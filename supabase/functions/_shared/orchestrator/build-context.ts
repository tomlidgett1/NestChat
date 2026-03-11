import type Anthropic from 'npm:@anthropic-ai/sdk@0.78.0';
import type { TurnInput, TurnContext, MemoryItem, ConversationSummary, ToolTrace, StoredMessage } from './types.ts';
import { emptyWorkingMemory } from './types.ts';
import { MEMORY_V2_ENABLED } from '../env.ts';

import { formatRelativeTime } from '../utils/format.ts';
import { loadWorkingMemory } from './working-memory.ts';

// ═══════════════════════════════════════════════════════════════
// History formatting
// ═══════════════════════════════════════════════════════════════

function formatToolNotes(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) return '';
  const tools = metadata.tools_used as Array<{ tool: string; detail?: string }> | undefined;
  if (!tools || tools.length === 0) return '';
  return ' ' + tools.map((t) => `[${t.tool}]`).join(' ');
}

function formatHistoryForClaude(messages: StoredMessage[], isGroupChat: boolean): Anthropic.MessageParam[] {
  return messages.map((message) => {
    const timeTag = formatRelativeTime(message.createdAt);
    const toolNotes = message.role === 'assistant' ? formatToolNotes(message.metadata) : '';
    let content = message.content;

    if (isGroupChat && message.role === 'user' && message.handle) {
      content = `[${message.handle}]: ${content}`;
    }

    if (timeTag && message.role === 'user') {
      content = `[${timeTag}] ${content}`;
    }

    if (toolNotes) {
      content = `${content}${toolNotes}`;
    }

    return { role: message.role as 'user' | 'assistant', content };
  });
}

// ═══════════════════════════════════════════════════════════════
// Audio transcription (delegates to OpenAI Whisper)
// ═══════════════════════════════════════════════════════════════

async function transcribeAudio(url: string): Promise<string | null> {
  try {
    const OpenAI = (await import('npm:openai@6.16.0')).default;
    const openai = new OpenAI({ apiKey: Deno.env.get('OPENAI_API_KEY') });

    const response = await fetch(url);
    if (!response.ok) return null;

    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'audio/mp4';
    const blob = new Blob([arrayBuffer], { type: contentType });
    const file = new File([blob], 'voice_memo.m4a', { type: contentType });
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
    });
    return transcription.text;
  } catch (error) {
    console.error('[build-context] Transcription error:', error);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Message content assembly (images, audio, text)
// ═══════════════════════════════════════════════════════════════

interface MessageContentResult {
  messageContent: Anthropic.ContentBlockParam[];
  transcriptions: string[];
  transcriptionFailed: boolean;
  textToSend: string;
}

async function buildMessageContent(input: TurnInput): Promise<MessageContentResult> {
  const messageContent: Anthropic.ContentBlockParam[] = [];

  for (const image of input.images) {
    messageContent.push({
      type: 'image',
      source: { type: 'url', url: image.url },
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
    const transcriptText = transcriptions.join('\n');
    textToSend = textToSend
      ? `[Voice memo transcript: "${transcriptText}"]\n\n${textToSend}`
      : `[Voice memo transcript: "${transcriptText}"]\n\nRespond naturally to what they said in the voice memo.`;
  } else if (input.audio.length > 0 && transcriptionFailed) {
    textToSend = textToSend || '[Someone sent a voice memo but transcription failed. Let them know you could not hear it and ask them to try again or type their message.]';
  } else if (!textToSend && input.images.length > 0) {
    textToSend = "What's in this image?";
  }

  if (textToSend) {
    messageContent.push({ type: 'text', text: textToSend });
  }

  return { messageContent, transcriptions, transcriptionFailed, textToSend };
}

// ═══════════════════════════════════════════════════════════════
// Router context — lightweight fetch for routing decisions only
// ═══════════════════════════════════════════════════════════════

export interface RouterContext {
  recentTurns: Array<{ role: string; content: string }>;
  workingMemory: import('./types.ts').WorkingMemory;
}

export async function buildRouterContext(input: TurnInput): Promise<RouterContext> {
  const { getConversation } = await import('../state.ts');

  const [history, workingMemory] = await Promise.all([
    getConversation(input.chatId, 6),
    loadWorkingMemory(input.chatId).then((wm) => wm ?? emptyWorkingMemory()),
  ]);

  const recentTurns = history.slice(-6).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  return { recentTurns, workingMemory };
}

// ═══════════════════════════════════════════════════════════════
// Full context builder — parallel fetches for all data sources
// Accepts pre-fetched router context to avoid duplicate work
// ═══════════════════════════════════════════════════════════════

export async function buildContext(
  input: TurnInput,
  routerCtx?: RouterContext,
): Promise<TurnContext> {
  const {
    getConversation,
    getConversationSummaries,
    getRecentToolTraces,
    getUserProfile,
    getConnectedAccounts,
  } = await import('../state.ts');

  const historyPromise = getConversation(input.chatId);

  let memoryPromise: Promise<MemoryItem[]>;
  if (MEMORY_V2_ENABLED && input.senderHandle) {
    const { getRelevantMemoryItems } = await import('../memory.ts');
    memoryPromise = getRelevantMemoryItems(input.senderHandle, input.userMessage, 20);
  } else {
    memoryPromise = Promise.resolve([]);
  }

  const summariesPromise = MEMORY_V2_ENABLED
    ? getConversationSummaries(input.chatId, 10)
    : Promise.resolve([]);

  const tracesPromise = MEMORY_V2_ENABLED
    ? getRecentToolTraces(input.chatId, 10)
    : Promise.resolve([]);

  const profilePromise = input.senderHandle
    ? getUserProfile(input.senderHandle)
    : Promise.resolve(null);

  const accountsPromise = input.authUserId
    ? getConnectedAccounts(input.authUserId)
    : Promise.resolve([]);

  const messageContentPromise = buildMessageContent(input);

  const [
    history,
    memoryItems,
    rawSummaries,
    rawTraces,
    senderProfile,
    connectedAccounts,
    { messageContent, transcriptions, transcriptionFailed, textToSend },
  ] = await Promise.all([
    historyPromise,
    memoryPromise,
    summariesPromise,
    tracesPromise,
    profilePromise,
    accountsPromise,
    messageContentPromise,
  ]);

  let summaries: ConversationSummary[] = rawSummaries;
  let toolTraces: ToolTrace[] = rawTraces;

  if (MEMORY_V2_ENABLED) {
    const { getRelevantSummaries, getRelevantToolTraces } = await import('../memory.ts');
    summaries = getRelevantSummaries(rawSummaries, input.userMessage, 5);
    toolTraces = getRelevantToolTraces(rawTraces, input.userMessage, 5);
  }

  // RAG retrieval
  let ragEvidence = '';
  let ragEvidenceBlockCount = 0;
  if (input.senderHandle) {
    const recentChat = history.slice(-6).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    try {
      const { getAdminClient } = await import('../supabase.ts');
      const { serverSideRAG } = await import('../server-rag.ts');
      const supabase = getAdminClient();
      const evidence = await serverSideRAG(
        input.userMessage,
        recentChat,
        input.senderHandle,
        supabase,
      );
      if (evidence) {
        ragEvidence = evidence;
        ragEvidenceBlockCount = (evidence.match(/\[Evidence \d+\]/g) || []).length || 1;
      }
    } catch (err) {
      console.warn('[build-context] RAG retrieval failed:', (err as Error).message);
    }
  }

  // Persist the user message (fire-and-forget — no need to block response)
  const { addMessage } = await import('../state.ts');
  if (textToSend) {
    addMessage(input.chatId, 'user', textToSend, input.senderHandle, {
      isGroupChat: input.isGroupChat,
      chatName: input.chatName,
      participantNames: input.participantNames,
      service: input.service,
    }).catch((err) => console.warn('[build-context] addMessage failed:', (err as Error).message));
  }

  const recentTurns = routerCtx?.recentTurns ?? history.slice(-6).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const formattedHistory = formatHistoryForClaude(history, input.isGroupChat);

  const workingMemory = routerCtx?.workingMemory
    ?? (await loadWorkingMemory(input.chatId)) ?? emptyWorkingMemory();

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
  };
}
