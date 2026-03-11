import Anthropic from 'npm:@anthropic-ai/sdk@0.78.0';
import OpenAI from 'npm:openai@6.16.0';
import { getConversation } from './state.ts';
import type { Reaction } from './sendblue.ts';

// ═══════════════════════════════════════════════════════════════
// Shared clients
// ═══════════════════════════════════════════════════════════════

const client = new Anthropic({
  apiKey: Deno.env.get('ANTHROPIC_API_KEY'),
});

const openai = new OpenAI({
  apiKey: Deno.env.get('OPENAI_API_KEY'),
});

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
    console.error('[claude] DALL-E error:', error);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Effect text generation
// ═══════════════════════════════════════════════════════════════

export async function getTextForEffect(effectName: string): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
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

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 20,
      system: `You classify how "Nest" (a personal assistant in a group chat) should handle messages.

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
