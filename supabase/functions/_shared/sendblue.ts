import { getListEnv, getOptionalEnv, requireEnv } from './env.ts';

const BASE_URL = getOptionalEnv('SENDBLUE_API_BASE_URL') || 'https://api.sendblue.co';

function truncateError(text: string, maxLen = 140): string {
  if (text.includes('<!DOCTYPE') || text.includes('<html')) {
    return '[HTML error page - likely Sendblue backend issue]';
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function getAuthHeaders(): Record<string, string> {
  return {
    'sb-api-key-id': requireEnv('SENDBLUE_API_KEY'),
    'sb-api-secret-key': requireEnv('SENDBLUE_API_SECRET'),
  };
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
    console.error(`[sendblue] API error ${response.status}: ${truncateError(errorText)}`);
    throw new Error(`Sendblue API error: ${response.status} ${truncateError(errorText)}`);
  }

  return response.json() as Promise<T>;
}

export type StandardReactionType = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';
export type ReactionType = StandardReactionType | 'custom';
export type MessageService = 'iMessage' | 'SMS' | 'RCS';
export type SendblueMessageStyle =
  | 'celebration'
  | 'shooting_star'
  | 'fireworks'
  | 'lasers'
  | 'love'
  | 'confetti'
  | 'balloons'
  | 'spotlight'
  | 'echo'
  | 'invisible'
  | 'gentle'
  | 'loud'
  | 'slam';

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

export interface SendblueWebhookEvent {
  accountEmail?: string;
  content?: string;
  is_outbound?: boolean;
  status?: string;
  error_code?: number | string | null;
  error_message?: string | null;
  error_reason?: string | null;
  error_detail?: string | null;
  message_handle?: string;
  date_sent?: string;
  date_updated?: string;
  from_number?: string;
  number?: string;
  to_number?: string;
  was_downgraded?: boolean | null;
  plan?: string;
  media_url?: string;
  message_type?: string;
  group_id?: string;
  participants?: string[];
  send_style?: string;
  opted_out?: boolean;
  sendblue_number?: string | null;
  service?: MessageService | string;
  group_display_name?: string | null;
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
  conversation: ConversationTarget;
}

export interface SendMessageResponse {
  message_handle?: string;
  status?: string;
  content?: string;
  media_url?: string;
  number?: string;
  from_number?: string;
  group_id?: string;
}

export interface SendReactionResponse {
  status: string;
  message?: string;
  message_handle?: string;
  reaction?: string;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.heif']);
const AUDIO_EXTENSIONS = new Set(['.caf', '.m4a', '.mp3', '.wav', '.aac', '.ogg', '.oga', '.flac']);
const SCREEN_EFFECTS = new Set(['celebration', 'shooting_star', 'fireworks', 'lasers', 'love', 'confetti', 'balloons', 'spotlight', 'echo']);
const BUBBLE_EFFECTS = new Set(['invisible', 'gentle', 'loud', 'slam']);

export function isInboundReceiveWebhook(event: SendblueWebhookEvent): boolean {
  return !event.is_outbound && event.status === 'RECEIVED' && !!event.message_handle;
}

export function isOutboundMessageWebhook(event: SendblueWebhookEvent): boolean {
  return event.is_outbound === true && !!event.message_handle;
}

function normaliseService(service?: string): MessageService | undefined {
  if (!service) return undefined;
  const value = service.toLowerCase();
  if (value === 'imessage') return 'iMessage';
  if (value === 'sms') return 'SMS';
  if (value === 'rcs') return 'RCS';
  return undefined;
}

function normaliseStyleToEffect(style?: string): MessageEffect | undefined {
  if (!style) return undefined;
  if (SCREEN_EFFECTS.has(style)) return { type: 'screen', name: style };
  if (BUBBLE_EFFECTS.has(style)) return { type: 'bubble', name: style };
  return undefined;
}

function inferMimeType(url: string): string | null {
  const pathname = new URL(url).pathname.toLowerCase();

  for (const extension of IMAGE_EXTENSIONS) {
    if (pathname.endsWith(extension)) {
      return extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : `image/${extension.slice(1)}`;
    }
  }

  for (const extension of AUDIO_EXTENSIONS) {
    if (pathname.endsWith(extension)) {
      if (extension === '.m4a') return 'audio/mp4';
      if (extension === '.caf') return 'audio/x-caf';
      return `audio/${extension.slice(1)}`;
    }
  }

  return null;
}

function extractMedia(mediaUrl?: string): { images: ExtractedMedia[]; audio: ExtractedMedia[] } {
  if (!mediaUrl) return { images: [], audio: [] };

  try {
    const mimeType = inferMimeType(mediaUrl);
    if (!mimeType) {
      return { images: [], audio: [] };
    }

    const media = { url: mediaUrl, mimeType };
    if (mimeType.startsWith('image/')) return { images: [media], audio: [] };
    if (mimeType.startsWith('audio/')) return { images: [], audio: [media] };
  } catch {
    return { images: [], audio: [] };
  }

  return { images: [], audio: [] };
}

export function normaliseIncomingMessage(event: SendblueWebhookEvent): NormalisedIncomingMessage | null {
  if (!isInboundReceiveWebhook(event)) {
    return null;
  }

  const from = event.from_number?.trim();
  const botNumber = (event.sendblue_number || event.to_number)?.trim();
  const messageId = event.message_handle?.trim();
  if (!from || !botNumber || !messageId) {
    return null;
  }

  const participants = Array.from(new Set((event.participants || []).map((participant) => participant.trim()).filter(Boolean)));
  const groupId = event.group_id?.trim() || null;
  const isGroupChat = !!groupId || participants.filter((participant) => participant !== botNumber).length > 1;
  const chatId = groupId ? `GROUP#${groupId}` : `DM#${botNumber}#${from}`;
  const service = normaliseService(event.service);
  const { images, audio } = extractMedia(event.media_url);

  return {
    chatId,
    from,
    text: event.content?.trim() || '',
    messageId,
    images,
    audio,
    incomingEffect: normaliseStyleToEffect(event.send_style),
    service,
    isGroupChat,
    participantNames: participants.length > 0 ? participants : [from, botNumber],
    chatName: event.group_display_name || null,
    conversation: {
      chatId,
      fromNumber: botNumber,
      recipientNumber: from,
      isGroupChat,
      groupId,
      participants: participants.length > 0 ? participants : [from, botNumber],
      chatName: event.group_display_name || null,
      service,
    },
  };
}

function toSendStyle(effect?: MessageEffect): SendblueMessageStyle | undefined {
  if (!effect) return undefined;

  switch (effect.name) {
    case 'celebration':
    case 'shooting_star':
    case 'fireworks':
    case 'lasers':
    case 'love':
    case 'confetti':
    case 'balloons':
    case 'spotlight':
    case 'echo':
    case 'invisible':
    case 'gentle':
    case 'loud':
    case 'slam':
      return effect.name;
    case 'sparkles':
      return 'shooting_star';
    case 'hearts':
      return 'love';
    case 'happy_birthday':
      return 'celebration';
    case 'invisible_ink':
      return 'invisible';
    default:
      return undefined;
  }
}

export async function sendMessage(
  conversation: ConversationTarget,
  text: string,
  effect?: MessageEffect,
  media?: MediaAttachment[],
): Promise<SendMessageResponse> {
  const mediaUrl = media?.[0]?.url;
  if (!text && !mediaUrl) {
    throw new Error('sendMessage requires text or media');
  }

  const sendStyle = conversation.service === 'iMessage' ? toSendStyle(effect) : undefined;
  const body: Record<string, unknown> = {
    from_number: conversation.fromNumber,
  };

  if (text) body.content = text;
  if (mediaUrl) body.media_url = mediaUrl;
  if (sendStyle) body.send_style = sendStyle;

  if (conversation.isGroupChat) {
    if (conversation.groupId) {
      body.group_id = conversation.groupId;
    } else {
      body.numbers = conversation.participants.filter((participant) => participant !== conversation.fromNumber);
    }

    return sendRequest<SendMessageResponse>('/api/send-group-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  body.number = conversation.recipientNumber;
  return sendRequest<SendMessageResponse>('/api/send-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function markAsRead(conversation: ConversationTarget): Promise<void> {
  if (conversation.service === 'SMS' || conversation.isGroupChat) return;

  await sendRequest('/api/mark-read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      number: conversation.recipientNumber,
      from_number: conversation.fromNumber,
    }),
  });
}

export async function startTyping(conversation: ConversationTarget): Promise<void> {
  if (conversation.service === 'SMS' || conversation.isGroupChat) return;

  await sendRequest('/api/send-typing-indicator', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      number: conversation.recipientNumber,
      from_number: conversation.fromNumber,
    }),
  });
}

const VALID_REACTIONS = new Set([
  'love', 'like', 'dislike', 'laugh', 'emphasize', 'question',
  '-love', '-like', '-dislike', '-laugh', '-emphasize', '-question',
]);

export async function sendReaction(
  messageId: string,
  fromNumber: string,
  reaction: Reaction,
  partIndex?: number,
): Promise<SendReactionResponse> {
  const reactionValue = reaction.type === 'custom' ? reaction.emoji : reaction.type;
  if (!VALID_REACTIONS.has(reactionValue)) {
    console.warn(`[sendblue] Skipping unsupported reaction: ${reactionValue}`);
    return { status: 'skipped', message: `Unsupported reaction: ${reactionValue}` };
  }
  return sendRequest<SendReactionResponse>('/api/send-reaction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from_number: fromNumber,
      message_handle: messageId,
      reaction: reactionValue,
      ...(typeof partIndex === 'number' ? { part_index: partIndex } : {}),
    }),
  });
}

export function shouldProcessBotNumber(botNumber: string): boolean {
  const allowedBotNumbers = getListEnv('SENDBLUE_BOT_NUMBERS');
  return allowedBotNumbers.length === 0 || allowedBotNumbers.includes(botNumber);
}

export function isAllowedSender(handle: string): boolean {
  const allowedSenders = getListEnv('ALLOWED_SENDERS');
  return allowedSenders.length === 0 || allowedSenders.includes(handle);
}

export function isIgnoredSender(handle: string): boolean {
  return getListEnv('IGNORED_SENDERS').includes(handle);
}
