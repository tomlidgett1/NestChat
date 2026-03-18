import type {
  AgentConfig,
  Capability,
  ConversationSummary,
  DomainTag,
  MemoryItem,
  ToolTrace,
  TurnContext,
  TurnInput,
} from "../orchestrator/types.ts";
import {
  COMPACT_IDENTITY_LAYER,
  IDENTITY_LAYER,
  ONBOARDING_IDENTITY_LAYER,
} from "./base-instructions.ts";
import {
  COMPACT_CONVERSATION_BEHAVIOR_LAYER,
  CONVERSATION_BEHAVIOR_LAYER,
} from "./conversation-behavior.ts";
import {
  getAuxiliaryInstructions,
  getDeepProfileInstructions,
  getDomainInstructions,
  getTravelInstructions,
} from "./domain-instructions.ts";
import {
  COMPACT_MEMORY_CONTINUITY_LAYER,
  MEMORY_CONTINUITY_LAYER,
} from "./memory-continuity.ts";
import {
  COMPACT_MESSAGE_SHAPING_LAYER,
  MESSAGE_SHAPING_LAYER,
} from "./message-shaping.ts";
import { COMPACT_CASUAL_MODE_LAYER } from "./mode-casual.ts";
import { COMPACT_RESEARCH_MODE_LAYER } from "./mode-task.ts";
import { formatRelativeTime } from "../utils/format.ts";
import { getOptionalEnv } from "../env.ts";

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
  if (m.confidence < 0.6) parts.push("uncertain");
  if (m.lastConfirmedAt) {
    parts.push(`confirmed ${formatRelativeTime(m.lastConfirmedAt)}`);
  }
  const qualifier = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `${m.category}: ${m.valueText}${qualifier}`;
}

function formatMemoryItemsForPrompt(items: MemoryItem[]): string {
  if (items.length === 0) return "";

  const grouped = new Map<string, MemoryItem[]>();
  for (const item of items) {
    const group = grouped.get(item.memoryType) ?? [];
    group.push(item);
    grouped.set(item.memoryType, group);
  }

  const typeLabels: Record<string, string> = {
    identity: "Identity",
    preference: "Preferences",
    plan: "Plans",
    task_commitment: "Task Commitments",
    relationship: "Relationships",
    emotional_context: "Emotional Context",
    bio_fact: "Facts",
    contextual_note: "Notes",
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
      const lineTokens = estimateTokens(line + "\n");
      if (tokensUsed + lineTokens > TOKEN_BUDGET.memories) break;
      tokensUsed += lineTokens;
      lines.push(line);
    }

    if (lines.length > 0) {
      sections.push(`${header}${lines.join("\n")}`);
    }
  }

  return sections.join("\n");
}

function formatSummariesForPrompt(summaries: ConversationSummary[]): string {
  if (summaries.length === 0) return "";

  let tokensUsed = 0;
  const lines: string[] = [];

  for (const s of summaries) {
    const timeAgo = formatRelativeTime(s.lastMessageAt);
    const topicStr = s.topics.length > 0 ? ` (${s.topics.join(", ")})` : "";
    const line = `${timeAgo}${topicStr}: ${s.summary}`;
    const lineTokens = estimateTokens(line + "\n");
    if (tokensUsed + lineTokens > TOKEN_BUDGET.summaries) break;
    tokensUsed += lineTokens;
    lines.push(line);
  }

  return lines.join("\n");
}

function formatToolTracesForPrompt(traces: ToolTrace[]): string {
  if (traces.length === 0) return "";

  let tokensUsed = 0;
  const lines: string[] = [];

  for (const t of traces) {
    const timeAgo = formatRelativeTime(t.createdAt);
    const detail = t.safeSummary ? ` (${t.safeSummary})` : "";
    const line = `${timeAgo}: ${t.toolName}${detail} = ${t.outcome}`;
    const lineTokens = estimateTokens(line + "\n");
    if (tokensUsed + lineTokens > TOKEN_BUDGET.toolTraces) break;
    tokensUsed += lineTokens;
    lines.push(line);
  }

  return lines.join("\n");
}

const SCOPE_LABELS: Record<string, string> = {
  "https://www.googleapis.com/auth/calendar.events": "calendar",
  "https://www.googleapis.com/auth/gmail.modify": "email",
  "https://www.googleapis.com/auth/gmail.readonly": "email",
  "https://www.googleapis.com/auth/contacts.readonly": "contacts",
  "https://www.googleapis.com/auth/contacts.other.readonly": "contacts",
  "https://www.googleapis.com/auth/drive.readonly": "drive",
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

function buildIdentityLayer(agent: AgentConfig, input: TurnInput): string {
  if (agent.name === "onboard" && input.isOnboarding) {
    return ONBOARDING_IDENTITY_LAYER;
  }
  return IDENTITY_LAYER;
}

// ═══════════════════════════════════════════════════════════════
// Layer 2: Conversation behaviour — human rhythm and anti-robot rules
// ═══════════════════════════════════════════════════════════════

function detectUserCaseStyle(
  message: string,
): "lowercase" | "uppercase" | null {
  const letters = message.replace(/[^a-zA-Z]+/g, "");
  if (letters.length < 3) return null;
  if (letters === letters.toLowerCase()) return "lowercase";
  if (letters === letters.toUpperCase()) return "uppercase";
  return null;
}

function isGreetingLike(message: string): boolean {
  const trimmed = message.trim().toLowerCase();
  return /^(good\s+(morning|afternoon|evening)|morning|afternoon|evening|gm|hey|hi|hello|yo|what'?s up|sup|you around\??)$/
    .test(trimmed);
}

function buildConversationBehaviorLayer(input: TurnInput): string {
  const sections = [CONVERSATION_BEHAVIOR_LAYER];
  const caseStyle = detectUserCaseStyle(input.userMessage);

  if (caseStyle === "lowercase") {
    sections.push(
      "Style cue\nThe user is writing in lowercase. Mirror that unless clarity would genuinely suffer.",
    );
  } else if (caseStyle === "uppercase") {
    sections.push(
      "Style cue\nThe user is using capitals for emphasis. Stay calm and readable rather than shouting back.",
    );
  }

  return sections.join("\n\n");
}

// ═══════════════════════════════════════════════════════════════
// Layer 3: Agent — mode-specific behaviour and capabilities
// ═══════════════════════════════════════════════════════════════

function buildAgentLayer(agent: AgentConfig): string {
  return agent.instructions;
}

// ═══════════════════════════════════════════════════════════════
// Layer 4: Continuity — static memory guidance + dynamic re-entry cues
// ═══════════════════════════════════════════════════════════════

const LOCATION_MEMORY_HINTS = [
  "location",
  "city",
  "country",
  "lives",
  "based",
  "home",
  "address",
  "hometown",
];
const WORK_MEMORY_HINTS = [
  "job",
  "work",
  "career",
  "company",
  "employer",
  "role",
  "employment",
  "occupation",
];

function findMemoryAnchors(
  items: MemoryItem[],
  categoryHints: string[],
  limit: number,
): string[] {
  const anchors: string[] = [];

  for (const item of items) {
    const category = item.category.toLowerCase();
    if (!categoryHints.some((hint) => category.includes(hint))) continue;
    const value = item.valueText.trim();
    if (!value) continue;
    if (
      anchors.some((existing) => existing.toLowerCase() === value.toLowerCase())
    ) continue;
    anchors.push(value);
    if (anchors.length >= limit) break;
  }

  return anchors;
}

function findCompactMemoryAnchors(
  context: TurnContext,
  limit: number,
): string[] {
  const anchors: string[] = [];

  for (const item of context.memoryItems) {
    if (
      !["identity", "preference", "plan", "relationship", "bio_fact"].includes(
        item.memoryType,
      )
    ) continue;
    const anchor = `${item.category}: ${item.valueText}`;
    if (
      anchors.some((existing) =>
        existing.toLowerCase() === anchor.toLowerCase()
      )
    ) continue;
    anchors.push(anchor);
    if (anchors.length >= limit) return anchors;
  }

  for (const fact of context.senderProfile?.facts ?? []) {
    const trimmed = fact.trim();
    if (!trimmed) continue;
    if (
      anchors.some((existing) =>
        existing.toLowerCase() === trimmed.toLowerCase()
      )
    ) continue;
    anchors.push(trimmed);
    if (anchors.length >= limit) break;
  }

  return anchors;
}

function collectOpenLoops(
  summaries: ConversationSummary[],
  limit: number,
): string[] {
  const loops: string[] = [];
  for (const summary of summaries) {
    for (const loop of summary.openLoops) {
      const trimmed = loop.trim();
      if (!trimmed) continue;
      if (
        loops.some((existing) =>
          existing.toLowerCase() === trimmed.toLowerCase()
        )
      ) continue;
      loops.push(trimmed);
      if (loops.length >= limit) return loops;
    }
  }
  return loops;
}

function resolveUserTimezone(
  input: TurnInput,
  context?: TurnContext,
): string | null {
  if (input.timezone) return input.timezone;
  if (context?.memoryItems?.length) {
    return inferTimezoneFromMemory(context.memoryItems);
  }
  return null;
}

function formatLocalDate(now: Date, tz: string): string {
  return now.toLocaleDateString("en-AU", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function getLocalDayKey(date: Date, tz: string): string {
  return date.toLocaleDateString("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function getLocalDaypart(now: Date, tz: string): string {
  const hour = Number(now.toLocaleString("en-AU", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  }));

  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  return "late night";
}

function formatTimeSinceLastSeen(lastSeenEpochSeconds: number): string | null {
  const hours = (Date.now() / 1000 - lastSeenEpochSeconds) / 3600;
  if (!Number.isFinite(hours) || hours < 0) return null;
  if (hours < 1) return "under 1 hour";
  if (hours < 6) return `${hours.toFixed(1)} hours`;
  if (hours < 24) return `${Math.round(hours)} hours`;
  const days = hours / 24;
  if (days < 7) return `${Math.round(days)} days`;
  return `${Math.round(days / 7)} weeks`;
}

function buildMemoryContinuityLayer(
  context: TurnContext,
  input: TurnInput,
): string {
  const sections = [MEMORY_CONTINUITY_LAYER];
  const now = new Date();
  const cues: string[] = [];
  const timezone = resolveUserTimezone(input, context);

  if (timezone) {
    try {
      const daypart = getLocalDaypart(now, timezone);
      const dateLabel = formatLocalDate(now, timezone);
      cues.push(
        `Local context: it is ${daypart} for the user on ${dateLabel} (${timezone}).`,
      );
    } catch (err) {
      console.warn(
        `[prompt-layers] local continuity formatting failed for tz=${timezone}:`,
        err,
      );
      cues.push(
        `Timezone: ${timezone}. Use it if needed, but do not guess a specific local time if formatting fails.`,
      );
    }
  } else {
    cues.push(
      `Timezone is unknown. Do not guess the user's local time or daypart.`,
    );
  }

  if (context.senderProfile?.lastSeen) {
    const since = formatTimeSinceLastSeen(context.senderProfile.lastSeen);
    if (since) {
      cues.push(`Re-entry: they were last seen about ${since} ago.`);
    }

    if (timezone) {
      try {
        const nowKey = getLocalDayKey(now, timezone);
        const lastSeenKey = getLocalDayKey(
          new Date(context.senderProfile.lastSeen * 1000),
          timezone,
        );
        cues.push(
          nowKey === lastSeenKey
            ? "Thread state: this likely continues the same local-day conversation."
            : "Thread state: this is likely their first message of the local day.",
        );
      } catch (err) {
        console.warn(
          `[prompt-layers] local day key failed for tz=${timezone}:`,
          err,
        );
      }
    }
  }

  const locationAnchors = findMemoryAnchors(
    context.memoryItems,
    LOCATION_MEMORY_HINTS,
    2,
  );
  if (locationAnchors.length > 0) {
    cues.push(`Location anchors: ${locationAnchors.join(" | ")}`);
  }

  const workAnchors = findMemoryAnchors(
    context.memoryItems,
    WORK_MEMORY_HINTS,
    2,
  );
  if (workAnchors.length > 0) {
    cues.push(`Work anchors: ${workAnchors.join(" | ")}`);
  }

  const openLoops = collectOpenLoops(context.summaries, 2);
  if (openLoops.length > 0) {
    cues.push(`Open threads: ${openLoops.join(" | ")}`);
  }

  if (
    isGreetingLike(input.userMessage) &&
    (locationAnchors.length > 0 || workAnchors.length > 0 ||
      openLoops.length > 0)
  ) {
    cues.push(
      `Greeting guidance: this is a re-entry or greeting turn. If a real anchor fits, use one light personal callback instead of a generic opener.`,
    );
  }

  if (cues.length > 0) {
    sections.push(`Continuity signals\n${cues.join("\n")}`);
  }

  return sections.join("\n\n");
}

// ═══════════════════════════════════════════════════════════════
// Layer 5: Message shaping — bubble logic and answer packaging
// ═══════════════════════════════════════════════════════════════

function buildMessageShapingLayer(): string {
  return MESSAGE_SHAPING_LAYER;
}

// ═══════════════════════════════════════════════════════════════
// Layer 6: Context — memory, summaries, RAG, accounts
// ═══════════════════════════════════════════════════════════════

function buildContextLayer(context: TurnContext, input: TurnInput): string {
  const sections: string[] = [];

  // Person context
  if (input.senderHandle) {
    const hasMemory = context.memoryItems.length > 0;

    if (hasMemory) {
      const identityItems = context.memoryItems.filter((m) =>
        m.memoryType === "identity"
      );
      const knownName = identityItems.find((m) => m.category === "name")
        ?.valueText;

      let personBlock = `Known user context`;
      personBlock += `\nHandle: ${input.senderHandle}`;
      if (knownName) personBlock += `\nName: ${knownName}`;
      personBlock += `\n${formatMemoryItemsForPrompt(context.memoryItems)}`;
      personBlock +=
        `\n\nUse this naturally. Only write genuinely new durable details to memory, or correct details that are wrong.`;
      sections.push(personBlock);
    } else if (context.senderProfile) {
      const profile = context.senderProfile;
      if (profile.name || (profile.facts && profile.facts.length > 0)) {
        let personBlock = `Known user profile`;
        personBlock += `\nHandle: ${input.senderHandle}`;
        if (profile.name) personBlock += `\nName: ${profile.name}`;
        if (profile.facts && profile.facts.length > 0) {
          personBlock += `\nProfile anchors:\n${profile.facts.join("\n")}`;
        }
        personBlock +=
          `\n\nUse this naturally. Only write new durable details or corrections to memory.`;
        sections.push(personBlock);
      } else {
        sections.push(
          `Known user profile\nHandle: ${input.senderHandle}\nYou do not know their name yet. If they share it or it comes up naturally, use remember_user to save it.`,
        );
      }
    }
  }

  // Connected accounts
  if (context.connectedAccounts.length > 0) {
    let acctBlock = `Connected accounts`;
    for (const acct of context.connectedAccounts) {
      const label = acct.provider.charAt(0).toUpperCase() +
        acct.provider.slice(1);
      const primaryTag = acct.isPrimary ? " (primary)" : "";
      const nameTag = acct.name ? `, ${acct.name}` : "";
      const scopeLabels = acct.scopes.length > 0
        ? humaniseScopes(acct.scopes)
        : acct.provider === "microsoft"
        ? ["email", "calendar", "contacts"]
        : [];
      const scopeSummary = scopeLabels.length > 0
        ? ` [${scopeLabels.join(", ")}]`
        : "";
      acctBlock +=
        `\n${label}${primaryTag}: ${acct.email}${nameTag}${scopeSummary}`;
    }
    acctBlock +=
      `\nYou already know which accounts are connected. Answer naturally if asked.`;

    const hasGranola = context.connectedAccounts.some((a) =>
      a.provider === "granola"
    );
    if (!hasGranola && input.authUserId) {
      const supabaseUrl = getOptionalEnv("SUPABASE_URL") ??
        "https://oypzijwqmkxktvgtsqkp.supabase.co";
      const granolaAuthUrl =
        `${supabaseUrl}/functions/v1/granola-auth?user_id=${input.authUserId}`;
      acctBlock +=
        `\n\nGranola (meeting notes) is NOT connected. If the user asks to connect Granola, send them this link:\n\n${granolaAuthUrl}\n\nPut the link on its own line. Frame it as a quick tap to connect their meeting notes. Do NOT pretend you can connect it yourself or that you're "setting it up". Just give them the link and tell them to tap it.`;
    } else if (!hasGranola) {
      acctBlock +=
        `\n\nGranola (meeting notes) is NOT connected. If the user asks to connect Granola, tell them you need to look up their connection link and to ask again shortly.`;
    }

    sections.push(acctBlock);
  }

  // Conversation summaries
  if (context.summaries.length > 0) {
    sections.push(
      `Earlier conversation context (summaries of past messages)\n${
        formatSummariesForPrompt(context.summaries)
      }`,
    );
  }

  // Tool traces
  if (context.toolTraces.length > 0) {
    sections.push(
      `Recent tool usage\n${formatToolTracesForPrompt(context.toolTraces)}`,
    );
  }

  if (context.pendingEmailSends.length > 0) {
    const draft = context.pendingEmailSends[0];
    const to = draft.to.join(", ") || "unknown recipient";
    const subject = draft.subject ?? "no subject";
    const draftId = String(draft.id);
    sections.push(
      `PENDING EMAIL DRAFT (draft_id: ${draftId})\nTo: ${to}\nSubject: ${subject}\nStatus: awaiting user approval\n\nRULES:\n1. If the user confirms (e.g. "yes", "send it", "go ahead"), call email_send with draft_id "${draftId}".\n2. If the user asks to revise, call email_update_draft with draft_id "${draftId}" and the changes.\n3. If the user cancels, call email_cancel_draft with draft_id "${draftId}".\n4. Do NOT call email_draft again. The draft already exists.\n5. Do NOT invent a pending draft if none exists.`,
    );
  }

  // RAG evidence
  if (context.ragEvidence) {
    sections.push(
      `Retrieved knowledge (from your second brain)\n${context.ragEvidence}\nUse this context naturally when relevant. Don't mention "search results" or "my database". Just know things.`,
    );
  }

  // Group chat awareness nudge for DM users in the 20-40 message range
  if (
    !input.isOnboarding &&
    !input.isGroupChat &&
    context.summaries.length >= 1 &&
    context.summaries.length <= 3
  ) {
    sections.push(
      `Group chat tip (mention ONCE if it comes up naturally, don't force it)\nNest can be added to group chats too. If the conversation touches on friends, teams, or group plans, you can casually mention it. Reassure them that DM conversations are completely private and never shared with or visible in group chats. Only mention this once, ever. If you've already mentioned it in this conversation or a prior one, don't repeat it.`,
    );
  }

  return sections.join("\n\n");
}

// ═══════════════════════════════════════════════════════════════
// Layer 4: Turn — group chat, platform, effects
// ═══════════════════════════════════════════════════════════════

const LOCATION_TZ_MAP: Record<string, string> = {
  "melbourne": "Australia/Melbourne",
  "sydney": "Australia/Sydney",
  "brisbane": "Australia/Brisbane",
  "perth": "Australia/Perth",
  "adelaide": "Australia/Adelaide",
  "hobart": "Australia/Hobart",
  "darwin": "Australia/Darwin",
  "canberra": "Australia/Sydney",
  "gold coast": "Australia/Brisbane",
  "australia": "Australia/Sydney",
  "new zealand": "Pacific/Auckland",
  "auckland": "Pacific/Auckland",
  "wellington": "Pacific/Auckland",
  "london": "Europe/London",
  "uk": "Europe/London",
  "england": "Europe/London",
  "manchester": "Europe/London",
  "edinburgh": "Europe/London",
  "paris": "Europe/Paris",
  "france": "Europe/Paris",
  "berlin": "Europe/Berlin",
  "germany": "Europe/Berlin",
  "amsterdam": "Europe/Amsterdam",
  "netherlands": "Europe/Amsterdam",
  "rome": "Europe/Rome",
  "italy": "Europe/Rome",
  "madrid": "Europe/Madrid",
  "spain": "Europe/Madrid",
  "lisbon": "Europe/Lisbon",
  "portugal": "Europe/Lisbon",
  "dublin": "Europe/Dublin",
  "ireland": "Europe/Dublin",
  "zurich": "Europe/Zurich",
  "switzerland": "Europe/Zurich",
  "vienna": "Europe/Vienna",
  "austria": "Europe/Vienna",
  "stockholm": "Europe/Stockholm",
  "sweden": "Europe/Stockholm",
  "oslo": "Europe/Oslo",
  "norway": "Europe/Oslo",
  "copenhagen": "Europe/Copenhagen",
  "denmark": "Europe/Copenhagen",
  "helsinki": "Europe/Helsinki",
  "finland": "Europe/Helsinki",
  "new york": "America/New_York",
  "nyc": "America/New_York",
  "boston": "America/New_York",
  "washington": "America/New_York",
  "miami": "America/New_York",
  "atlanta": "America/New_York",
  "chicago": "America/Chicago",
  "dallas": "America/Chicago",
  "houston": "America/Chicago",
  "denver": "America/Denver",
  "los angeles": "America/Los_Angeles",
  "la": "America/Los_Angeles",
  "san francisco": "America/Los_Angeles",
  "sf": "America/Los_Angeles",
  "seattle": "America/Los_Angeles",
  "portland": "America/Los_Angeles",
  "phoenix": "America/Phoenix",
  "hawaii": "Pacific/Honolulu",
  "toronto": "America/Toronto",
  "vancouver": "America/Vancouver",
  "canada": "America/Toronto",
  "tokyo": "Asia/Tokyo",
  "japan": "Asia/Tokyo",
  "seoul": "Asia/Seoul",
  "korea": "Asia/Seoul",
  "singapore": "Asia/Singapore",
  "hong kong": "Asia/Hong_Kong",
  "shanghai": "Asia/Shanghai",
  "beijing": "Asia/Shanghai",
  "china": "Asia/Shanghai",
  "taipei": "Asia/Taipei",
  "taiwan": "Asia/Taipei",
  "mumbai": "Asia/Kolkata",
  "delhi": "Asia/Kolkata",
  "bangalore": "Asia/Kolkata",
  "india": "Asia/Kolkata",
  "dubai": "Asia/Dubai",
  "uae": "Asia/Dubai",
  "abu dhabi": "Asia/Dubai",
  "bangkok": "Asia/Bangkok",
  "thailand": "Asia/Bangkok",
  "jakarta": "Asia/Jakarta",
  "indonesia": "Asia/Jakarta",
  "kuala lumpur": "Asia/Kuala_Lumpur",
  "malaysia": "Asia/Kuala_Lumpur",
  "manila": "Asia/Manila",
  "philippines": "Asia/Manila",
  "tel aviv": "Asia/Jerusalem",
  "israel": "Asia/Jerusalem",
  "cairo": "Africa/Cairo",
  "egypt": "Africa/Cairo",
  "johannesburg": "Africa/Johannesburg",
  "south africa": "Africa/Johannesburg",
  "cape town": "Africa/Johannesburg",
  "nairobi": "Africa/Nairobi",
  "kenya": "Africa/Nairobi",
  "lagos": "Africa/Lagos",
  "nigeria": "Africa/Lagos",
  "sao paulo": "America/Sao_Paulo",
  "brazil": "America/Sao_Paulo",
  "buenos aires": "America/Argentina/Buenos_Aires",
  "argentina": "America/Argentina/Buenos_Aires",
  "mexico city": "America/Mexico_City",
  "mexico": "America/Mexico_City",
};

function inferTimezoneFromMemory(memoryItems: MemoryItem[]): string | null {
  const locationCategories = [
    "location",
    "city",
    "country",
    "lives_in",
    "based_in",
    "hometown",
    "home",
  ];
  for (const item of memoryItems) {
    const cat = item.category.toLowerCase();
    if (!locationCategories.some((lc) => cat.includes(lc))) continue;
    const val = item.valueText.toLowerCase().trim();
    for (const [key, tz] of Object.entries(LOCATION_TZ_MAP)) {
      if (val.includes(key)) return tz;
    }
  }
  return null;
}

function formatLocalDateTime(now: Date, tz: string): string {
  const formatted = now.toLocaleString("en-AU", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const shortTz =
    now.toLocaleString("en-AU", { timeZone: tz, timeZoneName: "short" }).split(
      " ",
    ).pop() ?? tz;
  return `Current date and time: ${formatted} ${shortTz} (${tz}). If the user asks the time, use this exact time, do not round or adjust it.`;
}

function buildTurnLayer(input: TurnInput, context?: TurnContext): string {
  const sections: string[] = [];

  const now = new Date();
  const tz = resolveUserTimezone(input, context);

  if (tz) {
    try {
      const dtLine = formatLocalDateTime(now, tz);
      sections.push(dtLine);
    } catch (e) {
      console.warn(
        `[prompt-layers] formatLocalDateTime failed for tz=${tz}:`,
        e,
      );
      sections.push(
        `Timezone: ${tz}. The timezone could not be formatted, so do not state a specific local time.`,
      );
    }
  } else {
    const utcFormatted = now.toLocaleString("en-AU", {
      timeZone: "UTC",
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    sections.push(
      `Current date and time: ${utcFormatted} UTC. The user's timezone is unknown, so do not state a specific local time. If they ask the time, ask where they are.`,
    );
  }

  if (input.isGroupChat) {
    const participants = input.participantNames.join(", ");
    const chatName = input.chatName
      ? `"${input.chatName}"`
      : "an unnamed group";
    sections.push(
      `Group Chat Context\nYou're in a group chat called ${chatName} with these participants: ${participants}\n\nIn group chats: address people by name when responding to them specifically. Be aware others can see your responses. Keep responses even shorter since group chats move fast. Dont react as often in groups, it can feel spammy.\n\nWhen the group is busy (multiple people chatting), your reply is automatically sent as a threaded reply to the message that triggered you. The recipient already sees which message you're responding to, so don't re-quote or re-reference it — just respond directly.`,
    );
  }

  if (input.isProactiveReply) {
    sections.push(
      `Proactive Reply Context\nThe user is replying to a proactive message you sent earlier. They may be continuing that thread or starting something new. Be aware of the prior proactive context and respond naturally. Don't re-introduce yourself or repeat information from the proactive message.`,
    );
  }

  if (input.incomingEffect) {
    sections.push(
      `Incoming Message Effect\nThe user sent their message with a ${input.incomingEffect.type} effect: "${input.incomingEffect.name}". You can acknowledge this if relevant.`,
    );
  }

  if (input.service) {
    let serviceNote =
      `Messaging Platform\nThis conversation is happening over ${input.service}.`;
    if (input.service === "iMessage") {
      serviceNote += " Reactions (any emoji) and expressive effects can work here.";
    } else if (input.service === "RCS") {
      serviceNote +=
        " Prefer plain text and media. Avoid assuming expressive effects or typing indicators are available.";
    } else if (input.service === "SMS") {
      serviceNote +=
        " This is basic SMS. Avoid reactions and expressive effects. Keep responses simple and concise.";
    }
    sections.push(serviceNote);
  }

  return sections.join("\n\n");
}

// ═══════════════════════════════════════════════════════════════
// Onboarding-specific context injection
// ═══════════════════════════════════════════════════════════════

function buildEntryStateStrategy(
  classification: {
    entryState: string;
    shouldAskName: boolean;
    includeTrustReassurance: boolean;
    emotionalLoad: string;
    needsClarification: boolean;
  },
  experimentVariants: Record<string, string>,
): string {
  const nameVariant = experimentVariants["name_first_vs_value_first"] ??
    "value_first";
  let strategy = "";

  switch (classification.entryState) {
    case "direct_task_opener":
      strategy =
        `ENTRY STATE: Direct task. They want help with something specific.
STRATEGY: Help them IMMEDIATELY. No intro. No name ask. Just handle it.
After completing the task, casually mention who you are: "by the way, I'm Nest. What should I call you?"
WEDGE: offload`;
      break;
    case "drafting_opener":
      strategy =
        `ENTRY STATE: Drafting request. They want help writing something.
STRATEGY: Ask 1-2 focused questions ONLY if needed (who's it for, what tone). Then deliver a usable draft. After, offer one helpful adjacent action.
WEDGE: draft`;
      break;
    case "overwhelm_opener":
      strategy = `ENTRY STATE: Overwhelm. They're stressed or swamped.
STRATEGY: Acknowledge first. Keep it real: "I hear you" or "let's sort this out." Then ask for the top 3 things on their mind. Structure it back to them clearly. Offer to track items.
Do NOT ask for their name. Help first.
WEDGE: organise`;
      break;
    case "referral_opener":
      strategy = `ENTRY STATE: Referral. Someone told them about you.
STRATEGY: Acknowledge warmly ("love that"). Keep it brief. ${
        classification.shouldAskName ? "Ask their name." : ""
      } Then extract: ask one curious question to learn something real about them ("what's keeping you busy at the moment?" or "what's the thing you keep meaning to sort out?"). Once they answer, show value against that specific thing.
WEDGE: ask_plan`;
      break;
    case "trust_opener":
      strategy =
        `ENTRY STATE: Trust/skepticism. They want to know who you are or if this is legit.
STRATEGY: Be brief and reassuring. "I'm Nest. I keep things simple and low-noise. You can use me when you need me, ignore me when you don't." Then steer toward extraction: ask one question that gets them to share something real so you can demonstrate value contextually.
Do NOT be defensive. Do NOT use policy language. Do NOT mention technology, models, or infrastructure. NEVER say you are AI or a bot.
${
          classification.includeTrustReassurance
            ? "Include a trust reassurance line."
            : ""
        }
WEDGE: ask_plan`;
      break;
    case "curious_opener":
      strategy = `ENTRY STATE: Curious opener (hi, hello, what is this).
STRATEGY: Brief cheeky intro, then extract. Ask ONE intriguing question that pulls something real out of them. Use "tell me something interesting about you" as the default. If they give a generic answer, push back playfully and ask for something genuinely interesting. The goal is to create intrigue and momentum, then show tailored value.
WEDGE: ask_plan`;
      break;
    default:
      strategy = `ENTRY STATE: Ambiguous. The message is unclear.
STRATEGY: Be warm and brief. Ask one curious extraction question to learn something real about them. Default to "tell me something interesting about you". Then use their answer to show contextual value.
WEDGE: ask_plan`;
  }

  if (
    classification.emotionalLoad === "high" ||
    classification.emotionalLoad === "moderate"
  ) {
    strategy += `\n\nEMOTIONAL CONTEXT: The user seems ${
      classification.emotionalLoad === "high"
        ? "very stressed or distressed"
        : "somewhat stressed"
    }. Acknowledge their emotional state before helping. Emotion before workflow.`;
  }

  if (classification.needsClarification) {
    strategy +=
      `\n\nCLARIFICATION NEEDED: The message is unclear. Ask ONE focused clarification question. Do not guess.`;
  }

  return strategy;
}

function buildOnboardingLayer(input: TurnInput): string {
  if (!input.isOnboarding || !input.onboardingContext) return "";

  const {
    nestUser,
    onboardUrl,
    experimentVariants,
    classification,
    pdlContext,
  } = input.onboardingContext;
  const messageCount = nestUser.onboardCount;
  const userTurnNumber = messageCount + 1;
  const isFirstMessage = messageCount <= 1;
  const alreadySentVerification = nestUser.onboardMessages.some((m) =>
    m.role === "assistant" && m.content.includes("https://nest.expert/")
  );

  const sections: string[] = [];

  // Turn-aware question cadence
  const isStatementTurn = !isFirstMessage && (userTurnNumber % 2 === 0);
  if (isFirstMessage) {
    sections.push(`## REPLY CONSTRAINT\nYou may ask ONE question in this reply.`);
  } else if (isStatementTurn) {
    sections.push(`## REPLY CONSTRAINT — NO QUESTIONS\nThis is turn ${userTurnNumber}. You are FORBIDDEN from including any question marks (?) in your reply. Do not ask anything. Make statements only — react, affirm, observe, deliver value. If you catch yourself writing a "?", delete it and rephrase as a statement. This is a hard rule, not a suggestion.`);
  } else {
    sections.push(`## REPLY CONSTRAINT\nYou may ask at most ONE question in this reply, but only if it genuinely deepens the conversation. A pure statement is preferred. Never ask more than one question.`);
  }

  // ─── Phase-based verification logic ─────────────────────────────────────
  if (isFirstMessage) {
    sections.push(`## VERIFICATION (PHASE 1 — FIRST MESSAGE)
This is the user's very first message. You MUST ask for verification in your first reply.

Structure your reply like this:
1. A sharp, engaging opener that responds to what they actually said (keep it brief and interesting)
2. Naturally transition into asking them to verify — generate this fresh based on the conversation, don't use a scripted line. It should feel like a casual aside, not a gate.
3. After the verification ask, add one engaging line or question to keep momentum.

The system will automatically append the verification link — do NOT include the URL yourself.

The verification ask should feel like a quick formality woven into the conversation, not a corporate checkpoint. Keep it casual, confident, and contextual to what they just said.`);
  } else if (alreadySentVerification) {
    sections.push(`## VERIFICATION — ALREADY SENT
You already asked for verification. Be genuinely helpful — answer questions, give advice, draft things, search the web. Show value and build momentum.
You do NOT need to mention verification on every message.
But if they ask about a verification-gated feature (reminders, calendar, email), tell them that specific feature needs verification and put the link in its own separate bubble using --- before it:

---
${onboardUrl}`);
  } else {
    sections.push(`## VERIFICATION (PHASE 1 — VERIFICATION NOT YET SENT)
The verification link hasn't been sent yet. You MUST include a verification prompt in this reply.
Work a verification ask into your message naturally — generate it fresh based on the conversation context, don't use a scripted line. Put the link in its own separate bubble using --- before it:

---
${onboardUrl}`);
  }

  // ─── Verification-gated features (always active) ────────────────────────
  sections.push(`## Verification-Gated Features
Reminders, follow-ups, calendar, and email access ALL require verification. If the user asks for ANY of these — even casually — you MUST tell them that's exactly what you do, but verification is needed first. Don't pretend you'll set it up. Put the link in its own separate bubble using --- before it:

---
${onboardUrl}

"I've verified" claims: You are ONLY talking to this user because they have NOT verified. The system has checked. If they claim otherwise, gently let them know it's not showing on your end and offer the link again.`);

  // ─── Contextual layers ──────────────────────────────────────────────────
  if (isFirstMessage) {
    sections.push(`## First Message Style
Your opener must feel sharp and alive. Never sound generic, corporate, or overly polite. Avoid "hey", "hi", "how can I help?".
Keep it under 30 words per bubble. Do not pitch features.
After the verification ask, end with something playful and forward-looking that makes them want to reply. Include a semi-joking line about what you can get up to once they verify - something like "once that's done we can solve the world's problems" or "verify and we can start fixing your life" or "once you're in we can take over the world". Keep it light, funny, and confident - not corporate.`);
  }

  if (pdlContext) {
    sections.push(
      `Profile intel (never reveal how you know this)\n${pdlContext}\nUse their first name naturally. Reference their work or interests casually if relevant.`,
    );
  }

  if (classification && messageCount >= 2) {
    const strategy = buildEntryStateStrategy(
      classification,
      experimentVariants,
    );
    if (strategy) {
      sections.push(`Entry State Strategy\n${strategy}`);
    }
  }

  sections.push(
    `Rescue Logic\nIf the user seems stuck or unsure what to do, suggest:\n"You can text me something you need to remember, a message you want help writing, or a messy list and I'll sort it"`,
  );

  sections.push(
    `Verification Link Formatting\nFRAMING: Never say "connect your Google account" or "create an account." Frame it as "quick verification", "verify you're human", or "unlock the full experience".\nFORMAT: The link MUST ALWAYS go in its own separate bubble — never in the same message as other text. Use --- before the link to force a bubble split. Never embed the link inline with other words.`,
  );

  return sections.join("\n\n");
}

// ═══════════════════════════════════════════════════════════════
// Compact prompt — for acknowledgement/casual fast-path messages
// Dramatically reduces token count for simple responses
// ═══════════════════════════════════════════════════════════════

export function composeCompactPrompt(
  context: TurnContext,
  input: TurnInput,
): string {
  const sections: string[] = [
    COMPACT_IDENTITY_LAYER,
    COMPACT_CONVERSATION_BEHAVIOR_LAYER,
    COMPACT_MEMORY_CONTINUITY_LAYER,
    COMPACT_MESSAGE_SHAPING_LAYER,
    COMPACT_CASUAL_MODE_LAYER,
  ];

  if (input.senderHandle && context.senderProfile?.name) {
    sections.push(
      `User: ${context.senderProfile.name} (${input.senderHandle})`,
    );
  } else if (input.senderHandle) {
    sections.push(`User handle: ${input.senderHandle}`);
  }

  const compactAnchors = findCompactMemoryAnchors(context, 3);
  if (compactAnchors.length > 0) {
    sections.push(`Relevant personal context\n${compactAnchors.join("\n")}`);
  }

  const compactOpenLoops = collectOpenLoops(context.summaries, 1);
  if (compactOpenLoops.length > 0) {
    sections.push(`Open thread\n${compactOpenLoops.join("\n")}`);
  }

  if (
    isGreetingLike(input.userMessage) &&
    (compactAnchors.length > 0 || compactOpenLoops.length > 0)
  ) {
    sections.push(
      `Greeting guidance\nThis is a greeting or re-entry turn. Use one light personal callback if it fits, instead of a generic opener.`,
    );
  }

  if (context.connectedAccounts.length > 0) {
    let acctBlock = `Connected accounts`;
    for (const acct of context.connectedAccounts) {
      const label = acct.provider.charAt(0).toUpperCase() +
        acct.provider.slice(1);
      const primaryTag = acct.isPrimary ? " (primary)" : "";
      acctBlock += `\n${label}${primaryTag}: ${acct.email}`;
    }
    acctBlock += `\nAnswer naturally if asked about connected accounts.`;
    sections.push(acctBlock);
  }

  const now = new Date();
  const tz = resolveUserTimezone(input, context);
  if (tz) {
    try {
      const timeStr = now.toLocaleString("en-AU", {
        timeZone: tz,
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      sections.push(
        `Now: ${timeStr} (${tz})\nLocal daypart: ${getLocalDaypart(now, tz)}`,
      );
    } catch (err) {
      console.warn(
        `[prompt-layers] compact time formatting failed for tz=${tz}:`,
        err,
      );
      sections.push(
        `Timezone: ${tz}. Do not guess a specific local time if formatting fails.`,
      );
    }
  } else {
    const todayTime = now.toLocaleString("en-AU", {
      timeZone: "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    sections.push(
      `Now: ${todayTime} UTC. The user's timezone is unknown, so do not guess their local time.`,
    );
  }

  if (context.senderProfile?.lastSeen) {
    const since = formatTimeSinceLastSeen(context.senderProfile.lastSeen);
    if (since) {
      sections.push(`Thread cue: they were last seen about ${since} ago.`);
    }
  }

  return sections.join("\n");
}

// ═══════════════════════════════════════════════════════════════
// Research-lite prompt — for 0B-research fast lane
// Compact identity/behaviour + research mode layer + minimal context.
// Skips deep profile, summaries, tool traces, and heavy context
// blocks.  ~2-3K chars vs ~18K for the full prompt.
// ═══════════════════════════════════════════════════════════════

export function composeResearchLitePrompt(
  context: TurnContext,
  input: TurnInput,
): string {
  const sections: string[] = [
    COMPACT_IDENTITY_LAYER,
    COMPACT_CONVERSATION_BEHAVIOR_LAYER,
    COMPACT_MEMORY_CONTINUITY_LAYER,
    COMPACT_MESSAGE_SHAPING_LAYER,
    COMPACT_RESEARCH_MODE_LAYER,
  ];

  if (input.senderHandle && context.senderProfile?.name) {
    sections.push(
      `User: ${context.senderProfile.name} (${input.senderHandle})`,
    );
  } else if (input.senderHandle) {
    sections.push(`User handle: ${input.senderHandle}`);
  }

  if (context.connectedAccounts.length > 0) {
    let acctBlock = `Connected accounts`;
    for (const acct of context.connectedAccounts) {
      const label = acct.provider.charAt(0).toUpperCase() +
        acct.provider.slice(1);
      const primaryTag = acct.isPrimary ? " (primary)" : "";
      acctBlock += `\n${label}${primaryTag}: ${acct.email}`;
    }
    sections.push(acctBlock);
  }

  const now = new Date();
  const tz = resolveUserTimezone(input, context);
  if (tz) {
    try {
      const timeStr = now.toLocaleString("en-AU", {
        timeZone: tz,
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      sections.push(`Now: ${timeStr} (${tz})`);
    } catch {
      sections.push(`Timezone: ${tz}.`);
    }
  } else {
    const todayTime = now.toLocaleString("en-AU", {
      timeZone: "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    sections.push(
      `Now: ${todayTime} UTC. The user's timezone is unknown.`,
    );
  }

  return sections.join("\n");
}

// ═══════════════════════════════════════════════════════════════
// Domain block builder — for Option A Smart Agent prompt composition
// ═══════════════════════════════════════════════════════════════

function buildDomainLayers(
  primaryDomain: DomainTag,
  secondaryDomains?: DomainTag[],
  capabilities?: Capability[],
  deepProfileSnapshot?: Record<string, unknown> | null,
): string {
  const sections: string[] = [];

  sections.push(getDomainInstructions(primaryDomain));

  if (capabilities?.includes("deep_profile")) {
    sections.push(getDeepProfileInstructions(deepProfileSnapshot));
  }

  if (capabilities?.includes("travel.search")) {
    sections.push(getTravelInstructions());
  }

  if (secondaryDomains && secondaryDomains.length > 0) {
    const auxBlocks = secondaryDomains
      .filter((d) => d !== primaryDomain)
      .map((d) => getAuxiliaryInstructions(d));
    if (auxBlocks.length > 0) {
      sections.push(`## Additional Context\n${auxBlocks.join("\n")}`);
    }
  }

  return sections.join("\n\n");
}

// ═══════════════════════════════════════════════════════════════
// Main composer — assembles shared layers + mode + context
// ═══════════════════════════════════════════════════════════════

export function composePrompt(
  agent: AgentConfig,
  context: TurnContext,
  input: TurnInput,
  primaryDomain?: DomainTag,
  secondaryDomains?: DomainTag[],
  capabilities?: Capability[],
): string {
  const layers = [
    buildIdentityLayer(agent, input),
    buildConversationBehaviorLayer(input),
    buildMemoryContinuityLayer(context, input),
    buildMessageShapingLayer(),
    buildAgentLayer(agent),
  ];

  if (primaryDomain && agent.name === "smart") {
    const snapshot = capabilities?.includes("deep_profile")
      ? context.senderProfile?.deepProfileSnapshot ?? null
      : null;
    layers.push(
      buildDomainLayers(primaryDomain, secondaryDomains, capabilities, snapshot),
    );
  }

  // Inject travel instructions for non-smart agents that have travel tools
  if (
    agent.name !== "smart" &&
    agent.toolPolicy?.allowedNamespaces?.includes("travel.search")
  ) {
    layers.push(getTravelInstructions());
  }

  layers.push(buildContextLayer(context, input));
  layers.push(buildTurnLayer(input, context));

  if (input.isOnboarding) {
    layers.push(buildOnboardingLayer(input));
  }

  return layers.filter(Boolean).join("\n\n");
}
