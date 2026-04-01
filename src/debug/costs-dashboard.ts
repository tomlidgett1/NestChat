/** Admin costs dashboard: API spend tracking across OpenAI, Gemini, Anthropic. */
export const costsDashboardHtml = `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nest — API Costs</title>
<style>
  :root {
    --bg: #f3f4f6;
    --surface: #ffffff;
    --border: #e5e7eb;
    --text: #111827;
    --muted: #6b7280;
    --dim: #9ca3af;
    --radius: 6px;
    --green: #059669;
    --red: #dc2626;
    --blue: #2563eb;
    --amber: #d97706;
    --purple: #7c3aed;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    padding: 20px 24px 40px;
  }
  h1 { font-size: 18px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 2px; }
  .sub { font-size: 13px; color: var(--muted); margin-bottom: 16px; }

  /* ── Toolbar ── */
  .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .toolbar select, .toolbar input {
    padding: 6px 10px;
    font-size: 13px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    font-family: inherit;
  }
  .toolbar label { font-size: 12px; font-weight: 500; color: var(--muted); }
  .btn {
    padding: 6px 14px; font-size: 13px; font-weight: 500;
    border-radius: var(--radius); border: 1px solid var(--border);
    background: var(--surface); cursor: pointer; font-family: inherit;
  }
  .btn:hover { background: #f9fafb; }
  .btn-sm { padding: 4px 10px; font-size: 12px; }

  /* ── Tabs ── */
  .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
  .tab {
    padding: 8px 16px; font-size: 13px; font-weight: 500; cursor: pointer;
    border: none; background: none; color: var(--muted);
    border-bottom: 2px solid transparent; margin-bottom: -1px; font-family: inherit;
  }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--text); border-bottom-color: var(--text); }
  .tab-content { display: none; }
  .tab-content.active { display: block; }

  /* ── Stat cards ── */
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 14px 16px;
  }
  .stat-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .stat-value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 4px; }
  .stat-hint { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .stat-value.green { color: var(--green); }

  /* ── Charts ── */
  .chart-container {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 16px; margin-bottom: 16px;
  }
  .chart-title { font-size: 13px; font-weight: 600; margin-bottom: 12px; }
  .chart-area { width: 100%; height: 200px; position: relative; }
  .bar-chart { display: flex; align-items: flex-end; gap: 2px; height: 100%; }
  .bar-group { flex: 1; display: flex; flex-direction: column; align-items: center; min-width: 0; }
  .bar {
    width: 100%; max-width: 32px; border-radius: 3px 3px 0 0;
    background: var(--text); transition: height 0.3s ease; cursor: default; position: relative;
  }
  .bar:hover { opacity: 0.85; }
  .bar-label { font-size: 9px; color: var(--dim); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; text-align: center; }
  .bar-tooltip {
    display: none; position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
    background: var(--text); color: #fff; font-size: 11px; padding: 4px 8px;
    border-radius: 4px; white-space: nowrap; z-index: 10; pointer-events: none;
  }
  .bar:hover .bar-tooltip { display: block; }

  /* ── Tables ── */
  .panel {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 16px; margin-bottom: 16px;
  }
  .panel h2 { font-size: 13px; font-weight: 600; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  th { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); position: sticky; top: 0; background: var(--surface); }
  tr:last-child td { border-bottom: none; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  th.num { text-align: right; }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; }
  .truncate { max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tag {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 11px; font-weight: 500; background: #f3f4f6; color: var(--muted);
  }
  .tag-openai { background: #f0fdf4; color: #166534; }
  .tag-gemini { background: #eff6ff; color: #1e40af; }
  .tag-anthropic { background: #fef3c7; color: #92400e; }
  .scrollable-table { max-height: 400px; overflow-y: auto; }

  /* ── Misc ── */
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
  .row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 16px; }
  @media (max-width: 900px) { .row2, .row3 { grid-template-columns: 1fr; } }
  .err { color: #b91c1c; font-size: 13px; padding: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
  .loading { color: var(--muted); font-size: 14px; padding: 20px; text-align: center; }
  .empty { color: var(--dim); font-size: 13px; padding: 20px; text-align: center; }
  .cost-bar-fill { border-radius: 2px; height: 6px; background: var(--text); }
  .cost-bar-track { border-radius: 2px; height: 6px; background: #e5e7eb; width: 100%; overflow: hidden; }
</style>
</head>
<body>

<h1>API Costs</h1>
<p class="sub">Real-time spend tracking across OpenAI, Gemini &amp; Anthropic</p>

<!-- Toolbar -->
<div class="toolbar">
  <label>Period</label>
  <select id="period-select">
    <option value="7">Last 7 days</option>
    <option value="14">Last 14 days</option>
    <option value="30" selected>Last 30 days</option>
    <option value="90">Last 90 days</option>
    <option value="365">All time</option>
  </select>
  <button class="btn btn-sm" onclick="refresh()">Refresh</button>
</div>

<!-- Stat cards -->
<div class="stat-grid" id="stat-cards">
  <div class="stat-card"><div class="stat-label">Total spend</div><div class="stat-value" id="s-total">—</div><div class="stat-hint" id="s-total-hint"></div></div>
  <div class="stat-card"><div class="stat-label">Today</div><div class="stat-value" id="s-today">—</div><div class="stat-hint" id="s-today-hint"></div></div>
  <div class="stat-card"><div class="stat-label">Cache savings</div><div class="stat-value green" id="s-savings">—</div><div class="stat-hint" id="s-savings-hint"></div></div>
  <div class="stat-card"><div class="stat-label">Total requests</div><div class="stat-value" id="s-requests">—</div></div>
  <div class="stat-card"><div class="stat-label">Tokens (in / out)</div><div class="stat-value" id="s-tokens">—</div><div class="stat-hint" id="s-tokens-hint"></div></div>
  <div class="stat-card"><div class="stat-label">Avg cost / request</div><div class="stat-value" id="s-avg">—</div></div>
</div>

<!-- Tabs -->
<div class="tabs">
  <button class="tab active" data-tab="overview">Overview</button>
  <button class="tab" data-tab="models">By Model</button>
  <button class="tab" data-tab="agents">By Agent</button>
  <button class="tab" data-tab="senders">By Sender</button>
  <button class="tab" data-tab="logs">Raw Logs</button>
</div>

<!-- Tab: Overview -->
<div class="tab-content active" id="tab-overview">
  <div class="chart-container">
    <div class="chart-title">Daily spend</div>
    <div class="chart-area" id="daily-chart"></div>
  </div>
  <div class="row2">
    <div class="panel">
      <h2>By Provider</h2>
      <div id="provider-table"><div class="loading">Loading…</div></div>
    </div>
    <div class="panel">
      <h2>By Message Type</h2>
      <div id="msgtype-table"><div class="loading">Loading…</div></div>
    </div>
  </div>
</div>

<!-- Tab: Models -->
<div class="tab-content" id="tab-models">
  <div class="panel">
    <h2>Cost by Model</h2>
    <div id="model-table"><div class="loading">Loading…</div></div>
  </div>
</div>

<!-- Tab: Agents -->
<div class="tab-content" id="tab-agents">
  <div class="panel">
    <h2>Cost by Agent</h2>
    <div id="agent-table"><div class="loading">Loading…</div></div>
  </div>
</div>

<!-- Tab: Senders -->
<div class="tab-content" id="tab-senders">
  <div class="panel">
    <h2>Cost by Sender</h2>
    <div id="sender-table"><div class="loading">Loading…</div></div>
  </div>
</div>

<!-- Tab: Raw Logs -->
<div class="tab-content" id="tab-logs">
  <div class="toolbar" style="margin-bottom: 12px;">
    <label>Provider</label>
    <select id="log-provider"><option value="">All</option><option value="openai">OpenAI</option><option value="gemini">Gemini</option><option value="anthropic">Anthropic</option></select>
    <label>Endpoint</label>
    <select id="log-endpoint"><option value="">All</option><option value="chat">Chat</option><option value="embeddings">Embeddings</option><option value="image_gen">Image Gen</option><option value="transcription">Transcription</option></select>
    <label>Agent</label>
    <select id="log-agent"><option value="">All</option><option value="casual">Casual</option><option value="chat">Chat</option><option value="smart">Smart</option><option value="productivity">Productivity</option><option value="research">Research</option><option value="operator">Operator</option><option value="recall">Recall</option><option value="onboard">Onboard</option></select>
    <label>Limit</label>
    <select id="log-limit"><option value="50">50</option><option value="100" selected>100</option><option value="250">250</option><option value="500">500</option></select>
    <button class="btn btn-sm" onclick="loadLogs()">Filter</button>
  </div>
  <div class="panel">
    <div class="scrollable-table" id="logs-table"><div class="loading">Loading…</div></div>
  </div>
</div>

<script>
(function () {
  var periodEl = document.getElementById('period-select');

  // ── Formatting helpers ──
  function usd(n) { return n >= 1 ? '$' + n.toFixed(2) : n >= 0.01 ? '$' + n.toFixed(4) : '$' + n.toFixed(6); }
  function usdShort(n) { return n >= 1 ? '$' + n.toFixed(2) : '$' + n.toFixed(4); }
  function num(n) { return n.toLocaleString(); }
  function pct(a, b) { return b > 0 ? (a / b * 100).toFixed(1) + '%' : '0%'; }
  function tokK(n) { return n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n); }
  function providerTag(p) { return '<span class="tag tag-' + p + '">' + p + '</span>'; }
  function ago(ts) {
    var d = new Date(ts), now = new Date(), s = Math.floor((now - d) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  // ── Tab switching ──
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
      document.querySelectorAll('.tab-content').forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      document.getElementById('tab-' + t.dataset.tab).classList.add('active');
    });
  });

  // ── Data loading ──
  var days = function () { return periodEl.value; };

  async function loadSummary() {
    try {
      var r = await fetch('/costs/api/summary');
      var d = await r.json();
      document.getElementById('s-total').textContent = usd(d.totalCost);
      document.getElementById('s-total-hint').textContent = 'Without cache: ' + usd(d.totalCostNoCache);
      document.getElementById('s-today').textContent = usd(d.todayCost);
      document.getElementById('s-today-hint').textContent = d.todayRequests + ' requests today';
      document.getElementById('s-savings').textContent = usd(d.cacheSavings);
      document.getElementById('s-savings-hint').textContent = pct(d.cacheSavings, d.totalCostNoCache) + ' of total saved';
      document.getElementById('s-requests').textContent = num(d.requests);
      document.getElementById('s-tokens').textContent = tokK(d.tokensIn) + ' / ' + tokK(d.tokensOut);
      document.getElementById('s-tokens-hint').textContent = tokK(d.tokensCached) + ' cached, ' + tokK(d.tokensReasoning) + ' reasoning';
      var avg = d.requests > 0 ? d.totalCost / d.requests : 0;
      document.getElementById('s-avg').textContent = usd(avg);
    } catch (e) { console.warn('summary failed', e); }
  }

  async function loadDaily() {
    try {
      var r = await fetch('/costs/api/daily?days=' + days());
      var data = await r.json();
      renderBarChart('daily-chart', data, 'date', 'cost');
    } catch (e) {
      document.getElementById('daily-chart').innerHTML = '<div class="err">Failed to load daily data</div>';
    }
  }

  function renderBarChart(containerId, data, labelKey, valueKey) {
    var el = document.getElementById(containerId);
    if (!data || data.length === 0) { el.innerHTML = '<div class="empty">No data yet</div>'; return; }
    var max = Math.max.apply(null, data.map(function (d) { return d[valueKey]; }));
    if (max === 0) max = 1;
    var html = '<div class="bar-chart">';
    data.forEach(function (d) {
      var h = Math.max(2, (d[valueKey] / max) * 180);
      var label = d[labelKey];
      if (labelKey === 'date') label = label.slice(5); // MM-DD
      html += '<div class="bar-group">';
      html += '<div class="bar" style="height:' + h + 'px">';
      html += '<div class="bar-tooltip">' + label + ': ' + usd(d[valueKey]) + ' (' + num(d.requests) + ' req)</div>';
      html += '</div>';
      html += '<div class="bar-label">' + label + '</div>';
      html += '</div>';
    });
    html += '</div>';
    el.innerHTML = html;
  }

  function renderBreakdownTable(containerId, data, nameKey, nameLabel) {
    var el = document.getElementById(containerId);
    if (!data || data.length === 0) { el.innerHTML = '<div class="empty">No data yet</div>'; return; }
    var totalCost = data.reduce(function (s, d) { return s + d.cost; }, 0);
    var html = '<table><thead><tr><th>' + nameLabel + '</th><th class="num">Cost</th><th class="num">Share</th><th class="num">Requests</th></tr></thead><tbody>';
    data.sort(function (a, b) { return b.cost - a.cost; });
    data.forEach(function (d) {
      var share = totalCost > 0 ? (d.cost / totalCost * 100) : 0;
      html += '<tr>';
      html += '<td>' + (d[nameKey] || '—') + '</td>';
      html += '<td class="num">' + usd(d.cost) + '</td>';
      html += '<td class="num">' + share.toFixed(1) + '%</td>';
      html += '<td class="num">' + num(d.requests) + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
  }

  async function loadProviders() {
    try {
      var r = await fetch('/costs/api/by-provider?days=' + days());
      var data = await r.json();
      renderBreakdownTable('provider-table', data, 'provider', 'Provider');
    } catch (e) { document.getElementById('provider-table').innerHTML = '<div class="err">Failed</div>'; }
  }

  async function loadMessageTypes() {
    try {
      var r = await fetch('/costs/api/by-message-type?days=' + days());
      var data = await r.json();
      renderBreakdownTable('msgtype-table', data, 'messageType', 'Message Type');
    } catch (e) { document.getElementById('msgtype-table').innerHTML = '<div class="err">Failed</div>'; }
  }

  async function loadModels() {
    var el = document.getElementById('model-table');
    try {
      var r = await fetch('/costs/api/by-model?days=' + days());
      var data = await r.json();
      if (!data || data.length === 0) { el.innerHTML = '<div class="empty">No data yet</div>'; return; }
      var maxCost = Math.max.apply(null, data.map(function (d) { return d.cost; }));
      var html = '<div class="scrollable-table"><table><thead><tr><th>Model</th><th>Provider</th><th class="num">Cost</th><th style="min-width:100px"></th><th class="num">Requests</th><th class="num">Tokens In</th><th class="num">Tokens Out</th><th class="num">Cached</th><th class="num">Avg Latency</th></tr></thead><tbody>';
      data.forEach(function (d) {
        var barW = maxCost > 0 ? Math.max(2, d.cost / maxCost * 100) : 0;
        html += '<tr>';
        html += '<td class="mono">' + d.model + '</td>';
        html += '<td>' + providerTag(d.provider) + '</td>';
        html += '<td class="num">' + usd(d.cost) + '</td>';
        html += '<td><div class="cost-bar-track"><div class="cost-bar-fill" style="width:' + barW + '%"></div></div></td>';
        html += '<td class="num">' + num(d.requests) + '</td>';
        html += '<td class="num">' + tokK(d.tokensIn) + '</td>';
        html += '<td class="num">' + tokK(d.tokensOut) + '</td>';
        html += '<td class="num">' + tokK(d.cached) + '</td>';
        html += '<td class="num">' + (d.avgLatency ? d.avgLatency + 'ms' : '—') + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table></div>';
      el.innerHTML = html;
    } catch (e) { el.innerHTML = '<div class="err">Failed</div>'; }
  }

  async function loadAgents() {
    var el = document.getElementById('agent-table');
    try {
      var r = await fetch('/costs/api/by-agent?days=' + days());
      var data = await r.json();
      if (!data || data.length === 0) { el.innerHTML = '<div class="empty">No data yet</div>'; return; }
      var maxCost = Math.max.apply(null, data.map(function (d) { return d.cost; }));
      var html = '<div class="scrollable-table"><table><thead><tr><th>Agent</th><th class="num">Cost</th><th style="min-width:100px"></th><th class="num">Requests</th><th class="num">Tokens In</th><th class="num">Tokens Out</th><th class="num">Avg Latency</th></tr></thead><tbody>';
      data.forEach(function (d) {
        var barW = maxCost > 0 ? Math.max(2, d.cost / maxCost * 100) : 0;
        html += '<tr>';
        html += '<td><strong>' + d.agent + '</strong></td>';
        html += '<td class="num">' + usd(d.cost) + '</td>';
        html += '<td><div class="cost-bar-track"><div class="cost-bar-fill" style="width:' + barW + '%"></div></div></td>';
        html += '<td class="num">' + num(d.requests) + '</td>';
        html += '<td class="num">' + tokK(d.tokensIn) + '</td>';
        html += '<td class="num">' + tokK(d.tokensOut) + '</td>';
        html += '<td class="num">' + (d.avgLatency ? d.avgLatency + 'ms' : '—') + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table></div>';
      el.innerHTML = html;
    } catch (e) { el.innerHTML = '<div class="err">Failed</div>'; }
  }

  async function loadSenders() {
    var el = document.getElementById('sender-table');
    try {
      var r = await fetch('/costs/api/by-sender?days=' + days());
      var data = await r.json();
      if (!data || data.length === 0) { el.innerHTML = '<div class="empty">No data yet</div>'; return; }
      var maxCost = Math.max.apply(null, data.map(function (d) { return d.cost; }));
      var html = '<div class="scrollable-table"><table><thead><tr><th>Sender</th><th class="num">Cost</th><th style="min-width:100px"></th><th class="num">Requests</th><th class="num">Tokens In</th><th class="num">Tokens Out</th><th class="num">Avg Latency</th></tr></thead><tbody>';
      data.forEach(function (d) {
        var barW = maxCost > 0 ? Math.max(2, d.cost / maxCost * 100) : 0;
        html += '<tr>';
        html += '<td class="mono">' + d.sender + '</td>';
        html += '<td class="num">' + usd(d.cost) + '</td>';
        html += '<td><div class="cost-bar-track"><div class="cost-bar-fill" style="width:' + barW + '%"></div></div></td>';
        html += '<td class="num">' + num(d.requests) + '</td>';
        html += '<td class="num">' + tokK(d.tokensIn) + '</td>';
        html += '<td class="num">' + tokK(d.tokensOut) + '</td>';
        html += '<td class="num">' + (d.avgLatency ? d.avgLatency + 'ms' : '—') + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table></div>';
      el.innerHTML = html;
    } catch (e) { el.innerHTML = '<div class="err">Failed</div>'; }
  }

  window.loadLogs = async function () {
    var el = document.getElementById('logs-table');
    el.innerHTML = '<div class="loading">Loading…</div>';
    try {
      var params = new URLSearchParams();
      var prov = document.getElementById('log-provider').value;
      var ep = document.getElementById('log-endpoint').value;
      var ag = document.getElementById('log-agent').value;
      var lim = document.getElementById('log-limit').value;
      if (prov) params.set('provider', prov);
      if (ep) params.set('endpoint', ep);
      if (ag) params.set('agent', ag);
      params.set('limit', lim);

      var r = await fetch('/costs/api/logs?' + params.toString());
      var data = await r.json();
      if (!data || data.length === 0) { el.innerHTML = '<div class="empty">No logs yet</div>'; return; }

      var html = '<table><thead><tr>';
      html += '<th>Time</th><th>Provider</th><th>Model</th><th>Endpoint</th><th>Agent</th><th>Type</th>';
      html += '<th class="num">In</th><th class="num">Out</th><th class="num">Cached</th>';
      html += '<th class="num">Cost</th><th class="num">Latency</th><th>Description</th>';
      html += '</tr></thead><tbody>';
      data.forEach(function (d) {
        html += '<tr>';
        html += '<td style="white-space:nowrap">' + ago(d.created_at) + '</td>';
        html += '<td>' + providerTag(d.provider) + '</td>';
        html += '<td class="mono" style="font-size:11px">' + d.model + '</td>';
        html += '<td>' + d.endpoint + '</td>';
        html += '<td>' + (d.agent_name || '—') + '</td>';
        html += '<td>' + (d.message_type || '—') + '</td>';
        html += '<td class="num">' + tokK(d.tokens_in) + '</td>';
        html += '<td class="num">' + tokK(d.tokens_out) + '</td>';
        html += '<td class="num">' + tokK(d.tokens_in_cached || 0) + '</td>';
        html += '<td class="num">' + usd(Number(d.cost_usd)) + '</td>';
        html += '<td class="num">' + (d.latency_ms ? d.latency_ms + 'ms' : '—') + '</td>';
        html += '<td class="truncate" title="' + (d.description || '').replace(/"/g, '&quot;') + '">' + (d.description || '—') + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table>';
      el.innerHTML = html;
    } catch (e) { el.innerHTML = '<div class="err">Failed to load logs</div>'; }
  };

  window.refresh = function () {
    loadSummary();
    loadDaily();
    loadProviders();
    loadMessageTypes();
    loadModels();
    loadAgents();
    loadSenders();
    loadLogs();
  };

  periodEl.addEventListener('change', function () { refresh(); });

  // Initial load
  refresh();
})();
</script>
</body>
</html>
`;
