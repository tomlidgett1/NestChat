import { getOpenAIClient, isGeminiModel, MODEL_MAP } from './ai/models.ts';
import { geminiSimpleText } from './ai/gemini.ts';
import { getConversation } from './state.ts';
import type { Reaction } from './sendblue.ts';

// ═══════════════════════════════════════════════════════════════
// Shared OpenAI client (re-exported for backward compat)
// ═══════════════════════════════════════════════════════════════

const openai = getOpenAIClient();

// ═══════════════════════════════════════════════════════════════
// Image generation (DALL-E 3)
// ═══════════════════════════════════════════════════════════════

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
    console.error('[ai] DALL-E error:', error);
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

Answer with ONE of these:
- "respond" - Nest should send a text reply.
- "react:love" or "react:like" or "react:laugh" - ONLY for brief acknowledgments where text would be weird.
- "ignore" - Human-to-human conversation not involving Nest at all`;
  const gcaUserMsg = `${contextBlock}New message from ${sender}: "${message}"\n\nHow should Nest handle this?`;

  try {
    let answer: string;
    const fastModel = MODEL_MAP.fast;

    if (isGeminiModel(fastModel)) {
      const result = await geminiSimpleText({ model: fastModel, systemPrompt: gcaSysPrompt, userMessage: gcaUserMsg, maxOutputTokens: 256 });
      answer = (result.text || 'ignore').toLowerCase().trim();
    } else {
      const response = await openai.responses.create({
        model: fastModel,
        instructions: gcaSysPrompt,
        input: gcaUserMsg,
        max_output_tokens: 256,
        store: false,
      } as Parameters<typeof openai.responses.create>[0]);
      answer = (response.output_text || 'ignore').toLowerCase().trim();
    }
    if (answer.includes('respond')) return { action: 'respond' };
    if (answer.includes('react')) {
      if (answer.includes('love')) return { action: 'react', reaction: { type: 'love' } };
      if (answer.includes('laugh')) return { action: 'react', reaction: { type: 'laugh' } };
      if (answer.includes('emphasize')) return { action: 'react', reaction: { type: 'emphasize' } };
      return { action: 'react', reaction: { type: 'like' } };
    }
    return { action: 'ignore' };
  } catch (error) {
    console.error('[ai] groupChatAction error:', error);
    return { action: 'ignore' };
  }
}
