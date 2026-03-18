// Local dev webhook types (legacy — production uses LINQ edge functions)

export type MessageService = 'iMessage' | 'SMS' | 'RCS';
export type MessageEffect = { type: 'screen' | 'bubble'; name: string };

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

export interface ExtractedMedia {
  url: string;
  mimeType: string;
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

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.heif']);
const AUDIO_EXTENSIONS = new Set(['.caf', '.m4a', '.mp3', '.wav', '.aac', '.ogg', '.oga', '.flac']);
const SCREEN_EFFECTS = new Set(['celebration', 'shooting_star', 'fireworks', 'lasers', 'love', 'confetti', 'balloons', 'spotlight', 'echo']);
const BUBBLE_EFFECTS = new Set(['invisible', 'gentle', 'loud', 'slam']);

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
    if (!mimeType) return { images: [], audio: [] };
    const media = { url: mediaUrl, mimeType };
    if (mimeType.startsWith('image/')) return { images: [media], audio: [] };
    if (mimeType.startsWith('audio/')) return { images: [], audio: [media] };
  } catch {
    return { images: [], audio: [] };
  }
  return { images: [], audio: [] };
}

export function isInboundReceiveWebhook(event: SendblueWebhookEvent): boolean {
  return !event.is_outbound && event.status === 'RECEIVED' && !!event.message_handle;
}

export function normaliseIncomingMessage(event: SendblueWebhookEvent): NormalisedIncomingMessage | null {
  if (!isInboundReceiveWebhook(event)) return null;

  const from = event.from_number?.trim();
  const botNumber = (event.sendblue_number || event.to_number)?.trim();
  const messageId = event.message_handle?.trim();
  if (!from || !botNumber || !messageId) return null;

  const participants = Array.from(new Set((event.participants || []).map(participant => participant.trim()).filter(Boolean)));
  const groupId = event.group_id?.trim() || null;
  const isGroupChat = !!groupId || participants.filter(participant => participant !== botNumber).length > 1;
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
