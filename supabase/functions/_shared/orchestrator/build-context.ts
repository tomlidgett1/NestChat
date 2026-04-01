import type { InputContentPart, InputMessage } from "../ai/models.ts";
import type {
  ContextSubTimings,
  ConversationSummary,
  LocationConfidence,
  LocationPrecision,
  LocationRole,
  MemoryItem,
  ResolvedLocationContext,
  ResolvedUserContext,
  StoredMessage,
  ToolTrace,
  TurnContext,
  TurnInput,
} from "./types.ts";
import { emptyWorkingMemory } from "./types.ts";
import { MEMORY_V2_ENABLED } from "../env.ts";
import type { UserProfile } from "../state.ts";
import { resolveUserContextForMessage } from "../user-context.ts";

import { formatRelativeTime } from "../utils/format.ts";
import { loadWorkingMemory } from "./working-memory.ts";

// ═══════════════════════════════════════════════════════════════
// History formatting
// ═══════════════════════════════════════════════════════════════

function formatToolNotes(
  metadata: Record<string, unknown> | undefined,
): string {
  if (!metadata) return "";
  const tools = metadata.tools_used as
    | Array<{ tool: string; detail?: string }>
    | undefined;
  if (!tools || tools.length === 0) return "";
  return " " + tools.map((t) => `[${t.tool}]`).join(" ");
}

function formatHistory(
  messages: StoredMessage[],
  isGroupChat: boolean,
): InputMessage[] {
  return messages.map((message) => {
    const timeTag = formatRelativeTime(message.createdAt);
    const toolNotes = message.role === "assistant"
      ? formatToolNotes(message.metadata)
      : "";
    let content = message.content;

    if (isGroupChat && message.role === "user" && message.handle) {
      content = `[${message.handle}]: ${content}`;
    }

    if (timeTag && message.role === "user") {
      content = `[${timeTag}] ${content}`;
    }

    if (toolNotes) {
      content = `${content}${toolNotes}`;
    }

    return { role: message.role as "user" | "assistant", content };
  });
}

type ResolvedLocationCandidate = ResolvedLocationContext & { score: number };

const LOCATION_CATEGORY_HINTS = [
  "location",
  "city",
  "country",
  "home",
  "hometown",
  "address",
  "lives",
  "based",
] as const;

const CURRENT_LOCATION_PATTERNS = [
  /\b(currently|right now|at the moment|for now)\b/i,
  /\b(staying|visiting|in town|travelling|traveling|back in)\b/i,
  /\b(this week|this month|today|tonight)\b/i,
];

const FREQUENT_LOCATION_PATTERNS = [
  /\b(often|usually|regularly|frequently)\b/i,
  /\b(work in|office in|weekends in|family in|parents in)\b/i,
];

const STREET_ADDRESS_PATTERN =
  /\b\d{1,5}\s+[\w'.-]+\s+(street|st|road|rd|avenue|ave|boulevard|blvd|drive|dr|lane|ln|way|place|pl|court|ct|crescent|cr|parade|pde|highway|hwy|circuit)\b/i;
const STATE_OR_REGION_PATTERN =
  /\b(vic|victoria|nsw|new south wales|qld|queensland|wa|western australia|sa|south australia|tas|tasmania|act|nt|california|new york|texas|england|scotland|wales)\b/i;
const SUBURB_HINT_PATTERN =
  /\b(cbd|suburb|district|neighbourhood|neighborhood|borough|shire)\b/i;

const KNOWN_LOCATION_PRECISIONS: LocationPrecision[] = [
  "unknown",
  "timezone_region",
  "country",
  "state",
  "city",
  "suburb",
  "address",
];
const KNOWN_LOCATION_ROLES: LocationRole[] = [
  "home",
  "current",
  "frequent",
  "regional",
];

function isLocationCategory(category: string): boolean {
  const lower = category.toLowerCase();
  return LOCATION_CATEGORY_HINTS.some((hint) => lower.includes(hint));
}

function normaliseLocationLabel(value: string): string {
  const cleaned = value
    .replace(
      /^(?:lives?|living|based|home(?:town)?(?:\s+is)?|currently(?:\s+based)?|staying|visiting|travelling|traveling|moved|move|works?\s+in|office\s+in|usually|often|regularly|frequently|from)\s+(?:in|at|to)?\s*/i,
      "",
    )
    .replace(
      /\b(right now|at the moment|for now|this week|this month|today|tonight)\b/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .replace(/^[,:\-\s]+|[,:\-\s]+$/g, "")
    .trim();
  return cleaned || value.trim();
}

function readStringMeta(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function inferLocationRole(
  value: string,
  metadata?: Record<string, unknown>,
): LocationRole {
  const metaRole = readStringMeta(metadata, "role")?.toLowerCase();
  if (
    metaRole &&
    KNOWN_LOCATION_ROLES.includes(metaRole as LocationRole)
  ) {
    return metaRole as LocationRole;
  }
  if (CURRENT_LOCATION_PATTERNS.some((pattern) => pattern.test(value))) {
    return "current";
  }
  if (FREQUENT_LOCATION_PATTERNS.some((pattern) => pattern.test(value))) {
    return "frequent";
  }
  return "home";
}

function inferLocationPrecision(
  label: string,
  metadata?: Record<string, unknown>,
): LocationPrecision {
  const metaPrecision = readStringMeta(metadata, "precision")?.toLowerCase();
  if (
    metaPrecision &&
    KNOWN_LOCATION_PRECISIONS.includes(metaPrecision as LocationPrecision)
  ) {
    return metaPrecision as LocationPrecision;
  }
  if (STREET_ADDRESS_PATTERN.test(label)) return "address";
  if (SUBURB_HINT_PATTERN.test(label)) return "suburb";
  if (STATE_OR_REGION_PATTERN.test(label) && label.includes(",")) return "suburb";
  if (STATE_OR_REGION_PATTERN.test(label)) return "state";
  if (label.split(",").length >= 2) return "city";
  if (label.trim().split(/\s+/).length <= 3) return "city";
  return "unknown";
}

function confidenceBucket(score: number): LocationConfidence {
  if (score >= 0.8) return "high";
  if (score >= 0.6) return "medium";
  if (score > 0) return "low";
  return "none";
}

function precisionBonus(precision: LocationPrecision): number {
  switch (precision) {
    case "address":
      return 0.12;
    case "suburb":
      return 0.08;
    case "city":
      return 0.04;
    case "state":
      return -0.04;
    case "country":
    case "timezone_region":
      return -0.08;
    default:
      return 0;
  }
}

function decayLocationScore(
  score: number,
  role: LocationRole,
  lastUpdatedAt: string | null,
): number {
  if (!lastUpdatedAt) {
    return role === "current" ? score - 0.12 : score;
  }

  const ageMs = Date.now() - new Date(lastUpdatedAt).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  const ageDays = ageHours / 24;

  if (role === "current") {
    if (ageHours > 24) return score - 0.22;
    if (ageHours > 8) return score - 0.12;
    return score;
  }

  if (role === "frequent") {
    if (ageDays > 30) return score - 0.15;
    if (ageDays > 7) return score - 0.08;
    return score;
  }

  if (ageDays > 180) return score - 0.08;
  return score;
}

function makeResolvedLocationCandidate(params: {
  label: string;
  role: LocationRole;
  precision: LocationPrecision;
  source: "memory" | "profile" | "timezone";
  explicitness: "explicit" | "inferred" | "fallback";
  memoryId?: number | null;
  lastUpdatedAt?: string | null;
  baseScore: number;
}): ResolvedLocationCandidate {
  const adjustedScore = Math.max(
    0,
    Math.min(
      0.95,
      decayLocationScore(
        params.baseScore + precisionBonus(params.precision),
        params.role,
        params.lastUpdatedAt ?? null,
      ),
    ),
  );

  return {
    label: params.label,
    role: params.role,
    precision: params.precision,
    confidence: confidenceBucket(adjustedScore),
    source: params.source,
    explicitness: params.explicitness,
    memoryId: params.memoryId ?? null,
    lastUpdatedAt: params.lastUpdatedAt ?? null,
    score: adjustedScore,
  };
}

function serialiseResolvedLocation(
  candidate: ResolvedLocationCandidate | null,
): ResolvedLocationContext | null {
  if (!candidate) return null;
  const { score: _score, ...rest } = candidate;
  return rest;
}

function extractLocationCandidatesFromMemories(
  memoryItems: MemoryItem[],
): ResolvedLocationCandidate[] {
  const results: ResolvedLocationCandidate[] = [];

  for (const memory of memoryItems) {
    if (!isLocationCategory(memory.category)) continue;

    const role = inferLocationRole(memory.valueText, memory.metadata);
    const label = normaliseLocationLabel(memory.valueText);
    if (!label) continue;

    results.push(makeResolvedLocationCandidate({
      label,
      role,
      precision: inferLocationPrecision(label, memory.metadata),
      source: "memory",
      explicitness: readStringMeta(memory.metadata, "explicitness") === "inferred"
        ? "inferred"
        : "explicit",
      memoryId: memory.id,
      lastUpdatedAt: memory.lastConfirmedAt ?? memory.lastSeenAt ?? memory.createdAt,
      baseScore: Math.max(0.35, Math.min(0.92, memory.confidence * 0.75 + 0.15)),
    }));
  }

  return results;
}

function extractLocationCandidatesFromProfile(
  senderProfile: UserProfile | null,
): ResolvedLocationCandidate[] {
  if (!senderProfile?.facts?.length) return [];

  return senderProfile.facts
    .filter((fact) =>
      isLocationCategory(fact) ||
      /\b(live|lives|living|based|home|hometown|moved to|move to|from|currently|staying|visiting|travelling|traveling|office in|work in|often|usually|regularly|frequently)\b/i
        .test(fact)
    )
    .map((fact) => {
      const role = inferLocationRole(fact);
      const label = normaliseLocationLabel(fact);
      return makeResolvedLocationCandidate({
        label,
        role,
        precision: inferLocationPrecision(label),
        source: "profile",
        explicitness: "explicit",
        lastUpdatedAt: null,
        baseScore: role === "current" ? 0.7 : 0.78,
      });
    })
    .filter((candidate) => candidate.label.length > 0);
}

function timezoneFallbackCandidate(
  timezone?: string | null,
): ResolvedLocationCandidate | null {
  if (!timezone || !timezone.includes("/")) return null;
  const city = timezone.split("/").pop()?.replace(/_/g, " ").trim();
  if (!city) return null;

  return makeResolvedLocationCandidate({
    label: city,
    role: "regional",
    precision: "timezone_region",
    source: "timezone",
    explicitness: "fallback",
    lastUpdatedAt: null,
    baseScore: 0.48,
  });
}

function pickBestLocation(
  candidates: ResolvedLocationCandidate[],
  roles: LocationRole[],
): ResolvedLocationCandidate | null {
  const filtered = candidates
    .filter((candidate) => roles.includes(candidate.role))
    .sort((a, b) => b.score - a.score);
  return filtered[0] ?? null;
}

function buildResolvedUserContext(
  currentMessage: string,
  memoryItems: MemoryItem[],
  senderProfile: UserProfile | null,
  timezone?: string | null,
): ResolvedUserContext | null {
  return resolveUserContextForMessage(
    currentMessage,
    senderProfile,
    memoryItems,
    timezone,
  );
}

// ═══════════════════════════════════════════════════════════════
// Audio transcription (delegates to OpenAI Whisper)
// ═══════════════════════════════════════════════════════════════

async function transcribeAudio(url: string): Promise<string | null> {
  const t0 = Date.now();
  try {
    const OpenAI = (await import("npm:openai@6.27.0")).default;
    const openai = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY") });

    const response = await fetch(url);
    if (!response.ok) return null;

    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "audio/mp4";
    const blob = new Blob([arrayBuffer], { type: contentType });
    const file = new File([blob], "voice_memo.m4a", { type: contentType });
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1",
    });

    // Estimate audio duration from file size (~16KB/s for compressed audio)
    const estimatedMinutes = Math.max(0.1, arrayBuffer.byteLength / (16_000 * 60));

    // Log Whisper cost (fire-and-forget)
    import("../cost-tracker.ts").then(({ logApiCost, calculateFixedCost }) => {
      import("../supabase.ts").then(({ getAdminClient }) => {
        logApiCost(getAdminClient(), {
          userId: null,
          model: "whisper-1",
          endpoint: "transcription",
          description: `Whisper transcription (~${estimatedMinutes.toFixed(1)} min)`,
          messageType: "voice",
          tokensIn: 0,
          tokensOut: 0,
          costUsdOverride: calculateFixedCost("whisper-per-minute", estimatedMinutes),
          latencyMs: Date.now() - t0,
          metadata: { audio_bytes: arrayBuffer.byteLength, estimated_minutes: estimatedMinutes },
        });
      });
    }).catch(() => {});

    return transcription.text;
  } catch (error) {
    console.error("[build-context] Transcription error:", error);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Message content assembly (images, audio, text)
// ═══════════════════════════════════════════════════════════════

interface MessageContentResult {
  messageContent: InputContentPart[];
  transcriptions: string[];
  transcriptionFailed: boolean;
  textToSend: string;
}

async function buildMessageContent(
  input: TurnInput,
): Promise<MessageContentResult> {
  const messageContent: InputContentPart[] = [];

  for (const image of input.images) {
    messageContent.push({
      type: "input_image",
      image_url: image.url,
    });
  }

  const transcriptions: string[] = [];
  let transcriptionFailed = false;
  for (const audioFile of input.audio) {
    const transcript = await transcribeAudio(audioFile.url);
    if (transcript) transcriptions.push(transcript);
    else transcriptionFailed = true;
  }

  let textToSend = input.userMessage.trim();
  if (transcriptions.length > 0) {
    const transcriptText = transcriptions.join("\n");
    textToSend = textToSend
      ? `[Voice memo transcript: "${transcriptText}"]\n\n${textToSend}`
      : `[Voice memo transcript: "${transcriptText}"]\n\nRespond naturally to what they said in the voice memo.`;
  } else if (input.audio.length > 0 && transcriptionFailed) {
    textToSend = textToSend ||
      "[Someone sent a voice memo but transcription failed. Let them know you could not hear it and ask them to try again or type their message.]";
  } else if (!textToSend && input.images.length > 0) {
    textToSend = "What's in this image?";
  }

  if (textToSend) {
    messageContent.push({ type: "input_text", text: textToSend });
  }

  return { messageContent, transcriptions, transcriptionFailed, textToSend };
}

// ═══════════════════════════════════════════════════════════════
// Group context builder — privacy firewall: only chat history,
// NO memory, profile, accounts, RAG, summaries, or tool traces
// ═══════════════════════════════════════════════════════════════

export async function buildGroupContext(
  input: TurnInput,
): Promise<ContextBuildResult> {
  const { getConversation, addMessage } = await import("../state.ts");

  const historyP = timed(() => getConversation(input.chatId, 30));
  const messageContentP = timed(() => buildMessageContent(input));

  const [historyT, messageContentT] = await Promise.all([
    historyP,
    messageContentP,
  ]);

  const history = historyT.result;
  const { messageContent, transcriptions, transcriptionFailed, textToSend } =
    messageContentT.result;

  if (textToSend) {
    addMessage(input.chatId, "user", textToSend, input.senderHandle, {
      isGroupChat: true,
      chatName: input.chatName,
      participantNames: input.participantNames,
      service: input.service,
    }).catch((err) =>
      console.warn("[build-context] group addMessage failed:", (err as Error).message)
    );
  }

  const formattedHistory = formatHistory(history, true);
  const recentTurns = history.slice(-6).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const subTimings: ContextSubTimings = {
    historyMs: historyT.ms,
    memoryMs: 0,
    summariesMs: 0,
    toolTracesMs: 0,
    profileMs: 0,
    accountsMs: 0,
    messageContentMs: messageContentT.ms,
    ragMs: 0,
    workingMemoryMs: 0,
    formatHistoryMs: 0,
  };

  console.log(
    `[build-context] GROUP path: history=${historyT.ms}ms msgContent=${messageContentT.ms}ms (no memory/profile/rag/accounts)`,
  );

  return {
    history,
    formattedHistory,
    messageContent,
    recentTurns,
    memoryItems: [],
    summaries: [],
    toolTraces: [],
    ragEvidence: "",
    ragEvidenceBlockCount: 0,
    senderProfile: null,
    connectedAccounts: [],
    transcriptions,
    transcriptionFailed,
    workingMemory: emptyWorkingMemory(),
    pendingEmailSend: null,
    pendingEmailSends: [],
    resolvedUserContext: null,
    subTimings,
  };
}

// ═══════════════════════════════════════════════════════════════
// Router context — lightweight fetch for routing decisions only
// ═══════════════════════════════════════════════════════════════

export interface RouterContext {
  recentTurns: Array<{ role: string; content: string }>;
  workingMemory: import("./types.ts").WorkingMemory;
  pendingEmailSend: import("../state.ts").PendingEmailSendAction | null;
  pendingEmailSends: import("../state.ts").PendingEmailSendAction[];
  preloadedHistory?: StoredMessage[];
  preloadedProfile?: import("../state.ts").UserProfile | null;
  preloadedAccounts?: import("../state.ts").ConnectedAccount[];
}

export async function buildRouterContext(
  input: TurnInput,
): Promise<RouterContext> {
  const {
    getConversation,
    getLatestPendingEmailSend,
    getPendingEmailSends,
    getUserProfile,
    getConnectedAccounts,
  } = await import("../state.ts");

  const historyP = getConversation(input.chatId);
  const workingMemoryP = input.isGroupChat
    ? Promise.resolve(emptyWorkingMemory())
    : loadWorkingMemory(input.chatId).then((wm) => wm ?? emptyWorkingMemory());
  const pendingEmailSendP = input.isGroupChat
    ? Promise.resolve(null)
    : getLatestPendingEmailSend(input.chatId);
  const pendingEmailSendsP = input.isGroupChat
    ? Promise.resolve([] as import("../state.ts").PendingEmailSendAction[])
    : getPendingEmailSends(input.chatId);

  const profileP = !input.isGroupChat && input.senderHandle
    ? getUserProfile(input.senderHandle)
    : Promise.resolve(null);
  const accountsP = !input.isGroupChat && input.authUserId
    ? getConnectedAccounts(input.authUserId)
    : Promise.resolve(
      [] as import("../state.ts").ConnectedAccount[],
    );

  const [
    history,
    workingMemory,
    pendingEmailSend,
    pendingEmailSends,
    profile,
    accounts,
  ] = await Promise.all([
    historyP,
    workingMemoryP,
    pendingEmailSendP,
    pendingEmailSendsP,
    profileP,
    accountsP,
  ]);

  const recentTurns = history.slice(-6).map((m) => {
    let content = m.content;
    if (m.role === "assistant" && m.metadata) {
      const tools = m.metadata.tools_used as
        | Array<{ tool: string; detail?: string }>
        | undefined;
      if (tools && tools.length > 0) {
        content += " " + tools.map((t) => `[${t.tool}]`).join(" ");
      }
    }
    return { role: m.role, content };
  });

  return {
    recentTurns,
    workingMemory,
    pendingEmailSend,
    pendingEmailSends,
    preloadedHistory: history,
    preloadedProfile: profile,
    preloadedAccounts: accounts,
  };
}

// ═══════════════════════════════════════════════════════════════
// Full context builder — parallel fetches for all data sources
// Accepts pre-fetched router context to avoid duplicate work
// ═══════════════════════════════════════════════════════════════

export interface ContextBuildResult extends TurnContext {
  subTimings: ContextSubTimings;
}

interface MemoryFetchResult {
  result: MemoryItem[];
  ms: number;
  detail: {
    activeItemsMs: number;
    semanticLookupMs: number;
    embeddingMs: number;
    vectorSearchMs: number;
    scoringMs: number;
    semanticSkipped: boolean;
  } | null;
}

function buildMemoryTimingFields(
  detail: MemoryFetchResult["detail"],
): Partial<ContextSubTimings> {
  if (!detail) return {};
  return {
    memoryActiveItemsMs: detail.activeItemsMs,
    memorySemanticLookupMs: detail.semanticLookupMs,
    memoryEmbeddingMs: detail.embeddingMs,
    memoryVectorSearchMs: detail.vectorSearchMs,
    memoryScoringMs: detail.scoringMs,
    memorySemanticSkipped: detail.semanticSkipped,
  };
}

// ═══════════════════════════════════════════════════════════════
// Lightweight context builder — for casual / acknowledgement
// messages where we skip RAG, memory, summaries, tool traces
// ═══════════════════════════════════════════════════════════════

export async function buildLightContext(
  input: TurnInput,
  routerCtx?: RouterContext,
): Promise<ContextBuildResult> {
  const hasPreloadedHistory = routerCtx?.preloadedHistory !== undefined;
  const hasPreloadedProfile = routerCtx?.preloadedProfile !== undefined;
  const hasPreloadedAccounts = routerCtx?.preloadedAccounts !== undefined;

  const {
    getConversation,
    getUserProfile,
    getConnectedAccounts,
    getLatestPendingEmailSend,
    getPendingEmailSends,
  } = await import("../state.ts");

  const historyP = hasPreloadedHistory
    ? Promise.resolve({ result: routerCtx!.preloadedHistory!, ms: 0 })
    : timed(() => getConversation(input.chatId));
  const profileP = hasPreloadedProfile
    ? Promise.resolve({ result: routerCtx!.preloadedProfile!, ms: 0 })
    : input.senderHandle
    ? timed(() => getUserProfile(input.senderHandle))
    : Promise.resolve({ result: null, ms: 0 });
  const accountsP = hasPreloadedAccounts
    ? Promise.resolve({ result: routerCtx!.preloadedAccounts!, ms: 0 })
    : input.authUserId
    ? timed(() => getConnectedAccounts(input.authUserId!))
    : Promise.resolve({
      result: [] as import("../state.ts").ConnectedAccount[],
      ms: 0,
    });
  const pendingEmailSendP = timed(() =>
    getLatestPendingEmailSend(input.chatId)
  );
  const pendingEmailSendsP = timed(() => getPendingEmailSends(input.chatId));
  const messageContentP = timed(() => buildMessageContent(input));

  const [
    historyT,
    profileT,
    accountsT,
    pendingEmailSendT,
    pendingEmailSendsT,
    messageContentT,
  ] = await Promise.all([
    historyP,
    profileP,
    accountsP,
    pendingEmailSendP,
    pendingEmailSendsP,
    messageContentP,
  ]);

  const history = historyT.result;
  const { messageContent, transcriptions, transcriptionFailed, textToSend } =
    messageContentT.result;

  const { addMessage } = await import("../state.ts");
  if (textToSend) {
    addMessage(input.chatId, "user", textToSend, input.senderHandle, {
      isGroupChat: input.isGroupChat,
      chatName: input.chatName,
      participantNames: input.participantNames,
      service: input.service,
    }).catch((err) =>
      console.warn("[build-context] addMessage failed:", (err as Error).message)
    );
  }

  const recentTurns = routerCtx?.recentTurns ?? history.slice(-6).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const formattedHistory = formatHistory(history, input.isGroupChat);
  const workingMemory = routerCtx?.workingMemory ??
    (await loadWorkingMemory(input.chatId)) ?? emptyWorkingMemory();
  const resolvedUserContext = buildResolvedUserContext(
    input.userMessage,
    [],
    profileT.result,
    input.timezone,
  );

  const subTimings: ContextSubTimings = {
    historyMs: historyT.ms,
    memoryMs: 0,
    summariesMs: 0,
    toolTracesMs: 0,
    profileMs: profileT.ms,
    accountsMs: accountsT.ms,
    messageContentMs: messageContentT.ms,
    ragMs: 0,
    workingMemoryMs: 0,
    formatHistoryMs: 0,
  };

  const preloaded = [
    hasPreloadedHistory && "history",
    hasPreloadedProfile && "profile",
    hasPreloadedAccounts && "accounts",
  ].filter(Boolean);
  console.log(
    `[build-context] LIGHT path: history=${historyT.ms}ms profile=${profileT.ms}ms accounts=${accountsT.ms}ms msgContent=${messageContentT.ms}ms${preloaded.length ? ` (preloaded: ${preloaded.join(", ")})` : ""}`,
  );

  return {
    history,
    formattedHistory,
    messageContent,
    recentTurns,
    memoryItems: [],
    summaries: [],
    toolTraces: [],
    ragEvidence: "",
    ragEvidenceBlockCount: 0,
    senderProfile: profileT.result,
    connectedAccounts: accountsT.result,
    transcriptions,
    transcriptionFailed,
    workingMemory,
    pendingEmailSend: routerCtx?.pendingEmailSend ?? pendingEmailSendT.result,
    pendingEmailSends: routerCtx?.pendingEmailSends ??
      pendingEmailSendsT.result,
    resolvedUserContext,
    subTimings,
  };
}

// ═══════════════════════════════════════════════════════════════
// Memory-light context builder — for lightweight conversational
// turns where we want a small amount of personal context but skip
// expensive retrieval like RAG and tool traces.
// ═══════════════════════════════════════════════════════════════

export async function buildMemoryLightContext(
  input: TurnInput,
  routerCtx?: RouterContext,
): Promise<ContextBuildResult> {
  const hasPreloadedHistory = routerCtx?.preloadedHistory !== undefined;
  const hasPreloadedProfile = routerCtx?.preloadedProfile !== undefined;
  const hasPreloadedAccounts = routerCtx?.preloadedAccounts !== undefined;

  const {
    getConversation,
    getConversationSummaries,
    getUserProfile,
    getConnectedAccounts,
    getLatestPendingEmailSend,
    getPendingEmailSends,
  } = await import("../state.ts");

  const historyP = hasPreloadedHistory
    ? Promise.resolve({ result: routerCtx!.preloadedHistory!, ms: 0 })
    : timed(() => getConversation(input.chatId));

  let memoryP: Promise<MemoryFetchResult>;
  if (MEMORY_V2_ENABLED && input.senderHandle) {
    const { getRelevantMemoryItemsWithTimings } = await import("../memory.ts");
    memoryP = getRelevantMemoryItemsWithTimings(
      input.senderHandle,
      input.userMessage,
      10,
    ).then(({ items, timings }) => ({
      result: items,
      ms: timings.totalMs,
      detail: timings,
    }));
  } else {
    memoryP = Promise.resolve({
      result: [] as MemoryItem[],
      ms: 0,
      detail: null,
    });
  }

  const summariesP = MEMORY_V2_ENABLED
    ? timed(() => getConversationSummaries(input.chatId, 6))
    : Promise.resolve({ result: [] as ConversationSummary[], ms: 0 });

  const profileP = hasPreloadedProfile
    ? Promise.resolve({ result: routerCtx!.preloadedProfile!, ms: 0 })
    : input.senderHandle
    ? timed(() => getUserProfile(input.senderHandle))
    : Promise.resolve({ result: null, ms: 0 });
  const accountsP = hasPreloadedAccounts
    ? Promise.resolve({ result: routerCtx!.preloadedAccounts!, ms: 0 })
    : input.authUserId
    ? timed(() => getConnectedAccounts(input.authUserId!))
    : Promise.resolve({
      result: [] as import("../state.ts").ConnectedAccount[],
      ms: 0,
    });
  const pendingEmailSendP = timed(() =>
    getLatestPendingEmailSend(input.chatId)
  );
  const pendingEmailSendsP = timed(() => getPendingEmailSends(input.chatId));
  const messageContentP = timed(() => buildMessageContent(input));

  const [
    historyT,
    memoryT,
    summariesT,
    profileT,
    accountsT,
    pendingEmailSendT,
    pendingEmailSendsT,
    messageContentT,
  ] = await Promise.all([
    historyP,
    memoryP,
    summariesP,
    profileP,
    accountsP,
    pendingEmailSendP,
    pendingEmailSendsP,
    messageContentP,
  ]);

  const history = historyT.result;
  const memoryItems = memoryT.result;
  const rawSummaries = summariesT.result;
  const summaries = MEMORY_V2_ENABLED
    ? (await import("../memory.ts")).getRelevantSummaries(
      rawSummaries,
      input.userMessage,
      2,
    )
    : [];
  const { messageContent, transcriptions, transcriptionFailed, textToSend } =
    messageContentT.result;

  const { addMessage } = await import("../state.ts");
  if (textToSend) {
    addMessage(input.chatId, "user", textToSend, input.senderHandle, {
      isGroupChat: input.isGroupChat,
      chatName: input.chatName,
      participantNames: input.participantNames,
      service: input.service,
    }).catch((err) =>
      console.warn("[build-context] addMessage failed:", (err as Error).message)
    );
  }

  const recentTurns = routerCtx?.recentTurns ?? history.slice(-6).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const fmtStart = Date.now();
  const formattedHistory = formatHistory(history, input.isGroupChat);
  const formatHistoryMs = Date.now() - fmtStart;

  const wmStart = Date.now();
  const workingMemory = routerCtx?.workingMemory ??
    (await loadWorkingMemory(input.chatId)) ?? emptyWorkingMemory();
  const workingMemoryMs = Date.now() - wmStart;
  const resolvedUserContext = buildResolvedUserContext(
    input.userMessage,
    memoryItems,
    profileT.result,
    input.timezone,
  );

  const subTimings: ContextSubTimings = {
    historyMs: historyT.ms,
    memoryMs: memoryT.ms,
    summariesMs: summariesT.ms,
    toolTracesMs: 0,
    profileMs: profileT.ms,
    accountsMs: accountsT.ms,
    messageContentMs: messageContentT.ms,
    ragMs: 0,
    workingMemoryMs,
    formatHistoryMs,
    ...buildMemoryTimingFields(memoryT.detail),
  };

  const preloaded = [
    hasPreloadedHistory && "history",
    hasPreloadedProfile && "profile",
    hasPreloadedAccounts && "accounts",
  ].filter(Boolean);
  console.log(
    `[build-context] MEMORY-LIGHT path: history=${historyT.ms}ms memory=${memoryT.ms}ms summaries=${summariesT.ms}ms profile=${profileT.ms}ms accounts=${accountsT.ms}ms msgContent=${messageContentT.ms}ms${preloaded.length ? ` (preloaded: ${preloaded.join(", ")})` : ""}`,
  );

  return {
    history,
    formattedHistory,
    messageContent,
    recentTurns,
    memoryItems,
    summaries,
    toolTraces: [],
    ragEvidence: "",
    ragEvidenceBlockCount: 0,
    senderProfile: profileT.result,
    connectedAccounts: accountsT.result,
    transcriptions,
    transcriptionFailed,
    workingMemory,
    pendingEmailSend: routerCtx?.pendingEmailSend ?? pendingEmailSendT.result,
    pendingEmailSends: routerCtx?.pendingEmailSends ??
      pendingEmailSendsT.result,
    resolvedUserContext,
    subTimings,
  };
}

function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const s = Date.now();
  return fn().then((result) => ({ result, ms: Date.now() - s }));
}

export async function buildContext(
  input: TurnInput,
  routerCtx?: RouterContext,
  options?: { historyLimit?: number },
): Promise<ContextBuildResult> {
  const customHistoryLimit = options?.historyLimit;
  const hasPreloadedHistory = routerCtx?.preloadedHistory !== undefined && !customHistoryLimit;
  const hasPreloadedProfile = routerCtx?.preloadedProfile !== undefined;
  const hasPreloadedAccounts = routerCtx?.preloadedAccounts !== undefined;

  const {
    getConversation,
    getConversationSummaries,
    getRecentToolTraces,
    getUserProfile,
    getConnectedAccounts,
    getLatestPendingEmailSend,
    getPendingEmailSends,
  } = await import("../state.ts");

  const historyP = hasPreloadedHistory
    ? Promise.resolve({ result: routerCtx!.preloadedHistory!, ms: 0 })
    : timed(() => getConversation(input.chatId, customHistoryLimit));

  let memoryP: Promise<MemoryFetchResult>;
  if (MEMORY_V2_ENABLED && input.senderHandle) {
    const { getRelevantMemoryItemsWithTimings } = await import("../memory.ts");
    memoryP = getRelevantMemoryItemsWithTimings(
      input.senderHandle,
      input.userMessage,
      20,
    ).then(({ items, timings }) => ({
      result: items,
      ms: timings.totalMs,
      detail: timings,
    }));
  } else {
    memoryP = Promise.resolve({
      result: [],
      ms: 0,
      detail: null,
    });
  }

  const summariesP = MEMORY_V2_ENABLED
    ? timed(() => getConversationSummaries(input.chatId, 10))
    : Promise.resolve({ result: [] as ConversationSummary[], ms: 0 });

  const tracesP = MEMORY_V2_ENABLED
    ? timed(() => getRecentToolTraces(input.chatId, 10))
    : Promise.resolve({ result: [] as ToolTrace[], ms: 0 });

  const profileP = hasPreloadedProfile
    ? Promise.resolve({ result: routerCtx!.preloadedProfile!, ms: 0 })
    : input.senderHandle
    ? timed(() => getUserProfile(input.senderHandle))
    : Promise.resolve({ result: null, ms: 0 });

  const accountsP = hasPreloadedAccounts
    ? Promise.resolve({ result: routerCtx!.preloadedAccounts!, ms: 0 })
    : input.authUserId
    ? timed(() => getConnectedAccounts(input.authUserId!))
    : Promise.resolve({
      result: [] as import("../state.ts").ConnectedAccount[],
      ms: 0,
    });
  const pendingEmailSendP = timed(() =>
    getLatestPendingEmailSend(input.chatId)
  );
  const pendingEmailSendsP = timed(() => getPendingEmailSends(input.chatId));

  const messageContentP = timed(() => buildMessageContent(input));

  const [
    historyT,
    memoryT,
    summariesT,
    tracesT,
    profileT,
    accountsT,
    pendingEmailSendT,
    pendingEmailSendsT,
    messageContentT,
  ] = await Promise.all([
    historyP,
    memoryP,
    summariesP,
    tracesP,
    profileP,
    accountsP,
    pendingEmailSendP,
    pendingEmailSendsP,
    messageContentP,
  ]);

  const history = historyT.result;
  const memoryItems = memoryT.result;
  const rawSummaries = summariesT.result;
  const rawTraces = tracesT.result;
  const senderProfile = profileT.result;
  const connectedAccounts = accountsT.result;
  const { messageContent, transcriptions, transcriptionFailed, textToSend } =
    messageContentT.result;

  let summaries: ConversationSummary[] = rawSummaries;
  let toolTraces: ToolTrace[] = rawTraces;

  if (MEMORY_V2_ENABLED) {
    const { getRelevantSummaries, getRelevantToolTraces } = await import(
      "../memory.ts"
    );
    summaries = getRelevantSummaries(rawSummaries, input.userMessage, 5);
    toolTraces = getRelevantToolTraces(rawTraces, input.userMessage, 5);
  }

  // RAG retrieval
  const ragStart = Date.now();
  let ragEvidence = "";
  let ragEvidenceBlockCount = 0;
  if (input.senderHandle) {
    const recentChat = history.slice(-6).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    try {
      const { getAdminClient } = await import("../supabase.ts");
      const { serverSideRAG } = await import("../server-rag.ts");
      const supabase = getAdminClient();
      const evidence = await serverSideRAG(
        input.userMessage,
        recentChat,
        input.senderHandle,
        supabase,
      );
      if (evidence) {
        ragEvidence = evidence;
        ragEvidenceBlockCount =
          (evidence.match(/\[Evidence \d+\]/g) || []).length || 1;
      }
    } catch (err) {
      console.warn(
        "[build-context] RAG retrieval failed:",
        (err as Error).message,
      );
    }
  }
  const ragMs = Date.now() - ragStart;

  // Persist the user message (fire-and-forget)
  const { addMessage } = await import("../state.ts");
  if (textToSend) {
    addMessage(input.chatId, "user", textToSend, input.senderHandle, {
      isGroupChat: input.isGroupChat,
      chatName: input.chatName,
      participantNames: input.participantNames,
      service: input.service,
    }).catch((err) =>
      console.warn("[build-context] addMessage failed:", (err as Error).message)
    );
  }

  const recentTurns = routerCtx?.recentTurns ?? history.slice(-6).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const fmtStart = Date.now();
  const formattedHistory = formatHistory(history, input.isGroupChat);
  const formatHistoryMs = Date.now() - fmtStart;

  const wmStart = Date.now();
  const workingMemory = routerCtx?.workingMemory ??
    (await loadWorkingMemory(input.chatId)) ?? emptyWorkingMemory();
  const workingMemoryMs = Date.now() - wmStart;
  const resolvedUserContext = buildResolvedUserContext(
    input.userMessage,
    memoryItems,
    senderProfile,
    input.timezone,
  );

  const subTimings: ContextSubTimings = {
    historyMs: historyT.ms,
    memoryMs: memoryT.ms,
    summariesMs: summariesT.ms,
    toolTracesMs: tracesT.ms,
    profileMs: profileT.ms,
    accountsMs: accountsT.ms,
    messageContentMs: messageContentT.ms,
    ragMs,
    workingMemoryMs,
    formatHistoryMs,
    ...buildMemoryTimingFields(memoryT.detail),
  };

  const preloaded = [
    hasPreloadedHistory && "history",
    hasPreloadedProfile && "profile",
    hasPreloadedAccounts && "accounts",
  ].filter(Boolean);
  console.log(
    `[build-context] sub-timings: history=${historyT.ms}ms memory=${memoryT.ms}ms summaries=${summariesT.ms}ms traces=${tracesT.ms}ms profile=${profileT.ms}ms accounts=${accountsT.ms}ms msgContent=${messageContentT.ms}ms rag=${ragMs}ms wm=${workingMemoryMs}ms fmt=${formatHistoryMs}ms${preloaded.length ? ` (preloaded: ${preloaded.join(", ")})` : ""}`,
  );

  return {
    history,
    formattedHistory,
    messageContent,
    recentTurns,
    memoryItems,
    summaries,
    toolTraces,
    ragEvidence,
    ragEvidenceBlockCount,
    senderProfile,
    connectedAccounts,
    transcriptions,
    transcriptionFailed,
    workingMemory,
    pendingEmailSend: routerCtx?.pendingEmailSend ?? pendingEmailSendT.result,
    pendingEmailSends: routerCtx?.pendingEmailSends ??
      pendingEmailSendsT.result,
    resolvedUserContext,
    subTimings,
  };
}
