// Linq Blue V3 API Client + Webhook Types
// Ref: https://apidocs.linqapp.com

import { getListEnv, getOptionalEnv, requireEnv } from './env.ts';

// ─── Shared messaging types (canonical definitions) ──────────────────────────

export type StandardReactionType = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';
export type ReactionType = StandardReactionType | 'custom';
export type MessageService = 'iMessage' | 'SMS' | 'RCS';

export type MessageEffect = { type: 'screen' | 'bubble'; name: string };

export interface ExtractedMedia {
  url: string;
  mimeType: string;
}

export type Reaction = {
  type: StandardReactionType;
} | {
  type: 'custom';
  emoji: string;
};

export interface MediaAttachment {
  url: string;
}

export interface NormalisedIncomingMessage {
  chatId: string;
  from: string;
  text: string;
  messageId: string;
  images: ExtractedMedia[];
  audio: ExtractedMedia[];
  incomingEffect?: MessageEffect;
  service?: MessageService;
  isGroupChat: boolean;
  participantNames: string[];
  chatName: string | null;
  provider: 'linq';
  conversation: ConversationTarget;
}

export interface ConversationTarget {
  chatId: string;
  fromNumber: string;
  recipientNumber: string;
  isGroupChat: boolean;
  groupId: string | null;
  participants: string[];
  chatName: string | null;
  service?: MessageService;
}

const BASE_URL = getOptionalEnv('LINQ_API_BASE_URL') || 'https://api.linqapp.com/api/partner/v3';

function truncateError(text: string, maxLen = 100): string {
  if (text.includes('<!DOCTYPE') || text.includes('<html')) {
    return '[HTML error page - likely Linq backend issue]';
  }
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}

function getAuthHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${requireEnv('LINQ_API_TOKEN')}` };
}

async function sendRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...getAuthHeaders(),
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[linq] API error ${response.status}: ${truncateError(errorText)}`);
    throw new Error(`Linq API error: ${response.status} ${truncateError(errorText)}`);
  }

  const text = await response.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

// ─── Chat info (cached) ─────────────────────────────────────────────────────

const chatInfoCache = new Map<string, ChatInfo>();

export interface ChatHandle {
  handle: string;
  service: string;
  is_me?: boolean;
  status?: string;
  joined_at?: string;
  left_at?: string | null;
}

export interface ChatInfo {
  id: string;
  display_name: string | null;
  handles: ChatHandle[];
  is_group: boolean;
  service: string;
}

export async function getChat(chatId: string): Promise<ChatInfo> {
  const cached = chatInfoCache.get(chatId);
  if (cached) return cached;

  console.log(`[linq] Fetching chat info for ${chatId}`);
  const data = await sendRequest<ChatInfo>(`/chats/${encodeURIComponent(chatId)}`, { method: 'GET' });

  chatInfoCache.set(chatId, data);
  console.log(`[linq] Chat info cached: ${data.handles.length} participants, is_group=${data.is_group}`);
  return data;
}

// ─── Webhook types (matched to actual Linq V3 payload structure) ─────────────

export interface WebhookEvent {
  api_version: 'v3';
  webhook_version: string;
  event_id: string;
  event_type: string;
  created_at: string;
  trace_id: string;
  partner_id: string;
  data: unknown;
}

export interface HandleInfo {
  handle: string;
  id: string;
  is_me: boolean;
  joined_at: string;
  left_at: string | null;
  service: string;
  status: string;
}

export interface ChatInfo_Webhook {
  id: string;
  is_group: boolean;
  owner_handle: HandleInfo;
}

export interface MessageReceivedData {
  chat: ChatInfo_Webhook;
  delivered_at: string | null;
  direction: string;
  effect: MessageEffect | null;
  id: string;
  idempotency_key: string;
  parts: MessagePart[];
  preferred_service: string | null;
  read_at: string | null;
  reply_to: ReplyTo | null;
  sender_handle: HandleInfo;
  sent_at: string;
  service: string;
}

export interface MessageReceivedEvent extends WebhookEvent {
  event_type: 'message.received';
  data: MessageReceivedData;
}

export interface TextPart {
  type: 'text';
  value: string;
}

export interface MediaPart {
  type: 'media';
  url?: string;
  attachment_id?: string;
  filename?: string;
  mime_type?: string;
  size?: number;
}

export type MessagePart = TextPart | MediaPart;

export interface ReplyTo {
  message_id: string;
  part_index?: number;
}

export function isMessageReceivedEvent(event: WebhookEvent): event is MessageReceivedEvent {
  return event.event_type === 'message.received';
}

function extractTextContent(parts: MessagePart[]): string {
  return parts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.value)
    .join('\n');
}

function extractImageUrls(parts: MessagePart[]): ExtractedMedia[] {
  return parts
    .filter((part): part is MediaPart =>
      part.type === 'media' &&
      !!part.url &&
      !!part.mime_type &&
      part.mime_type.startsWith('image/')
    )
    .map((part) => ({ url: part.url!, mimeType: part.mime_type! }));
}

function extractAudioUrls(parts: MessagePart[]): ExtractedMedia[] {
  return parts
    .filter((part): part is MediaPart =>
      part.type === 'media' &&
      !!part.url &&
      !!part.mime_type &&
      part.mime_type.startsWith('audio/')
    )
    .map((part) => ({ url: part.url!, mimeType: part.mime_type! }));
}

// ─── Normalise incoming webhook to shared message type ───────────────────────

function normaliseService(service?: string): MessageService | undefined {
  if (!service) return undefined;
  const value = service.toLowerCase();
  if (value === 'imessage') return 'iMessage';
  if (value === 'sms') return 'SMS';
  if (value === 'rcs') return 'RCS';
  return undefined;
}

export async function normaliseLinqMessage(event: MessageReceivedEvent): Promise<NormalisedIncomingMessage | null> {
  const { data } = event;

  // Skip our own outbound messages
  if (data.sender_handle?.is_me || data.direction === 'outbound') return null;

  const from = data.sender_handle?.handle?.trim();
  const botNumber = data.chat?.owner_handle?.handle?.trim();
  const chatId = data.chat?.id;
  const messageId = data.id;

  if (!from || !botNumber || !chatId || !messageId) return null;

  const text = extractTextContent(data.parts || []);
  const images = extractImageUrls(data.parts || []);
  const audio = extractAudioUrls(data.parts || []);
  const service = normaliseService(data.service);

  const isGroupChat = data.chat?.is_group ?? false;
  let participants = [from, botNumber];
  let chatName: string | null = null;

  // For group chats, enrich with full participant list from Linq API
  if (isGroupChat) {
    try {
      const chatInfo = await getChat(chatId);
      participants = chatInfo.handles
        .filter(h => !h.is_me)
        .map(h => h.handle);
      chatName = chatInfo.display_name ?? null;
    } catch (err) {
      console.warn('[linq] Failed to enrich group participants:', (err as Error).message);
    }
  }

  const incomingEffect = data.effect
    ? { type: data.effect.type, name: data.effect.name }
    : undefined;

  return {
    chatId,
    from,
    text: text.trim(),
    messageId,
    images,
    audio,
    incomingEffect,
    service,
    isGroupChat,
    participantNames: participants,
    chatName,
    provider: 'linq',
    conversation: {
      chatId,
      fromNumber: botNumber,
      recipientNumber: from,
      isGroupChat,
      groupId: isGroupChat ? chatId : null,
      participants,
      chatName,
      service,
    },
  };
}

// ─── Create chat (sends initial message) ─────────────────────────────────────

/**
 * Linq requires a non-empty initial message when creating a chat. Use this when the only
 * user-visible content will be a voice memo (avoids a separate text bubble before the memo).
 * iMessage often renders a zero-width space as an empty or minimal bubble; if the API rejects
 * it, fall back to a single visible character and revisit with Linq support.
 */
export const CREATE_CHAT_INVISIBLE_PLACEHOLDER = '\u200B';

export interface LinqCreateChatResponse {
  chat: {
    id: string;
    display_name: string | null;
    service: string;
    is_group: boolean;
    message: {
      id: string;
      parts: Array<{ type: string; value?: string }>;
      sent_at: string;
      delivery_status: 'pending' | 'queued' | 'sent' | 'delivered' | 'failed';
      is_read: boolean;
    };
  };
}

export async function createChat(
  from: string,
  to: string[],
  text: string,
): Promise<LinqCreateChatResponse> {
  return sendRequest<LinqCreateChatResponse>('/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to,
      message: {
        parts: [{ type: 'text', value: text }],
      },
    }),
  });
}

// ─── Send message ────────────────────────────────────────────────────────────

export interface LinqSendMessageResponse {
  chat_id: string;
  message: {
    id: string;
    parts: Array<{ type: string; value?: string }>;
    sent_at: string;
    delivery_status: 'pending' | 'queued' | 'sent' | 'delivered' | 'failed';
    is_read: boolean;
  };
}

export interface LinqMediaAttachment {
  url: string;
}

export async function sendMessage(
  chatId: string,
  text: string,
  effect?: MessageEffect,
  media?: LinqMediaAttachment[],
  replyTo?: ReplyTo,
): Promise<LinqSendMessageResponse> {
  const parts: Array<{ type: string; value?: string; url?: string }> = [];

  if (text) {
    parts.push({ type: 'text', value: text });
  }

  if (media) {
    for (const m of media) {
      parts.push({ type: 'media', url: m.url });
    }
  }

  const message: Record<string, unknown> = { parts };
  if (effect) message.effect = effect;
  if (replyTo) message.reply_to = replyTo;

  return sendRequest<LinqSendMessageResponse>(`/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

/** iMessage voice memo bubble (inline playback) — not a downloadable media attachment. */
export interface LinqSendVoiceMemoResult {
  voice_memo: {
    id: string;
    status: string;
    from?: string;
    to?: string[];
    created_at?: string;
    chat?: unknown;
  };
}

export async function sendVoiceMemo(chatId: string, voiceMemoUrl: string): Promise<LinqSendVoiceMemoResult> {
  return sendRequest<LinqSendVoiceMemoResult>(`/chats/${encodeURIComponent(chatId)}/voicememo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice_memo_url: voiceMemoUrl }),
  });
}

// ─── Reactions ───────────────────────────────────────────────────────────────

export interface LinqSendReactionResponse {
  is_me: boolean;
  handle: string;
  type: string;
}

export async function sendReaction(
  messageId: string,
  reaction: Reaction,
  operation: 'add' | 'remove' = 'add',
): Promise<LinqSendReactionResponse> {
  const isCustom = reaction.type === 'custom';
  const body: Record<string, string> = {
    operation,
    type: reaction.type,
  };

  if (isCustom) {
    body.custom_emoji = (reaction as { type: 'custom'; emoji: string }).emoji;
  }

  return sendRequest<LinqSendReactionResponse>(`/messages/${messageId}/reactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Read receipts & typing ──────────────────────────────────────────────────

export async function markAsRead(chatId: string): Promise<void> {
  await sendRequest(`/chats/${encodeURIComponent(chatId)}/read`, { method: 'POST' });
}

export async function startTyping(chatId: string): Promise<void> {
  await sendRequest(`/chats/${encodeURIComponent(chatId)}/typing`, { method: 'POST' });
}

export async function stopTyping(chatId: string): Promise<void> {
  await sendRequest(`/chats/${encodeURIComponent(chatId)}/typing`, { method: 'DELETE' });
}

// ─── Contact cards ───────────────────────────────────────────────────────────

export async function shareContactCard(chatId: string): Promise<void> {
  await sendRequest(`/chats/${encodeURIComponent(chatId)}/share_contact_card`, { method: 'POST' });
}

// ─── Sender filtering ────────────────────────────────────────────────────────

export function shouldProcessLinqBotNumber(botNumber: string): boolean {
  const allowedBotNumbers = getListEnv('LINQ_AGENT_BOT_NUMBERS');
  return allowedBotNumbers.length === 0 || allowedBotNumbers.includes(botNumber);
}

export function isAllowedSender(handle: string): boolean {
  const allowedSenders = getListEnv('ALLOWED_SENDERS');
  return allowedSenders.length === 0 || allowedSenders.includes(handle);
}

export function isIgnoredSender(handle: string): boolean {
  return getListEnv('IGNORED_SENDERS').includes(handle);
}
