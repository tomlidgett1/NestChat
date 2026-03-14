export const debugDashboardHtml = `<!DOCTYPE html>
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

  .header h1 { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
  .header h1 span { color: var(--text-secondary); font-weight: 400; margin-left: 8px; }

  .header-actions { display: flex; gap: 8px; align-items: center; }

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
  .btn-copy { position: relative; }
  .btn-copy.copied { border-color: var(--green); color: var(--green); }

  .layout { display: flex; height: calc(100vh - 53px); }

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
    background: var(--surface);
  }

  .trace-count { font-weight: 400; text-transform: none; letter-spacing: 0; }

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
    flex-wrap: wrap;
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
  .badge-light { background: #dbeafe; color: #1e40af; }
  .badge-full { background: var(--accent-light); color: var(--text-secondary); }
  .badge-effort-low { background: var(--green-bg); color: var(--green); }
  .badge-effort-medium { background: var(--orange-bg); color: var(--orange); }
  .badge-effort-high { background: var(--red-bg); color: var(--red); }
  .badge-rag-skip { background: #ecfdf5; color: #059669; }

  .latency-pill { font-size: 10px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }

  .main { flex: 1; overflow-y: auto; padding: 24px 32px; }

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

  .tree { position: relative; }
  .tree-node { position: relative; }

  .tree-connector {
    position: absolute;
    left: 20px;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--border);
  }

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
    position: absolute;
    left: -32px;
    top: 18px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid var(--border);
    background: var(--surface);
    z-index: 2;
  }

  .node-dot.dot-input { border-color: var(--accent); background: var(--accent); }
  .node-dot.dot-route { border-color: var(--purple); background: var(--purple); }
  .node-dot.dot-context { border-color: var(--blue); background: var(--blue); }
  .node-dot.dot-agent { border-color: var(--orange); background: var(--orange); }
  .node-dot.dot-tool { border-color: var(--green); background: var(--green); }
  .node-dot.dot-response { border-color: var(--accent); background: var(--accent); }
  .node-dot.dot-error { border-color: var(--red); background: var(--red); }

  .node-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .node-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-secondary);
  }

  .node-latency {
    font-size: 11px;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
    font-weight: 500;
  }

  .node-body { font-size: 13px; }

  .node-body .kv {
    display: flex;
    gap: 8px;
    padding: 3px 0;
    border-bottom: 1px solid #f3f4f6;
  }

  .node-body .kv:last-child { border-bottom: none; }

  .node-body .kv-key {
    color: var(--text-secondary);
    font-size: 12px;
    min-width: 140px;
    flex-shrink: 0;
  }

  .node-body .kv-val {
    font-size: 12px;
    font-weight: 500;
    word-break: break-word;
  }

  .node-body .kv-val.mono {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 11px;
  }

  .node-body .kv-val.dim { color: var(--text-secondary); font-weight: 400; }

  .tool-sub-node {
    background: #fafafa;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 12px;
    margin-top: 6px;
  }

  .tool-sub-node .tool-name {
    font-size: 12px;
    font-weight: 600;
    font-family: 'SF Mono', 'Fira Code', monospace;
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .tool-outcome {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }

  .tool-outcome.success { background: var(--green); }
  .tool-outcome.error { background: var(--red); }
  .tool-outcome.timeout { background: var(--orange); }

  .response-preview {
    background: #fafafa;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
    font-size: 13px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 300px;
    overflow-y: auto;
  }

  .blocked-tool {
    background: var(--red-bg);
    border: 1px solid #fecaca;
    border-radius: 6px;
    padding: 8px 12px;
    margin-top: 6px;
    font-size: 12px;
  }

  .stats-bar {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 20px;
  }

  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 14px;
    min-width: 110px;
  }

  .stat-card .stat-label {
    font-size: 10px;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 500;
  }

  .stat-card .stat-value {
    font-size: 18px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    margin-top: 2px;
  }

  .stat-card .stat-unit {
    font-size: 11px;
    font-weight: 400;
    color: var(--text-secondary);
  }

  .error-banner {
    background: var(--red-bg);
    border: 1px solid #fecaca;
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 16px;
    font-size: 13px;
    color: var(--red);
  }

  .error-banner strong { font-weight: 600; }

  .namespaces-list { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }

  .ns-tag {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--accent-light);
    color: var(--text-secondary);
    font-family: 'SF Mono', 'Fira Code', monospace;
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px;
    color: var(--text-secondary);
    font-size: 13px;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    margin-right: 6px;
    vertical-align: middle;
  }

  .sidebar-search { padding: 8px 16px; border-bottom: 1px solid var(--border); }

  .sidebar-search input {
    width: 100%;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 13px;
    outline: none;
    background: var(--bg);
    transition: border-color 0.15s;
  }

  .sidebar-search input:focus { border-color: #aaa; }

  .side-effects-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }

  .side-effect-tag {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .se-reaction { background: #fef3c7; color: #92400e; }
  .se-effect { background: #dbeafe; color: #1e40af; }
  .se-memory { background: #ede9fe; color: #5b21b6; }
  .se-image { background: #fce7f3; color: #9d174d; }

  .latency-bar-wrap { margin-top: 16px; margin-bottom: 8px; }

  .latency-bar-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 6px;
  }

  .latency-bar {
    display: flex;
    height: 28px;
    border-radius: 6px;
    overflow: hidden;
    background: var(--accent-light);
  }

  .latency-segment {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 600;
    color: white;
    white-space: nowrap;
    overflow: hidden;
    min-width: 2px;
    transition: width 0.3s ease;
  }

  .seg-route { background: var(--purple); }
  .seg-context { background: var(--blue); }
  .seg-agent { background: var(--orange); }
  .seg-tools { background: var(--green); }
  .seg-overhead { background: #9ca3af; }
  .seg-routerctx { background: #6366f1; }
  .seg-prompt { background: #ec4899; }

  .latency-legend { display: flex; gap: 12px; margin-top: 6px; flex-wrap: wrap; }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text-secondary);
  }

  .legend-dot { width: 8px; height: 8px; border-radius: 2px; }

  .round-row {
    display: flex;
    align-items: stretch;
    gap: 0;
    margin: 4px 0;
    border-radius: 4px;
    overflow: hidden;
    height: 22px;
    background: var(--accent-light);
  }

  .round-seg {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 600;
    color: white;
    min-width: 1px;
    white-space: nowrap;
    overflow: hidden;
  }

  .round-seg-api { background: var(--orange); }
  .round-seg-tool { background: var(--green); }
  .round-seg-overhead { background: #d1d5db; }

  .round-label {
    font-size: 10px;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 2px;
  }

  .retry-badge {
    font-size: 9px;
    background: var(--red-bg);
    color: var(--red);
    padding: 1px 5px;
    border-radius: 4px;
    font-weight: 600;
  }

  .ctx-timing-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px 12px;
  }

  .ctx-timing-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 0;
    font-size: 11px;
  }

  .ctx-timing-bar {
    height: 6px;
    border-radius: 3px;
    background: var(--blue);
    min-width: 2px;
    transition: width 0.3s ease;
  }

  .ctx-timing-name {
    color: var(--text-secondary);
    min-width: 80px;
    font-size: 11px;
  }

  .ctx-timing-val {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    font-size: 11px;
  }

  .perf-alert {
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 11px;
    margin-top: 8px;
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }

  .perf-alert-warn { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; }
  .perf-alert-crit { background: var(--red-bg); border: 1px solid #fecaca; color: var(--red); }

  .section-divider {
    border: none;
    border-top: 1px dashed var(--border);
    margin: 6px 0;
  }

  .mini-bar-wrap { display: flex; align-items: center; gap: 6px; margin-top: 2px; }

  .mini-bar {
    height: 6px;
    border-radius: 3px;
    background: var(--green);
    transition: width 0.3s ease;
  }

  .mini-bar-label { font-size: 10px; color: var(--text-secondary); white-space: nowrap; }

  .json-toggle {
    margin-top: 8px;
  }

  .json-toggle summary {
    font-size: 11px;
    color: var(--text-secondary);
    cursor: pointer;
    font-weight: 500;
    padding: 4px 0;
  }

  .json-toggle pre {
    background: #f9fafb;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px;
    font-size: 11px;
    font-family: 'SF Mono', 'Fira Code', monospace;
    line-height: 1.5;
    overflow-x: auto;
    max-height: 300px;
    overflow-y: auto;
    margin-top: 4px;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .top-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }

  .top-bar-left {
    font-size: 11px;
    color: var(--text-secondary);
    font-family: 'SF Mono', 'Fira Code', monospace;
  }

  .top-bar-actions { display: flex; gap: 6px; }

  .toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: var(--accent);
    color: white;
    padding: 10px 16px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    z-index: 1000;
    opacity: 0;
    transform: translateY(8px);
    transition: all 0.2s ease;
    pointer-events: none;
  }

  .toast.show {
    opacity: 1;
    transform: translateY(0);
  }
</style>
</head>
<body>

<div class="header">
  <h1>Nest Debug <span>Decision Tree Inspector</span></h1>
  <div class="header-actions">
    <button class="btn" onclick="loadTraces()" id="refreshBtn">Refresh</button>
  </div>
</div>

<div class="layout">
  <div class="sidebar">
    <div class="sidebar-search">
      <input type="text" id="searchInput" placeholder="Search messages..." oninput="filterMessages()" />
    </div>
    <div class="sidebar-header">
      <span>Recent Messages</span>
      <span class="trace-count" id="traceCount">&mdash;</span>
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

<div class="toast" id="toast">Copied to clipboard</div>

<script>
var allTraces = [];
var activeTraceId = null;
var activeTrace = null;
var threadCache = {};
var activeThread = null;

function showToast(msg) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(function() { el.classList.remove('show'); }, 1800);
}

function copyTraceJson() {
  if (!activeTrace) return;

  var enriched = JSON.parse(JSON.stringify(activeTrace));

  var total = enriched.total_latency_ms || 1;
  var routeMs = enriched.route_latency_ms || 0;
  var ctxMs = enriched.context_build_latency_ms || 0;
  var agentMs = enriched.agent_loop_latency_ms || 0;
  var toolMs = enriched.tool_total_latency_ms || 0;
  var overheadMs = Math.max(0, total - routeMs - ctxMs - agentMs);

  enriched._computed = {
    latency_breakdown: {
      router_context_ms: enriched.router_context_ms || 0,
      route_ms: routeMs,
      route_pct: pct(routeMs, total),
      context_ms: ctxMs,
      context_pct: pct(ctxMs, total),
      context_sub_timings: enriched.context_sub_timings || null,
      agent_loop_ms: agentMs,
      agent_loop_pct: pct(agentMs, total),
      prompt_compose_ms: enriched.prompt_compose_ms || 0,
      tool_filter_ms: enriched.tool_filter_ms || 0,
      tool_total_ms: toolMs,
      tool_pct: pct(toolMs, total),
      overhead_ms: overheadMs,
      overhead_pct: pct(overheadMs, total),
    },
    round_traces: enriched.round_traces || [],
    tokens: {
      total: (enriched.input_tokens || 0) + (enriched.output_tokens || 0),
      input: enriched.input_tokens || 0,
      output: enriched.output_tokens || 0,
      per_round_avg: enriched.agent_loop_rounds > 0 ? Math.round(((enriched.input_tokens || 0) + (enriched.output_tokens || 0)) / enriched.agent_loop_rounds) : 0,
      output_per_round_avg: enriched.agent_loop_rounds > 0 ? Math.round((enriched.output_tokens || 0) / enriched.agent_loop_rounds) : 0,
    },
    cost_estimate_usd: estimateCost(enriched),
    ms_per_output_token: enriched.output_tokens > 0 ? round2((enriched.agent_loop_latency_ms || 0) / enriched.output_tokens) : null,
    response_chars_per_second: enriched.total_latency_ms > 0 ? Math.round((enriched.response_length || 0) / (enriched.total_latency_ms / 1000)) : 0,
    context_path: enriched.context_path || 'full',
    rag_skipped: enriched.context_sub_timings ? enriched.context_sub_timings.ragMs === 0 : false,
    routing_method: enriched.route_fast_path ? 'fast_path_regex' : 'llm_router',
    routing_fell_back: !enriched.route_fast_path && (enriched.route_confidence || 0) < 0.6,
    pending_action_debug: enriched.pending_action_debug || {},
    tool_calls_detail: (enriched.tool_calls || []).map(function(tc) {
      return {
        name: tc.name,
        namespace: tc.namespace,
        side_effect: tc.sideEffect || tc.side_effect,
        outcome: tc.outcome,
        latency_ms: tc.latencyMs || tc.latency_ms || 0,
        pct_of_tool_total: toolMs > 0 ? pct(tc.latencyMs || tc.latency_ms || 0, toolMs) : '0%',
        pct_of_turn_total: pct(tc.latencyMs || tc.latency_ms || 0, total),
        input_summary: tc.inputSummary || tc.input_summary || null,
        approval_method: tc.approvalMethod || tc.approval_method || null,
        approval_granted: tc.approvalGranted || tc.approval_granted || null,
        pending_action_id: tc.pendingActionId || tc.pending_action_id || null,
        send_resolution_source: tc.sendResolutionSource || tc.send_resolution_source || null,
        pending_action_failure_reason: tc.pendingActionFailureReason || tc.pending_action_failure_reason || null,
      };
    }),
    blocked_calls_detail: (enriched.tool_calls_blocked || []).map(function(bc) {
      return {
        name: bc.name,
        namespace: bc.namespace,
        reason: bc.reason,
        detail: bc.detail || null,
        pending_action_id: bc.pendingActionId || bc.pending_action_id || null,
      };
    }),
    side_effects: extractSideEffectNames(enriched.tool_calls || []),
    has_error: !!enriched.error_message,
  };

  if (activeThread && activeThread.length > 0) {
    enriched._conversation_thread = activeThread;
  }

  navigator.clipboard.writeText(JSON.stringify(enriched, null, 2)).then(function() {
    showToast('Copied full trace JSON to clipboard');
  });
}

async function loadThread(chatId, beforeTimestamp) {
  if (threadCache[chatId]) {
    activeThread = threadCache[chatId];
    renderThreadPanel(activeThread, chatId);
    return;
  }

  var threadEl = document.getElementById('threadPanel');
  if (threadEl) threadEl.innerHTML = '<div class="loading"><div class="spinner"></div>Loading conversation thread...</div>';

  try {
    var url = '/debug/api/thread/' + encodeURIComponent(chatId) + '?limit=40';
    if (beforeTimestamp) url += '&before=' + encodeURIComponent(beforeTimestamp);
    var res = await fetch(url);
    var data = await res.json();
    threadCache[chatId] = data;
    activeThread = data;
    renderThreadPanel(data, chatId);
  } catch (e) {
    if (threadEl) threadEl.innerHTML = '<div class="loading" style="color:var(--red)">Failed to load thread</div>';
  }
}

function renderThreadPanel(messages, chatId) {
  var el = document.getElementById('threadPanel');
  if (!el) return;

  if (!messages || messages.length === 0) {
    el.innerHTML = '<div style="color:var(--text-secondary);font-size:12px;padding:8px 0">No conversation messages found for this chat.</div>';
    return;
  }

  var html = '<div style="display:flex;flex-direction:column;gap:4px;max-height:400px;overflow-y:auto;padding:4px 0">';

  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    var role = msg.role || 'unknown';
    var isUser = role === 'user';
    var isHighlighted = activeTrace && msg.content && activeTrace.user_message && msg.content.trim() === activeTrace.user_message.trim();
    var time = msg.created_at ? new Date(msg.created_at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: true }) : '';
    var handle = msg.handle ? msg.handle : '';
    var toolsMeta = msg.metadata && msg.metadata.tools_used ? ' [tools: ' + msg.metadata.tools_used.map(function(t) { return t.tool; }).join(', ') + ']' : '';
    var content = (msg.content || '').substring(0, 300);
    if ((msg.content || '').length > 300) content += '...';

    var bgColor = isHighlighted ? '#fef3c7' : (isUser ? '#f9fafb' : 'white');
    var borderColor = isHighlighted ? '#fbbf24' : 'var(--border)';
    var roleBg = isUser ? 'var(--blue-bg)' : 'var(--green-bg)';
    var roleColor = isUser ? 'var(--blue)' : 'var(--green)';

    html += '<div style="background:' + bgColor + ';border:1px solid ' + borderColor + ';border-radius:6px;padding:8px 10px;font-size:12px">'
      + '<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">'
      + '<span class="badge" style="background:' + roleBg + ';color:' + roleColor + '">' + role + '</span>'
      + (handle ? '<span style="font-size:10px;color:var(--text-secondary);font-family:monospace">' + escHtml(handle) + '</span>' : '')
      + '<span style="font-size:10px;color:var(--text-secondary);margin-left:auto">' + time + '</span>'
      + (isHighlighted ? '<span class="badge" style="background:#fef3c7;color:#92400e">THIS MSG</span>' : '')
      + '</div>'
      + '<div style="white-space:pre-wrap;word-break:break-word;line-height:1.5;color:var(--text)">' + escHtml(content) + '</div>'
      + (toolsMeta ? '<div style="font-size:10px;color:var(--text-secondary);margin-top:2px">' + escHtml(toolsMeta) + '</div>' : '')
      + '</div>';
  }

  html += '</div>';
  el.innerHTML = html;
}

function pct(part, total) {
  if (!total) return '0%';
  return (part / total * 100).toFixed(1) + '%';
}

function round2(n) { return Math.round(n * 100) / 100; }

function estimateCost(t) {
  var inputRate = 0;
  var outputRate = 0;
  var model = (t.model_used || '').toLowerCase();
  if (model.includes('5-nano') || model.includes('nano')) {
    inputRate = 0.10 / 1000000;
    outputRate = 0.40 / 1000000;
  } else if (model.includes('4.1-mini')) {
    inputRate = 0.40 / 1000000;
    outputRate = 1.60 / 1000000;
  } else if (model.includes('5-mini') || model.includes('mini')) {
    inputRate = 0.30 / 1000000;
    outputRate = 1.25 / 1000000;
  } else if (model.includes('4.1')) {
    inputRate = 2.00 / 1000000;
    outputRate = 8.00 / 1000000;
  } else {
    inputRate = 0.30 / 1000000;
    outputRate = 1.25 / 1000000;
  }
  var routerCost = 0;
  if (!t.route_fast_path) {
    routerCost = (500 * 0.10 / 1000000) + (150 * 0.40 / 1000000);
  }
  return round2(((t.input_tokens || 0) * inputRate + (t.output_tokens || 0) * outputRate + routerCost) * 100) / 100;
}

function extractSideEffectNames(toolCalls) {
  var effects = [];
  for (var i = 0; i < toolCalls.length; i++) {
    var n = toolCalls[i].name;
    if (n === 'send_reaction') effects.push('reaction');
    if (n === 'send_effect') effects.push('message_effect');
    if (n === 'remember_user') effects.push('memory_write');
    if (n === 'generate_image') effects.push('image_generation');
  }
  return effects;
}

async function loadTraces() {
  var btn = document.getElementById('refreshBtn');
  btn.textContent = 'Loading...';
  btn.disabled = true;

  try {
    var res = await fetch('/debug/api/traces?limit=100');
    allTraces = await res.json();
    renderMessageList(allTraces);
    document.getElementById('traceCount').textContent = allTraces.length + ' traces';
  } catch (e) {
    document.getElementById('messageList').innerHTML =
      '<div class="loading" style="color:var(--red)">Failed to load traces</div>';
  } finally {
    btn.textContent = 'Refresh';
    btn.disabled = false;
  }
}

function filterMessages() {
  var q = document.getElementById('searchInput').value.toLowerCase();
  var filtered = allTraces.filter(function(t) {
    return (t.user_message || '').toLowerCase().includes(q) ||
      (t.route_agent || '').toLowerCase().includes(q) ||
      (t.sender_handle || '').toLowerCase().includes(q) ||
      (t.response_text || '').toLowerCase().includes(q);
  });
  renderMessageList(filtered);
}

function renderMessageList(traces) {
  var container = document.getElementById('messageList');
  if (!traces.length) {
    container.innerHTML = '<div class="loading">No traces found</div>';
    return;
  }

  container.innerHTML = traces.map(function(t) {
    var time = new Date(t.created_at).toLocaleString('en-AU', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true
    });
    var isActive = t.id === activeTraceId;
    var routeType = t.route_fast_path ? 'fast' : 'llm';
    var hasError = t.error_message ? '<span class="badge badge-error">ERR</span>' : '';

    var itemToolCalls = t.tool_calls || [];
    var itemToolNames = [];
    for (var tn = 0; tn < itemToolCalls.length; tn++) {
      var tName = itemToolCalls[tn].name || itemToolCalls[tn].tool_name;
      if (tName && itemToolNames.indexOf(tName) === -1) itemToolNames.push(tName);
    }
    var sideEffectNames = { send_reaction: 'reaction', send_effect: 'effect', remember_user: 'memory', generate_image: 'image' };
    var toolBadgesHtml = itemToolNames.length > 0
      ? '<div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:4px">' + itemToolNames.map(function(n) {
          var isSideEffect = sideEffectNames[n];
          if (isSideEffect) return '<span style="font-size:9px;background:#fef3c7;color:#92400e;padding:1px 5px;border-radius:4px;font-weight:500">' + n + '</span>';
          return '<span style="font-size:9px;background:#ecfdf5;color:#059669;padding:1px 5px;border-radius:4px;font-weight:500">' + n + '</span>';
        }).join('') + '</div>'
      : '<div style="font-size:9px;color:#9ca3af;margin-top:3px">no tools \\u2014 context only</div>';

    var ctxPath = t.context_path || 'full';
    var ctxBadge = ctxPath === 'light' ? '<span class="badge badge-light">LIGHT</span>' : '';

    return '<div class="message-item ' + (isActive ? 'active' : '') + '" onclick="selectTrace(' + t.id + ')">'
      + '<div class="msg-text">' + escHtml((t.user_message || '\\u2014').substring(0, 80)) + '</div>'
      + '<div class="msg-meta">'
      + '<span class="badge badge-agent">' + t.route_agent + '</span>'
      + '<span class="badge badge-' + routeType + '">' + routeType + '</span>'
      + ctxBadge
      + hasError
      + '<span class="latency-pill">' + t.total_latency_ms + 'ms</span>'
      + '<span>' + time + '</span>'
      + '</div>'
      + toolBadgesHtml
      + '</div>';
  }).join('');
}

function selectTrace(id) {
  activeTraceId = id;
  activeTrace = allTraces.find(function(t) { return t.id === id; });
  if (!activeTrace) return;
  activeThread = null;
  filterMessages();
  renderDecisionTree(activeTrace);
  loadThread(activeTrace.chat_id, activeTrace.created_at);
}

function kv(key, val, cls) {
  return '<div class="kv"><span class="kv-key">' + key + '</span><span class="kv-val' + (cls ? ' ' + cls : '') + '">' + val + '</span></div>';
}

function splitPromptLayers(prompt) {
  if (!prompt) return [];
  var parts = prompt.split(/\\n\\n/);
  var layers = [];
  var current = { name: 'Identity', content: '' };

  var layerPatterns = [
    { pattern: /^(ROLE|IDENTITY|You are Nest)/i, name: 'Identity' },
    { pattern: /^(AGENT INSTRUCTIONS|CAPABILITIES|You handle|Your job)/i, name: 'Agent Instructions' },
    { pattern: /^(What you know about|About the person|Handle:)/i, name: 'Person Context' },
    { pattern: /^(Connected accounts)/i, name: 'Connected Accounts' },
    { pattern: /^(Earlier conversation context|summaries of past)/i, name: 'Conversation Summaries' },
    { pattern: /^(Recent tool usage)/i, name: 'Recent Tool Traces' },
    { pattern: /^(Retrieved knowledge|from your second brain)/i, name: 'RAG Evidence' },
    { pattern: /^(Current date|Current time)/i, name: 'Turn Context' },
    { pattern: /^(Group Chat Context)/i, name: 'Group Chat' },
    { pattern: /^(Proactive Reply)/i, name: 'Proactive Reply' },
    { pattern: /^(Incoming Message Effect)/i, name: 'Message Effect' },
    { pattern: /^(Messaging Platform)/i, name: 'Platform' },
    { pattern: /^(Onboarding Context|This is a NEW user)/i, name: 'Onboarding' },
    { pattern: /^(First Message Guidance)/i, name: 'First Message' },
    { pattern: /^(Profile intel)/i, name: 'PDL Enrichment' },
    { pattern: /^(Entry State Strategy)/i, name: 'Entry State' },
    { pattern: /^(Rescue Logic)/i, name: 'Rescue Logic' },
    { pattern: /^(Verification Link)/i, name: 'Verification' },
  ];

  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    if (!part) continue;

    var matched = false;
    for (var j = 0; j < layerPatterns.length; j++) {
      if (layerPatterns[j].pattern.test(part)) {
        if (current.content.trim()) {
          layers.push({ name: current.name, content: current.content.trim() });
        }
        current = { name: layerPatterns[j].name, content: part };
        matched = true;
        break;
      }
    }
    if (!matched) {
      current.content += '\\n\\n' + part;
    }
  }
  if (current.content.trim()) {
    layers.push({ name: current.name, content: current.content.trim() });
  }

  if (layers.length === 0 && prompt) {
    layers.push({ name: 'Full Prompt', content: prompt });
  }

  return layers;
}

function renderMessages(messages) {
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return '<div style="color:var(--text-secondary);font-size:12px;padding:8px 0">No messages captured (older trace)</div>';
  }

  return messages.map(function(msg, idx) {
    var role = msg.role || 'unknown';
    var roleBg = role === 'user' ? 'var(--blue-bg)' : role === 'assistant' ? 'var(--green-bg)' : 'var(--accent-light)';
    var roleColor = role === 'user' ? 'var(--blue)' : role === 'assistant' ? 'var(--green)' : 'var(--text-secondary)';

    var contentStr = '';
    if (typeof msg.content === 'string') {
      contentStr = msg.content;
    } else if (Array.isArray(msg.content)) {
      contentStr = msg.content.map(function(block) {
        if (block.type === 'text') return block.text || '';
        if (block.type === 'image') return '[image: ' + (block.source ? block.source.type : 'base64') + ']';
        if (block.type === 'tool_use') return '[tool_use: ' + block.name + ']';
        if (block.type === 'tool_result') return '[tool_result: ' + (block.content || '').substring(0, 100) + ']';
        return '[' + (block.type || 'unknown') + ']';
      }).join('\\n');
    } else {
      contentStr = JSON.stringify(msg.content);
    }

    var preview = contentStr.length > 500 ? contentStr.substring(0, 500) + '...' : contentStr;

    return '<div class="tool-sub-node" style="margin-top:6px">'
      + '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">'
      + '<span class="badge" style="background:' + roleBg + ';color:' + roleColor + '">' + role + '</span>'
      + '<span style="font-size:10px;color:var(--text-secondary)">#' + (idx + 1) + ' &middot; ' + contentStr.length + ' chars</span>'
      + '</div>'
      + '<div class="json-toggle"><details><summary style="font-size:11px">Show content</summary>'
      + '<pre style="font-size:11px;max-height:200px">' + escHtml(preview) + '</pre>'
      + '</details></div>'
      + '</div>';
  }).join('');
}

function buildPromptNode(t) {
  if (!t.system_prompt) {
    return '<div class="tree-node"><div class="node-card">'
      + '<div class="node-dot dot-context"></div>'
      + '<div class="node-header"><span class="node-title">3B \\u2014 System Prompt</span><span class="node-latency">' + formatNum(t.system_prompt_length) + ' chars</span></div>'
      + '<div class="node-body">'
      + '<div style="color:var(--text-secondary);font-size:12px;padding:4px 0">Prompt content not captured (older trace). New traces will include the full prompt.</div>'
      + '</div></div></div>';
  }

  var layers = splitPromptLayers(t.system_prompt);
  var layerNodes = layers.map(function(layer, idx) {
    var charCount = layer.content.length;
    var tokenEst = Math.ceil(charCount / 4);
    return '<div class="tool-sub-node" style="margin-top:6px">'
      + '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">'
      + '<span class="badge badge-agent">' + layer.name + '</span>'
      + '<span style="font-size:10px;color:var(--text-secondary)">' + charCount + ' chars &middot; ~' + tokenEst + ' tokens</span>'
      + '</div>'
      + '<div class="json-toggle"><details><summary style="font-size:11px">Show ' + layer.name.toLowerCase() + ' layer</summary>'
      + '<pre style="font-size:11px;max-height:300px">' + escHtml(layer.content) + '</pre>'
      + '</details></div>'
      + '</div>';
  }).join('');

  return '<div class="tree-node"><div class="node-card">'
    + '<div class="node-dot dot-context"></div>'
    + '<div class="node-header"><span class="node-title">3B \\u2014 System Prompt</span><span class="node-latency">' + formatNum(t.system_prompt_length) + ' chars &middot; ' + layers.length + ' layers</span></div>'
    + '<div class="node-body">'
    + kv('Total Length', formatNum(t.system_prompt_length) + ' chars (~' + Math.ceil(t.system_prompt_length / 4) + ' tokens)')
    + kv('Layers Detected', layers.length + '')
    + kv('Prompt Hash', t.system_prompt_hash || '\\u2014', 'mono')
    + '</div>'
    + layerNodes
    + '<div class="json-toggle" style="margin-top:8px"><details><summary style="font-size:11px">Show full raw prompt (' + formatNum(t.system_prompt_length) + ' chars)</summary>'
    + '<pre style="font-size:11px;max-height:400px">' + escHtml(t.system_prompt) + '</pre>'
    + '</details></div>'
    + '</div></div>';
}

function buildMessagesNode(t) {
  var messages = t.initial_messages;
  var msgCount = Array.isArray(messages) ? messages.length : 0;

  if (!messages || msgCount === 0) {
    return '<div class="tree-node"><div class="node-card">'
      + '<div class="node-dot dot-context"></div>'
      + '<details><summary class="node-header" style="cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;width:100%"><span class="node-title">3C \\u2014 API Messages</span></summary>'
      + '<div class="node-body" style="margin-top:8px">'
      + '<div style="color:var(--text-secondary);font-size:12px;padding:4px 0">Message history not captured (older trace). New traces will include the full message array.</div>'
      + '</div></details></div></div>';
  }

  var userMsgs = messages.filter(function(m) { return m.role === 'user'; }).length;
  var assistantMsgs = messages.filter(function(m) { return m.role === 'assistant'; }).length;

  var totalChars = 0;
  for (var i = 0; i < messages.length; i++) {
    var c = messages[i].content;
    if (typeof c === 'string') totalChars += c.length;
    else if (Array.isArray(c)) {
      for (var j = 0; j < c.length; j++) {
        if (c[j].text) totalChars += c[j].text.length;
      }
    }
  }

  return '<div class="tree-node"><div class="node-card">'
    + '<div class="node-dot dot-context"></div>'
    + '<details><summary class="node-header" style="cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;width:100%"><span class="node-title">3C \\u2014 API Messages</span><span class="node-latency">' + msgCount + ' messages</span></summary>'
    + '<div class="node-body" style="margin-top:8px">'
    + kv('Total Messages', msgCount + '')
    + kv('User Messages', userMsgs + '')
    + kv('Assistant Messages', assistantMsgs + '')
    + kv('Total Content', formatNum(totalChars) + ' chars (~' + Math.ceil(totalChars / 4) + ' tokens)')
    + '</div>'
    + renderMessages(messages)
    + '<div class="json-toggle" style="margin-top:8px"><details><summary style="font-size:11px">Show full messages JSON</summary>'
    + '<pre style="font-size:11px;max-height:400px">' + escHtml(JSON.stringify(messages, null, 2)) + '</pre>'
    + '</details></div>'
    + '</details></div></div>';
}

function buildContextSubTimings(sub, totalCtxMs) {
  if (!sub) return '<div style="color:var(--text-secondary);font-size:11px;padding:6px 0;margin-top:4px">Sub-timings not captured (older trace). New traces will include per-source breakdowns.</div>';

  var items = [
    { name: 'History', ms: sub.historyMs || 0, color: '#3b82f6' },
    { name: 'Memory', ms: sub.memoryMs || 0, color: '#8b5cf6' },
    { name: 'Summaries', ms: sub.summariesMs || 0, color: '#6366f1' },
    { name: 'Tool Traces', ms: sub.toolTracesMs || 0, color: '#06b6d4' },
    { name: 'Profile', ms: sub.profileMs || 0, color: '#14b8a6' },
    { name: 'Accounts', ms: sub.accountsMs || 0, color: '#10b981' },
    { name: 'Msg Content', ms: sub.messageContentMs || 0, color: '#f59e0b' },
    { name: 'RAG', ms: sub.ragMs || 0, color: '#ef4444' },
    { name: 'Working Mem', ms: sub.workingMemoryMs || 0, color: '#a855f7' },
    { name: 'Format Hist', ms: sub.formatHistoryMs || 0, color: '#64748b' },
  ];

  var maxMs = Math.max.apply(null, items.map(function(i) { return i.ms; }));
  if (maxMs === 0) maxMs = 1;

  var html = '<div style="margin-top:8px;padding:8px 12px;background:#f9fafb;border:1px solid var(--border);border-radius:6px">'
    + '<div style="font-size:10px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">Context Sub-Timings (parallel where possible)</div>'
    + '<div class="ctx-timing-grid">';

  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.ms === 0 && it.name !== 'RAG') continue;
    var barW = Math.max(4, (it.ms / maxMs) * 100);
    var isSlow = (it.name === 'RAG' && it.ms > 2000) || (it.name === 'Memory' && it.ms > 1500) || (it.name === 'History' && it.ms > 1000);
    var ragSkipBadge = (it.name === 'RAG' && it.ms === 0) ? ' <span class="badge badge-rag-skip" style="font-size:9px;margin-left:4px">SKIPPED</span>' : '';
    html += '<div class="ctx-timing-item">'
      + '<span class="ctx-timing-name">' + it.name + ragSkipBadge + '</span>'
      + '<div style="flex:1;display:flex;align-items:center;gap:4px">'
      + '<div class="ctx-timing-bar" style="width:' + barW + '%;background:' + it.color + '"></div>'
      + '<span class="ctx-timing-val" style="' + (isSlow ? 'color:var(--red)' : '') + '">' + it.ms + 'ms</span>'
      + '</div></div>';
  }

  html += '</div>';

  var parallelMax = Math.max(sub.historyMs || 0, sub.memoryMs || 0, sub.summariesMs || 0, sub.toolTracesMs || 0, sub.profileMs || 0, sub.accountsMs || 0, sub.messageContentMs || 0);
  var sequential = (sub.ragMs || 0) + (sub.workingMemoryMs || 0) + (sub.formatHistoryMs || 0);
  html += '<div style="font-size:10px;color:var(--text-secondary);margin-top:4px">Parallel batch: ~' + parallelMax + 'ms (slowest source) + Sequential: ~' + sequential + 'ms = ~' + (parallelMax + sequential) + 'ms effective</div>';

  html += '</div>';
  return html;
}

function buildRoundWaterfall(rounds, totalMs) {
  if (!rounds || rounds.length === 0) return '';
  if (rounds.length === 1 && !rounds[0].wasRetry) return '';

  var html = '<div class="latency-bar-wrap" style="margin-top:12px">'
    + '<div class="latency-bar-label">Per-Round Breakdown \\u2014 ' + rounds.length + ' round' + (rounds.length > 1 ? 's' : '') + '</div>';

  for (var i = 0; i < rounds.length; i++) {
    var r = rounds[i];
    var roundTotal = r.totalRoundMs || 1;
    var apiPct = Math.max((r.apiLatencyMs / roundTotal) * 100, 1);
    var toolPct = Math.max((r.toolExecLatencyMs / roundTotal) * 100, 1);
    var ohMs = Math.max(0, roundTotal - r.apiLatencyMs - r.toolExecLatencyMs);
    var ohPct = Math.max((ohMs / roundTotal) * 100, 0.5);

    var rEffort = r.reasoningEffort || 'medium';
    var rEffortClass = rEffort === 'low' ? 'badge-effort-low' : rEffort === 'high' ? 'badge-effort-high' : 'badge-effort-medium';

    html += '<div class="round-label">'
      + '<strong>R' + r.round + '</strong> ' + roundTotal + 'ms'
      + ' <span class="badge ' + rEffortClass + '" style="font-size:8px;padding:0 4px">' + rEffort + '</span>'
      + ' \\u2014 ' + formatNum(r.inputTokens) + ' in / ' + formatNum(r.outputTokens) + ' out'
      + (r.functionCallCount > 0 ? ' \\u2014 ' + r.functionCallCount + ' tool call' + (r.functionCallCount > 1 ? 's' : '') : '')
      + (r.webSearchCalled ? ' \\u2014 web search' : '')
      + (r.wasRetry ? ' <span class="retry-badge">RETRY: ' + escHtml(r.retryReason || '') + '</span>' : '')
      + '</div>'
      + '<div class="round-row">'
      + '<div class="round-seg round-seg-api" style="width:' + apiPct + '%">' + (apiPct > 15 ? r.apiLatencyMs + 'ms' : '') + '</div>'
      + (r.toolExecLatencyMs > 0 ? '<div class="round-seg round-seg-tool" style="width:' + toolPct + '%">' + (toolPct > 15 ? r.toolExecLatencyMs + 'ms' : '') + '</div>' : '')
      + '<div class="round-seg round-seg-overhead" style="width:' + ohPct + '%"></div>'
      + '</div>';
  }

  html += '<div class="latency-legend" style="margin-top:4px">'
    + '<div class="legend-item"><div class="legend-dot" style="background:var(--orange)"></div>API call</div>'
    + '<div class="legend-item"><div class="legend-dot" style="background:var(--green)"></div>Tool exec</div>'
    + '<div class="legend-item"><div class="legend-dot" style="background:#d1d5db"></div>Overhead</div>'
    + '</div></div>';

  return html;
}

function buildRoundDetails(rounds, agentLoopMs) {
  if (!rounds || rounds.length === 0) return '';

  var html = '<div style="margin-top:8px">';

  for (var i = 0; i < rounds.length; i++) {
    var r = rounds[i];
    var borderColor = r.wasRetry ? '#fecaca' : 'var(--border)';
    var bgColor = r.wasRetry ? '#fef2f2' : '#fafafa';

    var effortVal = r.reasoningEffort || 'medium';
    var effortBadgeClass = effortVal === 'low' ? 'badge-effort-low' : effortVal === 'high' ? 'badge-effort-high' : 'badge-effort-medium';
    var wasDowngraded = i > 0 && effortVal === 'low' && rounds[0].reasoningEffort && rounds[0].reasoningEffort !== 'low';

    html += '<div class="tool-sub-node" style="border-color:' + borderColor + ';background:' + bgColor + '">'
      + '<div class="tool-name">'
      + '<span style="font-weight:700">Round ' + r.round + '</span>'
      + '<span style="font-weight:400;color:var(--text-secondary);font-size:11px">' + r.totalRoundMs + 'ms total</span>'
      + '<span class="badge ' + effortBadgeClass + '" style="font-size:9px">' + effortVal + (wasDowngraded ? ' \\u2193' : '') + '</span>'
      + (r.wasRetry ? '<span class="retry-badge">RETRY</span>' : '')
      + (r.webSearchCalled ? '<span style="font-size:9px;background:var(--green-bg);color:var(--green);padding:1px 5px;border-radius:4px;font-weight:600">WEB SEARCH</span>' : '')
      + '</div>'
      + '<div class="node-body">'
      + kv('API Latency', r.apiLatencyMs + 'ms (' + pct(r.apiLatencyMs, r.totalRoundMs) + ' of round)')
      + (r.toolExecLatencyMs > 0 ? kv('Tool Execution', r.toolExecLatencyMs + 'ms (' + pct(r.toolExecLatencyMs, r.totalRoundMs) + ' of round)') : '')
      + kv('Input Tokens', formatNum(r.inputTokens))
      + kv('Output Tokens', formatNum(r.outputTokens))
      + kv('Reasoning Effort', '<span class="badge ' + effortBadgeClass + '" style="font-size:10px">' + effortVal + '</span>' + (wasDowngraded ? ' <span style="font-size:10px;color:var(--green)">(downgraded for post-tool formatting)</span>' : ''))
      + kv('Status', r.status)
      + kv('Function Calls', r.functionCallCount + '')
      + kv('Text Output', r.textLength + ' chars')
      + kv('Max Output Tokens', formatNum(r.maxOutputTokens))
      + (r.retryReason ? kv('Retry Reason', '<span style="color:var(--red)">' + escHtml(r.retryReason) + '</span>') : '')
      + '</div></div>';
  }

  html += '</div>';
  return html;
}

function renderDecisionTree(t) {
  var main = document.getElementById('mainContent');

  var toolCalls = Array.isArray(t.tool_calls) ? t.tool_calls : [];
  var blockedCalls = Array.isArray(t.tool_calls_blocked) ? t.tool_calls_blocked : [];
  var routeType = t.route_fast_path ? 'Fast-path (regex)' : 'LLM Router (gpt-5-nano)';
  var confidence = t.route_confidence != null ? (t.route_confidence * 100).toFixed(0) + '%' : '\\u2014';
  var ctxPathVal = t.context_path || 'full';
  var totalTokens = (t.input_tokens || 0) + (t.output_tokens || 0);
  var total = t.total_latency_ms || 1;
  var routeMs = t.route_latency_ms || 0;
  var ctxMs = t.context_build_latency_ms || 0;
  var agentMs = t.agent_loop_latency_ms || 0;
  var toolMs = t.tool_total_latency_ms || 0;
  var overheadMs = Math.max(0, total - routeMs - ctxMs - agentMs);
  var costEst = estimateCost(t);
  var msPerOutToken = t.output_tokens > 0 ? round2(agentMs / t.output_tokens) : null;
  var tokensPerRound = t.agent_loop_rounds > 0 ? Math.round(totalTokens / t.agent_loop_rounds) : 0;

  var errorHtml = '';
  if (t.error_message) {
    errorHtml = '<div class="error-banner"><strong>Error at ' + escHtml(t.error_stage || 'unknown') + ' stage:</strong> ' + escHtml(t.error_message) + '</div>';
  }

  // Tool sub-nodes
  var maxToolLatency = 1;
  for (var ti = 0; ti < toolCalls.length; ti++) {
    var tcl = toolCalls[ti].latencyMs || toolCalls[ti].latency_ms || 0;
    if (tcl > maxToolLatency) maxToolLatency = tcl;
  }

  var toolNodes = toolCalls.map(function(tc, idx) {
    var lat = tc.latencyMs || tc.latency_ms || 0;
    var barW = maxToolLatency > 0 ? Math.max(2, (lat / maxToolLatency) * 100) : 2;
    var pctOfTotal = total > 0 ? (lat / total * 100).toFixed(1) : '0.0';

    var html = '<div class="tool-sub-node">'
      + '<div class="tool-name">'
      + '<span class="tool-outcome ' + (tc.outcome || 'success') + '"></span>'
      + escHtml(tc.name)
      + '<span style="font-weight:400;color:var(--text-secondary);font-size:11px">' + lat + 'ms (' + pctOfTotal + '% of turn)</span>'
      + '</div>'
      + '<div class="mini-bar-wrap"><div class="mini-bar" style="width:' + barW + '%"></div></div>'
      + '<div class="node-body">'
      + kv('Namespace', tc.namespace || '\\u2014', 'mono')
      + kv('Side Effect', tc.sideEffect || tc.side_effect || '\\u2014')
      + kv('Outcome', tc.outcome || 'success')
      + kv('Sequence', '#' + (idx + 1) + ' of ' + toolCalls.length);
    if (tc.inputSummary || tc.input_summary) {
      html += kv('Input Summary', escHtml(tc.inputSummary || tc.input_summary), 'mono');
    }
    if (tc.approvalMethod || tc.approval_method) {
      html += kv('Approval', (tc.approvalMethod || tc.approval_method) + ' (' + ((tc.approvalGranted || tc.approval_granted) ? 'granted' : 'denied') + ')');
    }
    if (tc.pendingActionId || tc.pending_action_id) {
      html += kv('Pending Action ID', String(tc.pendingActionId || tc.pending_action_id));
    }
    if (tc.sendResolutionSource || tc.send_resolution_source) {
      html += kv('Send Resolution', escHtml(tc.sendResolutionSource || tc.send_resolution_source));
    }
    if (tc.pendingActionFailureReason || tc.pending_action_failure_reason) {
      html += kv('Pending Failure', escHtml(tc.pendingActionFailureReason || tc.pending_action_failure_reason));
    }
    html += '</div></div>';
    return html;
  }).join('');

  var blockedNodes = blockedCalls.map(function(bc) {
    var detail = bc.detail ? ' (' + escHtml(bc.detail) + ')' : '';
    var pendingId = bc.pendingActionId || bc.pending_action_id;
    var pendingText = pendingId ? ' <span class="ns-tag" style="margin-left:4px">pending #' + pendingId + '</span>' : '';
    return '<div class="blocked-tool"><strong>' + escHtml(bc.name) + '</strong> \\u2014 blocked: ' + bc.reason + detail + ' <span class="ns-tag" style="margin-left:4px">' + bc.namespace + '</span>' + pendingText + '</div>';
  }).join('');

  var namespaceTags = (t.route_namespaces || []).map(function(ns) {
    return '<span class="ns-tag">' + ns + '</span>';
  }).join('');

  var sideEffects = [];
  for (var si = 0; si < toolCalls.length; si++) {
    if (toolCalls[si].name === 'send_reaction') sideEffects.push('<span class="side-effect-tag se-reaction">Reaction</span>');
    if (toolCalls[si].name === 'send_effect') sideEffects.push('<span class="side-effect-tag se-effect">Effect</span>');
    if (toolCalls[si].name === 'remember_user') sideEffects.push('<span class="side-effect-tag se-memory">Memory Write</span>');
    if (toolCalls[si].name === 'generate_image') sideEffects.push('<span class="side-effect-tag se-image">Image Gen</span>');
  }

  // Granular timing data
  var routerCtxMs = t.router_context_ms || 0;
  var promptMs = t.prompt_compose_ms || 0;
  var toolFilterMsVal = t.tool_filter_ms || 0;
  var ctxSub = t.context_sub_timings || null;
  var rounds = t.round_traces || [];
  var pendingDebug = t.pending_action_debug || {};

  // Latency waterfall — 6 segments
  var routerCtxPct = Math.max((routerCtxMs / total) * 100, 0.5);
  var routePct = Math.max((routeMs / total) * 100, 0.5);
  var ctxPct = Math.max((ctxMs / total) * 100, 0.5);
  var agentPct = Math.max((agentMs / total) * 100, 0.5);
  var toolPct = Math.max((toolMs / total) * 100, 0.5);
  var overheadPct = Math.max((overheadMs / total) * 100, 0.5);

  var waterfallHtml = '<div class="latency-bar-wrap">'
    + '<div class="latency-bar-label">Latency Waterfall \\u2014 ' + total + 'ms total</div>'
    + '<div class="latency-bar">'
    + (routerCtxMs > 0 ? '<div class="latency-segment seg-routerctx" style="width:' + routerCtxPct + '%">' + (routerCtxPct > 6 ? routerCtxMs + 'ms' : '') + '</div>' : '')
    + '<div class="latency-segment seg-route" style="width:' + routePct + '%">' + (routePct > 6 ? routeMs + 'ms' : '') + '</div>'
    + '<div class="latency-segment seg-context" style="width:' + ctxPct + '%">' + (ctxPct > 6 ? ctxMs + 'ms' : '') + '</div>'
    + '<div class="latency-segment seg-agent" style="width:' + agentPct + '%">' + (agentPct > 6 ? agentMs + 'ms' : '') + '</div>'
    + '<div class="latency-segment seg-tools" style="width:' + toolPct + '%">' + (toolPct > 6 ? toolMs + 'ms' : '') + '</div>'
    + '<div class="latency-segment seg-overhead" style="width:' + overheadPct + '%">' + (overheadPct > 6 ? overheadMs + 'ms' : '') + '</div>'
    + '</div>'
    + '<div class="latency-legend">'
    + (routerCtxMs > 0 ? '<div class="legend-item"><div class="legend-dot" style="background:#6366f1"></div>Router Ctx ' + routerCtxMs + 'ms</div>' : '')
    + '<div class="legend-item"><div class="legend-dot" style="background:var(--purple)"></div>Route ' + routeMs + 'ms (' + pct(routeMs, total) + ')</div>'
    + '<div class="legend-item"><div class="legend-dot" style="background:var(--blue)"></div>Context ' + ctxMs + 'ms (' + pct(ctxMs, total) + ')</div>'
    + '<div class="legend-item"><div class="legend-dot" style="background:var(--orange)"></div>Agent ' + agentMs + 'ms (' + pct(agentMs, total) + ')</div>'
    + '<div class="legend-item"><div class="legend-dot" style="background:var(--green)"></div>Tools ' + toolMs + 'ms (' + pct(toolMs, total) + ')</div>'
    + '<div class="legend-item"><div class="legend-dot" style="background:#9ca3af"></div>Overhead ' + overheadMs + 'ms (' + pct(overheadMs, total) + ')</div>'
    + '</div></div>';

  // Performance alerts
  var perfAlerts = '';
  if (total > 15000) {
    perfAlerts += '<div class="perf-alert perf-alert-crit"><strong>CRITICAL:</strong> Turn took ' + (total / 1000).toFixed(1) + 's — well above the 5s target.</div>';
  } else if (total > 8000) {
    perfAlerts += '<div class="perf-alert perf-alert-warn"><strong>SLOW:</strong> Turn took ' + (total / 1000).toFixed(1) + 's — above the 5s target.</div>';
  }
  if (ctxMs > 3000) {
    perfAlerts += '<div class="perf-alert perf-alert-warn"><strong>Context build slow:</strong> ' + ctxMs + 'ms. Check sub-timings below for the bottleneck.</div>';
  }
  if (ctxSub && ctxSub.ragMs > 2000) {
    perfAlerts += '<div class="perf-alert perf-alert-warn"><strong>RAG retrieval slow:</strong> ' + ctxSub.ragMs + 'ms. Vector search may need optimisation.</div>';
  }
  if (ctxSub && ctxSub.ragMs > 500 && t.rag_evidence_blocks === 0) {
    perfAlerts += '<div class="perf-alert perf-alert-warn"><strong>RAG waste:</strong> Spent ' + ctxSub.ragMs + 'ms on RAG but got 0 useful evidence blocks. This query should be skipped by the RAG gate.</div>';
  }
  if (ctxSub && ctxSub.ragMs === 0 && t.rag_evidence_blocks === 0) {
    perfAlerts += '<div class="perf-alert" style="background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46"><strong>RAG skipped:</strong> Gate correctly identified this query does not need personal knowledge retrieval. Saved ~1\\u20134s.</div>';
  }
  if (ctxSub && ctxSub.memoryMs > 1500) {
    perfAlerts += '<div class="perf-alert perf-alert-warn"><strong>Memory retrieval slow:</strong> ' + ctxSub.memoryMs + 'ms.</div>';
  }
  if (ctxPathVal === 'light') {
    perfAlerts += '<div class="perf-alert" style="background:#dbeafe;border:1px solid #93c5fd;color:#1e40af"><strong>Light context path:</strong> Casual fast-path detected. Skipped memory, summaries, tool traces, and RAG. Saved ~1\\u20133s of context build time.</div>';
  }
  var retryRounds = rounds.filter(function(r) { return r.wasRetry; });
  if (retryRounds.length > 0) {
    var retryMs = retryRounds.reduce(function(s, r) { return s + r.totalRoundMs; }, 0);
    perfAlerts += '<div class="perf-alert perf-alert-warn"><strong>' + retryRounds.length + ' retry round' + (retryRounds.length > 1 ? 's' : '') + ':</strong> Wasted ' + retryMs + 'ms on retries (' + retryRounds.map(function(r) { return r.retryReason || 'unknown'; }).join('; ') + ')</div>';
  }
  if (routeMs > 2000 && !t.route_fast_path) {
    perfAlerts += '<div class="perf-alert perf-alert-warn"><strong>Router slow:</strong> LLM router took ' + routeMs + 'ms. Consider expanding fast-path rules for this pattern.</div>';
  }
  var apiOnlyMs = rounds.reduce(function(s, r) { return s + r.apiLatencyMs; }, 0);
  if (apiOnlyMs > 0 && agentMs > 0) {
    var apiPctOfLoop = (apiOnlyMs / agentMs * 100).toFixed(0);
    if (parseInt(apiPctOfLoop) > 90 && agentMs > 5000) {
      perfAlerts += '<div class="perf-alert perf-alert-warn"><strong>API-bound:</strong> ' + apiPctOfLoop + '% of agent loop (' + apiOnlyMs + 'ms) is waiting for the model API. Reduce input tokens or switch to a faster model.</div>';
    }
  }
  var downgradedRounds = rounds.filter(function(r) { return r.reasoningEffort === 'low' && rounds[0] && rounds[0].reasoningEffort && rounds[0].reasoningEffort !== 'low'; });
  if (downgradedRounds.length > 0) {
    perfAlerts += '<div class="perf-alert" style="background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46"><strong>Reasoning effort downgraded:</strong> ' + downgradedRounds.length + ' round' + (downgradedRounds.length > 1 ? 's' : '') + ' used low effort for post-tool text formatting (saves reasoning tokens and latency).</div>';
  }

  var toolSection = '';
  if (toolCalls.length > 0 || blockedCalls.length > 0) {
    toolSection = '<div class="tree-node"><div class="node-card">'
      + '<div class="node-dot dot-tool"></div>'
      + '<div class="node-header"><span class="node-title">5 \\u2014 Tool Execution</span><span class="node-latency">' + toolMs + 'ms total (' + pct(toolMs, total) + ' of turn)</span></div>'
      + '<div class="node-body">'
      + kv('Calls Made', t.tool_call_count + '')
      + kv('Calls Blocked', blockedCalls.length + '')
      + kv('Avg Latency/Call', toolCalls.length > 0 ? Math.round(toolMs / toolCalls.length) + 'ms' : '\\u2014')
      + kv('Parallel Execution', toolCalls.length > 1 ? 'Yes (' + toolCalls.length + ' calls)' : 'No (single call)')
      + '</div>'
      + toolNodes + blockedNodes
      + '</div></div>';
  } else {
    toolSection = '<div class="tree-node"><div class="node-card" style="border-style:dashed">'
      + '<div class="node-dot" style="border-color:#d1d5db;background:#d1d5db"></div>'
      + '<div class="node-header"><span class="node-title">5 \\u2014 Tool Execution</span><span class="node-latency">skipped</span></div>'
      + '<div class="node-body">'
      + '<div style="padding:8px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:4px;margin-bottom:8px">'
      + '<div style="font-size:12px;font-weight:600;color:#92400e;margin-bottom:4px">No tools were called</div>'
      + '<div style="font-size:11px;color:#78350f">The agent responded purely from its loaded context (memory, summaries, RAG evidence, conversation history). No external data was fetched for this turn.</div>'
      + '</div>'
      + kv('Available Tools', (t.available_tool_names || []).length + ' tools were available but unused')
      + ((t.available_tool_names || []).length > 0 ? '<div style="display:flex;gap:4px;flex-wrap:wrap;margin:4px 0 8px 0">' + (t.available_tool_names || []).map(function(n) { return '<span class="ns-tag" style="opacity:0.5">' + n + '</span>'; }).join('') + '</div>' : '')
      + kv('Blocked Calls', blockedCalls.length + '')
      + '</div></div></div>';
  }

  // Build the execution summary banner
  var toolNamesList = toolCalls.map(function(tc) { return tc.name; });
  var uniqueTools = [];
  for (var ut = 0; ut < toolNamesList.length; ut++) {
    if (uniqueTools.indexOf(toolNamesList[ut]) === -1) uniqueTools.push(toolNamesList[ut]);
  }

  var summaryBg, summaryBorder, summaryIcon, summaryText;
  if (t.error_message) {
    summaryBg = 'var(--red-bg)'; summaryBorder = '#fecaca'; summaryIcon = '\\u2718'; summaryText = 'Error at ' + (t.error_stage || 'unknown') + ' stage';
  } else if (uniqueTools.length > 0) {
    summaryBg = 'var(--green-bg)'; summaryBorder = '#a7f3d0'; summaryIcon = '\\u2714';
    var commitTools = uniqueTools.filter(function(n) { return ['email_send','email_draft','calendar_write','remember_user','generate_image','send_reaction','send_effect'].indexOf(n) >= 0; });
    var readTools = uniqueTools.filter(function(n) { return commitTools.indexOf(n) < 0; });
    summaryText = uniqueTools.length + ' tool' + (uniqueTools.length > 1 ? 's' : '') + ' called';
  } else {
    summaryBg = 'var(--accent-light)'; summaryBorder = 'var(--border)'; summaryIcon = '\\u2014'; summaryText = 'No tools called \\u2014 answered from loaded context only';
  }

  var toolBadges = uniqueTools.map(function(name) {
    var isCommit = ['email_send','email_draft','calendar_write','remember_user','generate_image'].indexOf(name) >= 0;
    var bg = isCommit ? 'var(--orange-bg)' : 'var(--green-bg)';
    var color = isCommit ? 'var(--orange)' : 'var(--green)';
    return '<span class="badge" style="background:' + bg + ';color:' + color + ';font-size:11px;padding:2px 8px">' + name + '</span>';
  }).join(' ');

  var sideEffectSummary = sideEffects.length > 0
    ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">' + sideEffects.join('') + '</div>'
    : '';

  var executionSummary = '<div style="background:' + summaryBg + ';border:1px solid ' + summaryBorder + ';border-radius:6px;padding:12px 16px;margin-bottom:16px">'
    + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:' + (uniqueTools.length > 0 || sideEffects.length > 0 ? '8' : '0') + 'px">'
    + '<span style="font-size:14px;font-weight:600">' + summaryIcon + '</span>'
    + '<span style="font-size:13px;font-weight:600">' + summaryText + '</span>'
    + '<span style="font-size:11px;color:var(--text-secondary);margin-left:auto">' + t.agent_name + ' \\u2192 ' + t.model_used + ' \\u2192 ' + t.agent_loop_rounds + ' round' + (t.agent_loop_rounds !== 1 ? 's' : '') + '</span>'
    + '</div>'
    + (uniqueTools.length > 0 ? '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><span style="font-size:10px;color:var(--text-secondary);font-weight:500">TOOLS:</span> ' + toolBadges + '</div>' : '')
    + sideEffectSummary
    + '</div>';

  var stepNum = toolCalls.length > 0 ? '6' : '5';

  main.innerHTML =
    '<div class="top-bar">'
    + '<div class="top-bar-left">turn/' + escHtml(t.turn_id) + '</div>'
    + '<div class="top-bar-actions">'
    + '<button class="btn btn-copy" onclick="copyTraceJson()">Copy JSON</button>'
    + '</div></div>'

    + errorHtml

    + '<div class="stats-bar">'
    + '<div class="stat-card"><div class="stat-label">Total Latency</div><div class="stat-value">' + t.total_latency_ms + '<span class="stat-unit">ms</span></div></div>'
    + '<div class="stat-card"><div class="stat-label">Agent Rounds</div><div class="stat-value">' + t.agent_loop_rounds + '</div></div>'
    + '<div class="stat-card"><div class="stat-label">Tools Used</div><div class="stat-value">' + (uniqueTools.length > 0 ? uniqueTools.length : '<span style="color:var(--text-secondary)">0</span>') + '</div>'
    + (uniqueTools.length > 0 ? '<div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:4px">' + uniqueTools.map(function(n) { return '<span style="font-size:9px;background:var(--accent-light);padding:1px 5px;border-radius:4px;color:var(--text-primary)">' + n + '</span>'; }).join('') + '</div>' : '<div style="font-size:9px;color:var(--text-secondary);margin-top:2px">context only</div>')
    + '</div>'
    + '<div class="stat-card"><div class="stat-label">Total Tokens</div><div class="stat-value">' + formatNum(totalTokens) + '</div></div>'
    + '<div class="stat-card"><div class="stat-label">Est. Cost</div><div class="stat-value">$' + costEst.toFixed(4) + '</div></div>'
    + '<div class="stat-card"><div class="stat-label">Model</div><div class="stat-value" style="font-size:12px">' + (t.model_used || '\\u2014') + '</div></div>'
    + '<div class="stat-card"><div class="stat-label">Context Path</div><div class="stat-value" style="font-size:12px"><span class="badge badge-' + (ctxPathVal === 'light' ? 'light' : 'full') + '">' + ctxPathVal.toUpperCase() + '</span></div></div>'
    + '</div>'

    + executionSummary

    + perfAlerts

    + waterfallHtml

    + buildRoundWaterfall(rounds, total)

    + '<div class="tree"><div class="tree-connector"></div>'

    // 0. CONVERSATION THREAD (collapsed by default)
    + '<div class="tree-node"><div class="node-card">'
    + '<div class="node-dot" style="border-color:#9ca3af;background:#9ca3af"></div>'
    + '<details><summary class="node-header" style="cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;width:100%"><span class="node-title">0 \\u2014 Conversation Thread</span><span class="node-latency">prior messages in ' + escHtml(t.chat_id) + '</span></summary>'
    + '<div id="threadPanel" style="margin-top:8px"><div class="loading"><div class="spinner"></div>Loading conversation thread...</div></div>'
    + '</details></div></div>'

    // 1. INPUT
    + '<div class="tree-node"><div class="node-card">'
    + '<div class="node-dot dot-input"></div>'
    + '<div class="node-header"><span class="node-title">1 \\u2014 User Input</span><span class="node-latency">' + new Date(t.created_at).toLocaleString('en-AU') + '</span></div>'
    + '<div class="node-body">'
    + kv('Message', escHtml(t.user_message || '\\u2014'))
    + kv('Message Length', (t.user_message || '').length + ' chars')
    + kv('Sender', escHtml(t.sender_handle), 'mono')
    + kv('Chat ID', escHtml(t.chat_id), 'mono')
    + kv('Turn ID', escHtml(t.turn_id), 'mono')
    + kv('Trace Row ID', t.id + '')
    + kv('Timezone', t.timezone_resolved || 'not resolved')
    + kv('Timestamp (UTC)', t.created_at)
    + '</div></div></div>'

    // 2. ROUTING
    + '<div class="tree-node"><div class="node-card">'
    + '<div class="node-dot dot-route"></div>'
    + '<div class="node-header"><span class="node-title">2 \\u2014 Routing Decision</span><span class="node-latency">' + routeMs + 'ms (' + pct(routeMs, total) + ')</span></div>'
    + '<div class="node-body">'
    + kv('Method', routeType)
    + kv('Agent Selected', '<span class="badge badge-agent">' + t.route_agent + '</span>')
    + kv('Mode', t.route_mode || '\\u2014')
    + kv('Confidence', confidence + (t.route_confidence < 0.6 && !t.route_fast_path ? ' <span style="color:var(--orange)">(below 0.6 threshold)</span>' : ''))
    + kv('Fast-path Used', t.route_fast_path ? 'Yes (skipped LLM)' : 'No (used LLM classifier)')
    + kv('Router Latency', routeMs + 'ms' + (t.route_fast_path ? ' (0ms regex + overhead)' : ' (includes gpt-5-nano API call)'))
    + kv('Confirmation Result', pendingDebug.confirmationResult || 'not_checked')
    + kv('Namespaces (' + (t.route_namespaces || []).length + ')', '<div class="namespaces-list">' + (namespaceTags || '<span style="color:var(--text-secondary)">none</span>') + '</div>')
    + '</div></div></div>'

    // 3. CONTEXT
    + '<div class="tree-node"><div class="node-card">'
    + '<div class="node-dot dot-context"></div>'
    + '<div class="node-header"><span class="node-title">3 \\u2014 Context Assembly</span><span class="node-latency">' + ctxMs + 'ms (' + pct(ctxMs, total) + ') <span class="badge badge-' + (ctxPathVal === 'light' ? 'light' : 'full') + '" style="font-size:9px;margin-left:4px">' + ctxPathVal.toUpperCase() + '</span></span></div>'
    + '<div class="node-body">'
    + kv('Context Path', '<span class="badge badge-' + (ctxPathVal === 'light' ? 'light' : 'full') + '">' + ctxPathVal.toUpperCase() + '</span>' + (ctxPathVal === 'light' ? ' <span style="font-size:10px;color:var(--text-secondary)">(skipped memory, summaries, tool traces, RAG)</span>' : ''))
    + kv('History Messages', t.history_messages_count + '')
    + kv('Memory Items', t.memory_items_loaded + '' + (ctxPathVal === 'light' && t.memory_items_loaded === 0 ? ' <span style="font-size:10px;color:var(--text-secondary)">(skipped)</span>' : ''))
    + kv('Summaries', t.summaries_loaded + '' + (ctxPathVal === 'light' && t.summaries_loaded === 0 ? ' <span style="font-size:10px;color:var(--text-secondary)">(skipped)</span>' : ''))
    + kv('RAG Evidence', t.rag_evidence_blocks + ' blocks' + (ctxSub && ctxSub.ragMs === 0 ? ' <span class="badge badge-rag-skip" style="font-size:9px;margin-left:4px">SKIPPED</span>' : ''))
    + kv('Connected Accounts', t.connected_accounts_count + '')
    + kv('Pending Email Sends', String(pendingDebug.pendingEmailSendCount || 0))
    + kv('Pending Action ID', pendingDebug.pendingEmailSendId != null ? String(pendingDebug.pendingEmailSendId) : '\\u2014')
    + kv('Pending Status', pendingDebug.pendingEmailSendStatus || '\\u2014')
    + kv('Draft ID Present', pendingDebug.draftIdPresent ? 'Yes' : 'No')
    + kv('Account Bound', pendingDebug.accountPresent ? 'Yes' : 'No')
    + '<hr class="section-divider">'
    + kv('System Prompt', formatNum(t.system_prompt_length) + ' chars')
    + kv('Prompt Hash', t.system_prompt_hash || '\\u2014', 'mono')
    + kv('Context Build Time', ctxMs + 'ms')
    + (routerCtxMs > 0 ? kv('Router Context Fetch', routerCtxMs + 'ms (history + working memory)') : '')
    + kv('Available Tools', (t.available_tool_names || []).length > 0
        ? '<div class="namespaces-list">' + (t.available_tool_names || []).map(function(n) { return '<span class="ns-tag">' + n + '</span>'; }).join('') + '</div>'
        : '<span class="kv-val dim">not captured (older trace)</span>')
    + '</div>'
    + buildContextSubTimings(ctxSub, ctxMs)
    + '</div></div>'

    // 3B. SYSTEM PROMPT
    + buildPromptNode(t)

    // 3C. API MESSAGES
    + buildMessagesNode(t)

    // 4. AGENT LOOP
    + '<div class="tree-node"><div class="node-card">'
    + '<div class="node-dot dot-agent"></div>'
    + '<div class="node-header"><span class="node-title">4 \\u2014 Agent Loop</span><span class="node-latency">' + agentMs + 'ms (' + pct(agentMs, total) + ')</span></div>'
    + '<div class="node-body">'
    + kv('Agent', '<span class="badge badge-agent">' + t.agent_name + '</span>')
    + kv('Model', t.model_used, 'mono')
    + kv('Reasoning Effort', (function() {
        if (!rounds || rounds.length === 0) return '\\u2014';
        var efforts = rounds.map(function(r) { return r.reasoningEffort || 'medium'; });
        var unique = [];
        for (var ue = 0; ue < efforts.length; ue++) { if (unique.indexOf(efforts[ue]) === -1) unique.push(efforts[ue]); }
        if (unique.length === 1) {
          var ec = unique[0] === 'low' ? 'badge-effort-low' : unique[0] === 'high' ? 'badge-effort-high' : 'badge-effort-medium';
          return '<span class="badge ' + ec + '">' + unique[0] + '</span> (all rounds)';
        }
        return efforts.map(function(e, idx) {
          var ec2 = e === 'low' ? 'badge-effort-low' : e === 'high' ? 'badge-effort-high' : 'badge-effort-medium';
          return 'R' + (idx + 1) + ': <span class="badge ' + ec2 + '">' + e + '</span>';
        }).join(' ');
      })())
    + kv('Rounds', t.agent_loop_rounds + (retryRounds.length > 0 ? ' <span style="color:var(--red);font-weight:600">(' + retryRounds.length + ' retries)</span>' : ''))
    + (promptMs > 0 ? kv('Prompt Compose', promptMs + 'ms') : '')
    + (toolFilterMsVal > 0 ? kv('Tool Filter', toolFilterMsVal + 'ms') : '')
    + '<hr class="section-divider">'
    + kv('Input Tokens', formatNum(t.input_tokens))
    + kv('Output Tokens', formatNum(t.output_tokens))
    + kv('Total Tokens', formatNum(totalTokens))
    + kv('Tokens/Round (avg)', formatNum(tokensPerRound))
    + kv('ms/Output Token', msPerOutToken != null ? msPerOutToken + 'ms' : '\\u2014')
    + (apiOnlyMs > 0 ? kv('API Wait Time', apiOnlyMs + 'ms (' + pct(apiOnlyMs, agentMs) + ' of loop)') : '')
    + '<hr class="section-divider">'
    + kv('Agent Loop Time', agentMs + 'ms')
    + kv('Estimated Cost', '$' + costEst.toFixed(4))
    + '</div>'
    + buildRoundDetails(rounds, agentMs)
    + '</div></div>'

    // 5. TOOLS
    + toolSection

    // 6. RESPONSE
    + '<div class="tree-node"><div class="node-card">'
    + '<div class="node-dot dot-response"></div>'
    + '<div class="node-header"><span class="node-title">' + stepNum + ' \\u2014 Response</span><span class="node-latency">' + (t.response_length || 0) + ' chars</span></div>'
    + '<div class="node-body">'
    + kv('Response Length', (t.response_length || 0) + ' chars')
    + kv('Bubble Count', t.response_text ? t.response_text.split('---').filter(function(s) { return s.trim(); }).length + '' : '0')
    + (sideEffects.length > 0 ? kv('Side Effects', '<div class="side-effects-row">' + sideEffects.join('') + '</div>') : '')
    + '<div style="margin-top:8px"><div class="response-preview">' + escHtml(t.response_text || '(no text response \\u2014 reaction/effect only)') + '</div></div>'
    + '</div></div></div>'

    // RAW JSON
    + '<div class="tree-node"><div class="node-card">'
    + '<div class="node-dot" style="border-color:#9ca3af;background:#9ca3af"></div>'
    + '<div class="node-header"><span class="node-title">Raw Trace Data</span></div>'
    + '<div class="json-toggle"><details><summary>Show full JSON (' + JSON.stringify(t).length + ' bytes)</summary>'
    + '<pre>' + escHtml(JSON.stringify(t, null, 2)) + '</pre>'
    + '</details></div>'
    + '</div></div>'

    + '</div>';
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatNum(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString();
}

loadTraces();
</script>
</body>
</html>`;
