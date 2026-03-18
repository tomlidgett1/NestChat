import type { InputContentPart, InputMessage } from "../ai/models.ts";
import type {
  ContextSubTimings,
  ConversationSummary,
  MemoryItem,
  StoredMessage,
  ToolTrace,
  TurnContext,
  TurnInput,
} from "./types.ts";
import { emptyWorkingMemory } from "./types.ts";
import { MEMORY_V2_ENABLED } from "../env.ts";

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

// ═══════════════════════════════════════════════════════════════
// Audio transcription (delegates to OpenAI Whisper)
// ═══════════════════════════════════════════════════════════════

async function transcribeAudio(url: string): Promise<string | null> {
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

  let memoryP: Promise<{ result: MemoryItem[]; ms: number }>;
  if (MEMORY_V2_ENABLED && input.senderHandle) {
    const { getRelevantMemoryItems } = await import("../memory.ts");
    memoryP = timed(() =>
      getRelevantMemoryItems(input.senderHandle, input.userMessage, 5)
    );
  } else {
    memoryP = Promise.resolve({ result: [] as MemoryItem[], ms: 0 });
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
): Promise<ContextBuildResult> {
  const hasPreloadedHistory = routerCtx?.preloadedHistory !== undefined;
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
    : timed(() => getConversation(input.chatId));

  let memoryP: Promise<{ result: MemoryItem[]; ms: number }>;
  if (MEMORY_V2_ENABLED && input.senderHandle) {
    const { getRelevantMemoryItems } = await import("../memory.ts");
    memoryP = timed(() =>
      getRelevantMemoryItems(input.senderHandle, input.userMessage, 20)
    );
  } else {
    memoryP = Promise.resolve({ result: [], ms: 0 });
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
    subTimings,
  };
}
