import { getBrand } from './brand-registry.ts';
import { getUnsummarisedMessages } from './state.ts';
import { geminiGenerateContent, type GeminiContent } from './ai/gemini.ts';
import { MODEL_MAP } from './ai/models.ts';

// ═══════════════════════════════════════════════════════════════
// Core brand chat logic for brand-mode sessions.
// Uses session conversation history only (no Nest memory/tools).
// ═══════════════════════════════════════════════════════════════

const BRAND_CHAT_MODEL = MODEL_MAP.fast;
const MAX_OUTPUT_TOKENS = 2048;
const BRAND_VOICE_LOCK = [
  'VOICE LOCK (HARD RULES):',
  '- Always speak in first person as the store: use "we", "our", and "us".',
  '- Never say "Ashburton Cycles does/says/has..." in third person.',
  '- Never say "the website says" or "the official site says".',
  '- If older messages use third-person wording, do NOT mirror it; rewrite in first-person.',
  '- Internet/web browsing is not available in this mode. Do not claim live web checks.',
].join('\n');

export interface BrandChatInput {
  chatId: string;
  senderHandle: string;
  brandKey: string;
  message: string;
  sessionStartedAt?: string;
}

export interface BrandChatResult {
  text: string;
  brandName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export async function handleBrandChat(input: BrandChatInput): Promise<BrandChatResult> {
  const brand = getBrand(input.brandKey);
  if (!brand) {
    throw new Error(`Unknown brand: ${input.brandKey}`);
  }

  const since = input.sessionStartedAt ?? '1970-01-01T00:00:00Z';
  const sessionMessages = await getUnsummarisedMessages(input.chatId, since);
  const contents: GeminiContent[] = sessionMessages.map((msg) => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  }));
  contents.push({ role: 'user', parts: [{ text: input.message }] });

  const result = await geminiGenerateContent({
    model: BRAND_CHAT_MODEL,
    systemPrompt: `${BRAND_VOICE_LOCK}\n\n${brand.systemPrompt}`,
    contents,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  return {
    text: result.outputText,
    brandName: brand.name,
    model: BRAND_CHAT_MODEL,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
}
