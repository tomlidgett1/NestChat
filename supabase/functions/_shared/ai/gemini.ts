// ═══════════════════════════════════════════════════════════════
// Gemini REST API client — uses fetch directly for Deno compat
// ═══════════════════════════════════════════════════════════════

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_TIMEOUT_MS = 60_000;

export function getGeminiApiKey(): string {
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY not set');
  return key;
}

export function isGeminiModel(model: string): boolean {
  return model.startsWith('gemini-');
}

// ═══════════════════════════════════════════════════════════════
// Types — Gemini REST API shapes
// ═══════════════════════════════════════════════════════════════

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thoughtSignature?: string;
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
  googleSearch?: Record<string, never>;
}

// Unified response shape that the agent loop can consume
export interface GeminiUnifiedResponse {
  outputText: string;
  functionCalls: Array<{
    callId: string;
    name: string;
    arguments: string;
  }>;
  usage: { inputTokens: number; outputTokens: number };
  status: 'completed' | 'incomplete';
  rawModelParts: GeminiPart[];
}

// ═══════════════════════════════════════════════════════════════
// Format converters — OpenAI shapes → Gemini shapes
// ═══════════════════════════════════════════════════════════════

// Convert OpenAI-style message history to Gemini contents
export function toGeminiContents(
  messages: Array<{ role: string; content?: string | unknown[] }>,
): GeminiContent[] {
  const contents: GeminiContent[] = [];

  for (const msg of messages) {
    // Skip system messages (handled via systemInstruction)
    if (msg.role === 'system') continue;

    // Handle function_call_output items from tool execution
    if ((msg as Record<string, unknown>).type === 'function_call_output') {
      const fco = msg as unknown as { call_id: string; output: string; _gemini_fn_name?: string };
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: fco._gemini_fn_name ?? `fn_${fco.call_id}`,
            response: safeParseJson(fco.output),
          },
        }],
      });
      continue;
    }

    // Handle function_call items from model output (fed back into input)
    if ((msg as Record<string, unknown>).type === 'function_call') {
      const fc = msg as unknown as { name: string; arguments: string; call_id: string; thoughtSignature?: string };
      const parts: GeminiPart[] = [{
        functionCall: {
          name: fc.name,
          args: safeParseJsonObj(fc.arguments),
        },
      }];
      if (fc.thoughtSignature) {
        parts[0].thoughtSignature = fc.thoughtSignature;
      }
      contents.push({ role: 'model', parts });
      continue;
    }

    // Handle web_search_call items — skip (Gemini doesn't have this)
    if ((msg as Record<string, unknown>).type === 'web_search_call') continue;

    // Standard text messages
    const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';
    let textContent = '';

    if (typeof msg.content === 'string') {
      textContent = msg.content;
    } else if (Array.isArray(msg.content)) {
      // Extract text from content parts (InputContentPart[])
      for (const part of msg.content) {
        if (typeof part === 'string') {
          textContent += part;
        } else if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (p.type === 'input_text' && typeof p.text === 'string') {
            textContent += p.text;
          } else if (p.text && typeof p.text === 'string') {
            textContent += p.text;
          }
        }
      }
    }

    if (!textContent) continue;

    // Merge consecutive same-role messages (Gemini requires alternating roles)
    const last = contents[contents.length - 1];
    if (last && last.role === role && last.parts.every(p => p.text !== undefined)) {
      last.parts.push({ text: textContent });
    } else {
      contents.push({ role, parts: [{ text: textContent }] });
    }
  }

  return contents;
}

// Convert tool results (FunctionCallOutput[]) to Gemini format
// We need the function name for each call_id, so we accept a name map
export function toGeminiFunctionResponses(
  toolResults: Array<{ type: string; call_id: string; output: string }>,
  callIdToName: Map<string, string>,
): GeminiContent {
  const parts: GeminiPart[] = toolResults.map(tr => ({
    functionResponse: {
      name: callIdToName.get(tr.call_id) ?? `fn_${tr.call_id}`,
      response: safeParseJson(tr.output),
    },
  }));
  return { role: 'user', parts };
}

// Convert model's function call parts back to Gemini content for the next round
export function modelPartsToGeminiContent(parts: GeminiPart[]): GeminiContent {
  return { role: 'model', parts };
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === 'object' && parsed !== null ? parsed : { result: s };
  } catch {
    return { result: s };
  }
}

function safeParseJsonObj(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ═══════════════════════════════════════════════════════════════
// Core API call
// ═══════════════════════════════════════════════════════════════

let _callIdCounter = 0;

export async function geminiGenerateContent(opts: {
  model: string;
  systemPrompt: string;
  contents: GeminiContent[];
  tools?: GeminiTool[];
  toolChoice?: string;
  maxOutputTokens: number;
}): Promise<GeminiUnifiedResponse> {
  const apiKey = getGeminiApiKey();
  const url = `${GEMINI_API_BASE}/models/${opts.model}:generateContent?key=${apiKey}`;

  // Build request body
  // deno-lint-ignore no-explicit-any
  const body: Record<string, any> = {
    contents: opts.contents,
    generationConfig: {
      maxOutputTokens: opts.maxOutputTokens,
    },
  };

  if (opts.systemPrompt) {
    body.systemInstruction = {
      parts: [{ text: opts.systemPrompt }],
    };
  }

  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
  }

  if (opts.toolChoice === 'required') {
    body.toolConfig = {
      functionCallingConfig: { mode: 'ANY' },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Gemini API ${resp.status}: ${errBody.substring(0, 500)}`);
    }

    // deno-lint-ignore no-explicit-any
    const data: any = await resp.json();

    // Parse response
    const candidate = data.candidates?.[0];
    if (!candidate) {
      throw new Error('Gemini returned no candidates');
    }

    const parts: GeminiPart[] = candidate.content?.parts ?? [];
    let outputText = '';
    const functionCalls: GeminiUnifiedResponse['functionCalls'] = [];

    for (const part of parts) {
      if (part.text) {
        outputText += part.text;
      }
      if (part.functionCall) {
        _callIdCounter++;
        const callId = `gemini_call_${_callIdCounter}_${Date.now()}`;
        functionCalls.push({
          callId,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        });
      }
    }

    const usage = data.usageMetadata ?? {};
    const inputTokens = usage.promptTokenCount ?? 0;
    const outputTokens = usage.candidatesTokenCount ?? 0;

    const finishReason = candidate.finishReason;
    const status: 'completed' | 'incomplete' =
      finishReason === 'MAX_TOKENS' ? 'incomplete' : 'completed';

    return {
      outputText,
      functionCalls,
      usage: { inputTokens, outputTokens },
      status,
      rawModelParts: parts,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════
// Grounded web search — uses googleSearch tool in a dedicated call
// Returns search results text that can be fed back as tool output
// ═══════════════════════════════════════════════════════════════

export async function geminiGroundedSearch(opts: {
  model: string;
  query: string;
  conversationContext?: string;
}): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const apiKey = getGeminiApiKey();
  const url = `${GEMINI_API_BASE}/models/${opts.model}:generateContent?key=${apiKey}`;

  const userPrompt = opts.conversationContext
    ? `Based on this conversation context: ${opts.conversationContext}\n\nSearch the web for: ${opts.query}`
    : opts.query;

  const body = {
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: { maxOutputTokens: 2048 },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Gemini search API ${resp.status}: ${errBody.substring(0, 300)}`);
    }

    // deno-lint-ignore no-explicit-any
    const data: any = await resp.json();
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    let text = '';
    for (const part of parts) {
      if (part.text) text += part.text;
    }

    // Also extract grounding metadata if available
    const grounding = candidate?.groundingMetadata;
    if (grounding?.groundingChunks?.length > 0) {
      const sources = grounding.groundingChunks
        // deno-lint-ignore no-explicit-any
        .filter((c: any) => c.web?.uri)
        // deno-lint-ignore no-explicit-any
        .map((c: any) => `${c.web.title ?? ''}: ${c.web.uri}`)
        .slice(0, 5)
        .join('\n');
      if (sources) {
        text += `\n\nSources:\n${sources}`;
      }
    }

    const usage = data.usageMetadata ?? {};
    return {
      text: text || 'No search results found.',
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════
// Simple text-only helper for standalone callers
// ═══════════════════════════════════════════════════════════════

export async function geminiSimpleText(opts: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxOutputTokens?: number;
}): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const result = await geminiGenerateContent({
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    contents: [{ role: 'user', parts: [{ text: opts.userMessage }] }],
    maxOutputTokens: opts.maxOutputTokens ?? 1024,
  });
  return {
    text: result.outputText,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
}
