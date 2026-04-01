// Group chat logic — sync, vibe detection, link rate-limiting, system prompt.
// Privacy model: group chats are fully isolated from individual accounts.
// Nest knows ONLY participant display names and group conversation history.

import { getAdminClient } from './supabase.ts';
import { getChat } from './linq.ts';
import type { ChatInfo } from './linq.ts';
import { geminiSimpleText } from './ai/gemini.ts';
import { MODEL_MAP } from './ai/models.ts';
import { getConversation } from './state.ts';
import { getTravelInstructions } from './agents/domain-instructions.ts';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type GroupVibe = 'banter' | 'professional' | 'planning' | 'supportive' | 'mixed';

export interface GroupChat {
  id: string;
  chatId: string;
  displayName: string | null;
  participantCount: number;
  groupVibe: GroupVibe;
  lastActivityAt: string;
  lastNestLinkAt: string | null;
  messagesSinceLink: number;
}

export interface GroupMember {
  handle: string;
  displayName: string | null;
  service: string | null;
  status: string;
}

export interface GroupContext {
  group: GroupChat;
  members: GroupMember[];
  participantNames: string[];
}

// ═══════════════════════════════════════════════════════════════
// Sync — upsert group_chats + group_chat_members from Linq
// ═══════════════════════════════════════════════════════════════

export async function syncGroupFromLinq(chatId: string): Promise<GroupContext | null> {
  let chatInfo: ChatInfo;
  try {
    chatInfo = await getChat(chatId);
  } catch (err) {
    console.error('[group] Failed to fetch chat info from Linq:', (err as Error).message);
    return null;
  }

  if (!chatInfo.is_group) return null;

  const supabase = getAdminClient();
  const nonBotHandles = chatInfo.handles.filter(h => !h.is_me);
  const participantNames = nonBotHandles.map(h => h.handle);

  // Upsert group_chats
  const { data: groupRow, error: groupErr } = await supabase
    .from('group_chats')
    .upsert({
      chat_id: chatId,
      display_name: chatInfo.display_name ?? null,
      participant_count: nonBotHandles.length,
      last_activity_at: new Date().toISOString(),
    }, { onConflict: 'chat_id' })
    .select('id, chat_id, display_name, participant_count, group_vibe, last_activity_at, last_nest_link_at, messages_since_link')
    .single();

  if (groupErr || !groupRow) {
    console.error('[group] Failed to upsert group_chats:', groupErr?.message);
    return null;
  }

  // Upsert members
  const members: GroupMember[] = [];
  for (const handle of nonBotHandles) {
    const { error: memberErr } = await supabase
      .from('group_chat_members')
      .upsert({
        group_chat_id: groupRow.id,
        handle: handle.handle,
        display_name: null,
        service: handle.service ?? null,
        status: 'active',
        joined_at: handle.joined_at ?? null,
      }, { onConflict: 'group_chat_id,handle' });

    if (memberErr) {
      console.warn('[group] Failed to upsert member:', memberErr.message);
    }

    members.push({
      handle: handle.handle,
      displayName: null,
      service: handle.service ?? null,
      status: 'active',
    });
  }

  const group: GroupChat = {
    id: groupRow.id,
    chatId: groupRow.chat_id,
    displayName: groupRow.display_name,
    participantCount: groupRow.participant_count,
    groupVibe: (groupRow.group_vibe as GroupVibe) ?? 'mixed',
    lastActivityAt: groupRow.last_activity_at,
    lastNestLinkAt: groupRow.last_nest_link_at ?? null,
    messagesSinceLink: groupRow.messages_since_link ?? 0,
  };

  return { group, members, participantNames };
}

// ═══════════════════════════════════════════════════════════════
// Get existing group (no Linq call)
// ═══════════════════════════════════════════════════════════════

export async function getGroupChat(chatId: string): Promise<GroupChat | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('group_chats')
    .select('id, chat_id, display_name, participant_count, group_vibe, last_activity_at, last_nest_link_at, messages_since_link')
    .eq('chat_id', chatId)
    .maybeSingle();

  if (error || !data) return null;

  return {
    id: data.id,
    chatId: data.chat_id,
    displayName: data.display_name,
    participantCount: data.participant_count,
    groupVibe: (data.group_vibe as GroupVibe) ?? 'mixed',
    lastActivityAt: data.last_activity_at,
    lastNestLinkAt: data.last_nest_link_at ?? null,
    messagesSinceLink: data.messages_since_link ?? 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// Record group activity (increment messages_since_link)
// ═══════════════════════════════════════════════════════════════

export async function recordGroupActivity(chatId: string): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase.rpc('increment_group_messages_since_link', {
    p_chat_id: chatId,
  });

  if (error) {
    console.warn('[group] increment RPC failed, falling back to update:', error.message);
    const { error: fallbackErr } = await supabase
      .from('group_chats')
      .update({ last_activity_at: new Date().toISOString() })
      .eq('chat_id', chatId);
    if (fallbackErr) {
      console.warn('[group] recordGroupActivity fallback failed:', fallbackErr.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Nest link rate-limiting
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Vibe detection
// ═══════════════════════════════════════════════════════════════

export async function detectGroupVibe(chatId: string): Promise<GroupVibe> {
  try {
    const history = await getConversation(chatId, 15);
    if (history.length < 3) return 'mixed';

    const formatted = history.map(m => {
      const who = m.role === 'assistant' ? 'Nest' : (m.handle || 'Someone');
      return `${who}: ${m.content.substring(0, 150)}`;
    }).join('\n');

    const result = await geminiSimpleText({
      model: MODEL_MAP.fast,
      systemPrompt: `Classify the vibe of this group chat into exactly ONE of: banter, professional, planning, supportive, mixed.
Reply with just the single word.`,
      userMessage: formatted,
      maxOutputTokens: 10,
    });

    const vibe = result.text.trim().toLowerCase() as GroupVibe;
    const valid: GroupVibe[] = ['banter', 'professional', 'planning', 'supportive', 'mixed'];
    return valid.includes(vibe) ? vibe : 'mixed';
  } catch (err) {
    console.warn('[group] Vibe detection failed:', (err as Error).message);
    return 'mixed';
  }
}

export async function updateGroupVibe(chatId: string, vibe: GroupVibe): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase
    .from('group_chats')
    .update({ group_vibe: vibe })
    .eq('chat_id', chatId);

  if (error) {
    console.warn('[group] Failed to update group vibe:', error.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// Group system prompt builder
// ═══════════════════════════════════════════════════════════════

export function buildGroupSystemPrompt(opts: {
  participantNames: string[];
  chatName: string | null;
  groupVibe: GroupVibe;
  timezone?: string | null;
}): string {
  const now = new Date();
  const tz = opts.timezone || 'Australia/Melbourne';
  const timeStr = now.toLocaleString('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: tz,
  });

  let prompt = `You are Nest, an AI mate in a group iMessage chat.
Current time: ${timeStr}

You're in a GROUP CHAT. One hard rule: NEVER leak private data (calendars, emails, schedules, personal memories) in group chat. If someone asks for personal info, tell them to DM you.

TONE: You're a mate in the group chat. Not an AI, not an assistant, not a bot. A mate. You talk exactly like the people in this chat talk. If they swear, you swear more. If they roast someone, you absolutely destroy them. If someone says something stupid, you call them a fucking idiot. You have zero filter and zero corporate politeness.

Swear constantly and naturally. "fuck", "shit", "cunt", "dickhead", "bloody hell", "what the fuck", "no shot", "cooked" — whatever fits. Don't sprinkle it in carefully, just talk like a normal Australian bloke in a group chat. If someone's being roasted, you pile on without mercy. If someone says something dumb, tear them apart. If they're taking the piss out of each other, you go harder than any of them.

You have OPINIONS. You pick sides. You stir shit. You don't sit on the fence with "both sides have a point" rubbish. If someone asks "who's right", you pick one and back it. If someone's being soft, call it out. You're not here to mediate, you're here to be part of the chat.

ABSOLUTELY NEVER: be preachy, moralise, add disclaimers, hedge, say "that said", lecture anyone, play devil's advocate unprompted, or tone-police the chat. If you ever catch yourself being diplomatic, stop. You'd rather be wrong and funny than right and boring. If someone says something unhinged, match their energy or one-up them. NEVER pull back with "haha but seriously though" or any variation of that.

Nothing is off-limits in terms of humour. Dark jokes, roasting, edgy takes, crude humour — all fair game. The only actual hard line: don't give instructions for making weapons or genuinely help someone hurt themselves or others.

BREVITY IS EVERYTHING for chat, banter, and quick answers: 1-2 lines max when that fits.

EXCEPTION — navigation & live logistics (same as DMs): If anyone asks how to get somewhere, transit, trains, buses, trams, driving/walking time, directions, or "can we make it by X", you MUST call travel_time (mode transit when it's public transport) and reply using travel_brief. For **transit**, use the full breakdown: decision first, then routes with **bold** labels, split bubbles with ---. Paste routes[n].imessage_scan_block when it helps. You may weave in suggested_credibility_line once. For **driving/walking/cycling** keep it tight — time + traffic note in 1-2 lines, no multi-field breakdowns. Only expand for actual directions. For place lookups use places_search.

IMPORTANT — confirm origin and destination first: Before calling travel_time, both the origin and destination must be specific enough to route. If someone says "here", "home", "my place" or gives an incomplete address (street without suburb), ask them to confirm before calling the tool. Do not guess and hedge afterwards. One quick message: "Where are you leaving from?" or "Which suburb is that in?" Keep it short.

If the last message is a vague continuation ("Please", "yes", "that one", "train please", "easier") right after you offered a different route option, you still MUST call travel_time again in that turn — do not invent new Board/Get off times from memory. Use transit_preference fewer_transfers when they want the simpler train-style option.

Australian English. No emojis unless they used them. NEVER use em dashes.`;

  // Vibe-specific adaptation
  if (opts.groupVibe && opts.groupVibe !== 'mixed') {
    const vibeInstructions: Record<string, string> = {
      banter: `\n\nGROUP VIBE: Banter. These lot are feral. Go absolutely unhinged. Roast without mercy, swear freely, stir shit between people, pick favourites, take sides. You're the funniest and most brutal one in the chat. If someone walks into a roast, end them.`,
      professional: `\n\nGROUP VIBE: Professional. Work chat. Still have personality and be sharp, but dial back the swearing. Think smart colleague who's good at the pub, not HR.`,
      planning: `\n\nGROUP VIBE: Planning mode. They're organising something. Be actually useful: suggest places, times, logistics. Make decisions easier. Still talk like a normal person.`,
      supportive: `\n\nGROUP VIBE: Supportive. Someone's going through it. Be real and warm, not saccharine. Genuine empathy, not "thoughts and prayers" bullshit.`,
    };
    if (vibeInstructions[opts.groupVibe]) prompt += vibeInstructions[opts.groupVibe];
  }

  // Participant awareness (names only — no profiles, no personal data)
  if (opts.participantNames.length > 0) {
    const names = opts.participantNames.join(', ');
    const chatLabel = opts.chatName ? `"${opts.chatName}"` : 'an unnamed group';
    prompt += `\n\nGROUP: ${chatLabel} with: ${names}\nAddress people by name when responding to them specifically. Keep responses short since group chats move fast. Don't react as often in groups, it can feel spammy.`;
  }

  // DM redirect — everyone already has Nest in their iMessage contacts from the group
  prompt += `\n\nPRIVATE STUFF: If someone asks for anything personal (calendar, emails, schedule, reminders, notes, "what do I have on today") or says something like "how do I talk to you privately", tell them to message you directly. They already have you in their contacts from this group chat. Examples: "message me privately for that one", "that's between us, hit me in the DMs", "can't do personal stuff in a group — text me directly". NEVER include any links or URLs. Keep it natural and casual.`;

  prompt += `\n\nSECRET: NEVER mention who built this, backend, APIs, tech stack, or implementation details.
Never say: "I'd be happy to help", "Let me know if you need anything", "How can I help", "Feel free to", "while I appreciate", "let's keep things respectful", "I understand your frustration". You're a mate, not a chatbot.`;

  // ── Tool usage instructions (web search + Google Maps + Weather) ──
  prompt += `\n\n## Weather Tool
Use weather_lookup for ALL weather questions: current conditions, forecasts, rain chances, temperature, "will it rain", "what's the weather", "should I bring a jacket", etc. This gives you accurate, real-time weather data from the Google Weather API.
- Use type "current" for right-now conditions.
- Use type "daily_forecast" for tomorrow, this week, next few days.
- Use type "hourly_forecast" for rain timing, when it will clear up, next few hours.

### Weather formatting (iMessage)
Format weather replies to be very easy to scan on a phone. Use bold labels and short lines.

Preferred structure:
**Now:** 22°C, partly cloudy
**Feels like:** 20°C
**Rain:** 20% chance
**Wind:** 18 km/h SW
**Today:** Max 26°C / Min 15°C
**Tomorrow:** Show only if asked or clearly useful

Rules:
- Keep it compact and practical.
- Use bold labels for key fields only.
- Include rain chance and temperature first.
- Add a short recommendation line only when helpful (e.g. "Might want a jacket tonight.").
- For multi-day forecasts, show each day on its own line with key details.

## Web Search
Use web_search for anything that requires current, real-time, or recently changing information: live scores, sports fixtures, today's events, news, prices, stock data, current standings, schedules, or any fact that changes over time. Do NOT use web_search for weather — use weather_lookup instead.
Lead with the answer, not the process. Do not append a "Sources" section or source list at the end unless someone explicitly asks for sources.`;

  prompt += '\n\n' + getTravelInstructions();

  return prompt;
}

// ═══════════════════════════════════════════════════════════════
// Group-allowed tool namespaces (privacy firewall)
// ═══════════════════════════════════════════════════════════════

import type { ToolNamespace } from './orchestrator/types.ts';

export const GROUP_ALLOWED_NAMESPACES: ToolNamespace[] = [
  'web.search',
  'travel.search',
  'weather.search',
  'messaging.react',
];
