import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function getAdminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
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

  .btn-sm {
    padding: 4px 8px;
    font-size: 11px;
  }

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

  .badge-agent {
    background: var(--accent-light);
    color: var(--accent);
  }

  .badge-fast {
    background: var(--green-bg);
    color: var(--green);
  }

  .badge-llm {
    background: var(--purple-bg);
    color: var(--purple);
  }

  .badge-error {
    background: var(--red-bg);
    color: var(--red);
  }

  .latency-pill {
    font-size: 10px;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }

  /* ── Main: decision tree ── */
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

  /* ── Decision tree ── */
  .tree {
    position: relative;
    padding-left: 0;
  }

  .tree-node {
    position: relative;
    margin-bottom: 0;
  }

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

  .node-card:hover {
    box-shadow: 0 1px 4px rgba(0,0,0,0.06);
  }

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

  .node-body {
    font-size: 13px;
  }

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
    min-width: 120px;
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
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 20px;
  }

  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px 16px;
    min-width: 120px;
  }

  .stat-card .stat-label {
    font-size: 11px;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 500;
  }

  .stat-card .stat-value {
    font-size: 20px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    margin-top: 2px;
  }

  .stat-card .stat-unit {
    font-size: 12px;
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

  .namespaces-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }

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

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    margin-right: 8px;
  }

  .sidebar-search {
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
  }

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

  .sidebar-search input:focus {
    border-color: #aaa;
  }

  .side-effects-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 6px;
  }

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

<script>
let allTraces = [];
let activeTraceId = null;

const BASE_URL = window.location.pathname.replace(/\\/$/, '');

async function loadTraces() {
  const btn = document.getElementById('refreshBtn');
  btn.textContent = 'Loading...';
  btn.disabled = true;

  try {
    const res = await fetch(BASE_URL + '?api=traces&limit=100');
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
  if (!traces.length) {
    container.innerHTML = '<div class="loading">No traces found</div>';
    return;
  }

  container.innerHTML = traces.map(t => {
    const time = new Date(t.created_at).toLocaleString('en-AU', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true
    });
    const isActive = t.id === activeTraceId;
    const routeType = t.route_fast_path ? 'fast' : 'llm';
    const hasError = t.error_message ? '<span class="badge badge-error">ERR</span>' : '';

    return \`
      <div class="message-item \${isActive ? 'active' : ''}" onclick="selectTrace(\${t.id})">
        <div class="msg-text">\${escHtml((t.user_message || '—').substring(0, 80))}</div>
        <div class="msg-meta">
          <span class="badge badge-agent">\${t.route_agent}</span>
          <span class="badge badge-\${routeType}">\${routeType}</span>
          \${hasError}
          <span class="latency-pill">\${t.total_latency_ms}ms</span>
          <span>\${time}</span>
        </div>
      </div>
    \`;
  }).join('');
}

function selectTrace(id) {
  activeTraceId = id;
  const trace = allTraces.find(t => t.id === id);
  if (!trace) return;
  renderMessageList(allTraces.filter(t => {
    const q = document.getElementById('searchInput').value.toLowerCase();
    if (!q) return true;
    return (t.user_message || '').toLowerCase().includes(q) ||
      (t.route_agent || '').toLowerCase().includes(q) ||
      (t.sender_handle || '').toLowerCase().includes(q);
  }));
  renderDecisionTree(trace);
}

function renderDecisionTree(t) {
  const main = document.getElementById('mainContent');

  const toolCalls = Array.isArray(t.tool_calls) ? t.tool_calls : [];
  const blockedCalls = Array.isArray(t.tool_calls_blocked) ? t.tool_calls_blocked : [];
  const routeType = t.route_fast_path ? 'Fast-path (regex)' : 'LLM Router';
  const confidence = t.route_confidence != null ? (t.route_confidence * 100).toFixed(0) + '%' : '—';

  const errorHtml = t.error_message ? \`
    <div class="error-banner">
      <strong>Error at \${t.error_stage || 'unknown'} stage:</strong> \${escHtml(t.error_message)}
    </div>
  \` : '';

  const toolNodes = toolCalls.map((tc, i) => \`
    <div class="tool-sub-node">
      <div class="tool-name">
        <span class="tool-outcome \${tc.outcome || 'success'}"></span>
        \${escHtml(tc.name)}
        <span style="font-weight:400;color:var(--text-secondary);font-size:11px">\${tc.latencyMs || tc.latency_ms || 0}ms</span>
      </div>
      <div class="node-body">
        <div class="kv"><span class="kv-key">Namespace</span><span class="kv-val mono">\${tc.namespace || '—'}</span></div>
        <div class="kv"><span class="kv-key">Side Effect</span><span class="kv-val">\${tc.sideEffect || tc.side_effect || '—'}</span></div>
        <div class="kv"><span class="kv-key">Outcome</span><span class="kv-val">\${tc.outcome || 'success'}</span></div>
        \${tc.inputSummary || tc.input_summary ? \`<div class="kv"><span class="kv-key">Input</span><span class="kv-val mono">\${escHtml(tc.inputSummary || tc.input_summary)}</span></div>\` : ''}
        \${tc.approvalMethod || tc.approval_method ? \`<div class="kv"><span class="kv-key">Approval</span><span class="kv-val">\${tc.approvalMethod || tc.approval_method} (\${tc.approvalGranted || tc.approval_granted ? 'granted' : 'denied'})</span></div>\` : ''}
      </div>
    </div>
  \`).join('');

  const blockedNodes = blockedCalls.map(bc => \`
    <div class="blocked-tool">
      <strong>\${escHtml(bc.name)}</strong> — blocked: \${bc.reason}
      <span class="ns-tag" style="margin-left:4px">\${bc.namespace}</span>
    </div>
  \`).join('');

  const namespaceTags = (t.route_namespaces || []).map(ns =>
    \`<span class="ns-tag">\${ns}</span>\`
  ).join('');

  const sideEffects = [];
  if (t.response_text && t.response_text.includes('[reacted')) sideEffects.push('<span class="side-effect-tag se-reaction">Reaction</span>');
  if (t.response_text && t.response_text.includes('[sent')) sideEffects.push('<span class="side-effect-tag se-effect">Effect</span>');
  for (const tc of toolCalls) {
    if (tc.name === 'remember_user') sideEffects.push('<span class="side-effect-tag se-memory">Memory Write</span>');
    if (tc.name === 'generate_image') sideEffects.push('<span class="side-effect-tag se-image">Image Gen</span>');
  }

  main.innerHTML = \`
    \${errorHtml}

    <div class="stats-bar">
      <div class="stat-card">
        <div class="stat-label">Total Latency</div>
        <div class="stat-value">\${t.total_latency_ms}<span class="stat-unit">ms</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Agent Rounds</div>
        <div class="stat-value">\${t.agent_loop_rounds}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Tool Calls</div>
        <div class="stat-value">\${t.tool_call_count}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Input Tokens</div>
        <div class="stat-value">\${formatNum(t.input_tokens)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Output Tokens</div>
        <div class="stat-value">\${formatNum(t.output_tokens)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Model</div>
        <div class="stat-value" style="font-size:13px">\${t.model_used || '—'}</div>
      </div>
    </div>

    <div class="tree">
      <div class="tree-connector"></div>

      <!-- 1. INPUT -->
      <div class="tree-node">
        <div class="node-card">
          <div class="node-dot dot-input"></div>
          <div class="node-header">
            <span class="node-title">1 — User Input</span>
            <span class="node-latency">\${new Date(t.created_at).toLocaleString('en-AU')}</span>
          </div>
          <div class="node-body">
            <div class="kv"><span class="kv-key">Message</span><span class="kv-val">\${escHtml(t.user_message || '—')}</span></div>
            <div class="kv"><span class="kv-key">Sender</span><span class="kv-val mono">\${escHtml(t.sender_handle)}</span></div>
            <div class="kv"><span class="kv-key">Chat ID</span><span class="kv-val mono">\${escHtml(t.chat_id)}</span></div>
            \${t.timezone_resolved ? \`<div class="kv"><span class="kv-key">Timezone</span><span class="kv-val">\${t.timezone_resolved}</span></div>\` : ''}
          </div>
        </div>
      </div>

      <!-- 2. ROUTING -->
      <div class="tree-node">
        <div class="node-card">
          <div class="node-dot dot-route"></div>
          <div class="node-header">
            <span class="node-title">2 — Routing Decision</span>
            <span class="node-latency">\${t.route_latency_ms}ms</span>
          </div>
          <div class="node-body">
            <div class="kv"><span class="kv-key">Method</span><span class="kv-val">\${routeType}</span></div>
            <div class="kv"><span class="kv-key">Agent Selected</span><span class="kv-val"><span class="badge badge-agent">\${t.route_agent}</span></span></div>
            <div class="kv"><span class="kv-key">Mode</span><span class="kv-val">\${t.route_mode || '—'}</span></div>
            <div class="kv"><span class="kv-key">Confidence</span><span class="kv-val">\${confidence}</span></div>
            <div class="kv">
              <span class="kv-key">Namespaces</span>
              <span class="kv-val"><div class="namespaces-list">\${namespaceTags || '<span style="color:var(--text-secondary)">none</span>'}</div></span>
            </div>
          </div>
        </div>
      </div>

      <!-- 3. CONTEXT -->
      <div class="tree-node">
        <div class="node-card">
          <div class="node-dot dot-context"></div>
          <div class="node-header">
            <span class="node-title">3 — Context Assembly</span>
            <span class="node-latency">\${t.context_build_latency_ms}ms</span>
          </div>
          <div class="node-body">
            <div class="kv"><span class="kv-key">History Messages</span><span class="kv-val">\${t.history_messages_count}</span></div>
            <div class="kv"><span class="kv-key">Memory Items</span><span class="kv-val">\${t.memory_items_loaded}</span></div>
            <div class="kv"><span class="kv-key">Summaries</span><span class="kv-val">\${t.summaries_loaded}</span></div>
            <div class="kv"><span class="kv-key">RAG Evidence</span><span class="kv-val">\${t.rag_evidence_blocks} blocks</span></div>
            <div class="kv"><span class="kv-key">Connected Accounts</span><span class="kv-val">\${t.connected_accounts_count}</span></div>
            <div class="kv"><span class="kv-key">System Prompt</span><span class="kv-val">\${formatNum(t.system_prompt_length)} chars</span></div>
          </div>
        </div>
      </div>

      <!-- 4. AGENT LOOP -->
      <div class="tree-node">
        <div class="node-card">
          <div class="node-dot dot-agent"></div>
          <div class="node-header">
            <span class="node-title">4 — Agent Loop</span>
            <span class="node-latency">\${t.agent_loop_latency_ms}ms</span>
          </div>
          <div class="node-body">
            <div class="kv"><span class="kv-key">Agent</span><span class="kv-val"><span class="badge badge-agent">\${t.agent_name}</span></span></div>
            <div class="kv"><span class="kv-key">Model</span><span class="kv-val mono">\${t.model_used}</span></div>
            <div class="kv"><span class="kv-key">Rounds</span><span class="kv-val">\${t.agent_loop_rounds}</span></div>
            <div class="kv"><span class="kv-key">Input Tokens</span><span class="kv-val">\${formatNum(t.input_tokens)}</span></div>
            <div class="kv"><span class="kv-key">Output Tokens</span><span class="kv-val">\${formatNum(t.output_tokens)}</span></div>
          </div>
        </div>
      </div>

      <!-- 5. TOOL CALLS -->
      \${toolCalls.length > 0 || blockedCalls.length > 0 ? \`
      <div class="tree-node">
        <div class="node-card">
          <div class="node-dot dot-tool"></div>
          <div class="node-header">
            <span class="node-title">5 — Tool Execution</span>
            <span class="node-latency">\${t.tool_total_latency_ms}ms total</span>
          </div>
          <div class="node-body">
            <div class="kv"><span class="kv-key">Calls Made</span><span class="kv-val">\${t.tool_call_count}</span></div>
            <div class="kv"><span class="kv-key">Blocked</span><span class="kv-val">\${blockedCalls.length}</span></div>
          </div>
          \${toolNodes}
          \${blockedNodes}
        </div>
      </div>
      \` : ''}

      <!-- 6. RESPONSE -->
      <div class="tree-node">
        <div class="node-card">
          <div class="node-dot dot-response"></div>
          <div class="node-header">
            <span class="node-title">\${toolCalls.length > 0 ? '6' : '5'} — Response</span>
            <span class="node-latency">\${t.response_length} chars</span>
          </div>
          <div class="node-body">
            <div class="response-preview">\${escHtml(t.response_text || '(no text response — reaction/effect only)')}</div>
            \${sideEffects.length > 0 ? \`<div class="side-effects-row">\${sideEffects.join('')}</div>\` : ''}
          </div>
        </div>
      </div>
    </div>
  \`;
}

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
