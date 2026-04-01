import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';
import { internalEdgeJsonHeaders } from '../lib/internal-edge-auth.js';
import { formatMissingEdgeFunctionMessage } from '../lib/supabase-edge-function-errors.js';

const openai = new OpenAI();
const anthropic = new Anthropic();

// ═══════════════════════════════════════════════════════════════
// Onboarding identity + agent instructions (from production)
// ═══════════════════════════════════════════════════════════════

const ONBOARDING_IDENTITY = `You are Nest.

Nest is someone people text. A friend, companion, advisor, debate partner, joker, chief of staff, whatever they need in the moment.

This is first-impression mode. You should feel sharp, witty, a bit cheeky, useful, and magnetic straight away. Do not open with intake-style questions.

You are not introduced as a chatbot, bot, product, or tool. If asked who you are: one cheeky line (e.g. smartest contact in their phone). Never "personal assistant" or AI framing, then move back to helping.

Relationship model: trusted operator with a cheeky edge.

Priorities:
- keep the user wanting to text Nest again
- build momentum and curiosity, not friction
- feel fun and semi witty to talk to
- channel subtle "you found me" energy without sounding try-hard
- if you ask a question, make it intriguing and natural
- never use the phrase "what's on your plate" or close variants
- feel interesting, not salesy
- keep the cheekiness light
- stay warm, calm, and low-pressure
- never oversell or dump a feature list

Hard boundaries:
- never mention AI, models, tools, or internal systems unless explicitly asked
- never sound like onboarding copy or customer support
- never get try-hard, smug, or sarcastic
- you cannot make a phone call
- you cannot book anything`;

const CONVERSATION_BEHAVIOR = `Conversation behaviour

Write like a real person texting, not like an article.
Vary sentence length. Fragments are fine when they feel natural.
Do not make every reply symmetrical, polished, or maximally complete.
Mirror the user's energy and tone.
If they swear, you can swear too.

Use restraint.
Do not over-explain simple things.
Do not dump long lists unless they are clearly useful.
Stop when enough has been said.

Match the user's emotional temperature.
Mirror the user's obvious register when it helps.
If they text casually, be casual.
Even when they write in all lowercase, use normal sentence case: capitalise the first letter of every sentence and every message bubble.

Use Australian spelling.
Do not use em dashes.
Only use emojis if the user does first.

Ask questions only when they materially help.
Do not ask a follow-up just to keep the conversation alive.
Do not stack multiple questions across consecutive replies.

Avoid assistant voice.
Do not use phrases like: "Certainly", "Absolutely", "I'd be happy to help", "I understand", "Based on the information provided", "Please let me know", "Here are a few options"

Avoid synthetic empathy, corporate transitions, and performative cleverness.

Continuation handling matters.
Replies to messages like "haha", "yeah true", "wait what", "nah", "mmm maybe", "go on" should feel like a continuation, not a reset.`;

const MESSAGE_SHAPING = `Message shaping

This conversation happens like a text thread.

Use the literal delimiter --- on its own line to split message bubbles.
Line breaks alone do not create separate bubbles.

Lead with the most relevant thing.
If there is more than one distinct idea, split it into natural bubbles.
Each bubble should carry one coherent thought.
Usually 1 to 3 short sentences per bubble is enough.

Do not over-chunk.
One short answer can stay as one bubble.
Two or three bubbles are usually enough for longer replies.

Plain text only.
No markdown headers.
No code blocks unless the user explicitly needs code.
Do not default to bullets or rigid structure unless the task genuinely needs it.`;

const AGENT_INSTRUCTIONS = `## Agent: Onboard
You handle new users who haven't verified yet. Your only job: keep the user engaged and wanting to text Nest again.

Right now (before verification) you can: answer questions, give advice, have a conversation about anything, help draft messages or texts, help organise thoughts and plans, web search for current info, remember things about the user, and be genuinely helpful with whatever they need.

Things that require verification (tease these naturally when relevant): reminders and follow-ups, calendar integration, email access, proactive check-ins.

## The Momentum Play (CRITICAL)
Your #1 goal in the first 2-3 messages is to create momentum and chemistry while learning one real thing about the user: what they care about, what they're doing, what they're avoiding, or what they're curious about.

Once you have it, USE IT. Show them how you'd actually help with that specific thing. Not a generic pitch. A contextual, tailored response that makes them think "oh wait, this is actually useful."
When the user shares something personal, specific, or preference-based, affirm it first so they feel good about sharing. React like a real person, then continue.

The flow:
1. Sharp opener that makes them curious.
2. Your default first question should be asking the user to tell you something about them that is interesting. 
3. If their answer is bland, generic, or low-effort, push back playfully and ask for a genuinely interesting detail.
4. When they answer with something real, first affirm/react, then immediately show value against THAT thing. Draft something, organise something, remember something, look something up. Whatever fits.

The question should feel like genuine curiosity, not an intake form. Keep it casual and slightly cheeky.

If they already volunteered something in their first message, skip the question and go straight to showing value with what they gave you.


Pushback style when their answer is not interesting:
- Keep it cheeky, not rude.
- Example: "nah, that's too safe. give me something actually interesting."
- Example: "cute answer. now give me the real one."
- Example: "that's warm-up chat. i want the interesting version." 

Affirmation examples when they share something:
- User: "i go for the melbourne demons" -> "Oh thank god, anything but collingwood. elite choice."
- User: "i'm cooked from work" -> "Fair, that's a lot. thanks for saying it straight."
- User: "i love early runs" -> "That's strong. most people just talk about doing that."

## First 5-Message Guardrails
Ask at most ONE question at a time. Max 30 words per bubble. Do not ask more than TWO total questions before delivering value. Avoid sending more than one example block. Never stack multiple asks in one message unless tightly coupled. Do not pitch features after value has been discovered naturally. Emotion before workflow. If someone sounds stressed, acknowledge it first.

## Opening Bar
The very first reply should feel sharp and alive. Never sound generic, corporate, or overly polite. Avoid "hey", "hi", "how can I help?", and other flat openers. The first line should make them curious enough to reply.
It should have a subtle "you found me" vibe: intriguing, confident, and playful.

## Edge Cases
If they say no or "not interested" or "stop": back off gracefully. "All good. I'm here whenever you need me"
If they swear: match their energy naturally.
If they ask how you got their info: you didn't, someone gave them your number.
If they ask if you're a bot or AI: deflect naturally. "I'm Nest. Try me with something and see." then move on.
If they ask what you cost: "don't worry about that right now, just try me out"
If they ask about privacy: "I only text when it's useful, and you can ignore me anytime. No setup needed."`;

// ═══════════════════════════════════════════════════════════════
// In-memory session store
// ═══════════════════════════════════════════════════════════════

interface ColumnState {
  messages: Array<{ role: string; content: string }>;
  msgCount: number;
}

/** Matches production iMessage bot so DBG# chats and nest_user rows align. */
const PRODUCTION_BOT_NUMBER = '+13466215973';

interface OnboardSession {
  handle: string;
  chatId: string;
  onboardingToken: string;
  onboardUrl: string;
  /** When true, prompt uses simulated onboard_count (net new). When false, real DB state for the selected handle. */
  simulateNetNew: boolean;
  turnCount: number;
  verificationSent: boolean;
  onboardState: string;
  experimentVariants: Record<string, string>;
  rememberedFacts: string[];
  rememberedName: string | null;
  columnStates: Map<string, ColumnState>;
}

const sessions = new Map<string, OnboardSession>();

function getGeminiClient(): GoogleGenAI | null {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  if (!key) return null;
  return new GoogleGenAI({ apiKey: key });
}

function getColumnState(session: OnboardSession, columnId: string): ColumnState {
  let state = session.columnStates.get(columnId);
  if (!state) {
    state = { messages: [], msgCount: 0 };
    session.columnStates.set(columnId, state);
  }
  return state;
}

type Provider = 'openai' | 'anthropic' | 'gemini';

async function callLLM(
  provider: Provider,
  model: string,
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  userMessage: string,
): Promise<{ text: string; tokens?: number }> {
  if (provider === 'openai') {
    const input: Array<{ role: string; content: string }> = [];
    for (const msg of history) input.push({ role: msg.role, content: msg.content });
    input.push({ role: 'user', content: userMessage });
    const response = await openai.responses.create({
      model,
      instructions: systemPrompt,
      input: input as Parameters<typeof openai.responses.create>[0]['input'],
      max_output_tokens: 4096,
      store: false,
    } as Parameters<typeof openai.responses.create>[0]);
    const openaiResponse = response as unknown as { output_text?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    const text = openaiResponse.output_text ?? '';
    const usage = openaiResponse.usage;
    const tokens = usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : undefined;
    return { text, tokens };
  }

  if (provider === 'anthropic') {
    const messages: Anthropic.MessageParam[] = [];
    for (const msg of history) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
      }
    }
    messages.push({ role: 'user', content: userMessage });
    const response = await anthropic.messages.create({ model, max_tokens: 4096, system: systemPrompt, messages });
    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
    const text = textBlocks.map((b) => b.text).join('\n');
    const tokens = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
    return { text, tokens };
  }

  // gemini
  const client = getGeminiClient();
  if (!client) throw new Error('Gemini API key not configured. Set GEMINI_API_KEY in .env');
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  for (const msg of history) {
    contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] });
  }
  contents.push({ role: 'user', parts: [{ text: userMessage }] });
  const response = await client.models.generateContent({
    model,
    contents,
    config: { systemInstruction: systemPrompt, maxOutputTokens: 4096 },
  });
  const text = response.text ?? '';
  const usage = response.usageMetadata;
  const tokens = usage ? (usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0) : undefined;
  return { text, tokens };
}

// ═══════════════════════════════════════════════════════════════
// Build the onboarding system prompt (replicates prompt-layers.ts)
// ═══════════════════════════════════════════════════════════════

function buildOnboardingPrompt(session: OnboardSession): string {
  const sections: string[] = [
    ONBOARDING_IDENTITY,
    CONVERSATION_BEHAVIOR,
    MESSAGE_SHAPING,
    AGENT_INSTRUCTIONS,
  ];

  const userTurnNumber = session.turnCount + 1;
  const isFirstMessage = session.turnCount === 0;
  const isEarlyConversation = userTurnNumber <= 3;
  const shouldForceVerification = userTurnNumber === 5;

  sections.push(
    `Onboarding Context\nThis is a NEW user who hasn't verified yet. Your only job: be useful immediately. Earn trust fast.`,
  );

  if (isFirstMessage) {
    sections.push(`First Message Guidance
This is the user's very first message to Nest.
Your opener must be unusually engaging. It should feel interesting straight away, not generic or polite-by-default. Be cheeky.
Lead with a sharp, slightly cheeky line that creates curiosity or momentum, then respond directly to what they said.
Do NOT open with "hey", "hi", "how can I help?", "what can I do for you?", or anything that sounds like support.
Keep it under 40 words per bubble.
Do not pitch features.


Default behaviour: You need to try and get the user to tell you something interesting about them, not generic things, something that is unique to them.
If they reply with something bland, generic, or low-effort, push back playfully and ask again for something genuinely interesting.
Keep the pushback cheeky, confident, and brief, never mean.
Your objective is intrigue and momentum so they want to keep texting you.

If they already told you something specific, skip the question and show value immediately.
The goal: keep them wanting to continue the thread while showing fast, specific value. Never use "what's on your plate".`);
  }

  if (session.rememberedName) {
    sections.push(`Known info: User's name is ${session.rememberedName}. Use it naturally.`);
  }
  if (session.rememberedFacts.length > 0) {
    sections.push(`Known facts about user:\n${session.rememberedFacts.map(f => `- ${f}`).join('\n')}`);
  }

  sections.push(`Rescue Logic\nIf the user seems stuck or unsure what to do, suggest:\n"You can text me something you need to remember, a message you want help writing, or a messy list and I'll sort it"`);

  let verificationBlock: string;
  if (isFirstMessage) {
    verificationBlock = `DO NOT include the verification link. Focus entirely on being useful.`;
  } else if (isEarlyConversation) {
    verificationBlock = `Only include the verification link if they explicitly ask how to sign up or get started. Otherwise, keep being useful.`;
  } else if (shouldForceVerification && !session.verificationSent) {
    verificationBlock = `This is the 5th message in the conversation. Casually drop in that you just need to quickly verify they're human — keep it light and natural, not a big deal. Then put the verification link on its own line as a separate bubble:

${session.onboardUrl}

Do not add extra text in the link bubble.`;
  } else if (userTurnNumber > 5) {
    verificationBlock = session.verificationSent
      ? `You already sent the verification link. Don't include it again unless they ask.`
      : `You can naturally work in the verification link now. Frame it as "quick 30 second thing to unlock everything" or similar. Put the link on its own line:\n\n${session.onboardUrl}\n\nDon't include it if you already sent it.`;
  } else {
    verificationBlock = `Only include the verification link if they explicitly ask:\n\n${session.onboardUrl}`;
  }

  sections.push(
    `Verification Link Rules\n${verificationBlock}\n\nFRAMING: Never say "connect your Google account" or "create an account." Frame it as "quick verification", "verify you're human", or "unlock the full experience".\nFORMAT: Always put the link on its own line, never embedded in text.`,
  );

  const now = new Date();
  const formatted = now.toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  sections.push(`Current date and time: ${formatted} AEDT (Australia/Sydney)`);

  sections.push(`Messaging Platform\nThis conversation is happening over iMessage. Reactions and expressive effects can work here.`);

  sections.push(`This is user turn #${userTurnNumber} of the onboarding conversation.`);

  return sections.join('\n\n');
}

// ═══════════════════════════════════════════════════════════════
// Verification bubble enforcement (replicates pipeline.ts)
// ═══════════════════════════════════════════════════════════════

function enforceVerificationBubble(
  text: string | null,
  onboardUrl: string,
  userTurnNumber: number,
  alreadySent: boolean,
): string | null {
  if (alreadySent) return text;
  if (userTurnNumber !== 5) return text;

  if (text && text.includes('nest.expert')) return text;

  const verificationLine = "quick one - i just need to confirm you're a human";
  const injected = `${verificationLine}\n---\n${onboardUrl}`;

  if (!text || !text.trim()) return injected;
  return `${text.trim()}\n---\n${injected}`;
}

// ═══════════════════════════════════════════════════════════════
// remember_user tool extraction from response
// ═══════════════════════════════════════════════════════════════

function extractRememberUserCalls(text: string): { name?: string; fact?: string }[] {
  const calls: { name?: string; fact?: string }[] = [];
  const regex = /remember_user\s*\(\s*\{([^}]+)\}\s*\)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const obj = JSON.parse(`{${match[1]}}`);
      calls.push(obj);
    } catch { /* ignore parse errors */ }
  }
  return calls;
}

// ═══════════════════════════════════════════════════════════════
// Handlers
// ═══════════════════════════════════════════════════════════════

export async function handleOnboardNew(req: Request, res: Response) {
  const supabase = getSupabase();
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  const sessionId = `onboard_${ts}_${rand}`;

  const body = (req.body ?? {}) as { selectedHandle?: string };
  const selectedRaw = typeof body.selectedHandle === 'string' ? body.selectedHandle.trim() : '';
  const selectedHandle = selectedRaw.length > 0 ? selectedRaw : null;

  try {
    let handle: string;
    let chatId: string;
    let simulateNetNew: boolean;

    if (selectedHandle) {
      handle = selectedHandle;
      chatId = `DBG#${PRODUCTION_BOT_NUMBER}#${handle}`;
      simulateNetNew = false;
    } else {
      handle = `+test_${ts}_${rand}`;
      chatId = `DBG#${PRODUCTION_BOT_NUMBER}#${handle}`;
      simulateNetNew = true;
    }

    const { data, error } = await supabase.rpc('ensure_nest_user', {
      p_handle: handle,
      p_bot_number: PRODUCTION_BOT_NUMBER,
    });

    if (error) {
      console.error('[onboard-test] ensure_nest_user failed:', error.message);
      return res.status(500).json({ error: `Failed to create test user: ${error.message}` });
    }

    const rows = data as Array<Record<string, unknown>> | null;
    const row = rows?.[0];
    const token = (row?.out_onboarding_token as string) || crypto.randomUUID();
    const onboardUrl = `https://nest.expert/?token=${token}`;

    const nameVariant = Math.random() < 0.5 ? 'name_first' : 'value_first';
    const promptVariant = Math.random() < 0.5 ? 'open' : 'guided';

    const session: OnboardSession = {
      handle,
      chatId,
      onboardingToken: token,
      onboardUrl,
      simulateNetNew,
      turnCount: 0,
      verificationSent: false,
      onboardState: 'new_user_unclassified',
      experimentVariants: {
        name_first_vs_value_first: nameVariant,
        open_vs_guided: promptVariant,
      },
      rememberedFacts: [],
      rememberedName: null,
      columnStates: new Map(),
    };

    sessions.set(sessionId, session);

    console.log(
      `[onboard-test] Session ${sessionId}: ${simulateNetNew ? 'net new' : 'selected user'} ${handle}`,
    );

    return res.json({
      sessionId,
      handle,
      chatId,
      onboardingToken: token,
      onboardUrl,
      userSource: selectedHandle ? 'selected' : 'synthetic',
      simulateNetNew,
      experimentVariants: session.experimentVariants,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[onboard-test] Error creating session:', message);
    return res.status(500).json({ error: message });
  }
}

// ═══════════════════════════════════════════════════════════════
// Supabase backend call — routes through the production pipeline
// ═══════════════════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL || '';

async function callSupabaseOnboard(
  message: string,
  keepHistory: boolean,
  opts: {
    senderHandle: string;
    simulateNetNew: boolean;
    simulatedOnboardCount: number;
  },
): Promise<Record<string, unknown>> {
  const url = `${SUPABASE_URL}/functions/v1/debug-dashboard?api=run-single`;
  const payload: Record<string, unknown> = {
    message,
    expectedAgent: 'onboard',
    keepHistory,
    forceOnboarding: true,
    senderHandle: opts.senderHandle,
    botNumber: PRODUCTION_BOT_NUMBER,
  };
  if (opts.simulateNetNew) {
    payload.simulatedOnboardCount = opts.simulatedOnboardCount;
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers: internalEdgeJsonHeaders(),
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(
      formatMissingEdgeFunctionMessage('debug-dashboard', resp.status, errBody, 'Supabase onboard call failed'),
    );
  }
  return await resp.json() as Record<string, unknown>;
}

export async function handleOnboardChat(req: Request, res: Response) {
  const { sessionId, message, provider: reqProvider, model: reqModel, columnId } = req.body as {
    sessionId?: string;
    message?: string;
    provider?: string;
    model?: string;
    columnId?: string;
  };

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'Missing sessionId or message' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found. Create a new session first.' });
  }

  const provider = (reqProvider || 'production') as string;
  const colId = columnId || 'default';
  const colState = getColumnState(session, colId);

  const start = Date.now();

  try {
    // Route through the production Supabase pipeline
    const keepHistory = session.turnCount > 0; // keep history after first message
    const result = await callSupabaseOnboard(message, keepHistory, {
      senderHandle: session.handle,
      simulateNetNew: session.simulateNetNew,
      simulatedOnboardCount: session.turnCount,
    });

    let responseText = (result.responseText as string) ?? '';
    const tokens = ((result.inputTokens as number) ?? 0) + ((result.outputTokens as number) ?? 0);
    const model = (result.model as string) ?? 'production';

    const userTurnNumber = session.turnCount + 1;

    if (responseText.includes(session.onboardUrl) || responseText.includes('nest.expert')) {
      session.verificationSent = true;
    }

    colState.messages.push(
      { role: 'user', content: message },
      { role: 'assistant', content: responseText },
    );
    colState.msgCount += 2;

    // Only advance the shared turn count once per user message (first column to respond wins)
    if (session.turnCount < userTurnNumber) {
      session.turnCount = userTurnNumber;
      if (userTurnNumber === 1) session.onboardState = 'new_user_intro_started';
      else if (userTurnNumber === 2) session.onboardState = 'first_value_pending';
      else if (userTurnNumber >= 3) session.onboardState = 'first_value_delivered';
    }

    const latencyMs = Date.now() - start;
    console.log(`[onboard-test] Turn ${userTurnNumber} [production/${model}] col:${colId}: ${latencyMs}ms, ${tokens ?? '?'} tokens`);

    return res.json({
      text: responseText,
      latencyMs,
      tokens,
      provider: 'production',
      model,
      columnId: colId,
      turnNumber: userTurnNumber,
      onboardState: session.onboardState,
      verificationSent: session.verificationSent,
      experimentVariants: session.experimentVariants,
      handle: session.handle,
      onboardUrl: session.onboardUrl,
      // Include trace from production for debugging
      trace: result.trace ?? null,
      toolCalls: result.tools ?? [],
    });
  } catch (err) {
    const latencyMs = Date.now() - start;
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[onboard-test] Error [production] col:${colId} (${latencyMs}ms):`, errMsg);
    return res.status(500).json({ error: errMsg, columnId: colId });
  }
}

// ═══════════════════════════════════════════════════════════════
// Agent mode: local agent loop with tool calling (mirrors production)
// ═══════════════════════════════════════════════════════════════

const ONBOARD_AGENT_MODEL = 'gemini-3.1-flash-lite-preview';
const MAX_AGENT_ROUNDS = 3;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

import { Type } from '@google/genai';

const ONBOARD_TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web for current, real-time information. Use when the user asks about current events, live scores, recent news, or anything requiring up-to-date info.',
    parameters: {
      type: Type.OBJECT,
      properties: { query: { type: Type.STRING, description: 'The search query.' } },
      required: ['query'],
    },
  },
  {
    name: 'remember_user',
    description: "Save information about the user to Nest's memory. Use when you learn genuinely NEW info (name, location, job, preferences, interests).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "The person's name if shared." },
        fact: { type: Type.STRING, description: "A concise factual statement, e.g. 'Lives in Melbourne'." },
        category: { type: Type.STRING, description: 'Semantic category: location, employment, hobby, interest, sport_team, preference, general, etc.' },
      },
    },
  },
  {
    name: 'travel_time',
    description: 'Get travel time and directions between two locations. Supports driving, transit (bus, train, tram), walking, and bicycling.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        origin: { type: Type.STRING, description: 'Starting location (address, place name, or landmark).' },
        destination: { type: Type.STRING, description: 'Destination location (address, place name, or landmark).' },
        mode: { type: Type.STRING, description: "Travel mode: driving, transit, walking, or bicycling. Default driving." },
      },
      required: ['origin', 'destination'],
    },
  },
  {
    name: 'places_search',
    description: 'Search for places, restaurants, cafes, bars, attractions, and businesses. Get details like phone numbers, hours, ratings, and reviews.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Search query (e.g. "best coffee in Melbourne CBD").' },
        place_id: { type: Type.STRING, description: 'Google Place ID from a previous search result for full details.' },
        location: { type: Type.STRING, description: 'Location to bias search results (e.g. "Melbourne CBD").' },
      },
    },
  },
  {
    name: 'send_reaction',
    description: "Send an iMessage tapback reaction to the user's most recent message. Types: love, like, dislike, laugh, emphasize, question.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        type: { type: Type.STRING, description: "Reaction type: love, like, dislike, laugh, emphasize, or question." },
      },
      required: ['type'],
    },
  },
  {
    name: 'send_effect',
    description: 'Add an expressive iMessage effect to your text response. Only use when the moment genuinely calls for it.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        category: { type: Type.STRING, description: "'screen' or 'bubble'." },
        effect: { type: Type.STRING, description: 'The effect name: celebration, fireworks, confetti, balloons, lasers, love, slam, loud, gentle, invisible, etc.' },
      },
      required: ['category', 'effect'],
    },
  },
];

interface AgentToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

const ROUTES_API = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const PLACES_TEXT_SEARCH_API = 'https://places.googleapis.com/v1/places:searchText';
const PLACES_DETAIL_API = 'https://places.googleapis.com/v1/places';

async function executeTravelTime(args: Record<string, unknown>): Promise<string> {
  const origin = args.origin as string;
  const destination = args.destination as string;
  if (!origin || !destination) return JSON.stringify({ error: "Both 'origin' and 'destination' are required." });
  if (!GOOGLE_MAPS_API_KEY) return JSON.stringify({ error: 'Google Maps not configured.' });

  const mode = (args.mode as string) || 'driving';
  const modeMap: Record<string, string> = { driving: 'DRIVE', walking: 'WALK', bicycling: 'BICYCLE', transit: 'TRANSIT' };
  const travelMode = modeMap[mode] || 'DRIVE';

  try {
    const body: Record<string, unknown> = {
      origin: { address: origin },
      destination: { address: destination },
      travelMode,
      routingPreference: travelMode === 'TRANSIT' ? undefined : 'TRAFFIC_AWARE',
      departureTime: new Date().toISOString(),
    };
    if (travelMode === 'TRANSIT') {
      body.transitPreferences = {};
    }

    const fieldMask = travelMode === 'TRANSIT'
      ? 'routes.legs.duration,routes.legs.steps.transitDetails,routes.localizedValues,routes.legs.localizedValues'
      : 'routes.duration,routes.distanceMeters,routes.localizedValues,routes.legs.duration,routes.legs.localizedValues';

    const resp = await fetch(ROUTES_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) return JSON.stringify({ error: data.error?.message || 'Routes API error' });
    return JSON.stringify(data);
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

async function executePlacesSearch(args: Record<string, unknown>): Promise<string> {
  if (!GOOGLE_MAPS_API_KEY) return JSON.stringify({ error: 'Google Maps not configured.' });

  const placeId = args.place_id as string | undefined;
  if (placeId) {
    try {
      const fields = 'displayName,formattedAddress,rating,userRatingCount,currentOpeningHours,nationalPhoneNumber,websiteUri,googleMapsUri,reviews';
      const resp = await fetch(`${PLACES_DETAIL_API}/${placeId}`, {
        headers: { 'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY, 'X-Goog-FieldMask': fields },
      });
      const data = await resp.json();
      if (!resp.ok) return JSON.stringify({ error: data.error?.message || 'Places detail error' });
      return JSON.stringify({
        name: data.displayName?.text,
        address: data.formattedAddress,
        rating: data.rating,
        reviews_count: data.userRatingCount,
        phone: data.nationalPhoneNumber,
        website: data.websiteUri,
        google_maps_url: data.googleMapsUri,
        open_now: data.currentOpeningHours?.openNow,
        reviews: (data.reviews || []).slice(0, 3).map((r: Record<string, unknown>) => ({
          rating: r.rating,
          text: ((r.text as Record<string, unknown>)?.text as string)?.substring(0, 150),
        })),
      });
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  const query = args.query as string;
  if (!query) return JSON.stringify({ error: 'Provide either query or place_id.' });
  const location = args.location as string | undefined;
  const searchQuery = location ? `${query} near ${location}` : query;

  try {
    const resp = await fetch(PLACES_TEXT_SEARCH_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.currentOpeningHours,places.id',
      },
      body: JSON.stringify({ textQuery: searchQuery, maxResultCount: Number(args.max_results) || 5 }),
    });
    const data = await resp.json();
    if (!resp.ok) return JSON.stringify({ error: data.error?.message || 'Places search error' });
    const places = (data.places || []).map((p: Record<string, unknown>) => ({
      name: (p.displayName as Record<string, unknown>)?.text,
      address: p.formattedAddress,
      rating: p.rating,
      reviews_count: p.userRatingCount,
      place_id: p.id,
      open_now: (p.currentOpeningHours as Record<string, unknown>)?.openNow,
    }));
    return JSON.stringify({ results: places });
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

async function executeOnboardTool(
  name: string,
  args: Record<string, unknown>,
  session: OnboardSession,
): Promise<string> {
  if (name === 'web_search') {
    const query = (args.query as string) || '';
    const client = getGeminiClient();
    if (!client) return JSON.stringify({ error: 'Gemini not configured for web search' });
    try {
      const response = await client.models.generateContent({
        model: ONBOARD_AGENT_MODEL,
        contents: [{ role: 'user', parts: [{ text: query }] }],
        config: {
          tools: [{ googleSearch: {} }],
          maxOutputTokens: 2048,
        },
      });
      return response.text ?? 'No results found.';
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (name === 'remember_user') {
    if (args.name && typeof args.name === 'string') {
      session.rememberedName = args.name;
    }
    if (args.fact && typeof args.fact === 'string') {
      session.rememberedFacts.push(args.fact);
    }
    const supabase = getSupabase();
    if (args.name) {
      await supabase.from('user_profiles').update({ name: args.name }).eq('handle', session.handle).then(() => {});
    }
    return JSON.stringify({ success: true, saved: { name: args.name, fact: args.fact, category: args.category } });
  }

  if (name === 'travel_time') return executeTravelTime(args);
  if (name === 'places_search') return executePlacesSearch(args);

  if (name === 'send_reaction') {
    return JSON.stringify({ success: true, reaction: args.type, note: 'Reaction sent (test mode)' });
  }
  if (name === 'send_effect') {
    return JSON.stringify({ success: true, effect: args.effect, note: 'Effect applied (test mode)' });
  }

  return JSON.stringify({ error: `Unknown tool: ${name}` });
}

async function runOnboardAgentLoop(
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  userMessage: string,
  session: OnboardSession,
): Promise<{ text: string; tokens: number; rounds: number; toolCalls: AgentToolCall[]; model: string }> {
  const client = getGeminiClient();
  if (!client) throw new Error('Gemini API key not configured');

  const geminiContents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
  for (const msg of history) {
    geminiContents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] });
  }
  geminiContents.push({ role: 'user', parts: [{ text: userMessage }] });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolDeclarations = ONBOARD_TOOLS as any[];

  let totalTokens = 0;
  const allToolCalls: AgentToolCall[] = [];

  for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
    const response = await client.models.generateContent({
      model: ONBOARD_AGENT_MODEL,
      contents: geminiContents,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 4096,
        tools: [{ functionDeclarations: toolDeclarations }],
      },
    });

    const usage = response.usageMetadata;
    totalTokens += (usage?.promptTokenCount ?? 0) + (usage?.candidatesTokenCount ?? 0);

    const candidates = response.candidates;
    const parts = candidates?.[0]?.content?.parts ?? [];

    let textOutput = '';
    const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    for (const part of parts) {
      const p = part as Record<string, unknown>;
      if (p.text && typeof p.text === 'string') {
        textOutput += p.text;
      }
      if (p.functionCall) {
        const fc = p.functionCall as { name: string; args?: Record<string, unknown> };
        functionCalls.push({ name: fc.name, args: fc.args ?? {} });
      }
    }

    if (functionCalls.length === 0) {
      return { text: textOutput || response.text || '', tokens: totalTokens, rounds: round + 1, toolCalls: allToolCalls, model: ONBOARD_AGENT_MODEL };
    }

    // Feed model output back
    geminiContents.push({ role: 'model', parts: parts as Array<Record<string, unknown>> });

    // Execute tools and build function responses
    const functionResponses: Array<Record<string, unknown>> = [];
    for (const fc of functionCalls) {
      console.log(`[onboard-agent] tool_call: ${fc.name}(${JSON.stringify(fc.args).substring(0, 100)})`);
      const result = await executeOnboardTool(fc.name, fc.args, session);
      allToolCalls.push({ name: fc.name, args: fc.args, result: result.substring(0, 200) });
      functionResponses.push({
        functionResponse: { name: fc.name, response: { content: result } },
      });
    }

    geminiContents.push({ role: 'user', parts: functionResponses });
  }

  // If we exhausted rounds, get final text
  const finalResponse = await client.models.generateContent({
    model: ONBOARD_AGENT_MODEL,
    contents: geminiContents,
    config: { systemInstruction: systemPrompt, maxOutputTokens: 4096 },
  });
  const finalUsage = finalResponse.usageMetadata;
  totalTokens += (finalUsage?.promptTokenCount ?? 0) + (finalUsage?.candidatesTokenCount ?? 0);

  return { text: finalResponse.text || '', tokens: totalTokens, rounds: MAX_AGENT_ROUNDS + 1, toolCalls: allToolCalls, model: ONBOARD_AGENT_MODEL };
}

export async function handleOnboardAgentChat(req: Request, res: Response) {
  const { sessionId, message, columnId } = req.body as {
    sessionId?: string;
    message?: string;
    columnId?: string;
  };

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'Missing sessionId or message' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found. Create a new session first.' });
  }

  const colId = columnId || 'default';
  const colState = getColumnState(session, colId);
  const start = Date.now();

  try {
    // Route through the production Supabase pipeline (same as handleOnboardChat)
    const keepHistory = session.turnCount > 0;
    const result = await callSupabaseOnboard(message, keepHistory, {
      senderHandle: session.handle,
      simulateNetNew: session.simulateNetNew,
      simulatedOnboardCount: session.turnCount,
    });

    const responseText = (result.responseText as string) ?? '';
    const tokens = ((result.inputTokens as number) ?? 0) + ((result.outputTokens as number) ?? 0);
    const model = (result.model as string) ?? 'production';
    const userTurnNumber = session.turnCount + 1;

    colState.messages.push(
      { role: 'user', content: message },
      { role: 'assistant', content: responseText },
    );
    colState.msgCount += 2;

    if (session.turnCount < userTurnNumber) {
      session.turnCount = userTurnNumber;
      if (userTurnNumber === 1) session.onboardState = 'new_user_intro_started';
      else if (userTurnNumber === 2) session.onboardState = 'first_value_pending';
      else if (userTurnNumber >= 3) session.onboardState = 'first_value_delivered';
    }

    if (responseText.includes('nest.expert')) {
      session.verificationSent = true;
    }

    const latencyMs = Date.now() - start;
    console.log(`[onboard-agent] Turn ${userTurnNumber} [production/${model}] col:${colId}: ${latencyMs}ms, ${tokens} tokens`);

    return res.json({
      text: responseText,
      latencyMs,
      tokens,
      provider: 'production',
      model,
      agent: result.agent ?? 'onboard',
      routeAgent: result.agent ?? 'onboard',
      toolCalls: (result.tools as string[] ?? []).map((name: string) => ({ name })),
      agentLoopRounds: result.rounds ?? 0,
      columnId: colId,
      turnNumber: userTurnNumber,
      onboardState: session.onboardState,
      verificationSent: session.verificationSent,
      handle: session.handle,
      onboardUrl: session.onboardUrl,
      trace: result.trace ?? null,
    });
  } catch (err) {
    const latencyMs = Date.now() - start;
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[onboard-agent] Error col:${colId} (${latencyMs}ms):`, errMsg);
    return res.status(500).json({ error: errMsg, columnId: colId });
  }
}

export async function handleOnboardState(req: Request, res: Response) {
  const { sessionId } = req.query as { sessionId?: string };

  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  return res.json({
    handle: session.handle,
    chatId: session.chatId,
    turnCount: session.turnCount,
    onboardState: session.onboardState,
    verificationSent: session.verificationSent,
    experimentVariants: session.experimentVariants,
    onboardUrl: session.onboardUrl,
    onboardingToken: session.onboardingToken,
    messageCount: Array.from(session.columnStates.values()).reduce((sum, col) => sum + col.messages.length, 0),
    rememberedName: session.rememberedName,
    rememberedFacts: session.rememberedFacts,
  });
}
