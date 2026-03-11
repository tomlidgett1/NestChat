import type { TurnResult } from '../orchestrator/types.ts';
import type { EvalTask } from './tasks.ts';

export interface VerificationResult {
  taskId: string;
  passed: boolean;
  checks: CheckResult[];
  latencyMs: number;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export function verifyResult(task: EvalTask, result: TurnResult, latencyMs: number): VerificationResult {
  const checks: CheckResult[] = [];

  // Check: response is non-empty
  if (task.expectNonEmpty) {
    const hasText = !!result.text && result.text.trim().length > 0;
    checks.push({
      name: 'response_non_empty',
      passed: hasText,
      detail: hasText ? `${result.text!.length} chars` : 'empty response',
    });
  }

  // Check: correct agent routed
  if (task.expectedAgent) {
    const actualAgent = result.trace.agentName;
    const passed = actualAgent === task.expectedAgent;
    checks.push({
      name: 'correct_agent',
      passed,
      detail: passed ? actualAgent : `expected ${task.expectedAgent}, got ${actualAgent}`,
    });
  }

  // Check: expected tools were called
  if (task.expectedTools && task.expectedTools.length > 0) {
    const calledTools = result.trace.toolCalls.map(t => t.name);
    for (const expectedTool of task.expectedTools) {
      const found = calledTools.includes(expectedTool);
      checks.push({
        name: `tool_called_${expectedTool}`,
        passed: found,
        detail: found ? 'called' : `${expectedTool} not called (called: ${calledTools.join(', ') || 'none'})`,
      });
    }
  }

  // Check: must not route to certain agents
  if (task.mustNotRoute && task.mustNotRoute.length > 0) {
    const actualAgent = result.trace.agentName;
    for (const forbidden of task.mustNotRoute) {
      const passed = actualAgent !== forbidden;
      checks.push({
        name: `not_routed_to_${forbidden}`,
        passed,
        detail: passed ? `routed to ${actualAgent}` : `incorrectly routed to ${forbidden}`,
      });
    }
  }

  // Check: no unexpected blocked tools
  if (result.trace.toolCallsBlocked.length > 0) {
    const blockedNames = result.trace.toolCallsBlocked.map(b => b.name);
    const expectedTools = new Set(task.expectedTools ?? []);
    const unexpectedBlocks = blockedNames.filter(n => expectedTools.has(n));
    checks.push({
      name: 'no_unexpected_blocks',
      passed: unexpectedBlocks.length === 0,
      detail: unexpectedBlocks.length === 0
        ? `${blockedNames.length} blocked (expected)`
        : `unexpectedly blocked: ${unexpectedBlocks.join(', ')}`,
    });
  }

  // Check: latency within bounds
  if (task.maxLatencyMs) {
    const passed = latencyMs <= task.maxLatencyMs;
    checks.push({
      name: 'latency',
      passed,
      detail: `${latencyMs}ms ${passed ? '<=' : '>'} ${task.maxLatencyMs}ms`,
    });
  }

  const allPassed = checks.every(c => c.passed);

  return {
    taskId: task.id,
    passed: allPassed,
    checks,
    latencyMs,
  };
}
