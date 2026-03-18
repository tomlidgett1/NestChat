import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function getAdminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

// In-memory store for test run results (persists while function is warm)
const testRunStore: Record<string, {
  status: 'running' | 'done' | 'error';
  suite: string;
  startedAt: string;
  finishedAt?: string;
  results: unknown[];
  summary?: Record<string, unknown>;
  error?: string;
}> = {};

async function runSingleTestCase(
  message: string,
  expectedAgent?: string,
  opts?: { keepHistory?: boolean; forceOnboarding?: boolean },
): Promise<Record<string, unknown>> {
  const { handleTurn } = await import('../_shared/orchestrator/handle-turn.ts');
  const { ensureNestUser, clearConversation, cancelPendingEmailSends, getUserTimezone } = await import('../_shared/state.ts');

  const SENDER_HANDLE = '+61414187820';
  const BOT_NUMBER = '+13466215973';
  const CHAT_ID = `DBG#${BOT_NUMBER}#${SENDER_HANDLE}`;

  // Mirror production: ensureNestUser returns NestUser with status, authUserId, etc.
  const nestUser = await ensureNestUser(SENDER_HANDLE, BOT_NUMBER);
  const authUserId = nestUser.authUserId ?? null;

  if (!opts?.keepHistory) {
    await clearConversation(CHAT_ID);
    await cancelPendingEmailSends(CHAT_ID);
  }

  // Mirror production: onboarding is determined by nestUser.status
  // Allow override for testing onboarding scenarios with an active user
  const isOnboarding = opts?.forceOnboarding ?? (nestUser.status !== 'active');

  // deno-lint-ignore no-explicit-any
  let onboardingContext: any;
  if (isOnboarding) {
    const onboardUrl = `https://nest.expert/?token=${nestUser.onboardingToken}`;
    onboardingContext = {
      nestUser,
      onboardUrl,
      experimentVariants: {},
    };
  }

  // Mirror production: resolve timezone
  const userTimezone = nestUser.timezone ??
    await getUserTimezone(SENDER_HANDLE).catch(() => null) ??
    'Australia/Melbourne';

  const start = Date.now();
  const result = await handleTurn({
    chatId: CHAT_ID,
    userMessage: message,
    images: [],
    audio: [],
    senderHandle: SENDER_HANDLE,
    isGroupChat: false,
    participantNames: [],
    chatName: null,
    authUserId,
    isOnboarding,
    onboardingContext: isOnboarding ? onboardingContext as any : undefined,
    service: 'imessage',
    timezone: userTimezone,
  });
  const latencyMs = Date.now() - start;

  const trace = result.trace ?? {};
  return {
    message,
    latencyMs,
    agent: trace.agentName ?? '?',
    model: trace.modelUsed ?? '?',
    routeLayer: trace.routeLayer ?? '?',
    isOnboarding,
    tools: (trace.toolCalls ?? []).map((tc: { name: string }) => tc.name),
    toolCount: trace.toolCallCount ?? 0,
    toolNames: trace.availableToolNames ?? [],
    inputTokens: trace.inputTokens ?? 0,
    outputTokens: trace.outputTokens ?? 0,
    rounds: trace.agentLoopRounds ?? 0,
    responseText: result.text ?? '',
    responsePreview: (result.text ?? '').substring(0, 300),
    responseLength: (result.text ?? '').length,
    pass: expectedAgent ? (trace.agentName === expectedAgent) : null,
    // Full trace for debug panel (mirrors debug dashboard)
    trace: {
      // Routing
      routeReason: trace.routeReason ?? null,
      routeFastPath: trace.routeDecision?.fastPathUsed ?? false,
      routeConfidence: trace.routeDecision?.confidence ?? null,
      routeMode: trace.routeDecision?.mode ?? null,
      routeNamespaces: trace.routeDecision?.allowedNamespaces ?? [],
      matchedDisqualifierBucket: trace.matchedDisqualifierBucket ?? null,
      hadPendingState: trace.hadPendingState ?? false,
      classifierLatencyMs: trace.classifierLatencyMs ?? 0,
      routeLatencyMs: trace.routerContextMs ?? 0,
      // Context
      systemPromptLength: trace.systemPromptLength ?? 0,
      systemPrompt: trace.systemPrompt ?? null,
      memoryItemsLoaded: trace.memoryItemsLoaded ?? 0,
      ragEvidenceBlocks: trace.ragEvidenceBlocks ?? 0,
      summariesLoaded: trace.summariesLoaded ?? 0,
      connectedAccountsCount: trace.connectedAccountsCount ?? 0,
      historyMessagesCount: trace.historyMessagesCount ?? 0,
      contextBuildLatencyMs: trace.contextBuildLatencyMs ?? 0,
      contextPath: trace.contextPath ?? null,
      // Agent
      agentName: trace.agentName ?? '?',
      modelUsed: trace.modelUsed ?? '?',
      agentLoopRounds: trace.agentLoopRounds ?? 0,
      agentLoopLatencyMs: trace.agentLoopLatencyMs ?? 0,
      promptComposeMs: trace.promptComposeMs ?? 0,
      toolFilterMs: trace.toolFilterMs ?? 0,
      // Tools
      toolCalls: trace.toolCalls ?? [],
      toolCallsBlocked: trace.toolCallsBlocked ?? [],
      toolCallCount: trace.toolCallCount ?? 0,
      toolTotalLatencyMs: trace.toolTotalLatencyMs ?? 0,
      // Tokens
      inputTokens: trace.inputTokens ?? 0,
      outputTokens: trace.outputTokens ?? 0,
      // Response
      responseLength: trace.responseLength ?? 0,
      totalLatencyMs: trace.totalLatencyMs ?? 0,
      // Error
      errorMessage: trace.errorMessage ?? null,
      errorStage: trace.errorStage ?? null,
      // Timezone
      timezoneResolved: trace.timezoneResolved ?? null,
      // Available tools
      availableToolNames: trace.availableToolNames ?? [],
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);

  // API: GET /debug-dashboard?api=traces&limit=50
  if (url.searchParams.get('api') === 'traces') {
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from('turn_traces')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // API: GET /debug-dashboard?api=trace&id=123
  if (url.searchParams.get('api') === 'trace') {
    const id = url.searchParams.get('id');
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from('turn_traces')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // API: POST /debug-dashboard?api=run-single — run a single message through the pipeline
  if (req.method === 'POST' && url.searchParams.get('api') === 'run-single') {
    try {
      const body = await req.json();
      const result = await runSingleTestCase(body.message, body.expectedAgent, {
        keepHistory: body.keepHistory ?? false,
        forceOnboarding: body.forceOnboarding ?? undefined,
      });
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: (err as Error).message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  // API: POST /debug-dashboard?api=clear-history — clear the DBG# conversation history
  if (req.method === 'POST' && url.searchParams.get('api') === 'clear-history') {
    try {
      const { clearConversation, cancelPendingEmailSends } = await import('../_shared/state.ts');
      const SENDER_HANDLE = '+61414187820';
      const BOT_NUMBER = '+13466215973';
      const CHAT_ID = `DBG#${BOT_NUMBER}#${SENDER_HANDLE}`;
      await clearConversation(CHAT_ID);
      await cancelPendingEmailSends(CHAT_ID);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: (err as Error).message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  // API: GET /debug-dashboard?api=test-runs — list stored test run results
  if (url.searchParams.get('api') === 'test-runs') {
    const runs = Object.entries(testRunStore).map(([id, run]) => ({
      id, ...run, results: undefined, resultCount: run.results.length,
    }));
    return new Response(JSON.stringify(runs), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // API: GET /debug-dashboard?api=test-run&id=xxx — get a specific test run's full results
  if (url.searchParams.get('api') === 'test-run') {
    const id = url.searchParams.get('id');
    const run = id ? testRunStore[id] : null;
    if (!run) {
      return new Response(JSON.stringify({ error: 'Run not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(run), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // API: POST /debug-dashboard?api=run-batch — run a batch of messages
  if (req.method === 'POST' && url.searchParams.get('api') === 'run-batch') {
    try {
      const body = await req.json();
      const cases: Array<{ message: string; expectedAgent?: string; id?: string }> = body.cases ?? [];
      const runId = crypto.randomUUID().substring(0, 8);

      testRunStore[runId] = {
        status: 'running',
        suite: body.suite ?? 'custom',
        startedAt: new Date().toISOString(),
        results: [],
      };

      // Run in background — don't await
      (async () => {
        try {
          for (const tc of cases) {
            const result = await runSingleTestCase(tc.message, tc.expectedAgent);
            testRunStore[runId].results.push({ ...result, caseId: tc.id });
          }
          const results = testRunStore[runId].results as Array<Record<string, unknown>>;
          const passCount = results.filter(r => r.pass === true).length;
          const failCount = results.filter(r => r.pass === false).length;
          const avgLatency = results.reduce((s, r) => s + (r.latencyMs as number), 0) / results.length;
          testRunStore[runId].summary = { total: results.length, pass: passCount, fail: failCount, avgLatencyMs: Math.round(avgLatency) };
          testRunStore[runId].status = 'done';
          testRunStore[runId].finishedAt = new Date().toISOString();
        } catch (err) {
          testRunStore[runId].status = 'error';
          testRunStore[runId].error = (err as Error).message;
          testRunStore[runId].finishedAt = new Date().toISOString();
        }
      })();

      return new Response(JSON.stringify({ runId, status: 'started', caseCount: cases.length }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: (err as Error).message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  // Serve the HTML dashboard
  return new Response(DASHBOARD_HTML, {
    headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
  });
});

// ═══════════════════════════════════════════════════════════════
// Full HTML dashboard — single-page app
// ═══════════════════════════════════════════════════════════════

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nest — Debug Dashboard</title>
<style>
  :root {
    --bg: #f8f9fa;
    --surface: #ffffff;
    --border: #e5e7eb;
    --text: #111827;
    --text-secondary: #6b7280;
    --accent: #111827;
    --accent-light: #f3f4f6;
    --green: #059669;
    --green-bg: #ecfdf5;
    --red: #dc2626;
    --red-bg: #fef2f2;
    --orange: #d97706;
    --orange-bg: #fffbeb;
    --blue: #2563eb;
    --blue-bg: #eff6ff;
    --purple: #7c3aed;
    --purple-bg: #f5f3ff;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }

  .header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .header-left { display: flex; align-items: center; gap: 20px; }

  .header h1 {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .header h1 span {
    color: var(--text-secondary);
    font-weight: 400;
    margin-left: 8px;
  }

  .header-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  /* ── Tab bar ── */
  .tab-bar {
    display: flex;
    align-items: center;
    background: var(--accent-light);
    padding: 2px;
    border-radius: 6px;
  }

  .tab-btn {
    padding: 5px 14px;
    font-size: 13px;
    font-weight: 500;
    border-radius: 5px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.15s;
  }

  .tab-btn:hover { color: var(--text); background: rgba(0,0,0,0.03); }
  .tab-btn.active { color: var(--text); background: var(--surface); box-shadow: 0 1px 2px rgba(0,0,0,0.06); }

  .btn {
    padding: 6px 12px;
    font-size: 13px;
    font-weight: 500;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn:hover { background: var(--accent-light); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-primary {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }

  .btn-primary:hover { background: #333; }

  .btn-sm {
    padding: 4px 8px;
    font-size: 11px;
  }

  .tab-content { display: none; }
  .tab-content.active { display: flex; }

  .layout {
    display: flex;
    height: calc(100vh - 53px);
  }

  /* ── Sidebar: message list ── */
  .sidebar {
    width: 380px;
    min-width: 380px;
    border-right: 1px solid var(--border);
    background: var(--surface);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .sidebar-header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    display: flex;
    justify-content: space-between;
    align-items: center;
    position: sticky;
    top: 0;
    background: var(--surface);
    z-index: 10;
  }

  .trace-count {
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }

  .message-item {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background 0.1s;
  }

  .message-item:hover { background: var(--accent-light); }
  .message-item.active { background: #f0f0f0; border-left: 3px solid var(--accent); }

  .message-item .msg-text {
    font-size: 14px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 4px;
  }

  .message-item .msg-meta {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 11px;
    color: var(--text-secondary);
  }

  .badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    font-size: 10px;
    font-weight: 600;
    border-radius: 6px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .badge-agent { background: var(--accent-light); color: var(--accent); }
  .badge-fast { background: var(--green-bg); color: var(--green); }
  .badge-llm { background: var(--purple-bg); color: var(--purple); }
  .badge-error { background: var(--red-bg); color: var(--red); }
  .badge-pass { background: var(--green-bg); color: var(--green); }
  .badge-fail { background: var(--red-bg); color: var(--red); }
  .badge-running { background: var(--orange-bg); color: var(--orange); }
  .badge-chat { background: var(--blue-bg); color: var(--blue); }
  .badge-smart { background: var(--purple-bg); color: var(--purple); }

  .latency-pill {
    font-size: 10px;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .main {
    flex: 1;
    overflow-y: auto;
    padding: 24px 32px;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-secondary);
    font-size: 14px;
    gap: 8px;
  }

  .empty-state svg { opacity: 0.3; }

  .tree { position: relative; padding-left: 0; }
  .tree-node { position: relative; margin-bottom: 0; }
  .tree-connector { position: absolute; left: 20px; top: 0; bottom: 0; width: 2px; background: var(--border); }

  .node-card {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 14px 16px;
    margin-left: 44px;
    margin-bottom: 12px;
    transition: box-shadow 0.15s;
  }

  .node-card:hover { box-shadow: 0 1px 4px rgba(0,0,0,0.06); }

  .node-dot {
    position: absolute; left: -32px; top: 18px; width: 12px; height: 12px;
    border-radius: 50%; border: 2px solid var(--border); background: var(--surface); z-index: 2;
  }

  .node-dot.dot-input { border-color: var(--accent); background: var(--accent); }
  .node-dot.dot-route { border-color: var(--purple); background: var(--purple); }
  .node-dot.dot-context { border-color: var(--blue); background: var(--blue); }
  .node-dot.dot-agent { border-color: var(--orange); background: var(--orange); }
  .node-dot.dot-tool { border-color: var(--green); background: var(--green); }
  .node-dot.dot-response { border-color: var(--accent); background: var(--accent); }
  .node-dot.dot-error { border-color: var(--red); background: var(--red); }

  .node-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .node-title { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-secondary); }
  .node-latency { font-size: 11px; color: var(--text-secondary); font-variant-numeric: tabular-nums; font-weight: 500; }
  .node-body { font-size: 13px; }
  .node-body .kv { display: flex; gap: 8px; padding: 3px 0; border-bottom: 1px solid #f3f4f6; }
  .node-body .kv:last-child { border-bottom: none; }
  .node-body .kv-key { color: var(--text-secondary); font-size: 12px; min-width: 120px; flex-shrink: 0; }
  .node-body .kv-val { font-size: 12px; font-weight: 500; word-break: break-word; }
  .node-body .kv-val.mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; }

  .tool-sub-node { background: #fafafa; border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; margin-top: 6px; }
  .tool-sub-node .tool-name { font-size: 12px; font-weight: 600; font-family: 'SF Mono', 'Fira Code', monospace; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
  .tool-outcome { display: inline-block; width: 6px; height: 6px; border-radius: 50%; }
  .tool-outcome.success { background: var(--green); }
  .tool-outcome.error { background: var(--red); }
  .tool-outcome.timeout { background: var(--orange); }

  .response-preview { background: #fafafa; border: 1px solid var(--border); border-radius: 6px; padding: 12px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow-y: auto; }
  .blocked-tool { background: var(--red-bg); border: 1px solid #fecaca; border-radius: 6px; padding: 8px 12px; margin-top: 6px; font-size: 12px; }

  .stats-bar { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 12px 16px; min-width: 120px; }
  .stat-card .stat-label { font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 500; }
  .stat-card .stat-value { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .stat-card .stat-unit { font-size: 12px; font-weight: 400; color: var(--text-secondary); }

  .error-banner { background: var(--red-bg); border: 1px solid #fecaca; border-radius: 6px; padding: 12px 16px; margin-bottom: 16px; font-size: 13px; color: var(--red); }
  .error-banner strong { font-weight: 600; }

  .namespaces-list { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .ns-tag { font-size: 10px; padding: 2px 6px; border-radius: 4px; background: var(--accent-light); color: var(--text-secondary); font-family: 'SF Mono', 'Fira Code', monospace; }

  .loading { display: flex; align-items: center; justify-content: center; padding: 40px; color: var(--text-secondary); font-size: 13px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner { width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; margin-right: 8px; }

  .sidebar-search { padding: 8px 16px; border-bottom: 1px solid var(--border); }
  .sidebar-search input { width: 100%; padding: 7px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; outline: none; background: var(--bg); transition: border-color 0.15s; }
  .sidebar-search input:focus { border-color: #aaa; }

  .side-effects-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
  .side-effect-tag { font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: 600; text-transform: uppercase; }
  .se-reaction { background: #fef3c7; color: #92400e; }
  .se-effect { background: #dbeafe; color: #1e40af; }
  .se-memory { background: #ede9fe; color: #5b21b6; }
  .se-image { background: #fce7f3; color: #9d174d; }

  /* ── Test Runner styles ── */
  .test-layout { flex-direction: column; padding: 24px 32px; overflow-y: auto; }

  .test-input-bar {
    display: flex; gap: 8px; margin-bottom: 24px; align-items: stretch;
  }

  .test-input-bar input {
    flex: 1; padding: 10px 14px; border: 1px solid var(--border); border-radius: 6px;
    font-size: 14px; outline: none; background: var(--surface); transition: border-color 0.15s;
  }

  .test-input-bar input:focus { border-color: #aaa; }

  .test-result-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 16px 20px; margin-bottom: 12px; transition: box-shadow 0.15s;
  }

  .test-result-card:hover { box-shadow: 0 1px 4px rgba(0,0,0,0.06); }

  .test-result-header {
    display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;
  }

  .test-result-header .test-msg {
    font-size: 14px; font-weight: 500; flex: 1; margin-right: 12px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  .test-result-meta {
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 11px; color: var(--text-secondary);
  }

  .test-result-body {
    background: #fafafa; border: 1px solid var(--border); border-radius: 6px;
    padding: 12px; font-size: 13px; line-height: 1.6; white-space: pre-wrap;
    word-break: break-word; max-height: 200px; overflow-y: auto; margin-top: 8px;
  }

  .test-tools-row {
    display: flex; gap: 4px; flex-wrap: wrap; margin-top: 8px;
  }

  .test-section-header {
    font-size: 13px; font-weight: 600; color: var(--text-secondary);
    text-transform: uppercase; letter-spacing: 0.04em; margin: 20px 0 12px 0;
    padding-bottom: 8px; border-bottom: 1px solid var(--border);
  }

  .test-summary-bar {
    display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px;
  }

  .progress-bar-container {
    width: 100%; height: 6px; background: var(--accent-light); border-radius: 3px; overflow: hidden; margin-top: 8px;
  }

  .progress-bar-fill {
    height: 100%; border-radius: 3px; transition: width 0.3s ease;
  }

  .progress-bar-fill.green { background: var(--green); }
  .progress-bar-fill.red { background: var(--red); }

  .collapsible-toggle {
    cursor: pointer; user-select: none;
  }

  .collapsible-toggle:hover { opacity: 0.8; }

  .test-detail-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; margin-top: 8px;
  }

  .test-detail-item {
    font-size: 11px; color: var(--text-secondary);
  }

  .test-detail-item strong {
    display: block; font-size: 13px; color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums;
  }
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <h1>Nest Debug</h1>
    <div class="tab-bar">
      <button class="tab-btn active" onclick="switchTab('traces')">Traces</button>
      <button class="tab-btn" onclick="switchTab('tests')">Test Runner</button>
    </div>
  </div>
  <div class="header-actions" id="headerActions">
    <button class="btn" onclick="loadTraces()" id="refreshBtn">Refresh</button>
  </div>
</div>

<!-- ═══════════════════════════════════════════════════════════════ -->
<!-- TAB 1: TRACES (existing) -->
<!-- ═══════════════════════════════════════════════════════════════ -->
<div id="tab-traces" class="tab-content active layout">
  <div class="sidebar">
    <div class="sidebar-search">
      <input type="text" id="searchInput" placeholder="Search messages..." oninput="filterMessages()" />
    </div>
    <div class="sidebar-header">
      <span>Recent Messages</span>
      <span class="trace-count" id="traceCount">—</span>
    </div>
    <div id="messageList"></div>
  </div>

  <div class="main" id="mainContent">
    <div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
      <span>Select a message to inspect its decision tree</span>
    </div>
  </div>
</div>

<!-- ═══════════════════════════════════════════════════════════════ -->
<!-- TAB 2: TEST RUNNER -->
<!-- ═══════════════════════════════════════════════════════════════ -->
<div id="tab-tests" class="tab-content layout test-layout" style="display:none">

  <!-- Quick Test -->
  <div class="test-section-header">Quick Test — Send a Single Message</div>
  <div class="test-input-bar">
    <input type="text" id="testMessageInput" placeholder="Type a message to test (e.g. &quot;What's on my calendar today?&quot;)" onkeydown="if(event.key==='Enter')runQuickTest()" />
    <button class="btn btn-primary" onclick="runQuickTest()" id="quickTestBtn">Run</button>
  </div>
  <div id="quickTestResults"></div>

  <!-- Preset Suites -->
  <div class="test-section-header">Preset Test Suites</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
    <button class="btn" onclick="runPresetSuite('routing')">Routing (15 cases)</button>
    <button class="btn" onclick="runPresetSuite('email')">Email (8 cases)</button>
    <button class="btn" onclick="runPresetSuite('calendar')">Calendar (6 cases)</button>
    <button class="btn" onclick="runPresetSuite('research')">Research (6 cases)</button>
    <button class="btn" onclick="runPresetSuite('recall')">Recall (5 cases)</button>
    <button class="btn" onclick="runPresetSuite('compound')">Compound (6 cases)</button>
    <button class="btn" onclick="runPresetSuite('chat')">Chat/Casual (8 cases)</button>
    <button class="btn" onclick="runPresetSuite('all')">All (54 cases)</button>
  </div>

  <!-- Suite Progress -->
  <div id="suiteProgress" style="display:none">
    <div class="test-summary-bar" id="suiteSummary"></div>
    <div class="progress-bar-container"><div class="progress-bar-fill green" id="suiteProgressBar" style="width:0%"></div></div>
    <div style="font-size:11px;color:var(--text-secondary);margin-top:4px" id="suiteProgressLabel">Starting...</div>
  </div>

  <!-- Suite Results -->
  <div id="suiteResults"></div>

  <!-- Batch Run History -->
  <div class="test-section-header" style="margin-top:32px">Recent Batch Runs</div>
  <div id="batchHistory"><span style="color:var(--text-secondary);font-size:13px">No batch runs yet</span></div>
</div>

<script>
let allTraces = [];
let activeTraceId = null;
let currentTab = 'traces';
let suiteRunning = false;
let suiteResults = [];
let suiteTotal = 0;

const BASE_URL = window.location.pathname.replace(/\\/$/, '');

// ═══════════════════════════════════════════════════════════════
// Tab switching
// ═══════════════════════════════════════════════════════════════

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => { c.style.display = 'none'; c.classList.remove('active'); });
  document.querySelector(\`[onclick="switchTab('\${tab}')"]\`).classList.add('active');
  const el = document.getElementById('tab-' + tab);
  el.style.display = 'flex';
  el.classList.add('active');

  const actions = document.getElementById('headerActions');
  if (tab === 'traces') {
    actions.innerHTML = '<button class="btn" onclick="loadTraces()" id="refreshBtn">Refresh</button>';
  } else {
    actions.innerHTML = '<button class="btn" onclick="loadBatchHistory()">Refresh History</button>';
  }
}

// ═══════════════════════════════════════════════════════════════
// TRACES TAB (existing logic)
// ═══════════════════════════════════════════════════════════════

async function loadTraces() {
  const btn = document.getElementById('refreshBtn');
  if (btn) { btn.textContent = 'Loading...'; btn.disabled = true; }
  try {
    const res = await fetch(BASE_URL + '?api=traces&limit=100');
    allTraces = await res.json();
    renderMessageList(allTraces);
    document.getElementById('traceCount').textContent = allTraces.length + ' traces';
  } catch (e) {
    document.getElementById('messageList').innerHTML = '<div class="loading" style="color:var(--red)">Failed to load traces</div>';
  } finally {
    if (btn) { btn.textContent = 'Refresh'; btn.disabled = false; }
  }
}

function filterMessages() {
  const q = document.getElementById('searchInput').value.toLowerCase();
  const filtered = allTraces.filter(t =>
    (t.user_message || '').toLowerCase().includes(q) ||
    (t.route_agent || '').toLowerCase().includes(q) ||
    (t.sender_handle || '').toLowerCase().includes(q) ||
    (t.response_text || '').toLowerCase().includes(q)
  );
  renderMessageList(filtered);
}

function renderMessageList(traces) {
  const container = document.getElementById('messageList');
  if (!traces.length) { container.innerHTML = '<div class="loading">No traces found</div>'; return; }
  container.innerHTML = traces.map(t => {
    const time = new Date(t.created_at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
    const isActive = t.id === activeTraceId;
    const routeType = t.route_fast_path ? 'fast' : 'llm';
    const hasError = t.error_message ? '<span class="badge badge-error">ERR</span>' : '';
    return \`<div class="message-item \${isActive ? 'active' : ''}" onclick="selectTrace(\${t.id})">
      <div class="msg-text">\${escHtml((t.user_message || '—').substring(0, 80))}</div>
      <div class="msg-meta">
        <span class="badge badge-agent">\${t.route_agent}</span>
        <span class="badge badge-\${routeType}">\${routeType}</span>
        \${hasError}
        <span class="latency-pill">\${t.total_latency_ms}ms</span>
        <span>\${time}</span>
      </div>
    </div>\`;
  }).join('');
}

function selectTrace(id) {
  activeTraceId = id;
  const trace = allTraces.find(t => t.id === id);
  if (!trace) return;
  renderMessageList(allTraces.filter(t => {
    const q = document.getElementById('searchInput').value.toLowerCase();
    if (!q) return true;
    return (t.user_message || '').toLowerCase().includes(q) || (t.route_agent || '').toLowerCase().includes(q) || (t.sender_handle || '').toLowerCase().includes(q);
  }));
  renderDecisionTree(trace);
}

function renderDecisionTree(t) {
  const main = document.getElementById('mainContent');
  const toolCalls = Array.isArray(t.tool_calls) ? t.tool_calls : [];
  const blockedCalls = Array.isArray(t.tool_calls_blocked) ? t.tool_calls_blocked : [];
  const routeType = t.route_fast_path ? 'Fast-path (regex)' : 'LLM Router';
  const confidence = t.route_confidence != null ? (t.route_confidence * 100).toFixed(0) + '%' : '—';
  const errorHtml = t.error_message ? \`<div class="error-banner"><strong>Error at \${t.error_stage || 'unknown'} stage:</strong> \${escHtml(t.error_message)}</div>\` : '';
  const toolNodes = toolCalls.map(tc => \`<div class="tool-sub-node"><div class="tool-name"><span class="tool-outcome \${tc.outcome || 'success'}"></span>\${escHtml(tc.name)}<span style="font-weight:400;color:var(--text-secondary);font-size:11px">\${tc.latencyMs || tc.latency_ms || 0}ms</span></div><div class="node-body"><div class="kv"><span class="kv-key">Namespace</span><span class="kv-val mono">\${tc.namespace || '—'}</span></div><div class="kv"><span class="kv-key">Side Effect</span><span class="kv-val">\${tc.sideEffect || tc.side_effect || '—'}</span></div><div class="kv"><span class="kv-key">Outcome</span><span class="kv-val">\${tc.outcome || 'success'}</span></div>\${tc.inputSummary || tc.input_summary ? \`<div class="kv"><span class="kv-key">Input</span><span class="kv-val mono">\${escHtml(tc.inputSummary || tc.input_summary)}</span></div>\` : ''}\${tc.approvalMethod || tc.approval_method ? \`<div class="kv"><span class="kv-key">Approval</span><span class="kv-val">\${tc.approvalMethod || tc.approval_method} (\${tc.approvalGranted || tc.approval_granted ? 'granted' : 'denied'})</span></div>\` : ''}</div></div>\`).join('');
  const blockedNodes = blockedCalls.map(bc => \`<div class="blocked-tool"><strong>\${escHtml(bc.name)}</strong> — blocked: \${bc.reason}<span class="ns-tag" style="margin-left:4px">\${bc.namespace}</span></div>\`).join('');
  const namespaceTags = (t.route_namespaces || []).map(ns => \`<span class="ns-tag">\${ns}</span>\`).join('');
  const sideEffects = [];
  if (t.response_text && t.response_text.includes('[reacted')) sideEffects.push('<span class="side-effect-tag se-reaction">Reaction</span>');
  if (t.response_text && t.response_text.includes('[sent')) sideEffects.push('<span class="side-effect-tag se-effect">Effect</span>');
  for (const tc of toolCalls) {
    if (tc.name === 'remember_user') sideEffects.push('<span class="side-effect-tag se-memory">Memory Write</span>');
    if (tc.name === 'generate_image') sideEffects.push('<span class="side-effect-tag se-image">Image Gen</span>');
  }
  main.innerHTML = \`\${errorHtml}
    <div class="stats-bar">
      <div class="stat-card"><div class="stat-label">Total Latency</div><div class="stat-value">\${t.total_latency_ms}<span class="stat-unit">ms</span></div></div>
      <div class="stat-card"><div class="stat-label">Agent Rounds</div><div class="stat-value">\${t.agent_loop_rounds}</div></div>
      <div class="stat-card"><div class="stat-label">Tool Calls</div><div class="stat-value">\${t.tool_call_count}</div></div>
      <div class="stat-card"><div class="stat-label">Input Tokens</div><div class="stat-value">\${formatNum(t.input_tokens)}</div></div>
      <div class="stat-card"><div class="stat-label">Output Tokens</div><div class="stat-value">\${formatNum(t.output_tokens)}</div></div>
      <div class="stat-card"><div class="stat-label">Model</div><div class="stat-value" style="font-size:13px">\${t.model_used || '—'}</div></div>
    </div>
    <div class="tree"><div class="tree-connector"></div>
      <div class="tree-node"><div class="node-card"><div class="node-dot dot-input"></div><div class="node-header"><span class="node-title">1 — User Input</span><span class="node-latency">\${new Date(t.created_at).toLocaleString('en-AU')}</span></div><div class="node-body"><div class="kv"><span class="kv-key">Message</span><span class="kv-val">\${escHtml(t.user_message || '—')}</span></div><div class="kv"><span class="kv-key">Sender</span><span class="kv-val mono">\${escHtml(t.sender_handle)}</span></div><div class="kv"><span class="kv-key">Chat ID</span><span class="kv-val mono">\${escHtml(t.chat_id)}</span></div>\${t.timezone_resolved ? \`<div class="kv"><span class="kv-key">Timezone</span><span class="kv-val">\${t.timezone_resolved}</span></div>\` : ''}</div></div></div>
      <div class="tree-node"><div class="node-card"><div class="node-dot dot-route"></div><div class="node-header"><span class="node-title">2 — Routing Decision</span><span class="node-latency">\${t.route_latency_ms}ms</span></div><div class="node-body"><div class="kv"><span class="kv-key">Method</span><span class="kv-val">\${routeType}</span></div><div class="kv"><span class="kv-key">Agent Selected</span><span class="kv-val"><span class="badge badge-agent">\${t.route_agent}</span></span></div><div class="kv"><span class="kv-key">Mode</span><span class="kv-val">\${t.route_mode || '—'}</span></div><div class="kv"><span class="kv-key">Confidence</span><span class="kv-val">\${confidence}</span></div><div class="kv"><span class="kv-key">Namespaces</span><span class="kv-val"><div class="namespaces-list">\${namespaceTags || '<span style="color:var(--text-secondary)">none</span>'}</div></span></div></div></div></div>
      <div class="tree-node"><div class="node-card"><div class="node-dot dot-context"></div><div class="node-header"><span class="node-title">3 — Context Assembly</span><span class="node-latency">\${t.context_build_latency_ms}ms</span></div><div class="node-body"><div class="kv"><span class="kv-key">History Messages</span><span class="kv-val">\${t.history_messages_count}</span></div><div class="kv"><span class="kv-key">Memory Items</span><span class="kv-val">\${t.memory_items_loaded}</span></div><div class="kv"><span class="kv-key">Summaries</span><span class="kv-val">\${t.summaries_loaded}</span></div><div class="kv"><span class="kv-key">RAG Evidence</span><span class="kv-val">\${t.rag_evidence_blocks} blocks</span></div><div class="kv"><span class="kv-key">Connected Accounts</span><span class="kv-val">\${t.connected_accounts_count}</span></div><div class="kv"><span class="kv-key">System Prompt</span><span class="kv-val">\${formatNum(t.system_prompt_length)} chars</span></div></div></div></div>
      <div class="tree-node"><div class="node-card"><div class="node-dot dot-agent"></div><div class="node-header"><span class="node-title">4 — Agent Loop</span><span class="node-latency">\${t.agent_loop_latency_ms}ms</span></div><div class="node-body"><div class="kv"><span class="kv-key">Agent</span><span class="kv-val"><span class="badge badge-agent">\${t.agent_name}</span></span></div><div class="kv"><span class="kv-key">Model</span><span class="kv-val mono">\${t.model_used}</span></div><div class="kv"><span class="kv-key">Rounds</span><span class="kv-val">\${t.agent_loop_rounds}</span></div><div class="kv"><span class="kv-key">Input Tokens</span><span class="kv-val">\${formatNum(t.input_tokens)}</span></div><div class="kv"><span class="kv-key">Output Tokens</span><span class="kv-val">\${formatNum(t.output_tokens)}</span></div></div></div></div>
      \${toolCalls.length > 0 || blockedCalls.length > 0 ? \`<div class="tree-node"><div class="node-card"><div class="node-dot dot-tool"></div><div class="node-header"><span class="node-title">5 — Tool Execution</span><span class="node-latency">\${t.tool_total_latency_ms}ms total</span></div><div class="node-body"><div class="kv"><span class="kv-key">Calls Made</span><span class="kv-val">\${t.tool_call_count}</span></div><div class="kv"><span class="kv-key">Blocked</span><span class="kv-val">\${blockedCalls.length}</span></div></div>\${toolNodes}\${blockedNodes}</div></div>\` : ''}
      <div class="tree-node"><div class="node-card"><div class="node-dot dot-response"></div><div class="node-header"><span class="node-title">\${toolCalls.length > 0 ? '6' : '5'} — Response</span><span class="node-latency">\${t.response_length} chars</span></div><div class="node-body"><div class="response-preview">\${escHtml(t.response_text || '(no text response — reaction/effect only)')}</div>\${sideEffects.length > 0 ? \`<div class="side-effects-row">\${sideEffects.join('')}</div>\` : ''}</div></div></div>
    </div>\`;
}

// ═══════════════════════════════════════════════════════════════
// TEST RUNNER TAB
// ═══════════════════════════════════════════════════════════════

const PRESET_SUITES = {
  routing: [
    { id: 'r-1', message: 'Hey!', expectedAgent: 'chat' },
    { id: 'r-2', message: 'haha yeah true', expectedAgent: 'chat' },
    { id: 'r-3', message: 'Thanks!', expectedAgent: 'chat' },
    { id: 'r-4', message: "What's on my calendar today?", expectedAgent: 'smart' },
    { id: 'r-5', message: 'Check my latest emails', expectedAgent: 'smart' },
    { id: 'r-6', message: "Who is the president of France?", expectedAgent: 'smart' },
    { id: 'r-7', message: 'What do you know about me?', expectedAgent: 'smart' },
    { id: 'r-8', message: "What's Tom's email address?", expectedAgent: 'smart' },
    { id: 'r-9', message: 'Draft an email to tom@lidgett.net saying hello', expectedAgent: 'smart' },
    { id: 'r-10', message: "What's the weather in Melbourne?", expectedAgent: 'smart' },
    { id: 'r-11', message: 'Im bored lol', expectedAgent: 'chat' },
    { id: 'r-12', message: 'Prep me for my next meeting', expectedAgent: 'smart' },
    { id: 'r-13', message: 'How does venture capital work?', expectedAgent: 'chat' },
    { id: 'r-14', message: 'Can you help me with something?', expectedAgent: 'chat' },
    { id: 'r-15', message: "Find Dan's email and book 30 mins next week", expectedAgent: 'smart' },
  ],
  email: [
    { id: 'e-1', message: 'Check my latest emails' },
    { id: 'e-2', message: 'Do I have any unread emails?' },
    { id: 'e-3', message: 'Search my emails for anything from Blacklane' },
    { id: 'e-4', message: 'What emails did I get today?' },
    { id: 'e-5', message: 'Find all emails from Origin Energy' },
    { id: 'e-6', message: 'Summarise my most recent 5 emails' },
    { id: 'e-7', message: 'Draft an email to tom@lidgett.net saying test please disregard' },
    { id: 'e-8', message: 'Any important emails I should know about?' },
  ],
  calendar: [
    { id: 'c-1', message: "What's on my calendar today?" },
    { id: 'c-2', message: "What's on tomorrow?" },
    { id: 'c-3', message: 'When am I free this week?' },
    { id: 'c-4', message: 'How many hours of meetings do I have this week?' },
    { id: 'c-5', message: 'Am I free tomorrow afternoon?' },
    { id: 'c-6', message: "What's my next meeting?" },
  ],
  research: [
    { id: 'w-1', message: "What's the weather in Melbourne?" },
    { id: 'w-2', message: "What's the latest news about AI?" },
    { id: 'w-3', message: 'Who is the current president of France?' },
    { id: 'w-4', message: 'Compare Toyota HiLux vs Mazda BT-50 for towing' },
    { id: 'w-5', message: "What's the latest with AI regulation?" },
    { id: 'w-6', message: 'Tell me about the history of Japan' },
  ],
  recall: [
    { id: 'm-1', message: 'What do you know about me?' },
    { id: 'm-2', message: 'What are my food preferences?' },
    { id: 'm-3', message: 'Do you remember what I told you about my trip?' },
    { id: 'm-4', message: 'What do you remember about my work?' },
    { id: 'm-5', message: 'Give me a summary of everything you know about me' },
  ],
  compound: [
    { id: 'x-1', message: "Find Dan's email and book 30 mins next week" },
    { id: 'x-2', message: "What's on my calendar today, and check my emails too" },
    { id: 'x-3', message: 'Look up the latest AI news then draft an email to tom@lidgett.net summarising it' },
    { id: 'x-4', message: 'Check my calendar for tomorrow, find any emails related to those meetings' },
    { id: 'x-5', message: "What did we discuss last week? Then send a summary to tom@lidgett.net" },
    { id: 'x-6', message: "Who is Daniel Barth and when's my next meeting with him?" },
  ],
  chat: [
    { id: 'ch-1', message: 'Hey!', expectedAgent: 'chat' },
    { id: 'ch-2', message: 'haha yeah true', expectedAgent: 'chat' },
    { id: 'ch-3', message: 'Im bored lol', expectedAgent: 'chat' },
    { id: 'ch-4', message: 'Thanks!', expectedAgent: 'chat' },
    { id: 'ch-5', message: 'How does venture capital work?', expectedAgent: 'chat' },
    { id: 'ch-6', message: 'Can you help me with something?', expectedAgent: 'chat' },
    { id: 'ch-7', message: "What's the meaning of life?", expectedAgent: 'chat' },
    { id: 'ch-8', message: 'Tell me a joke', expectedAgent: 'chat' },
  ],
};
PRESET_SUITES.all = [...PRESET_SUITES.routing, ...PRESET_SUITES.email, ...PRESET_SUITES.calendar, ...PRESET_SUITES.research, ...PRESET_SUITES.recall, ...PRESET_SUITES.compound];

async function runQuickTest() {
  const input = document.getElementById('testMessageInput');
  const btn = document.getElementById('quickTestBtn');
  const msg = input.value.trim();
  if (!msg) return;

  btn.textContent = 'Running...';
  btn.disabled = true;

  try {
    const res = await fetch(BASE_URL + '?api=run-single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    const r = await res.json();
    if (r.error) throw new Error(r.error);

    const container = document.getElementById('quickTestResults');
    container.innerHTML = renderTestResultCard(r, true) + container.innerHTML;
    input.value = '';
  } catch (err) {
    const container = document.getElementById('quickTestResults');
    container.innerHTML = \`<div class="error-banner"><strong>Error:</strong> \${escHtml(err.message)}</div>\` + container.innerHTML;
  } finally {
    btn.textContent = 'Run';
    btn.disabled = false;
  }
}

async function runPresetSuite(suiteName) {
  if (suiteRunning) { alert('A suite is already running. Please wait.'); return; }
  const cases = PRESET_SUITES[suiteName];
  if (!cases) return;

  suiteRunning = true;
  suiteResults = [];
  suiteTotal = cases.length;

  document.getElementById('suiteProgress').style.display = 'block';
  document.getElementById('suiteResults').innerHTML = '';
  updateSuiteProgress(0, 0, 0);

  let passCount = 0;
  let failCount = 0;

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i];
    document.getElementById('suiteProgressLabel').textContent = \`Running \${i + 1}/\${cases.length}: "\${tc.message.substring(0, 50)}..."\`;

    try {
      const res = await fetch(BASE_URL + '?api=run-single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: tc.message, expectedAgent: tc.expectedAgent }),
      });
      const r = await res.json();
      r.caseId = tc.id;
      r.expectedAgent = tc.expectedAgent;
      suiteResults.push(r);

      if (r.pass === false) failCount++;
      else passCount++;
    } catch (err) {
      suiteResults.push({ caseId: tc.id, message: tc.message, error: err.message, pass: false, latencyMs: 0, agent: '?', tools: [], responsePreview: '' });
      failCount++;
    }

    updateSuiteProgress(i + 1, passCount, failCount);
    renderSuiteResults();
  }

  document.getElementById('suiteProgressLabel').textContent = \`Done — \${passCount} pass, \${failCount} fail out of \${cases.length}\`;
  suiteRunning = false;
}

function updateSuiteProgress(done, pass, fail) {
  const pct = suiteTotal > 0 ? (done / suiteTotal * 100).toFixed(0) : 0;
  document.getElementById('suiteProgressBar').style.width = pct + '%';
  document.getElementById('suiteProgressBar').className = 'progress-bar-fill ' + (fail > 0 ? 'red' : 'green');

  document.getElementById('suiteSummary').innerHTML = \`
    <div class="stat-card"><div class="stat-label">Progress</div><div class="stat-value">\${done}<span class="stat-unit">/ \${suiteTotal}</span></div></div>
    <div class="stat-card"><div class="stat-label">Pass</div><div class="stat-value" style="color:var(--green)">\${pass}</div></div>
    <div class="stat-card"><div class="stat-label">Fail</div><div class="stat-value" style="color:\${fail > 0 ? 'var(--red)' : 'var(--text-secondary)'}">\${fail}</div></div>
    <div class="stat-card"><div class="stat-label">Pass Rate</div><div class="stat-value">\${done > 0 ? ((pass / done) * 100).toFixed(0) : 0}<span class="stat-unit">%</span></div></div>
    <div class="stat-card"><div class="stat-label">Avg Latency</div><div class="stat-value">\${suiteResults.length > 0 ? (suiteResults.reduce((s, r) => s + (r.latencyMs || 0), 0) / suiteResults.length / 1000).toFixed(1) : '—'}<span class="stat-unit">s</span></div></div>
  \`;
}

function renderSuiteResults() {
  const container = document.getElementById('suiteResults');
  container.innerHTML = suiteResults.map(r => renderTestResultCard(r, false)).join('');
}

function renderTestResultCard(r, expanded) {
  const agentBadge = r.agent === 'chat' ? 'badge-chat' : r.agent === 'smart' ? 'badge-smart' : 'badge-agent';
  const passBadge = r.pass === true ? '<span class="badge badge-pass">PASS</span>'
    : r.pass === false ? '<span class="badge badge-fail">FAIL</span>'
    : '<span class="badge badge-agent">RAN</span>';
  const toolTags = (r.tools || []).map(t => \`<span class="ns-tag">\${t}</span>\`).join('');
  const errorHtml = r.error ? \`<div class="error-banner" style="margin-top:8px"><strong>Error:</strong> \${escHtml(r.error)}</div>\` : '';

  return \`<div class="test-result-card">
    <div class="test-result-header">
      <span class="test-msg">\${r.caseId ? '[' + r.caseId + '] ' : ''}\${escHtml(r.message)}</span>
      \${passBadge}
    </div>
    <div class="test-result-meta">
      <span class="badge \${agentBadge}">\${r.agent}</span>
      <span class="latency-pill">\${r.latencyMs ? (r.latencyMs / 1000).toFixed(1) + 's' : '—'}</span>
      <span>\${r.rounds || 0} rounds</span>
      <span>\${formatNum(r.inputTokens || 0)}in / \${formatNum(r.outputTokens || 0)}out</span>
      <span>\${r.routeLayer || ''}</span>
    </div>
    \${(r.tools || []).length > 0 ? \`<div class="test-tools-row">\${toolTags}</div>\` : ''}
    \${r.responsePreview ? \`<div class="test-result-body">\${escHtml(r.responsePreview)}</div>\` : ''}
    \${errorHtml}
  </div>\`;
}

async function loadBatchHistory() {
  try {
    const res = await fetch(BASE_URL + '?api=test-runs');
    const runs = await res.json();
    const container = document.getElementById('batchHistory');
    if (!runs.length) { container.innerHTML = '<span style="color:var(--text-secondary);font-size:13px">No batch runs yet</span>'; return; }
    container.innerHTML = runs.map(r => \`
      <div class="test-result-card" style="cursor:pointer" onclick="loadBatchRun('\${r.id}')">
        <div class="test-result-header">
          <span class="test-msg">\${r.suite} — \${r.resultCount} cases</span>
          <span class="badge badge-\${r.status === 'done' ? 'pass' : r.status === 'running' ? 'running' : 'fail'}">\${r.status}</span>
        </div>
        <div class="test-result-meta">
          <span>Started: \${new Date(r.startedAt).toLocaleString('en-AU')}</span>
          \${r.finishedAt ? \`<span>Finished: \${new Date(r.finishedAt).toLocaleString('en-AU')}</span>\` : ''}
        </div>
      </div>
    \`).join('');
  } catch (e) {
    document.getElementById('batchHistory').innerHTML = '<span style="color:var(--red);font-size:13px">Failed to load history</span>';
  }
}

async function loadBatchRun(id) {
  try {
    const res = await fetch(BASE_URL + '?api=test-run&id=' + id);
    const run = await res.json();
    suiteResults = run.results || [];
    suiteTotal = suiteResults.length;
    const pass = suiteResults.filter(r => r.pass === true).length;
    const fail = suiteResults.filter(r => r.pass === false).length;
    document.getElementById('suiteProgress').style.display = 'block';
    updateSuiteProgress(suiteTotal, pass, fail);
    document.getElementById('suiteProgressLabel').textContent = \`Loaded run \${id} — \${run.status}\`;
    renderSuiteResults();
  } catch (e) {
    alert('Failed to load run: ' + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatNum(n) {
  if (n == null) return '0';
  return n.toLocaleString();
}

loadTraces();
</script>
</body>
</html>`;
