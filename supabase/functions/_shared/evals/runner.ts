import { handleTurn } from '../orchestrator/handle-turn.ts';
import type { TurnInput } from '../orchestrator/types.ts';
import { EVAL_TASKS, type EvalTask } from './tasks.ts';
import { verifyResult, type VerificationResult } from './verifier.ts';

interface RunOptions {
  tags?: string[];
  taskIds?: string[];
  senderHandle?: string;
  chatId?: string;
  authUserId?: string | null;
  verbose?: boolean;
}

function buildTurnInput(task: EvalTask, opts: RunOptions): TurnInput {
  const base: TurnInput = {
    chatId: opts.chatId ?? `eval-${task.id}-${Date.now()}`,
    userMessage: task.message,
    images: [],
    audio: [],
    senderHandle: opts.senderHandle ?? '+61400000000',
    isGroupChat: false,
    participantNames: [],
    chatName: null,
    authUserId: opts.authUserId ?? null,
    isOnboarding: task.isOnboarding ?? false,
  };

  if (task.isOnboarding) {
    base.onboardingContext = {
      nestUser: {
        handle: base.senderHandle,
        onboardCount: task.onboardCount ?? 0,
        status: 'onboarding',
        onboardState: 'new_user_intro_started',
        onboardingToken: 'eval-token',
        onboardMessages: [],
      } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      onboardUrl: 'https://nest.expert/?token=eval-token',
      experimentVariants: {
        name_first_vs_value_first: 'value_first',
        open_vs_guided: 'guided',
      },
    };
  }

  return base;
}

export async function runEval(opts: RunOptions = {}): Promise<{
  results: VerificationResult[];
  summary: { total: number; passed: number; failed: number; avgLatencyMs: number };
}> {
  let tasks = EVAL_TASKS;

  if (opts.taskIds && opts.taskIds.length > 0) {
    const idSet = new Set(opts.taskIds);
    tasks = tasks.filter(t => idSet.has(t.id));
  }

  if (opts.tags && opts.tags.length > 0) {
    const tagSet = new Set(opts.tags);
    tasks = tasks.filter(t => t.tags.some(tag => tagSet.has(tag)));
  }

  const results: VerificationResult[] = [];

  for (const task of tasks) {
    const input = buildTurnInput(task, opts);

    if (opts.verbose) {
      console.log(`\n[eval] Running: ${task.id} — "${task.message.substring(0, 60)}"`);
    }

    const start = Date.now();
    try {
      const result = await handleTurn(input);
      const latencyMs = Date.now() - start;
      const verification = verifyResult(task, result, latencyMs);
      results.push(verification);

      if (opts.verbose) {
        const status = verification.passed ? 'PASS' : 'FAIL';
        console.log(`  [${status}] ${task.id} (${latencyMs}ms)`);
        for (const check of verification.checks) {
          if (!check.passed) {
            console.log(`    FAIL: ${check.name} — ${check.detail}`);
          }
        }
      }
    } catch (err) {
      const latencyMs = Date.now() - start;
      results.push({
        taskId: task.id,
        passed: false,
        checks: [{ name: 'execution', passed: false, detail: `Error: ${(err as Error).message}` }],
        latencyMs,
      });

      if (opts.verbose) {
        console.log(`  [ERROR] ${task.id}: ${(err as Error).message}`);
      }
    }
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  const avgLatencyMs = results.length > 0
    ? Math.round(results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length)
    : 0;

  return {
    results,
    summary: { total: results.length, passed, failed, avgLatencyMs },
  };
}
