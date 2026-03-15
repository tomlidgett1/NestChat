import type { ToolNamespace, SideEffect } from '../orchestrator/types.ts';
import type { OpenAITool } from '../ai/models.ts';
import type { GeminiTool } from '../ai/gemini.ts';
import type { PendingEmailSendAction } from '../state.ts';

// ═══════════════════════════════════════════════════════════════
// Tool context — passed to every handler
// ═══════════════════════════════════════════════════════════════

export interface ToolContext {
  chatId: string;
  senderHandle: string;
  authUserId: string | null;
  pendingEmailSend: PendingEmailSendAction | null;
  pendingEmailSends: PendingEmailSendAction[];
}

// ═══════════════════════════════════════════════════════════════
// Tool output — what every handler returns
// ═══════════════════════════════════════════════════════════════

export interface ToolOutput {
  content: string;
  structuredData?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
// Tool contract — the typed definition for every tool
// ═══════════════════════════════════════════════════════════════

export interface ToolContract {
  name: string;
  description: string;
  namespace: ToolNamespace;
  sideEffect: SideEffect;
  idempotent: boolean;
  timeoutMs: number;
  inputSchema: Record<string, unknown>;
  inputExamples?: Record<string, unknown>[];
  strict?: boolean;
  requiresConfirmation?: boolean;
  handler: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;
}

export function toOpenAITool(contract: ToolContract): OpenAITool {
  if (contract.name === 'web_search') {
    return { type: 'web_search_preview' };
  }
  return {
    type: 'function',
    name: contract.name,
    description: contract.description,
    parameters: contract.inputSchema,
    strict: false,
  };
}

export function toGeminiTools(contracts: ToolContract[]): GeminiTool[] {
  // Gemini cannot combine googleSearch with functionDeclarations in the same
  // request. For web_search, we include it as a regular function declaration
  // with a query parameter — the handler performs a real grounded search via
  // a dedicated Gemini googleSearch API call.
  const functionDeclarations = [];

  for (const contract of contracts) {
    functionDeclarations.push({
      name: contract.name,
      description: contract.description,
      parameters: contract.inputSchema,
    });
  }

  if (functionDeclarations.length > 0) {
    return [{ functionDeclarations }];
  }
  return [];
}

// ═══════════════════════════════════════════════════════════════
// Pending tool call — extracted from OpenAI response
// ═══════════════════════════════════════════════════════════════

export interface PendingToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
// Tool execution result — returned from executor for side-effect extraction
// ═══════════════════════════════════════════════════════════════

export interface ToolExecutionResult {
  toolName: string;
  outcome: 'success' | 'error' | 'timeout' | 'blocked';
  structuredData?: Record<string, unknown>;
}
