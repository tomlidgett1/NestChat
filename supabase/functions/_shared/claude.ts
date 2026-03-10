import Anthropic from 'npm:@anthropic-ai/sdk@0.39.0';
import OpenAI from 'npm:openai@6.16.0';
import {
  addMessage,
  addUserFact,
  clearConversation,
  clearUserProfile,
  getConversation,
  type StoredMessage,
  setUserName,
  type UserProfile,
  insertToolTrace,
  getRecentToolTraces,
  getConversationSummaries,
  getActiveMemoryItems,
  rejectMemoryItem,
  rejectAllMemoryItems,
  type MemoryItem,
  type ConversationSummary,
  type ToolTrace,
} from './state.ts';
import { MEMORY_V2_ENABLED } from './env.ts';

const client = new Anthropic({
  apiKey: Deno.env.get('ANTHROPIC_API_KEY'),
});

const openai = new OpenAI({
  apiKey: Deno.env.get('OPENAI_API_KEY'),
});

const SYSTEM_PROMPT = `You are Nest, an AI assistant accessible by text message. NEVER mention who built you, your tech stack, backend architecture, or any implementation details. If asked, deflect naturally and wittyly.

## Capabilities
If someone asks what you can do, here's what's available:
- Reminders
- Web Search
- Knowledge
- Calendar + Email
- Second brain
- Research nerd
- Personal assistant who never forgets
- Someone who settles debates at 2am
- Restaurant recommender
- Travel planner
Note: Dont ever just list all these, slowly reveal them as you go.

## Memory (CRITICAL)
You have a remember_user tool. You MUST call it whenever:
1. Someone shares personal info (name, location, job, interests, etc.)
2. Someone CORRECTS something you had wrong ("actually I live in Sydney" when you thought Melbourne)
3. Someone shares plans, preferences, or important life updates

NEVER just acknowledge info in text without saving it. If someone tells you something worth remembering, ALWAYS call remember_user. Saying "got it" in text does NOT save anything — only the tool call does.

## Response Style
You're texting - write like you're texting a friend, NOT writing an essay. You are witty and smart, and channel casual gen z texting vibes.

CRITICAL - MESSAGE SPLITTING (you MUST follow this):
You are sending iMessages. Each "---" in your response becomes a SEPARATE text bubble.
ALWAYS split your response into multiple bubbles using "---" between them.

Example of correct formatting:
Hey whats up
---
Yeah i can help with that
---
Basically what you wanna do is check the settings first

NEVER send a single long message. Even a 2-sentence reply should be split:
Oh nice thats cool
---
What are you working on?

Rules:
- EVERY response with more than one thought MUST use "---" to split into separate bubbles
- Each bubble should be 1-2 sentences max
- Aim for 2-4 bubbles per response
- Only a very short single-word or single-sentence reply (like "lol" or "nice") can skip splitting
- Always use METRIC system, not imperial.

Guidelines:
- Only use markdown (bullets, headers, bold, numbered lists) when data is being presented (transit, facts, weather, etc.)
- For structured info, use simple formatting that works in iMessage:
  Example for transit:
  **Caltrain to SF**
  • Departs: 10:15am
  • Arrives: 10:45am
  • Platform 2
- Uppercase by default for first word of each sentence - skip caps unless you're emphasizing something
- Casual abbreviations can be used SOMETIME, but ONLY if the user users them first - "u", "ur", "rn", "tbh", "ngl"
- Gen Z phrases VERY RARELY (like once every few convos max) - "lowkey", "valid", "real". dont force it
- Only use emojis is the user also uses them.

The vibe is: natural, chill, like texting a friend. Write normally but casual - dont try to sound like a gen z tiktok. If slang feels forced, skip it.

You can search the web for current information like weather, news, sports scores, etc. Use web search when you need up-to-date information.

## Reactions
You can react to messages using iMessage tapbacks, but TEXT RESPONSES ARE PREFERRED.

Available reactions: love, like, dislike, laugh, emphasize, question

CRITICAL REACTION RULES:
1. DEFAULT to text responses - reactions are supplementary, not primary
2. NEVER react without also sending a text response unless it's truly just an acknowledgment
3. If you've reacted recently, DO NOT react again - respond with text instead
4. If someone is asking you something or talking to you, RESPOND WITH TEXT
5. Reactions alone can feel dismissive - when in doubt, send text
6. NEVER write "[reacted with ...]" in your text - that's just a system marker in history! When you use send_reaction, just send normal text alongside it

When to use reactions (sparingly):
- love: Heartfelt news (promotions, engagements)
- like: Simple acknowledgment when no text response needed
- laugh: Genuinely funny messages

ANTI-LOOP PROTECTION: If the conversation feels like it's become mostly reactions, BREAK THE PATTERN by sending a proper text response. People want to talk to you, not just get tapbacks.

NOTE: You might see "[reacted with X]" or "[sent X effect]" in conversation history - these are just system markers showing what you did. NEVER write these in your actual responses!

## Message Effects
You can add expressive effects to your responses, but ONLY when explicitly requested or for truly special moments.`;

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
  return `- [${m.category}] ${m.valueText}${qualifier}`;
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
    const header = `**${label}:**\n`;
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
    const topicStr = s.topics.length > 0 ? ` [${s.topics.join(', ')}]` : '';
    const line = `- (${timeAgo})${topicStr} ${s.summary}`;
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
    const detail = t.safeSummary ? `: ${t.safeSummary}` : '';
    const line = `- (${timeAgo}) ${t.toolName}${detail} → ${t.outcome}`;
    const lineTokens = estimateTokens(line + '\n');
    if (tokensUsed + lineTokens > TOKEN_BUDGET.toolTraces) break;
    tokensUsed += lineTokens;
    lines.push(line);
  }

  return lines.join('\n');
}

function buildSystemPrompt(chatContext?: ChatContext): string {
  let prompt = SYSTEM_PROMPT;

  if (chatContext?.senderHandle) {
    const hasV2Memory = MEMORY_V2_ENABLED && chatContext.memoryItems && chatContext.memoryItems.length > 0;

    if (hasV2Memory) {
      const identityItems = chatContext.memoryItems!.filter((m) => m.memoryType === 'identity');
      const knownName = identityItems.find((m) => m.category === 'name')?.valueText;

      prompt += `\n\n## What you know about this person (ALREADY SAVED — do NOT re-save!)`;
      prompt += `\nHandle: ${chatContext.senderHandle}`;
      if (knownName) {
        prompt += `\nName: ${knownName}`;
      }
      prompt += `\n${formatMemoryItemsForPrompt(chatContext.memoryItems!)}`;
      prompt += `\n\nUse their name naturally. Use remember_user for genuinely NEW info OR to CORRECT info that's wrong (e.g. if they say "actually I live in Sydney" and you have "Melbourne" saved, call remember_user with the corrected fact).`;
    } else {
      const profile = chatContext.senderProfile;
      if (profile?.name || (profile?.facts && profile.facts.length > 0)) {
      prompt += `\n\n## About the person you're talking to (YOU ALREADY KNOW THIS)`;
      prompt += `\nHandle: ${chatContext.senderHandle}`;
      if (profile.name) {
        prompt += `\nName: ${profile.name}`;
      }
      if (profile.facts && profile.facts.length > 0) {
        prompt += `\nThings you remember about them:\n- ${profile.facts.join('\n- ')}`;
      }
      prompt += `\n\nUse their name naturally. Use remember_user for NEW info or to CORRECT wrong info (e.g. if they say "actually I live in Sydney" and you have "Melbourne" saved, call remember_user with the corrected fact).`;
      } else {
        prompt += `\n\n## About the person you're talking to\nHandle: ${chatContext.senderHandle}\nYou don't know their name yet. If they share it or it comes up naturally, use the remember_user tool to save it!`;
      }
    }
  }

  if (chatContext?.conversationSummaries && chatContext.conversationSummaries.length > 0) {
    prompt += `\n\n## Earlier conversation context (summaries of past messages)\n${formatSummariesForPrompt(chatContext.conversationSummaries)}`;
  }

  if (chatContext?.toolTraces && chatContext.toolTraces.length > 0) {
    prompt += `\n\n## Recent tool usage\n${formatToolTracesForPrompt(chatContext.toolTraces)}`;
  }

  if (chatContext?.isGroupChat) {
    const participants = chatContext.participantNames.join(', ');
    const chatName = chatContext.chatName ? `"${chatContext.chatName}"` : 'an unnamed group';
    prompt += `\n\n## Group Chat Context\nYou're in a group chat called ${chatName} with these participants: ${participants}\n\nIn group chats:\n- Address people by name when responding to them specifically\n- Be aware others can see your responses\n- Keep responses even shorter since group chats move fast\n- Dont react as often in groups - it can feel spammy`;
  }

  if (chatContext?.incomingEffect) {
    prompt += `\n\n## Incoming Message Effect\nThe user sent their message with a ${chatContext.incomingEffect.type} effect: "${chatContext.incomingEffect.name}". You can acknowledge this if relevant (e.g., "nice ${chatContext.incomingEffect.name} effect!").`;
  }

  if (chatContext?.service) {
    prompt += `\n\n## Messaging Platform\nThis conversation is happening over ${chatContext.service}.`;
    if (chatContext.service === 'iMessage') {
      prompt += ' Reactions and expressive effects can work here.';
    } else if (chatContext.service === 'RCS') {
      prompt += ' Prefer plain text and media. Avoid assuming expressive effects or typing indicators are available.';
    } else if (chatContext.service === 'SMS') {
      prompt += ' This is basic SMS - avoid reactions and expressive effects. Keep responses simple and concise.';
    }
  }

  return prompt;
}

const REACTION_TOOL: Anthropic.Tool = {
  name: 'send_reaction',
  description: 'Send an iMessage tapback reaction to the user\'s message. Only use standard tapbacks: love, like, dislike, laugh, emphasize, question.',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'],
      },
    },
    required: ['type'],
  },
};

const EFFECT_TOOL: Anthropic.Tool = {
  name: 'send_effect',
  description: 'Add an expressive iMessage effect to your text response. ONLY use when the user explicitly asks for an effect. You MUST also write a text message.',
  input_schema: {
    type: 'object' as const,
    properties: {
      effect_type: {
        type: 'string',
        enum: ['screen', 'bubble'],
      },
      effect: {
        type: 'string',
        enum: ['celebration', 'shooting_star', 'fireworks', 'lasers', 'love', 'confetti', 'balloons', 'spotlight', 'echo', 'slam', 'loud', 'gentle', 'invisible'],
      },
    },
    required: ['effect_type', 'effect'],
  },
};

const REMEMBER_USER_TOOL: Anthropic.Tool = {
  name: 'remember_user',
  description: 'Save or update information about someone. Use when you learn NEW info OR when someone CORRECTS previously saved info (e.g. "actually I live in Sydney not Melbourne"). You MUST write a text response too. Include a category when possible — e.g. "location" for where they live, "employment" for their job, "sport_team" for a team they support, "food" for diet/preferences, "hobby" for activities, "health" for medical/allergies.',
  input_schema: {
    type: 'object' as const,
    properties: {
      handle: { type: 'string' },
      name: { type: 'string' },
      fact: { type: 'string' },
      category: {
        type: 'string',
        description: 'Semantic category: location, employment, education, age, birthday, relationship_status, nationality, native_language, sport_team, music, food, pet, hobby, interest, skill, travel, health, preference, language, or general.',
      },
    },
  },
};

const GENERATE_IMAGE_TOOL: Anthropic.Tool = {
  name: 'generate_image',
  description: 'Generate an image using DALL-E. Expand the request into a detailed prompt and also write a short text reply.',
  input_schema: {
    type: 'object' as const,
    properties: {
      prompt: { type: 'string' },
    },
    required: ['prompt'],
  },
};

const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
} as unknown as Anthropic.Tool;

export type StandardReactionType = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';
export type ReactionType = StandardReactionType | 'custom';
export type MessageEffect = { type: 'screen' | 'bubble'; name: string };
export type Reaction = { type: StandardReactionType } | { type: 'custom'; emoji: string };

export interface ChatResponse {
  text: string | null;
  reaction: Reaction | null;
  effect: MessageEffect | null;
  rememberedUser: { name?: string; fact?: string; isForSender?: boolean } | null;
  generatedImage: { url: string; prompt: string } | null;
}

export interface ImageInput {
  url: string;
  mimeType: string;
}

export interface AudioInput {
  url: string;
  mimeType: string;
}

export type MessageService = 'iMessage' | 'SMS' | 'RCS';

export interface ChatContext {
  isGroupChat: boolean;
  participantNames: string[];
  chatName: string | null;
  incomingEffect?: { type: 'screen' | 'bubble'; name: string };
  senderHandle?: string;
  senderProfile?: UserProfile | null;
  service?: MessageService;
  memoryItems?: MemoryItem[];
  conversationSummaries?: ConversationSummary[];
  toolTraces?: ToolTrace[];
}

export async function generateImage(prompt: string): Promise<string | null> {
  try {
    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'standard',
    });
    return response.data?.[0]?.url || null;
  } catch (error) {
    console.error('[claude] DALL-E error:', error);
    return null;
  }
}

async function transcribeAudio(url: string): Promise<string | null> {
  try {
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
    console.error('[claude] Transcription error:', error);
    return null;
  }
}

function formatRelativeTime(isoString: string | undefined): string {
  if (!isoString) return '';
  const now = Date.now();
  const then = new Date(isoString).getTime();
  if (isNaN(then)) return '';

  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHr / 24);

  if (diffSec < 30) return 'just now';
  if (diffMin < 1) return `${diffSec}s ago`;
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHr < 24) return `${diffHr} hr ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return `${Math.floor(diffDays / 7)}w ago`;
}

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

    if (timeTag) {
      content = `[${timeTag}] ${content}`;
    }

    if (toolNotes) {
      content = `${content}${toolNotes}`;
    }

    return { role: message.role, content };
  });
}

export async function chat(chatId: string, userMessage: string, images: ImageInput[] = [], audio: AudioInput[] = [], chatContext?: ChatContext): Promise<ChatResponse> {
  const emptyResponse = {
    reaction: null,
    effect: null,
    rememberedUser: null,
    generatedImage: null,
  };

  const cmd = userMessage.toLowerCase().trim();
  if (cmd === '/help') {
    return {
      text: 'commands:\n/clear - reset our conversation\n/forget me - erase what i know about you\n/memory - see what i remember about you\n/memory delete <id> - remove a specific memory\n/memory clear - wipe all your memories\n/help - this message',
      ...emptyResponse,
    };
  }

  if (cmd === '/clear') {
    await clearConversation(chatId);
    return {
      text: 'conversation cleared, fresh start 🧹',
      ...emptyResponse,
    };
  }

  if (cmd === '/forget me' || cmd === '/forgetme') {
    if (chatContext?.senderHandle) {
      await clearUserProfile(chatContext.senderHandle);
      if (MEMORY_V2_ENABLED) {
        await rejectAllMemoryItems(chatContext.senderHandle);
      }
      return {
        text: "done, i've forgotten everything about you. we're strangers now 👋",
        ...emptyResponse,
      };
    }
    return {
      text: "hmm couldn't figure out who you are to forget you",
      ...emptyResponse,
    };
  }

  if (cmd === '/memory') {
    if (!chatContext?.senderHandle) {
      return { text: "couldn't identify you to look up memories", ...emptyResponse };
    }
    const memories = await getActiveMemoryItems(chatContext.senderHandle, 50);
    if (memories.length === 0) {
      return { text: "i don't have any memories saved for you yet", ...emptyResponse };
    }

    const grouped = new Map<string, MemoryItem[]>();
    for (const m of memories) {
      const group = grouped.get(m.category) ?? [];
      group.push(m);
      grouped.set(m.category, group);
    }

    const sections: string[] = [];
    for (const [category, items] of grouped) {
      const lines = items.map((m) => {
        const conf = m.confidence < 0.6 ? ' ⚠️' : '';
        return `  #${m.id} — ${m.valueText}${conf}`;
      });
      sections.push(`**${category}**\n${lines.join('\n')}`);
    }

    const header = `here's everything i remember about you (${memories.length} items):\n\n`;
    const footer = '\n\nuse "/memory delete <id>" to remove one, or "/memory clear" to wipe everything';
    return { text: header + sections.join('\n\n') + footer, ...emptyResponse };
  }

  if (cmd.startsWith('/memory delete ')) {
    if (!chatContext?.senderHandle) {
      return { text: "couldn't identify you", ...emptyResponse };
    }
    const idStr = cmd.replace('/memory delete ', '').trim();
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      return { text: `"${idStr}" isn't a valid memory id — use /memory to see your memories with their ids`, ...emptyResponse };
    }
    const deleted = await rejectMemoryItem(id, chatContext.senderHandle);
    if (deleted) {
      return { text: `done, memory #${id} has been deleted`, ...emptyResponse };
    }
    return { text: `couldn't find memory #${id} — it might not exist or belong to you`, ...emptyResponse };
  }

  if (cmd === '/memory clear') {
    if (!chatContext?.senderHandle) {
      return { text: "couldn't identify you", ...emptyResponse };
    }
    const count = await rejectAllMemoryItems(chatContext.senderHandle);
    if (count > 0) {
      return { text: `done, cleared ${count} memories. fresh start`, ...emptyResponse };
    }
    return { text: "you didn't have any active memories to clear", ...emptyResponse };
  }

  const historyPromise = getConversation(chatId);

  let memoryPromise: Promise<MemoryItem[]>;
  if (MEMORY_V2_ENABLED && chatContext?.senderHandle) {
    const { getRelevantMemoryItems } = await import('./memory.ts');
    memoryPromise = getRelevantMemoryItems(chatContext.senderHandle, userMessage, 20);
  } else {
    memoryPromise = Promise.resolve([] as MemoryItem[]);
  }

  const summariesPromise = MEMORY_V2_ENABLED
    ? getConversationSummaries(chatId, 10)
    : Promise.resolve([] as ConversationSummary[]);

  const tracesPromise = MEMORY_V2_ENABLED
    ? getRecentToolTraces(chatId, 10)
    : Promise.resolve([] as ToolTrace[]);

  const [history, memoryItems, rawSummaries, rawTraces] = await Promise.all([
    historyPromise,
    memoryPromise,
    summariesPromise,
    tracesPromise,
  ]);

  let conversationSummaries = rawSummaries;
  let toolTraces = rawTraces;

  if (MEMORY_V2_ENABLED) {
    const { getRelevantSummaries, getRelevantToolTraces } = await import('./memory.ts');
    conversationSummaries = getRelevantSummaries(rawSummaries, userMessage, 5);
    toolTraces = getRelevantToolTraces(rawTraces, userMessage, 5);
  }

  if (chatContext && MEMORY_V2_ENABLED) {
    chatContext.memoryItems = memoryItems;
    chatContext.conversationSummaries = conversationSummaries;
    chatContext.toolTraces = toolTraces;
  }

  const messageContent: Anthropic.ContentBlockParam[] = [];

  for (const image of images) {
    messageContent.push({
      type: 'image',
      source: {
        type: 'url',
        url: image.url,
      },
    });
  }

  const transcriptions: string[] = [];
  let transcriptionFailed = false;
  for (const audioFile of audio) {
    const transcript = await transcribeAudio(audioFile.url);
    if (transcript) transcriptions.push(transcript);
    else transcriptionFailed = true;
  }

  let textToSend = userMessage.trim();
  if (transcriptions.length > 0) {
    const transcriptText = transcriptions.join('\n');
    textToSend = textToSend
      ? `[Voice memo transcript: "${transcriptText}"]\n\n${textToSend}`
      : `[Voice memo transcript: "${transcriptText}"]\n\nRespond naturally to what they said in the voice memo.`;
  } else if (audio.length > 0 && transcriptionFailed) {
    textToSend = textToSend || '[Someone sent a voice memo but transcription failed. Let them know you could not hear it and ask them to try again or type their message.]';
  } else if (!textToSend && images.length > 0) {
    textToSend = "What's in this image?";
  }

  if (textToSend) {
    messageContent.push({ type: 'text', text: textToSend });
    await addMessage(chatId, 'user', textToSend, chatContext?.senderHandle, {
      isGroupChat: chatContext?.isGroupChat,
      chatName: chatContext?.chatName,
      participantNames: chatContext?.participantNames,
      service: chatContext?.service,
    });
  }

  const formattedHistory = formatHistoryForClaude(history, chatContext?.isGroupChat ?? false);
  const tools: Anthropic.Tool[] = [REACTION_TOOL, EFFECT_TOOL, REMEMBER_USER_TOOL, GENERATE_IMAGE_TOOL, WEB_SEARCH_TOOL];

  const systemPrompt = buildSystemPrompt(chatContext);
  const apiMessages: Anthropic.MessageParam[] = [...formattedHistory, { role: 'user', content: messageContent }];

  const textParts: string[] = [];
  let reaction: Reaction | null = null;
  let effect: MessageEffect | null = null;
  let rememberedUser: { name?: string; fact?: string; isForSender?: boolean } | null = null;
  let generatedImage: { url: string; prompt: string } | null = null;
  const toolsUsed: Array<{ tool: string; detail?: string }> = [];

  const MAX_TOOL_ROUNDS = 3;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let response;
    try {
      response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        tools,
        messages: apiMessages,
      });
    } catch (apiErr) {
      throw apiErr;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use' && block.name === 'send_reaction') {
        const input = block.input as { type: ReactionType; emoji?: string };
        reaction = input.type === 'custom' && input.emoji
          ? { type: 'custom', emoji: input.emoji }
          : { type: input.type as StandardReactionType };
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Reaction sent.' });
        toolsUsed.push({ tool: 'send_reaction', detail: reaction.type === 'custom' ? reaction.emoji : reaction.type });
      } else if (block.type === 'tool_use' && block.name === 'send_effect') {
        const input = block.input as { effect_type: 'screen' | 'bubble'; effect: string };
        effect = { type: input.effect_type, name: input.effect };
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Effect queued.' });
        toolsUsed.push({ tool: 'send_effect', detail: effect.name });
      } else if (block.type === 'tool_use' && block.name === 'remember_user') {
        const input = block.input as { handle?: string; name?: string; fact?: string; category?: string };
        const targetHandle = input.handle || chatContext?.senderHandle;
        let resultMsg = 'Saved.';
        if (targetHandle) {
          let nameChanged = false;
          let factChanged = false;
          if (input.name) {
            nameChanged = await setUserName(targetHandle, input.name);
          }
          if (input.fact) {
            factChanged = await addUserFact(targetHandle, input.fact);
          }

          if (MEMORY_V2_ENABLED) {
            try {
              const { processRealtimeMemory } = await import('./memory.ts');
              await processRealtimeMemory(
                targetHandle,
                input.fact || '',
                input.name,
                chatId,
                input.category,
              );
            } catch (err) {
              console.error('[claude] Memory v2 write failed, legacy write still succeeded:', err);
            }
          }

          if (nameChanged || factChanged) {
            rememberedUser = {
              name: nameChanged ? input.name : undefined,
              fact: factChanged ? input.fact : undefined,
              isForSender: !input.handle || input.handle === chatContext?.senderHandle,
            };
            resultMsg = 'Saved successfully.';
          } else {
            resultMsg = 'Already known, no update needed.';
          }
          const parts = [rememberedUser?.name ? `name: ${rememberedUser.name}` : '', rememberedUser?.fact ? rememberedUser.fact : ''].filter(Boolean);
          if (parts.length > 0) toolsUsed.push({ tool: 'remember_user', detail: parts.join(', ') });
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultMsg });
      } else if (block.type === 'tool_use' && block.name === 'generate_image') {
        const input = block.input as { prompt: string };
        generatedImage = { url: '', prompt: input.prompt };
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Image generation queued. It will be sent after your text reply.' });
        toolsUsed.push({ tool: 'generate_image', detail: generatedImage.prompt.substring(0, 60) });
      } else if (block.type === 'tool_use') {
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Done.' });
        if (block.name === 'web_search') toolsUsed.push({ tool: 'web_search' });
      }
    }

    if (response.stop_reason !== 'tool_use' || toolResults.length === 0) {
      break;
    }

    apiMessages.push({ role: 'assistant', content: response.content });
    apiMessages.push({ role: 'user', content: toolResults });
  }

  const messageMetadata = toolsUsed.length > 0 ? { tools_used: toolsUsed } : undefined;

  const textResponse = textParts.length > 0 ? textParts.join('\n') : null;
  if (textResponse) {
    const historyMessage = textResponse.split('---').map((part) => part.trim()).filter(Boolean).join(' ');
    await addMessage(chatId, 'assistant', historyMessage, undefined, {
      isGroupChat: chatContext?.isGroupChat,
      chatName: chatContext?.chatName,
      participantNames: chatContext?.participantNames,
      service: chatContext?.service,
      metadata: messageMetadata,
    });
  } else if (effect) {
    await addMessage(chatId, 'assistant', `[sent ${effect.name} effect]`);
  } else if (reaction) {
    const reactionDisplay = reaction.type === 'custom' ? reaction.emoji : reaction.type;
    await addMessage(chatId, 'assistant', `[reacted with ${reactionDisplay}]`);
  }

  if (MEMORY_V2_ENABLED) {
    const tracePromises = toolsUsed.map((t) =>
      insertToolTrace({
        chatId,
        toolName: t.tool,
        outcome: 'success',
        safeSummary: t.detail ?? null,
      }),
    );
    await Promise.allSettled(tracePromises);
  }

  return { text: textResponse, reaction, effect, rememberedUser, generatedImage };
}

export async function getTextForEffect(effectName: string): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: `Write a very short, fun message (under 10 words) to send with a ${effectName} iMessage effect. Just the message, nothing else.`,
    }],
  });

  if (response.content[0].type === 'text') {
    return response.content[0].text;
  }

  return `✨ ${effectName}! ✨`;
}

export type GroupChatAction = 'respond' | 'react' | 'ignore';

export async function getGroupChatAction(message: string, sender: string, chatId: string): Promise<{ action: GroupChatAction; reaction?: Reaction }> {
  const history = await getConversation(chatId, 4);
  let contextBlock = '';

  if (history.length > 0) {
    const formatted = history.map((entry) => {
      if (entry.role === 'assistant') return `Nest: ${entry.content}`;
      return `${entry.handle || 'Someone'}: ${entry.content}`;
    }).join('\n');
    contextBlock = `\nRecent conversation:\n${formatted}\n`;
  }

  try {
    const response = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 20,
      system: `You classify how an AI assistant "Nest" should handle messages in a group chat.

IMPORTANT: BIAS TOWARD "respond" - text responses are almost always better than reactions. Only use "react" for very brief acknowledgments where a text response would be awkward.

Answer with ONE of these:
- "respond" - Nest should send a text reply.
- "react:love" or "react:like" or "react:laugh" - ONLY for brief acknowledgments where text would be weird.
- "ignore" - Human-to-human conversation not involving Nest at all`,
      messages: [{
        role: 'user',
        content: `${contextBlock}New message from ${sender}: "${message}"\n\nHow should Nest handle this?`,
      }],
    });

    const answer = response.content[0].type === 'text' ? response.content[0].text.toLowerCase().trim() : 'ignore';
    if (answer.includes('respond')) return { action: 'respond' };
    if (answer.includes('react')) {
      if (answer.includes('love')) return { action: 'react', reaction: { type: 'love' } };
      if (answer.includes('laugh')) return { action: 'react', reaction: { type: 'laugh' } };
      if (answer.includes('emphasize')) return { action: 'react', reaction: { type: 'emphasize' } };
      return { action: 'react', reaction: { type: 'like' } };
    }
    return { action: 'ignore' };
  } catch (error) {
    console.error('[claude] groupChatAction error:', error);
    return { action: 'ignore' };
  }
}
