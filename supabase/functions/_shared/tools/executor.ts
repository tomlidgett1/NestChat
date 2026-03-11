import type Anthropic from 'npm:@anthropic-ai/sdk@0.78.0';
import type { ToolNamespace, ToolCallTrace, ToolCallBlockedTrace } from '../orchestrator/types.ts';
import type { ToolContext, PendingToolCall, ToolContract, ToolExecutionResult } from './types.ts';
import { getTool } from './registry.ts';

// ═══════════════════════════════════════════════════════════════
// Timeout helper
// ═══════════════════════════════════════════════════════════════

class ToolTimeoutError extends Error {
  constructor(toolName: string, ms: number) {
    super(`Tool ${toolName} timed out after ${ms}ms`);
    this.name = 'ToolTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolTimeoutError(toolName, ms)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ═══════════════════════════════════════════════════════════════
// Input summariser (for traces — never log full input)
// ═══════════════════════════════════════════════════════════════

function summariseInput(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(input)) {
    if (val === undefined || val === null) continue;
    const str = typeof val === 'string' ? val : JSON.stringify(val);
    parts.push(`${key}: ${str.substring(0, 60)}`);
  }
  return parts.join(', ').substring(0, 150);
}

// ═══════════════════════════════════════════════════════════════
// Single tool execution (used by parallel executor)
// ═══════════════════════════════════════════════════════════════

interface SingleToolResult {
  toolResult: Anthropic.ToolResultBlockParam;
  execResult: ToolExecutionResult;
  trace?: ToolCallTrace;
  blocked?: ToolCallBlockedTrace;
}

const COMMIT_EXEMPT_TOOLS = new Set(['send_reaction', 'send_effect', 'remember_user']);

const COMMIT_INTENT_TOOLS = new Set(['calendar_write', 'email_send']);

function needsActionLevelConfirmation(call: PendingToolCall): boolean {
  if (call.name === 'calendar_write') {
    const action = call.input.action as string;
    return action === 'delete';
  }
  return false;
}

async function executeSingleCall(
  call: PendingToolCall,
  ctx: ToolContext,
  nsSet: Set<string>,
  conversationHistory?: Array<{ role: string; content: string }>,
): Promise<SingleToolResult> {
  const tool = getTool(call.name);
  console.log(`[executor] tool_call: ${call.name}`, JSON.stringify(call.input).substring(0, 200));

  if (!tool) {
    if (call.name === 'web_search') {
      console.log(`[executor] web_search: native pass-through`);
      return {
        toolResult: { type: 'tool_result', tool_use_id: call.id, content: 'Done.' },
        execResult: { toolName: 'web_search', outcome: 'success' },
        trace: { name: 'web_search', namespace: 'web.search', sideEffect: 'read', latencyMs: 0, outcome: 'success' },
      };
    }
    console.warn(`[executor] unknown tool: ${call.name}`);
    return {
      toolResult: { type: 'tool_result', tool_use_id: call.id, content: 'Unknown tool.' },
      execResult: { toolName: call.name, outcome: 'error' },
    };
  }

  // Layer A: Namespace gate
  if (!nsSet.has(tool.namespace)) {
    console.warn(`[executor] BLOCKED ${tool.name}: namespace ${tool.namespace} not in allowed set`);
    return {
      toolResult: { type: 'tool_result', tool_use_id: call.id, content: 'This tool is not available right now.' },
      execResult: { toolName: tool.name, outcome: 'blocked' },
      blocked: { name: tool.name, namespace: tool.namespace, reason: 'namespace_denied' },
    };
  }

  // Layer B: Side-effect gate for commit tools requiring confirmation
  let approvalGranted: boolean | undefined;
  let approvalMethod: 'explicit' | 'implicit' | 'exempt' | undefined;

  if (tool.sideEffect === 'commit') {
    const requiresConfirm = tool.requiresConfirmation || needsActionLevelConfirmation(call);

    if (COMMIT_EXEMPT_TOOLS.has(tool.name)) {
      approvalMethod = 'exempt';
      approvalGranted = true;
    } else if (requiresConfirm) {
      const hasConfirmation = conversationHistory && hasUserConfirmation(conversationHistory);
      const hasDirectIntent = COMMIT_INTENT_TOOLS.has(tool.name) && conversationHistory && hasDirectActionIntent(conversationHistory);
      console.log(`[executor] ${tool.name} (action: ${call.input.action ?? 'n/a'}) confirmation check: hasConfirmation=${hasConfirmation}, hasDirectIntent=${hasDirectIntent}, lastUserMsg="${conversationHistory ? [...conversationHistory].reverse().find(m => m.role === 'user')?.content?.substring(0, 80) : 'none'}"`);

      if (hasConfirmation || hasDirectIntent) {
        approvalGranted = true;
        approvalMethod = hasConfirmation ? 'explicit' : 'implicit';
      } else {
        console.warn(`[executor] BLOCKED ${tool.name} (action: ${call.input.action ?? 'n/a'}): requires confirmation but none found`);
        return {
          toolResult: { type: 'tool_result', tool_use_id: call.id, content: 'User confirmation required before executing this action. Please ask the user to confirm first.' },
          execResult: { toolName: tool.name, outcome: 'blocked', structuredData: { reason: 'no_confirmation' } },
          blocked: { name: tool.name, namespace: tool.namespace, reason: 'side_effect_denied' },
        };
      }
    } else {
      approvalMethod = 'implicit';
      approvalGranted = true;
    }
  }

  // Layer C: Execute with timeout and trace
  const start = Date.now();
  try {
    console.log(`[executor] executing ${tool.name} (timeout: ${tool.timeoutMs}ms, approval: ${approvalMethod ?? 'n/a'})`);
    const output = await withTimeout(tool.handler(call.input, ctx), tool.timeoutMs, tool.name);
    const latency = Date.now() - start;
    console.log(`[executor] ${tool.name} completed in ${latency}ms, output length: ${output.content.length}`);

    return {
      toolResult: { type: 'tool_result', tool_use_id: call.id, content: output.content },
      execResult: { toolName: tool.name, outcome: 'success', structuredData: output.structuredData },
      trace: {
        name: tool.name,
        namespace: tool.namespace,
        sideEffect: tool.sideEffect,
        latencyMs: latency,
        outcome: 'success',
        inputSummary: summariseInput(call.input),
        ...(approvalGranted !== undefined && { approvalGranted }),
        ...(approvalMethod && { approvalMethod }),
      },
    };
  } catch (err) {
    const isTimeout = err instanceof ToolTimeoutError;
    const latency = Date.now() - start;
    console.error(`[executor] ${tool.name} FAILED in ${latency}ms:`, (err as Error).message);
    return {
      toolResult: {
        type: 'tool_result',
        tool_use_id: call.id,
        content: isTimeout
          ? 'This tool took too long. Try again or use a different approach.'
          : `Tool error: ${(err as Error).message}`,
      },
      execResult: { toolName: tool.name, outcome: isTimeout ? 'timeout' : 'error' },
      trace: {
        name: tool.name,
        namespace: tool.namespace,
        sideEffect: tool.sideEffect,
        latencyMs: latency,
        outcome: isTimeout ? 'timeout' : 'error',
        inputSummary: summariseInput(call.input),
      },
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// Confirmation detection for commit tools
// ═══════════════════════════════════════════════════════════════

const AFFIRMATIVE_PATTERNS = /\b(yes|yep|yeah|yea|sure|go ahead|send it|do it|confirm|approved?|lgtm|looks good|perfect|great|book it)\b/i;

function hasUserConfirmation(history: Array<{ role: string; content: string }>): boolean {
  if (history.length < 2) return false;
  const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return false;
  return AFFIRMATIVE_PATTERNS.test(lastUserMsg.content);
}

const DIRECT_ACTION_INTENT = /\b(add|create|schedule|book|set up|put|make|cancel|delete|remove|reschedule|move)\b.*\b(meeting|event|appointment|call|standup|sync|catch ?up|lunch|dinner|coffee|calendar|slot)\b/i;

function hasDirectActionIntent(history: Array<{ role: string; content: string }>): boolean {
  const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return false;
  return DIRECT_ACTION_INTENT.test(lastUserMsg.content);
}

// ═══════════════════════════════════════════════════════════════
// Policy-enforced parallel tool execution
// ═══════════════════════════════════════════════════════════════

interface ExecutorOutput {
  toolResults: Anthropic.ToolResultBlockParam[];
  execResults: ToolExecutionResult[];
}

export async function executePoliciedToolCalls(
  calls: PendingToolCall[],
  ctx: ToolContext,
  allowedNamespaces: ToolNamespace[],
  traces: ToolCallTrace[],
  blocked: ToolCallBlockedTrace[],
  conversationHistory?: Array<{ role: string; content: string }>,
): Promise<ExecutorOutput> {
  const nsSet = new Set<string>(allowedNamespaces);

  const settled = await Promise.allSettled(
    calls.map(call => executeSingleCall(call, ctx, nsSet, conversationHistory))
  );

  const toolResults: Anthropic.ToolResultBlockParam[] = [];
  const execResults: ToolExecutionResult[] = [];

  for (let i = 0; i < calls.length; i++) {
    const result = settled[i];
    if (result.status === 'fulfilled') {
      const r = result.value;
      toolResults.push(r.toolResult);
      execResults.push(r.execResult);
      if (r.trace) traces.push(r.trace);
      if (r.blocked) blocked.push(r.blocked);
    } else {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: calls[i].id,
        content: `Unexpected error: ${result.reason?.message ?? 'unknown'}`,
      });
      execResults.push({ toolName: calls[i].name, outcome: 'error' });
    }
  }

  return { toolResults, execResults };
}
