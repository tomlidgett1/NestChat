import OpenAI from 'npm:openai@6.27.0';

// ═══════════════════════════════════════════════════════════════
// Model tiers — change any model with a single-line edit
//
//   fast:          Non-reasoning, low-latency (chat, simple Q&A, recall)
//   agent:         Reasoning model for multi-step tool use
//   orchestration: Lightweight reasoning for routing/classification
// ═══════════════════════════════════════════════════════════════

export type ModelTier = 'fast' | 'agent' | 'orchestration';

export const MODEL_MAP: Record<ModelTier, string> = {
  fast: 'gpt-4.1-mini',
  agent: 'gpt-5.2',
  orchestration: 'gpt-5-nano',
};

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'none';

export const REASONING_EFFORT: Record<ModelTier, ReasoningEffort> = {
  fast: 'none',
  agent: 'medium',
  orchestration: 'low',
};

export function isReasoningModel(tier: ModelTier): boolean {
  return REASONING_EFFORT[tier] !== 'none';
}

// ═══════════════════════════════════════════════════════════════
// Shared OpenAI client (singleton)
// ═══════════════════════════════════════════════════════════════

let _client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: Deno.env.get('OPENAI_API_KEY') });
  }
  return _client;
}

// ═══════════════════════════════════════════════════════════════
// Provider-agnostic message types for conversation history
// ═══════════════════════════════════════════════════════════════

export interface InputMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | InputContentPart[];
}

export type InputContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string };

// ═══════════════════════════════════════════════════════════════
// OpenAI Responses API tool definition shape
// ═══════════════════════════════════════════════════════════════

export interface OpenAIFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

export interface OpenAIWebSearchTool {
  type: 'web_search_preview';
}

export type OpenAITool = OpenAIFunctionTool | OpenAIWebSearchTool;

// ═══════════════════════════════════════════════════════════════
// OpenAI Responses API function call output shape
// ═══════════════════════════════════════════════════════════════

export interface FunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

// ═══════════════════════════════════════════════════════════════
// LLM-based confirmation classifier (nano model, ~200-400ms)
// Used by both the router and the tool executor
// ═══════════════════════════════════════════════════════════════

const CONFIRM_CLASSIFIER_PROMPT = `Classify whether the user is confirming/approving the assistant's proposed action.
Output exactly one word: yes or no.`;

const CONFIRM_REGEX_FALLBACK = /\b(yes|yep|yeah|yea|sure|ok|okay|send|send it|go ahead|do it|confirm|perfect|lgtm|looks good|great|book it|go for it|ship it|fire away|let's go|sure thing|absolutely|definitely|of course|please do|that's? (good|fine|great|perfect)|approved?)\b/i;

const OBVIOUS_NEGATIVE = /\b(actually|change|edit|update|revise|modify|fix|redo|rewrite|replace|swap|instead|no[,.]?\s+(change|make|update|switch)|wait|hold on|not yet|don't send|cancel|stop|never ?mind)\b/i;

let _confirmCache = new Map<string, boolean>();

export async function classifyConfirmation(
  userMessage: string,
  assistantContext: string,
): Promise<boolean> {
  const cacheKey = `${userMessage}||${assistantContext.substring(0, 200)}`;
  if (_confirmCache.has(cacheKey)) return _confirmCache.get(cacheKey)!;

  if (_confirmCache.size > 100) _confirmCache = new Map();

  const msg = userMessage.trim();

  if (OBVIOUS_NEGATIVE.test(msg)) {
    console.log(`[confirm-classifier] "${userMessage}" → NOT confirmed (negative regex)`);
    _confirmCache.set(cacheKey, false);
    return false;
  }

  if (CONFIRM_REGEX_FALLBACK.test(msg)) {
    console.log(`[confirm-classifier] "${userMessage}" → CONFIRMED (regex fast-path)`);
    _confirmCache.set(cacheKey, true);
    return true;
  }

  try {
    const client = getOpenAIClient();
    const start = Date.now();
    const response = await client.responses.create({
      model: MODEL_MAP.fast,
      instructions: CONFIRM_CLASSIFIER_PROMPT,
      input: [
        { role: 'assistant', content: assistantContext.substring(0, 500) },
        { role: 'user', content: userMessage.substring(0, 200) },
      ],
      max_output_tokens: 16,
      store: false,
    } as Parameters<typeof client.responses.create>[0]);
    const ms = Date.now() - start;
    const answer = (response.output_text ?? '').trim().toLowerCase();
    const isConfirm = answer.startsWith('yes') || answer === 'y';
    console.log(`[confirm-classifier] "${userMessage}" → ${isConfirm ? 'CONFIRMED' : 'NOT confirmed'} (${ms}ms, raw: "${answer}")`);
    _confirmCache.set(cacheKey, isConfirm);
    return isConfirm;
  } catch (err) {
    console.warn('[confirm-classifier] failed, falling back to regex:', (err as Error).message);
    return CONFIRM_REGEX_FALLBACK.test(userMessage);
  }
}
