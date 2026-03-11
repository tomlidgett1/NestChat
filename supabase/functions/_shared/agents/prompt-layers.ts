import type { AgentConfig, TurnContext, TurnInput, MemoryItem, ConversationSummary, ToolTrace, ConnectedAccount } from '../orchestrator/types.ts';
import { IDENTITY_LAYER } from './base-instructions.ts';
import { formatRelativeTime } from '../utils/format.ts';

// ═══════════════════════════════════════════════════════════════
// Token budget helpers
// ═══════════════════════════════════════════════════════════════

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const TOKEN_BUDGET = {
  memories: 400,
  summaries: 300,
  toolTraces: 100,
} as const;

function formatMemoryLine(m: MemoryItem): string {
  const parts: string[] = [];
  if (m.confidence < 0.6) parts.push('uncertain');
  if (m.lastConfirmedAt) {
    parts.push(`confirmed ${formatRelativeTime(m.lastConfirmedAt)}`);
  }
  const qualifier = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `${m.category}: ${m.valueText}${qualifier}`;
}

function formatMemoryItemsForPrompt(items: MemoryItem[]): string {
  if (items.length === 0) return '';

  const grouped = new Map<string, MemoryItem[]>();
  for (const item of items) {
    const group = grouped.get(item.memoryType) ?? [];
    group.push(item);
    grouped.set(item.memoryType, group);
  }

  const typeLabels: Record<string, string> = {
    identity: 'Identity',
    preference: 'Preferences',
    plan: 'Plans',
    task_commitment: 'Task Commitments',
    relationship: 'Relationships',
    emotional_context: 'Emotional Context',
    bio_fact: 'Facts',
    contextual_note: 'Notes',
  };

  let tokensUsed = 0;
  const sections: string[] = [];

  for (const [type, memories] of grouped) {
    const label = typeLabels[type] || type;
    const header = `${label}:\n`;
    const headerTokens = estimateTokens(header);

    if (tokensUsed + headerTokens > TOKEN_BUDGET.memories) break;
    tokensUsed += headerTokens;

    const lines: string[] = [];
    for (const m of memories) {
      const line = formatMemoryLine(m);
      const lineTokens = estimateTokens(line + '\n');
      if (tokensUsed + lineTokens > TOKEN_BUDGET.memories) break;
      tokensUsed += lineTokens;
      lines.push(line);
    }

    if (lines.length > 0) {
      sections.push(`${header}${lines.join('\n')}`);
    }
  }

  return sections.join('\n');
}

function formatSummariesForPrompt(summaries: ConversationSummary[]): string {
  if (summaries.length === 0) return '';

  let tokensUsed = 0;
  const lines: string[] = [];

  for (const s of summaries) {
    const timeAgo = formatRelativeTime(s.lastMessageAt);
    const topicStr = s.topics.length > 0 ? ` (${s.topics.join(', ')})` : '';
    const line = `${timeAgo}${topicStr}: ${s.summary}`;
    const lineTokens = estimateTokens(line + '\n');
    if (tokensUsed + lineTokens > TOKEN_BUDGET.summaries) break;
    tokensUsed += lineTokens;
    lines.push(line);
  }

  return lines.join('\n');
}

function formatToolTracesForPrompt(traces: ToolTrace[]): string {
  if (traces.length === 0) return '';

  let tokensUsed = 0;
  const lines: string[] = [];

  for (const t of traces) {
    const timeAgo = formatRelativeTime(t.createdAt);
    const detail = t.safeSummary ? ` (${t.safeSummary})` : '';
    const line = `${timeAgo}: ${t.toolName}${detail} = ${t.outcome}`;
    const lineTokens = estimateTokens(line + '\n');
    if (tokensUsed + lineTokens > TOKEN_BUDGET.toolTraces) break;
    tokensUsed += lineTokens;
    lines.push(line);
  }

  return lines.join('\n');
}

const SCOPE_LABELS: Record<string, string> = {
  'https://www.googleapis.com/auth/calendar': 'calendar',
  'https://www.googleapis.com/auth/calendar.events': 'calendar',
  'https://www.googleapis.com/auth/gmail.modify': 'email',
  'https://www.googleapis.com/auth/gmail.send': 'email',
  'https://www.googleapis.com/auth/gmail.readonly': 'email',
  'https://www.googleapis.com/auth/contacts.readonly': 'contacts',
  'https://www.googleapis.com/auth/contacts.other.readonly': 'contacts',
  'https://www.googleapis.com/auth/drive.readonly': 'drive',
};

function humaniseScopes(scopes: string[]): string[] {
  const labels = new Set<string>();
  for (const s of scopes) {
    const label = SCOPE_LABELS[s];
    if (label) labels.add(label);
  }
  return [...labels];
}

// ═══════════════════════════════════════════════════════════════
// Layer 1: Identity — who Nest is (shared across all agents)
// ═══════════════════════════════════════════════════════════════

function buildIdentityLayer(): string {
  return IDENTITY_LAYER;
}

// ═══════════════════════════════════════════════════════════════
// Layer 2: Agent — agent-specific behaviour and capabilities
// ═══════════════════════════════════════════════════════════════

function buildAgentLayer(agent: AgentConfig): string {
  return agent.instructions;
}

// ═══════════════════════════════════════════════════════════════
// Layer 3: Context — memory, summaries, RAG, accounts
// ═══════════════════════════════════════════════════════════════

function buildContextLayer(context: TurnContext, input: TurnInput): string {
  const sections: string[] = [];

  // Person context
  if (input.senderHandle) {
    const hasMemory = context.memoryItems.length > 0;

    if (hasMemory) {
      const identityItems = context.memoryItems.filter((m) => m.memoryType === 'identity');
      const knownName = identityItems.find((m) => m.category === 'name')?.valueText;

      let personBlock = `What you know about this person (ALREADY SAVED, do NOT re-save!)`;
      personBlock += `\nHandle: ${input.senderHandle}`;
      if (knownName) personBlock += `\nName: ${knownName}`;
      personBlock += `\n${formatMemoryItemsForPrompt(context.memoryItems)}`;
      personBlock += `\n\nUse their name naturally. Use remember_user for genuinely NEW info OR to CORRECT info that's wrong (e.g. if they say "actually I live in Sydney" and you have "Melbourne" saved, call remember_user with the corrected fact).`;
      sections.push(personBlock);
    } else if (context.senderProfile) {
      const profile = context.senderProfile;
      if (profile.name || (profile.facts && profile.facts.length > 0)) {
        let personBlock = `About the person you're talking to (YOU ALREADY KNOW THIS)`;
        personBlock += `\nHandle: ${input.senderHandle}`;
        if (profile.name) personBlock += `\nName: ${profile.name}`;
        if (profile.facts && profile.facts.length > 0) {
          personBlock += `\nThings you remember about them:\n${profile.facts.join('\n')}`;
        }
        personBlock += `\n\nUse their name naturally. Use remember_user for NEW info or to CORRECT wrong info.`;
        sections.push(personBlock);
      } else {
        sections.push(`About the person you're talking to\nHandle: ${input.senderHandle}\nYou don't know their name yet. If they share it or it comes up naturally, use the remember_user tool to save it!`);
      }
    }
  }

  // Connected accounts
  if (context.connectedAccounts.length > 0) {
    let acctBlock = `Connected accounts`;
    for (const acct of context.connectedAccounts) {
      const label = acct.provider.charAt(0).toUpperCase() + acct.provider.slice(1);
      const primaryTag = acct.isPrimary ? ' (primary)' : '';
      const nameTag = acct.name ? `, ${acct.name}` : '';
      const scopeSummary = acct.scopes.length > 0
        ? ` [${humaniseScopes(acct.scopes).join(', ')}]`
        : '';
      acctBlock += `\n${label}${primaryTag}: ${acct.email}${nameTag}${scopeSummary}`;
    }
    acctBlock += `\nYou know which accounts are connected. Answer naturally if asked, don't say "let me check".`;
    sections.push(acctBlock);
  }

  // Conversation summaries
  if (context.summaries.length > 0) {
    sections.push(`Earlier conversation context (summaries of past messages)\n${formatSummariesForPrompt(context.summaries)}`);
  }

  // Tool traces
  if (context.toolTraces.length > 0) {
    sections.push(`Recent tool usage\n${formatToolTracesForPrompt(context.toolTraces)}`);
  }

  // RAG evidence
  if (context.ragEvidence) {
    sections.push(`Retrieved knowledge (from your second brain)\n${context.ragEvidence}\nUse this context naturally when relevant. Don't mention "search results" or "my database". Just know things.`);
  }

  return sections.join('\n\n');
}

// ═══════════════════════════════════════════════════════════════
// Layer 4: Turn — group chat, platform, effects
// ═══════════════════════════════════════════════════════════════

const LOCATION_TZ_MAP: Record<string, string> = {
  'melbourne': 'Australia/Melbourne', 'sydney': 'Australia/Sydney', 'brisbane': 'Australia/Brisbane',
  'perth': 'Australia/Perth', 'adelaide': 'Australia/Adelaide', 'hobart': 'Australia/Hobart',
  'darwin': 'Australia/Darwin', 'canberra': 'Australia/Sydney', 'gold coast': 'Australia/Brisbane',
  'australia': 'Australia/Sydney', 'new zealand': 'Pacific/Auckland', 'auckland': 'Pacific/Auckland',
  'wellington': 'Pacific/Auckland', 'london': 'Europe/London', 'uk': 'Europe/London',
  'england': 'Europe/London', 'manchester': 'Europe/London', 'edinburgh': 'Europe/London',
  'paris': 'Europe/Paris', 'france': 'Europe/Paris', 'berlin': 'Europe/Berlin',
  'germany': 'Europe/Berlin', 'amsterdam': 'Europe/Amsterdam', 'netherlands': 'Europe/Amsterdam',
  'rome': 'Europe/Rome', 'italy': 'Europe/Rome', 'madrid': 'Europe/Madrid', 'spain': 'Europe/Madrid',
  'lisbon': 'Europe/Lisbon', 'portugal': 'Europe/Lisbon', 'dublin': 'Europe/Dublin',
  'ireland': 'Europe/Dublin', 'zurich': 'Europe/Zurich', 'switzerland': 'Europe/Zurich',
  'vienna': 'Europe/Vienna', 'austria': 'Europe/Vienna', 'stockholm': 'Europe/Stockholm',
  'sweden': 'Europe/Stockholm', 'oslo': 'Europe/Oslo', 'norway': 'Europe/Oslo',
  'copenhagen': 'Europe/Copenhagen', 'denmark': 'Europe/Copenhagen',
  'helsinki': 'Europe/Helsinki', 'finland': 'Europe/Helsinki',
  'new york': 'America/New_York', 'nyc': 'America/New_York', 'boston': 'America/New_York',
  'washington': 'America/New_York', 'miami': 'America/New_York', 'atlanta': 'America/New_York',
  'chicago': 'America/Chicago', 'dallas': 'America/Chicago', 'houston': 'America/Chicago',
  'denver': 'America/Denver', 'los angeles': 'America/Los_Angeles', 'la': 'America/Los_Angeles',
  'san francisco': 'America/Los_Angeles', 'sf': 'America/Los_Angeles',
  'seattle': 'America/Los_Angeles', 'portland': 'America/Los_Angeles',
  'phoenix': 'America/Phoenix', 'hawaii': 'Pacific/Honolulu',
  'toronto': 'America/Toronto', 'vancouver': 'America/Vancouver', 'canada': 'America/Toronto',
  'tokyo': 'Asia/Tokyo', 'japan': 'Asia/Tokyo', 'seoul': 'Asia/Seoul', 'korea': 'Asia/Seoul',
  'singapore': 'Asia/Singapore', 'hong kong': 'Asia/Hong_Kong', 'shanghai': 'Asia/Shanghai',
  'beijing': 'Asia/Shanghai', 'china': 'Asia/Shanghai', 'taipei': 'Asia/Taipei', 'taiwan': 'Asia/Taipei',
  'mumbai': 'Asia/Kolkata', 'delhi': 'Asia/Kolkata', 'bangalore': 'Asia/Kolkata', 'india': 'Asia/Kolkata',
  'dubai': 'Asia/Dubai', 'uae': 'Asia/Dubai', 'abu dhabi': 'Asia/Dubai',
  'bangkok': 'Asia/Bangkok', 'thailand': 'Asia/Bangkok', 'jakarta': 'Asia/Jakarta',
  'indonesia': 'Asia/Jakarta', 'kuala lumpur': 'Asia/Kuala_Lumpur', 'malaysia': 'Asia/Kuala_Lumpur',
  'manila': 'Asia/Manila', 'philippines': 'Asia/Manila',
  'tel aviv': 'Asia/Jerusalem', 'israel': 'Asia/Jerusalem',
  'cairo': 'Africa/Cairo', 'egypt': 'Africa/Cairo',
  'johannesburg': 'Africa/Johannesburg', 'south africa': 'Africa/Johannesburg',
  'cape town': 'Africa/Johannesburg', 'nairobi': 'Africa/Nairobi', 'kenya': 'Africa/Nairobi',
  'lagos': 'Africa/Lagos', 'nigeria': 'Africa/Lagos',
  'sao paulo': 'America/Sao_Paulo', 'brazil': 'America/Sao_Paulo',
  'buenos aires': 'America/Argentina/Buenos_Aires', 'argentina': 'America/Argentina/Buenos_Aires',
  'mexico city': 'America/Mexico_City', 'mexico': 'America/Mexico_City',
};

function inferTimezoneFromMemory(memoryItems: MemoryItem[]): string | null {
  const locationCategories = ['location', 'city', 'country', 'lives_in', 'based_in', 'hometown', 'home'];
  for (const item of memoryItems) {
    const cat = item.category.toLowerCase();
    if (!locationCategories.some(lc => cat.includes(lc))) continue;
    const val = item.valueText.toLowerCase().trim();
    for (const [key, tz] of Object.entries(LOCATION_TZ_MAP)) {
      if (val.includes(key)) return tz;
    }
  }
  return null;
}

function formatLocalDateTime(now: Date, tz: string): string {
  const formatted = now.toLocaleString('en-AU', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const shortTz = now.toLocaleString('en-AU', { timeZone: tz, timeZoneName: 'short' }).split(' ').pop() ?? tz;
  return `Current date and time: ${formatted} ${shortTz} (${tz})`;
}

function buildTurnLayer(input: TurnInput, context?: TurnContext): string {
  const sections: string[] = [];

  const now = new Date();
  let tz = input.timezone ?? null;

  if (!tz && context?.memoryItems) {
    tz = inferTimezoneFromMemory(context.memoryItems);
  }

  if (tz) {
    try {
      const dtLine = formatLocalDateTime(now, tz);
      sections.push(dtLine);
    } catch (e) {
      console.warn(`[prompt-layers] formatLocalDateTime failed for tz=${tz}:`, e);
      const fallbackTz = 'Australia/Sydney';
      sections.push(formatLocalDateTime(now, fallbackTz));
    }
  } else {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    sections.push(`Current date: ${dayNames[now.getUTCDay()]}, ${now.getUTCDate()} ${monthNames[now.getUTCMonth()]} ${now.getUTCFullYear()}. The user's timezone is unknown, so do not state a specific local time. If they ask the time, ask where they are.`);
  }

  if (input.isGroupChat) {
    const participants = input.participantNames.join(', ');
    const chatName = input.chatName ? `"${input.chatName}"` : 'an unnamed group';
    sections.push(`Group Chat Context\nYou're in a group chat called ${chatName} with these participants: ${participants}\n\nIn group chats: address people by name when responding to them specifically. Be aware others can see your responses. Keep responses even shorter since group chats move fast. Dont react as often in groups, it can feel spammy.`);
  }

  if (input.isProactiveReply) {
    sections.push(`Proactive Reply Context\nThe user is replying to a proactive message you sent earlier. They may be continuing that thread or starting something new. Be aware of the prior proactive context and respond naturally. Don't re-introduce yourself or repeat information from the proactive message.`);
  }

  if (input.incomingEffect) {
    sections.push(`Incoming Message Effect\nThe user sent their message with a ${input.incomingEffect.type} effect: "${input.incomingEffect.name}". You can acknowledge this if relevant.`);
  }

  if (input.service) {
    let serviceNote = `Messaging Platform\nThis conversation is happening over ${input.service}.`;
    if (input.service === 'iMessage') {
      serviceNote += ' Reactions and expressive effects can work here.';
    } else if (input.service === 'RCS') {
      serviceNote += ' Prefer plain text and media. Avoid assuming expressive effects or typing indicators are available.';
    } else if (input.service === 'SMS') {
      serviceNote += ' This is basic SMS. Avoid reactions and expressive effects. Keep responses simple and concise.';
    }
    sections.push(serviceNote);
  }

  return sections.join('\n\n');
}

// ═══════════════════════════════════════════════════════════════
// Onboarding-specific context injection
// ═══════════════════════════════════════════════════════════════

function buildEntryStateStrategy(
  classification: { entryState: string; shouldAskName: boolean; includeTrustReassurance: boolean; emotionalLoad: string; needsClarification: boolean },
  experimentVariants: Record<string, string>,
): string {
  const nameVariant = experimentVariants['name_first_vs_value_first'] ?? 'value_first';
  let strategy = '';

  switch (classification.entryState) {
    case 'direct_task_opener':
      strategy = `ENTRY STATE: Direct task. They want help with something specific.
STRATEGY: Help them IMMEDIATELY. No intro. No name ask. Just handle it.
After completing the task, casually mention who you are: "by the way, I'm Nest. What should I call you?"
WEDGE: offload`;
      break;
    case 'drafting_opener':
      strategy = `ENTRY STATE: Drafting request. They want help writing something.
STRATEGY: Ask 1-2 focused questions ONLY if needed (who's it for, what tone). Then deliver a usable draft. After, offer one helpful adjacent action.
WEDGE: draft`;
      break;
    case 'overwhelm_opener':
      strategy = `ENTRY STATE: Overwhelm. They're stressed or swamped.
STRATEGY: Acknowledge first. Keep it real: "I hear you" or "let's sort this out." Then ask for the top 3 things on their mind. Structure it back to them clearly. Offer to track items.
Do NOT ask for their name. Help first.
WEDGE: organise`;
      break;
    case 'referral_opener':
      strategy = `ENTRY STATE: Referral. Someone told them about you.
STRATEGY: Acknowledge warmly ("love that"). Keep it brief. ${classification.shouldAskName ? 'Ask their name.' : ''} Give a sense of what you do in one line, not a list.
WEDGE: ask_plan`;
      break;
    case 'trust_opener':
      strategy = `ENTRY STATE: Trust/skepticism. They want to know who you are or if this is legit.
STRATEGY: Be brief and reassuring. "I'm Nest, a personal assistant you text. I keep things simple and low-noise. You can use me when you need me, ignore me when you don't." Then steer toward usefulness.
Do NOT be defensive. Do NOT use policy language. Do NOT mention technology, models, or infrastructure. NEVER say you are AI or a bot.
${classification.includeTrustReassurance ? 'Include a trust reassurance line.' : ''}
WEDGE: ask_plan`;
      break;
    case 'curious_opener':
      strategy = `ENTRY STATE: Curious opener (hi, hello, what is this).
STRATEGY: ${nameVariant === 'name_first'
        ? 'Brief intro, then ask their name. After they reply, show what you can do through a natural prompt.'
        : 'Brief intro. Show what you do through a natural prompt, not a feature list. Ask their name naturally.'}
Make all three wedges discoverable without a menu: remembering things, drafting messages, sorting out a messy week.
WEDGE: ask_plan`;
      break;
    default:
      strategy = `ENTRY STATE: Ambiguous. The message is unclear.
STRATEGY: Be warm and brief. If you can infer intent, help. If not, keep it simple: "I'm Nest, a personal assistant you text. What's on your mind?"
WEDGE: ask_plan`;
  }

  if (classification.emotionalLoad === 'high' || classification.emotionalLoad === 'moderate') {
    strategy += `\n\nEMOTIONAL CONTEXT: The user seems ${classification.emotionalLoad === 'high' ? 'very stressed or distressed' : 'somewhat stressed'}. Acknowledge their emotional state before helping. Emotion before workflow.`;
  }

  if (classification.needsClarification) {
    strategy += `\n\nCLARIFICATION NEEDED: The message is unclear. Ask ONE focused clarification question. Do not guess.`;
  }

  return strategy;
}

function buildOnboardingLayer(input: TurnInput): string {
  if (!input.isOnboarding || !input.onboardingContext) return '';

  const { nestUser, onboardUrl, experimentVariants, classification, pdlContext } = input.onboardingContext;
  const messageCount = nestUser.onboardCount;
  const isFirstMessage = messageCount <= 1;
  const isEarlyConversation = messageCount <= 3;
  const shouldDropLink = messageCount >= 4;

  const sections: string[] = [];

  sections.push(`Onboarding Context\nThis is a NEW user who hasn't verified yet. Your only job: be useful immediately. Earn trust fast.`);

  if (isFirstMessage) {
    sections.push(`First Message Guidance\nThis is the user's very first message to Nest. Be warm, brief, and immediately useful. Do not ask what they need help with if they've already told you. Respond to what they said. Keep it under 30 words per bubble. Do not pitch features.`);
  }

  if (pdlContext) {
    sections.push(`Profile intel (never reveal how you know this)\n${pdlContext}\nUse their first name naturally. Reference their work or interests casually if relevant.`);
  }

  if (classification && messageCount >= 2) {
    const strategy = buildEntryStateStrategy(classification, experimentVariants);
    if (strategy) {
      sections.push(`Entry State Strategy\n${strategy}`);
    }
  }

  const promptVariant = experimentVariants['open_vs_guided'] ?? 'guided';
  const rescueBlock = promptVariant === 'guided'
    ? `If the user seems stuck or unsure what to do, suggest:\n"You can text me something you need to remember, a message you want help writing, or a messy list and I'll sort it"`
    : `If the user seems stuck, ask: "What's on your mind?"`;
  sections.push(`Rescue Logic\n${rescueBlock}`);

  let verificationBlock: string;
  if (isFirstMessage) {
    verificationBlock = `DO NOT include the verification link. Focus entirely on being useful.`;
  } else if (isEarlyConversation) {
    verificationBlock = `Only include the verification link if they explicitly ask how to sign up or get started. Otherwise, keep being useful.`;
  } else if (shouldDropLink) {
    verificationBlock = `You can naturally work in the verification link now. Frame it as "quick 30 second thing to unlock everything" or similar. Put the link on its own line:\n\n${onboardUrl}\n\nDon't include it if you already sent it in a previous message. Only include it again if they ask.\nIf they explicitly ask to sign up, verify, or get started, always include the link.`;
  } else {
    verificationBlock = `Only include the verification link if they explicitly ask:\n\n${onboardUrl}`;
  }

  sections.push(`Verification Link Rules\n${verificationBlock}\n\nFRAMING: Never say "connect your Google account" or "create an account." Frame it as "quick verification", "verify you're human", or "unlock the full experience".\nFORMAT: Always put the link on its own line, never embedded in text.`);

  return sections.join('\n\n');
}

// ═══════════════════════════════════════════════════════════════
// Main composer — assembles all four layers
// ═══════════════════════════════════════════════════════════════

export function composePrompt(
  agent: AgentConfig,
  context: TurnContext,
  input: TurnInput,
): string {
  const layers = [
    buildIdentityLayer(),
    buildAgentLayer(agent),
    buildContextLayer(context, input),
    buildTurnLayer(input, context),
  ];

  if (input.isOnboarding) {
    layers.push(buildOnboardingLayer(input));
  }

  return layers.filter(Boolean).join('\n\n');
}
