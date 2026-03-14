import type { ToolNamespace, ToolCallTrace, ToolCallBlockedTrace } from '../orchestrator/types.ts';
import type { ToolContext, PendingToolCall, ToolExecutionResult } from './types.ts';
import type { FunctionCallOutput } from '../ai/models.ts';
import { classifyConfirmation } from '../ai/models.ts';
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
  toolResult: FunctionCallOutput;
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
  sameTurnHasDraft?: boolean,
): Promise<SingleToolResult> {
  const tool = getTool(call.name);
  console.log(`[executor] tool_call: ${call.name}`, JSON.stringify(call.input).substring(0, 200));
  const effectiveInput: Record<string, unknown> = { ...call.input };
  const pendingEmailSends = ctx.pendingEmailSends ?? [];
  const pendingEmailSend = ctx.pendingEmailSend ?? null;
  const activePendingEmailSend = pendingEmailSend ?? (pendingEmailSends.length === 1 ? pendingEmailSends[0] : null);

  if (!tool) {
    if (call.name === 'web_search') {
      console.log(`[executor] web_search: native pass-through`);
      return {
        toolResult: { type: 'function_call_output', call_id: call.id, output: 'Done.' },
        execResult: { toolName: 'web_search', outcome: 'success' },
        trace: { name: 'web_search', namespace: 'web.search', sideEffect: 'read', latencyMs: 0, outcome: 'success' },
      };
    }
    console.warn(`[executor] unknown tool: ${call.name}`);
    return {
      toolResult: { type: 'function_call_output', call_id: call.id, output: 'Unknown tool.' },
      execResult: { toolName: call.name, outcome: 'error' },
    };
  }

  // Layer A: Namespace gate
  if (!nsSet.has(tool.namespace)) {
    console.warn(`[executor] BLOCKED ${tool.name}: namespace ${tool.namespace} not in allowed set`);
    return {
      toolResult: { type: 'function_call_output', call_id: call.id, output: 'This tool is not available right now.' },
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
      const isSendAfterDraft = sameTurnHasDraft && /^(email_send|email)$/.test(tool.name);
      if (isSendAfterDraft) {
        console.warn(`[executor] BLOCKED ${tool.name}: draft was created this turn, user must confirm in a separate message`);
        return {
          toolResult: { type: 'function_call_output', call_id: call.id, output: 'The draft has been created. Please show it to the user and ask them to confirm before sending.' },
          execResult: { toolName: tool.name, outcome: 'blocked', structuredData: { reason: 'draft_same_turn' } },
          blocked: { name: tool.name, namespace: tool.namespace, reason: 'side_effect_denied' },
        };
      }

      if (tool.name === 'email_send' && !activePendingEmailSend) {
        console.warn('[executor] BLOCKED email_send: no pending draft in draft store');
        return {
          toolResult: { type: 'function_call_output', call_id: call.id, output: 'There is no pending draft ready to send. Create a draft first with email_draft.' },
          execResult: { toolName: tool.name, outcome: 'blocked', structuredData: { reason: 'no_pending_draft' } },
          blocked: { name: tool.name, namespace: tool.namespace, reason: 'side_effect_denied', detail: 'no_pending_draft' },
        };
      }

      const hasConfirmation = conversationHistory ? await hasUserConfirmation(conversationHistory) : false;
      const hasDirectIntent = COMMIT_INTENT_TOOLS.has(tool.name) && conversationHistory && hasDirectActionIntent(conversationHistory);
      console.log(`[executor] ${tool.name} (action: ${call.input.action ?? 'n/a'}) confirmation check: hasConfirmation=${hasConfirmation}, hasDirectIntent=${hasDirectIntent}, lastUserMsg="${conversationHistory ? [...conversationHistory].reverse().find(m => m.role === 'user')?.content?.substring(0, 80) : 'none'}"`);

      if (hasConfirmation || hasDirectIntent) {
        approvalGranted = true;
        approvalMethod = hasConfirmation ? 'explicit' : 'implicit';
      } else {
        console.warn(`[executor] BLOCKED ${tool.name} (action: ${call.input.action ?? 'n/a'}): requires confirmation but none found`);
        return {
          toolResult: { type: 'function_call_output', call_id: call.id, output: 'User confirmation required before executing this action. Please ask the user to confirm first.' },
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
    const output = await withTimeout(tool.handler(effectiveInput, ctx), tool.timeoutMs, tool.name);
    const latency = Date.now() - start;
    console.log(`[executor] ${tool.name} completed in ${latency}ms, output length: ${output.content.length}`);

    return {
      toolResult: { type: 'function_call_output', call_id: call.id, output: output.content },
      execResult: { toolName: tool.name, outcome: 'success', structuredData: output.structuredData },
      trace: {
        name: tool.name,
        namespace: tool.namespace,
        sideEffect: tool.sideEffect,
        latencyMs: latency,
        outcome: 'success',
        inputSummary: summariseInput(effectiveInput),
        ...(approvalGranted !== undefined && { approvalGranted }),
        ...(approvalMethod && { approvalMethod }),
        ...(activePendingEmailSend?.id ? { pendingActionId: activePendingEmailSend.id } : {}),
      },
    };
  } catch (err) {
    const isTimeout = err instanceof ToolTimeoutError;
    const latency = Date.now() - start;
    console.error(`[executor] ${tool.name} FAILED in ${latency}ms:`, (err as Error).message);
    return {
      toolResult: {
        type: 'function_call_output',
        call_id: call.id,
        output: isTimeout
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
        inputSummary: summariseInput(effectiveInput),
        ...(activePendingEmailSend?.id ? { pendingActionId: activePendingEmailSend.id } : {}),
      },
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// Confirmation detection for commit tools
// Fast regex pre-check for obvious cases; LLM classifier for ambiguous ones
// ═══════════════════════════════════════════════════════════════

const OBVIOUS_AFFIRMATIVE = /^(yes|yep|yeah|yea|sure|ok|send|send it|go ahead|do it|confirm|lgtm|looks good|perfect|great|book it|go for it|ship it|fire away|let's go)$/i;

async function hasUserConfirmation(history: Array<{ role: string; content: string }>): Promise<boolean> {
  if (history.length < 2) return false;
  const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return false;

  const msg = lastUserMsg.content.trim();

  if (OBVIOUS_AFFIRMATIVE.test(msg)) return true;

  if (msg.length > 120) return false;

  const lastAssistantMsg = [...history].reverse().find(m => m.role === 'assistant');
  const assistantContext = lastAssistantMsg?.content ?? '';

  return classifyConfirmation(msg, assistantContext);
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
  toolResults: FunctionCallOutput[];
  execResults: ToolExecutionResult[];
}

export async function executePoliciedToolCalls(
  calls: PendingToolCall[],
  ctx: ToolContext,
  allowedNamespaces: ToolNamespace[],
  traces: ToolCallTrace[],
  blocked: ToolCallBlockedTrace[],
  conversationHistory?: Array<{ role: string; content: string }>,
  priorTurnToolNames?: string[],
): Promise<ExecutorOutput> {
  const nsSet = new Set<string>(allowedNamespaces);

  const draftToolsThisBatch = new Set(
    calls.filter(c => /^(email_draft|email_write)$/.test(c.name) || (c.name === 'email' && /draft|compose|write/i.test(String(c.input.action ?? '')))).map(c => c.name)
  );
  const draftInPriorRound = (priorTurnToolNames ?? []).some(n => /^(email_draft|email_write)$/.test(n) || n === 'email');

  const sameTurnHasDraft = draftToolsThisBatch.size > 0 || draftInPriorRound;

  const settled = await Promise.allSettled(
    calls.map(call => executeSingleCall(call, ctx, nsSet, conversationHistory, sameTurnHasDraft))
  );

  const toolResults: FunctionCallOutput[] = [];
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
        type: 'function_call_output',
        call_id: calls[i].id,
        output: `Unexpected error: ${result.reason?.message ?? 'unknown'}`,
      });
      execResults.push({ toolName: calls[i].name, outcome: 'error' });
    }
  }

  return { toolResults, execResults };
}
