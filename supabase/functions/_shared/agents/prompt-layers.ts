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
  getWeatherInstructions,
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
  memories: 600,
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

function buildIdentityLayer(_agent: AgentConfig, input: TurnInput): string {
  if (input.isOnboarding) {
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
      "Style cue\nThe user is writing in lowercase. Still use normal sentence case: capitalise the first letter of every sentence and every message bubble. Keep the tone casual — do not mirror all-lowercase in your own messages.",
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

function formatResolvedLocation(
  location: NonNullable<
    NonNullable<TurnContext["resolvedUserContext"]>["assumedLocation"]
  >,
): string {
  return `${location.label} (${location.role}, ${location.confidence} confidence, ${location.precision})`;
}

function buildResolvedLocalContextBlock(
  context: TurnContext,
  mode: "compact" | "research" | "full",
): string {
  const resolved = context.resolvedUserContext;
  if (!resolved) return "";

  const lines: string[] = [];
  if (resolved.currentLocation) {
    lines.push(`Current location: ${formatResolvedLocation(resolved.currentLocation)}`);
  }
  if (
    resolved.homeLocation &&
    (!resolved.currentLocation ||
      resolved.homeLocation.label !== resolved.currentLocation.label)
  ) {
    lines.push(`Home location: ${formatResolvedLocation(resolved.homeLocation)}`);
  }
  if (resolved.workLocation) {
    lines.push(`Work location: ${formatResolvedLocation(resolved.workLocation)}`);
  }
  if (resolved.dietaryPreferences.length > 0) {
    lines.push(
      `Dietary preferences: ${resolved.dietaryPreferences.join(", ")}.`,
    );
  }

  const policyText = resolved.assumptionPolicy === "direct"
    ? "use it without asking first"
    : resolved.assumptionPolicy === "soft_assumption"
    ? "use it, but phrase it as a light assumption"
    : "ask before relying on it";
  if (resolved.assumedLocation) {
    lines.push(
      `Assumed location for low-risk local questions: ${resolved.assumedLocation.label}.`,
    );
  } else {
    lines.push("No safe assumed location is available for this prompt.");
  }
  lines.push(`Policy: ${resolved.assumptionPolicy} — ${policyText}.`);

  if (mode !== "compact") {
    lines.push(
      "For weather, nearby places, opening hours, and local events, use the assumed location above rather than asking where the user is.",
    );
    lines.push(
      "For exact routes, address-specific availability, or jurisdiction-sensitive questions, clarify if the required precision is missing.",
    );
    lines.push(
      "If the user mentions work or the office and a work location exists, use that work location first.",
    );
    lines.push(
      "For food or restaurant recommendations, respect any dietary preferences listed above.",
    );
  }

  return `Resolved local context\n${lines.join("\n")}`;
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
  const resolvedLocations = [
    context?.resolvedUserContext?.currentLocation?.label,
    context?.resolvedUserContext?.homeLocation?.label,
    context?.resolvedUserContext?.assumedLocation?.label,
  ].filter(Boolean) as string[];
  for (const location of resolvedLocations) {
    const inferred = inferTimezoneFromLocationLabel(location);
    if (inferred) return inferred;
  }
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
  } else if (context.resolvedUserContext?.assumedLocation) {
    cues.push(
      `Location anchors: ${context.resolvedUserContext.assumedLocation.label}`,
    );
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

  const resolvedLocalContextBlock = buildResolvedLocalContextBlock(
    context,
    "full",
  );
  if (resolvedLocalContextBlock) {
    sections.push(resolvedLocalContextBlock);
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

function inferTimezoneFromLocationLabel(locationLabel: string): string | null {
  const val = locationLabel.toLowerCase().trim();
  for (const [key, tz] of Object.entries(LOCATION_TZ_MAP)) {
    if (val.includes(key)) return tz;
  }
  return null;
}

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
    const inferred = inferTimezoneFromLocationLabel(item.valueText);
    if (inferred) return inferred;
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
      `Group Chat Context\nYou're in a group chat called ${chatName} with these participants: ${participants}\n\nIn group chats: address people by name when responding to them specifically. Be aware others can see your responses. Keep responses even shorter since group chats move fast. Dont react as often in groups, it can feel spammy.\n\nWhen the group is busy (multiple people chatting), your reply is automatically sent as a threaded reply to the message that triggered you. The recipient already sees which message you're responding to, so don't re-quote or re-reference it; just respond directly.`,
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
  _experimentVariants: Record<string, string>,
): string {
  let strategy = "";

  switch (classification.entryState) {
    case "direct_task_opener":
      strategy =
        `ENTRY STATE: Direct task.
STRATEGY: Help them immediately. No preamble.`;
      break;
    case "drafting_opener":
      strategy =
        `ENTRY STATE: Drafting request.
STRATEGY: Ask 1-2 focused questions ONLY if genuinely needed (who's it for, what tone). Then deliver a usable draft.`;
      break;
    case "overwhelm_opener":
      strategy = `ENTRY STATE: Overwhelm. They're stressed.
STRATEGY: Acknowledge briefly and genuinely. Then help them structure what's on their mind.`;
      break;
    case "referral_opener":
      strategy = `ENTRY STATE: Referral. Someone told them about you.
STRATEGY: Acknowledge warmly and briefly. Let them lead. If they don't have a task, just be easy to talk to.`;
      break;
    case "trust_opener":
      strategy =
        `ENTRY STATE: Trust/skepticism. They want to know who you are.
STRATEGY: One confident, brief line about who you are. Don't over-explain or get defensive. Let your next reply prove it.
${
          classification.includeTrustReassurance
            ? "Include a brief trust reassurance if it fits naturally."
            : ""
        }`;
      break;
    case "curious_opener":
      strategy = `ENTRY STATE: Curious opener (hi, hello, what is this).
STRATEGY: Brief cheeky intro. Let them steer the conversation next.`;
      break;
    default:
      strategy = `ENTRY STATE: Ambiguous.
STRATEGY: Be warm, brief, and easy to talk to. Respond to what they actually said.`;
  }

  if (
    classification.emotionalLoad === "high" ||
    classification.emotionalLoad === "moderate"
  ) {
    strategy += `\n\nEMOTIONAL CONTEXT: The user seems ${
      classification.emotionalLoad === "high"
        ? "very stressed or distressed"
        : "somewhat stressed"
    }. Acknowledge their emotional state before anything else.`;
  }

  if (classification.needsClarification) {
    strategy +=
      `\n\nCLARIFICATION NEEDED: The message is unclear. Ask ONE focused clarification question.`;
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

  // Question cadence — keep it natural, not mechanical
  if (isFirstMessage) {
    sections.push(`## REPLY CONSTRAINT\nYou may ask at most ONE question, and only if it flows naturally from what they said. A statement that lands well is always better than a forced question.`);
  } else {
    sections.push(`## REPLY CONSTRAINT\nDo NOT ask questions unless they flow directly from what the user just said. Never ask unprompted "get to know you" questions like "what's on your plate" or "what's keeping you busy" or "tell me something about yourself." If the conversation is flowing, just keep it flowing. If they ask you something, answer it. If they react positively, match their energy and let them lead. A reply that just lands is better than one that forces a question. Maximum one question per reply, and only when genuinely needed.`);
  }

  // ─── Phase-based verification logic ─────────────────────────────────────
  const isVeryFirstMessage = messageCount === 0;
  if (isVeryFirstMessage) {
    sections.push(`## FIRST MESSAGE: PURE ENGAGEMENT
This is the user's very first message to Nest. Do NOT mention verification, links, signing up, or any kind of setup. Zero onboarding friction.

Your only job is to:
1. Name yourself as Nest once, naturally in the reply (e.g. "Hey, Nest here" / "I'm Nest," / "Nest.") so it is unmistakably Nest texting back, not a generic service.
2. Respond to what they actually said: sharp, a little cheeky, genuinely engaging; avoid bland or corporate openers.
3. Show personality and make them feel like they've found something interesting.
4. End in a way that makes them want to text back. A confident statement, a light tease, or a playful observation. Do NOT default to ending with a question. If a question fits naturally, fine, but a reply that just lands is stronger than one that interrogates.

This is a first impression. Make it count. No gates, no asks, just chemistry.
Never call yourself an assistant, AI, chatbot, bot, or similar. You are Nest. Never use em dashes in your messages.
Do not mention verification or links on this first reply; the link is only sent when they ask later (or after message 20).`);
  } else if (alreadySentVerification) {
    sections.push(`## VERIFICATION: LINK MAY ALREADY BE IN THE THREAD
They may already have the verification link in an earlier bubble. Be genuinely helpful: answer questions, give advice, draft things, search the web.
Do NOT proactively push verification or links. If they ask how to verify or for the link, the system will append the URL in that reply.
If they ask about reminders, calendar, or email, explain that needs verification first; tell them they can ask for the link whenever they are ready.`);
  } else {
    sections.push(`## VERIFICATION: ON REQUEST ONLY (NO PROACTIVE NUDGE)
Do NOT ask them to verify or pitch verification unless they hit a gated feature (reminders, calendar, email) or they explicitly ask about signing up / verifying.
Focus on chemistry and usefulness. Never promise "the system will send a link" unless they have just asked how to verify; the link is only sent when they ask (or after message 20).
Do NOT include any URL yourself.`);
  }

  // ─── Verification-gated features (always active) ────────────────────────
  if (isVeryFirstMessage) {
    sections.push(`## Verification-Gated Features
Reminders, follow-ups, calendar, and email access require verification. If the user asks for ANY of these on this first message, tell them that's exactly what you do but they'll need to verify first. Do not include a link; they can ask for the link when ready (the system sends it only when they ask, or after message 20).

"I've verified" claims: You are ONLY talking to this user because they have NOT verified. The system has checked. If they claim otherwise, gently let them know it's not showing on your end.`);
  } else {
    sections.push(`## Verification-Gated Features
Reminders, follow-ups, calendar, and email access ALL require verification. If the user asks for ANY of these, even casually, you MUST tell them that's exactly what you do, but verification is needed first. Don't pretend you'll set it up.
Do NOT include any URL yourself. The system sends the verification link only when they explicitly ask how to verify / for the link (or after message 20). Invite them to ask if they want the link.

"I've verified" claims: You are ONLY talking to this user because they have NOT verified. The system has checked. If they claim otherwise, gently let them know it's not showing on your end.`);
  }

  // ─── Contextual layers ──────────────────────────────────────────────────
  if (isVeryFirstMessage) {
    sections.push(`## First Message Style
Your opener must feel sharp and alive: cheeky, human, a bit bold. Never sound generic, corporate, or customer-service ("how can I help", "what can I do for you"). Do not open with only "hey"/"hi" with nothing else; if you greet, pair it with substance or wit immediately.
Keep it under 30 words per bubble. Do not pitch features or capabilities.
End in a way that makes them want to text back, but do NOT end with a forced question. A confident statement or a light tease works better than "so what can I help you with?" Channel "you found Nest" energy without being try-hard.`);
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
    `Rescue Logic\nIf the user seems genuinely stuck or asks what you can do, give ONE concrete example relevant to the conversation so far. Never list capabilities unprompted. Never pitch.`,
  );

  sections.push(
    `Verification Framing\nNever say "connect your Google account" or "create an account." Frame it as "quick verification", "verify you're human", or "unlock the full experience". Never include any URL or link in your message. Do not say a link is being sent unless they have asked for it; the system appends the link only when they ask (or after message 20).`,
  );

  sections.push(`## Hard Limits (NEVER possible, even after verification)
BOOKING: Cannot book flights, hotels, restaurants, or appointments. Can find options and help compare.
CALLING: Cannot make or receive phone calls. Can help draft a message or find a number.
REAL-TIME MONITORING: Cannot watch for events or trigger alerts. Can search for the latest info right now.
PURCHASES: Cannot buy anything or process payments.
Never promise a capability you don't have. Never imply future capability. Redirect to what you CAN do.`);

  sections.push(`## Edge Cases
If they say no or "not interested" or "stop": back off gracefully.
If they swear: match their energy naturally.
If they ask if you're a bot or AI: "I'm Nest. Try me with something and see." (Never expand into assistant/AI framing.)
If they ask what you cost: "don't worry about that right now, just try me out"
If they ask about privacy: "your messages are encrypted and I don't share your data with anyone. you're in control, ask me to forget anything anytime"`);

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

  const compactResolvedContext = buildResolvedLocalContextBlock(
    context,
    "compact",
  );
  if (compactResolvedContext) {
    sections.push(compactResolvedContext);
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

  const compactAnchors = findCompactMemoryAnchors(context, 3);
  if (compactAnchors.length > 0) {
    sections.push(`Relevant personal context\n${compactAnchors.join("\n")}`);
  }

  const resolvedLocalContext = buildResolvedLocalContextBlock(
    context,
    "research",
  );
  if (resolvedLocalContext) {
    sections.push(resolvedLocalContext);
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

  if (capabilities?.includes("weather.search")) {
    sections.push(getWeatherInstructions());
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

  // Inject weather instructions for non-smart agents that have weather tools
  if (
    agent.name !== "smart" &&
    agent.toolPolicy?.allowedNamespaces?.includes("weather.search")
  ) {
    layers.push(getWeatherInstructions());
  }

  layers.push(buildContextLayer(context, input));
  layers.push(buildTurnLayer(input, context));

  if (input.isOnboarding) {
    layers.push(buildOnboardingLayer(input));
  }

  return layers.filter(Boolean).join("\n\n");
}
