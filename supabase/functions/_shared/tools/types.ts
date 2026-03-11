import type Anthropic from 'npm:@anthropic-ai/sdk@0.78.0';
import type { ToolNamespace, SideEffect } from '../orchestrator/types.ts';

// ═══════════════════════════════════════════════════════════════
// Tool context — passed to every handler
// ═══════════════════════════════════════════════════════════════

export interface ToolContext {
  chatId: string;
  senderHandle: string;
  authUserId: string | null;
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
  inputSchema: Anthropic.Tool['input_schema'];
  inputExamples?: Record<string, unknown>[];
  strict?: boolean;
  requiresConfirmation?: boolean;
  handler: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;
}

export function toAnthropicTool(contract: ToolContract): Anthropic.Tool {
  if (contract.name === 'web_search') {
    return { type: 'web_search_20250305', name: 'web_search' } as unknown as Anthropic.Tool;
  }
  const tool: Record<string, unknown> = {
    name: contract.name,
    description: contract.description,
    input_schema: contract.inputSchema,
  };
  if (contract.inputExamples && contract.inputExamples.length > 0) {
    tool.input_examples = contract.inputExamples;
  }
  return tool as unknown as Anthropic.Tool;
}

// ═══════════════════════════════════════════════════════════════
// Pending tool call — extracted from Anthropic response
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
