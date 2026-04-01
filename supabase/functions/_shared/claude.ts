import { getOpenAIClient, isGeminiModel, MODEL_MAP } from './ai/models.ts';
import { geminiSimpleText } from './ai/gemini.ts';
import { getConversation } from './state.ts';
import type { Reaction } from './linq.ts';
import { logApiCost, calculateFixedCost } from './cost-tracker.ts';

// ═══════════════════════════════════════════════════════════════
// Shared OpenAI client (re-exported for backward compat)
// ═══════════════════════════════════════════════════════════════

const openai = getOpenAIClient();

// ═══════════════════════════════════════════════════════════════
// Image generation (DALL-E 3)
// ═══════════════════════════════════════════════════════════════

export async function generateImage(prompt: string): Promise<string | null> {
  const t0 = Date.now();
  try {
    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'standard',
    });
    const url = response.data?.[0]?.url || null;

    // Log DALL-E cost (fire-and-forget)
    import('./supabase.ts').then(({ getAdminClient }) => {
      logApiCost(getAdminClient(), {
        userId: null,
        model: 'dall-e-3',
        endpoint: 'image_gen',
        description: `DALL-E 3 image (1024x1024, standard)`,
        messageType: 'image',
        tokensIn: 0,
        tokensOut: 0,
        costUsdOverride: calculateFixedCost('dall-e-3-standard-1024'),
        latencyMs: Date.now() - t0,
        metadata: { prompt: prompt.substring(0, 500) },
      });
    }).catch(() => {});

    return url;
  } catch (error) {
    console.error('[ai] DALL-E error:', error);

    import('./supabase.ts').then(({ getAdminClient }) => {
      logApiCost(getAdminClient(), {
        userId: null,
        model: 'dall-e-3',
        endpoint: 'image_gen',
        description: 'DALL-E 3 image (failed)',
        messageType: 'image',
        tokensIn: 0,
        tokensOut: 0,
        costUsdOverride: 0,
        latencyMs: Date.now() - t0,
        status: 'error',
        errorMessage: (error as Error).message,
      });
    }).catch(() => {});

    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Effect text generation
// ═══════════════════════════════════════════════════════════════

export async function getTextForEffect(effectName: string): Promise<string> {
  const fastModel = MODEL_MAP.fast;
  const sysPrompt = 'Write a very short, fun message (under 10 words) to accompany the requested effect. Just the message, nothing else.';
  const userMsg = `Write a message to send with a ${effectName} iMessage effect.`;

  if (isGeminiModel(fastModel)) {
    const result = await geminiSimpleText({ model: fastModel, systemPrompt: sysPrompt, userMessage: userMsg });
    return result.text || `✨ ${effectName}! ✨`;
  }

  const response = await openai.responses.create({
    model: fastModel,
    instructions: sysPrompt,
    input: userMsg,
    max_output_tokens: 1024,
    store: false,
  } as Parameters<typeof openai.responses.create>[0]);

  return response.output_text || `✨ ${effectName}! ✨`;
}

// ═══════════════════════════════════════════════════════════════
// Group chat action classification
// ═══════════════════════════════════════════════════════════════

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

  const gcaSysPrompt = `You classify how "Nest" (a personal assistant in a group chat) should handle messages.

IMPORTANT: BIAS TOWARD "respond" - text responses are almost always better than reactions. Only use "react" for very brief acknowledgments where a text response would be awkward.

NEVER use "ignore" when the message is about: directions, how to get somewhere, transit, train, bus, tram, trip, commute, airport, station, maps, walking or driving time, "how long to", travel time, running late, or meeting logistics that need routes. Those always need "respond" so Nest can call live routing tools.

Answer with ONE of these:
- "respond" - Nest should send a text reply.
- "react:love" or "react:like" or "react:laugh" or "react:emphasize" - standard tapbacks, ONLY for brief acknowledgments where text would be weird.
- "react:custom:EMOJI" - react with any emoji (e.g. "react:custom:🔥"), for when a specific emoji fits better than a standard tapback.
- "ignore" - Pure human-to-human side chat with zero question or task for Nest (e.g. two mates arranging dinner times between themselves with no ask of Nest)`;
  const gcaUserMsg = `${contextBlock}New message from ${sender}: "${message}"\n\nHow should Nest handle this?`;

  try {
    let answer: string;
    const fastModel = MODEL_MAP.fast;

    if (isGeminiModel(fastModel)) {
      const result = await geminiSimpleText({ model: fastModel, systemPrompt: gcaSysPrompt, userMessage: gcaUserMsg, maxOutputTokens: 256 });
      answer = (result.text || 'respond').toLowerCase().trim();
    } else {
      const response = await openai.responses.create({
        model: fastModel,
        instructions: gcaSysPrompt,
        input: gcaUserMsg,
        max_output_tokens: 256,
        store: false,
      } as Parameters<typeof openai.responses.create>[0]);
      answer = (response.output_text || 'respond').toLowerCase().trim();
    }
    if (answer.includes('respond')) return { action: 'respond' };
    if (answer.includes('react')) {
      const customMatch = answer.match(/react:custom:(.+)/);
      if (customMatch) {
        const emoji = customMatch[1].trim();
        return { action: 'react', reaction: { type: 'custom', emoji } };
      }
      if (answer.includes('love')) return { action: 'react', reaction: { type: 'love' } };
      if (answer.includes('laugh')) return { action: 'react', reaction: { type: 'laugh' } };
      if (answer.includes('emphasize')) return { action: 'react', reaction: { type: 'emphasize' } };
      return { action: 'react', reaction: { type: 'like' } };
    }
    console.log(`[ai] groupChatAction classified as IGNORE for ${chatId}: "${message.substring(0, 80)}"`);
    return { action: 'ignore' };
  } catch (error) {
    console.error('[ai] groupChatAction error, defaulting to respond:', error);
    return { action: 'respond' };
  }
}
