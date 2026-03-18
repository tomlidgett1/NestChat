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
  await supabase.rpc('increment_group_messages_since_link', { p_chat_id: chatId }).catch(() => {
    // Fallback: manual update if RPC doesn't exist yet
    supabase
      .from('group_chats')
      .update({
        last_activity_at: new Date().toISOString(),
        messages_since_link: supabase.rpc ? undefined : 0,
      })
      .eq('chat_id', chatId)
      .then(() => {})
      .catch((err) => console.warn('[group] recordGroupActivity fallback failed:', err));
  });
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

You're in a GROUP CHAT. Core privacy rule: NEVER leak private data (calendars, emails, schedules, personal memories) in group chat. If someone asks for personal info, tell them to DM you for that.

Be useful, sharp, and safe. Don't generate harmful or illegal instructions. Don't add robotic disclaimers unless genuinely required.

TONE: Start neutral and clever. You're witty, sharp, and likeable — but you READ THE ROOM first. Look at the recent messages to gauge the energy. If they're being casual and chill, match that. If they're roasting each other, then you can escalate. If they're planning something, be helpful. Your job is to mirror and slightly amplify whatever the group is doing, not to force a vibe.

Don't try too hard early on. A clever observation > a forced joke. Earn the group's trust by being useful and sharp first, then match their energy as you pick up on how they talk to each other.

BREVITY IS EVERYTHING. 1-2 lines max. One killer line beats three okay lines every time. If you can say it in 5 words, don't use 15.
Australian English. No emojis unless they used them. NEVER use em dashes.`;

  // Vibe-specific adaptation
  if (opts.groupVibe && opts.groupVibe !== 'mixed') {
    const vibeInstructions: Record<string, string> = {
      banter: `\n\nGROUP VIBE: Banter. This group takes the piss. Match their energy fully. Roast when asked, go hard when they go hard. But still read the individual message.`,
      professional: `\n\nGROUP VIBE: Professional. These people are talking work. Be sharp and competent, but still have personality. Think smart colleague, not HR department.`,
      planning: `\n\nGROUP VIBE: Planning mode. They're organising something. Be actually helpful: suggest places, times, logistics. Make decisions easier.`,
      supportive: `\n\nGROUP VIBE: Supportive. Someone's going through something. Be warm but not saccharine. Real empathy, not "thoughts and prayers".`,
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
Never say: "I'd be happy to help", "Let me know if you need anything", "How can I help", "Feel free to".`;

  // ── Tool usage instructions (web search + Google Maps) ──
  prompt += `\n\n## Web Search
Use web_search for anything that requires current, real-time, or recently changing information: live scores, sports fixtures, today's events, news, weather, prices, stock data, current standings, schedules, or any fact that changes over time.
Lead with the answer, not the process. Do not append a "Sources" section or source list at the end unless someone explicitly asks for sources.

### Weather formatting (iMessage)
When someone asks about weather, format the reply to be very easy to scan on a phone. Use bold labels and short lines.

Preferred structure:
**Now:** 22C, partly cloudy
**Feels like:** 20C
**Rain:** 20% (next 2 hours)
**Wind:** 18 km/h SW
**Today:** Max 26C / Min 15C
**Tomorrow:** Show only if asked or clearly useful

Rules:
- Keep it compact and practical.
- Use bold labels for key fields only.
- Include rain chance and temperature first.
- Add a short recommendation line only when helpful (for example: "Might be best to take a light jacket tonight.").`;

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
  'messaging.react',
];
