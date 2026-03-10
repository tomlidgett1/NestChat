const BASE_URL = process.env.SENDBLUE_API_BASE_URL || 'https://api.sendblue.co';
const API_KEY = process.env.SENDBLUE_API_KEY;
const API_SECRET = process.env.SENDBLUE_API_SECRET;

function truncateError(text: string, maxLen = 140): string {
  if (text.includes('<!DOCTYPE') || text.includes('<html')) {
    return '[HTML error page - likely Sendblue backend issue]';
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function getAuthHeaders(): Record<string, string> {
  if (!API_KEY || !API_SECRET) {
    throw new Error('SENDBLUE_API_KEY and SENDBLUE_API_SECRET must be configured');
  }

  return {
    'sb-api-key-id': API_KEY,
    'sb-api-secret-key': API_SECRET,
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
export type MessageService = 'iMessage' | 'SMS' | 'RCS';

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

function toSendStyle(effect?: MessageEffect): SendblueMessageStyle | undefined {
  if (!effect) {
    return undefined;
  }

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

  if (text) {
    body.content = text;
  }

  if (mediaUrl) {
    body.media_url = mediaUrl;
  }

  if (sendStyle) {
    body.send_style = sendStyle;
  }

  if (conversation.isGroupChat) {
    if (conversation.groupId) {
      body.group_id = conversation.groupId;
    } else {
      body.numbers = conversation.participants.filter(participant => participant !== conversation.fromNumber);
    }

    console.log(`[sendblue] Sending group message to ${conversation.chatId}`);
    return sendRequest<SendMessageResponse>('/api/send-group-message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  body.number = conversation.recipientNumber;
  console.log(`[sendblue] Sending message to ${conversation.recipientNumber}`);
  return sendRequest<SendMessageResponse>('/api/send-message', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

export async function markAsRead(conversation: ConversationTarget): Promise<void> {
  if (conversation.service !== 'iMessage' || conversation.isGroupChat) {
    return;
  }

  console.log(`[sendblue] Marking ${conversation.recipientNumber} as read`);
  await sendRequest('/api/mark-read', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      number: conversation.recipientNumber,
      from_number: conversation.fromNumber,
    }),
  });
}

export async function startTyping(conversation: ConversationTarget): Promise<void> {
  if (conversation.service !== 'iMessage' || conversation.isGroupChat) {
    return;
  }

  console.log(`[sendblue] Starting typing indicator for ${conversation.recipientNumber}`);
  await sendRequest('/api/send-typing-indicator', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      number: conversation.recipientNumber,
      from_number: conversation.fromNumber,
    }),
  });
}

export async function sendReaction(
  messageId: string,
  fromNumber: string,
  reaction: Reaction,
  partIndex?: number,
): Promise<SendReactionResponse> {
  const reactionValue = reaction.type === 'custom' ? reaction.emoji : reaction.type;
  console.log(`[sendblue] Sending reaction ${reactionValue} to ${messageId}`);

  return sendRequest<SendReactionResponse>('/api/send-reaction', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from_number: fromNumber,
      message_handle: messageId,
      reaction: reactionValue,
      ...(typeof partIndex === 'number' ? { part_index: partIndex } : {}),
    }),
  });
}
