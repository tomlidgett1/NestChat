/** Admin activity overview: turn volume, webhooks, queues, sampled agent / user breakdown. */
export const activityDashboardHtml = `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nest — Activity</title>
<style>
  :root {
    --bg: #f3f4f6;
    --surface: #ffffff;
    --border: #e5e7eb;
    --text: #111827;
    --muted: #6b7280;
    --radius: 6px;
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
  h1 { font-size: 18px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 4px; }
  .sub { font-size: 13px; color: var(--muted); margin-bottom: 20px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
  }
  .card .label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .card .value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 4px; }
  .card .hint { font-size: 11px; color: var(--muted); margin-top: 6px; }
  .row2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 20px;
  }
  @media (max-width: 800px) { .row2 { grid-template-columns: 1fr; } }
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
  }
  .panel h2 { font-size: 13px; font-weight: 600; margin-bottom: 12px; color: var(--text); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  th { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); }
  tr:last-child td { border-bottom: none; }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; }
  .toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
  .btn {
    padding: 6px 12px;
    font-size: 13px;
    font-weight: 500;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    cursor: pointer;
  }
  .btn:hover { background: #f9fafb; }
  .err { color: #b91c1c; font-size: 13px; padding: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
  .loading { color: var(--muted); font-size: 14px; }
  .verify-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px 20px;
    margin-bottom: 20px;
  }
  .verify-panel h2 { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .verify-panel .def { font-size: 12px; color: var(--muted); margin-bottom: 14px; line-height: 1.45; }
  .verify-hero { font-size: 28px; font-weight: 700; letter-spacing: -0.03em; margin-bottom: 4px; font-variant-numeric: tabular-nums; }
  .verify-sub { font-size: 14px; color: var(--text); margin-bottom: 14px; font-variant-numeric: tabular-nums; }
  .verify-bar {
    display: flex;
    height: 10px;
    border-radius: var(--radius);
    overflow: hidden;
    border: 1px solid var(--border);
    margin-bottom: 12px;
    background: #f3f4f6;
  }
  .verify-bar .seg-active { background: #374151; height: 100%; }
  .verify-bar .seg-pending { background: #d1d5db; height: 100%; }
  .verify-bar .seg-other { background: #e5e7eb; height: 100%; }
  .verify-cols { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; font-size: 13px; }
  @media (max-width: 560px) { .verify-cols { grid-template-columns: 1fr; } }
  .verify-cols .k { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); }
  .verify-cols .v { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .verify-cols .p { font-size: 12px; color: var(--muted); margin-top: 2px; }
</style>
</head>
<body>
  <h1>Activity</h1>
  <p class="sub">Roll-ups from Supabase: verification rates from <code>user_profiles.status</code>, plus turns, messages, webhooks, queues, and sampled routing (last 7 days).</p>
  <div class="toolbar">
    <button type="button" class="btn" id="refresh">Refresh</button>
    <span class="loading" id="status"></span>
  </div>
  <div id="error" class="err" style="display:none;"></div>
  <div id="content" style="display:none;">
    <div class="verify-panel" id="verify-panel"></div>
    <div class="grid" id="kpis"></div>
    <div class="row2">
      <div class="panel">
        <h2>Most active handles (sampled)</h2>
        <p class="sub" style="margin-bottom:10px;font-size:12px;">Based on up to 2,500 most recent turns in the last 7 days — not exact global ranking.</p>
        <table>
          <thead><tr><th>Handle</th><th>Turns in sample</th></tr></thead>
          <tbody id="handles-body"></tbody>
        </table>
      </div>
      <div class="panel">
        <h2>Agents (sampled)</h2>
        <table>
          <thead><tr><th>Agent</th><th>Turns in sample</th></tr></thead>
          <tbody id="agents-body"></tbody>
        </table>
      </div>
    </div>
  </div>
  <script>
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function card(label, value, hint) {
      return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div>' +
        (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') + '</div>';
    }

    async function load() {
      var errEl = document.getElementById('error');
      var statusEl = document.getElementById('status');
      var content = document.getElementById('content');
      errEl.style.display = 'none';
      content.style.display = 'none';
      statusEl.textContent = 'Loading…';
      try {
        var r = await fetch('/debug/api/activity-summary');
        var j = await r.json();
        if (!r.ok) throw new Error(j.error || r.statusText);
        statusEl.textContent = 'Updated ' + new Date(j.generatedAt).toLocaleString('en-AU');

        var uv = j.userVerification || {};
        var t = uv.totalUserProfiles || 0;
        var a = uv.verifiedActive || 0;
        var p = uv.pendingVerification || 0;
        var o = uv.otherStatus || 0;
        var pct = uv.verifiedPercentOfTotal != null ? uv.verifiedPercentOfTotal : 0;
        var wA = t > 0 ? (a / t) * 100 : 0;
        var wP = t > 0 ? (p / t) * 100 : 0;
        var wO = t > 0 ? (o / t) * 100 : 0;
        document.getElementById('verify-panel').innerHTML =
          '<h2>Onboarding verification</h2>' +
          '<p class="def">' + esc(uv.note || '') + '</p>' +
          '<div class="verify-hero">' + esc(pct) + '% verified</div>' +
          '<div class="verify-sub"><strong>' + esc(a) + '</strong> of <strong>' + esc(t) + '</strong> users have status <code>active</code></div>' +
          '<div class="verify-bar">' +
          (wA > 0 ? '<div class="seg-active" style="width:' + wA + '%"></div>' : '') +
          (wP > 0 ? '<div class="seg-pending" style="width:' + wP + '%"></div>' : '') +
          (wO > 0 ? '<div class="seg-other" style="width:' + wO + '%"></div>' : '') +
          '</div>' +
          '<div class="verify-cols">' +
          '<div><div class="k">Verified (active)</div><div class="v">' + esc(a) + '</div><div class="p">' + esc(uv.verifiedPercentOfTotal) + '% of total</div></div>' +
          '<div><div class="k">Pending verification</div><div class="v">' + esc(p) + '</div><div class="p">' + esc(uv.pendingPercentOfTotal) + '% of total</div></div>' +
          '<div><div class="k">Other status</div><div class="v">' + esc(o) + '</div><div class="p">' + esc(uv.otherPercentOfTotal) + '% of total</div></div>' +
          '</div>';

        var kpis = document.getElementById('kpis');
        kpis.innerHTML =
          card('Turns (24h)', j.turns.last24h) +
          card('Turns (7d)', j.turns.last7d) +
          card('Conversation messages (24h, non-expired)', j.conversationMessages.nonExpiredLast24h) +
          card('User profiles (total)', j.userProfiles) +
          card(
            'Verified users (active)',
            String(a) + ' (' + String(pct) + '%)',
            'user_profiles.status = active',
          ) +
          card('Pending verification', p, 'user_profiles.status = pending') +
          card('Webhook queue (queued)', j.webhooks.queued, 'Events waiting to process') +
          card('Webhooks processed (24h)', j.webhooks.processedLast24h) +
          card('Outbound pending', j.outboundMessages.pending) +
          card('Turn errors (24h)', j.turnErrors.last24h, 'Rows with error_message set') +
          card('Automation runs (24h)', j.automationRuns.last24h) +
          card('Onboarding events (24h)', j.onboardingEvents.last24h) +
          card('Ingestion jobs (pending)', j.ingestionJobs.pending) +
          card('Sampled turns (7d window)', j.sampledTurnsLast7d, 'Used for handle / agent tables');

        var hb = document.getElementById('handles-body');
        hb.innerHTML = (j.topHandlesBySampledTurns || []).map(function (row) {
          return '<tr><td class="mono">' + esc(row.handle) + '</td><td>' + esc(row.count) + '</td></tr>';
        }).join('') || '<tr><td colspan="2" style="color:#6b7280;">No data</td></tr>';

        var ab = document.getElementById('agents-body');
        ab.innerHTML = (j.agentBreakdownSampled || []).map(function (row) {
          return '<tr><td>' + esc(row.agent) + '</td><td>' + esc(row.count) + '</td></tr>';
        }).join('') || '<tr><td colspan="2" style="color:#6b7280;">No data</td></tr>';

        content.style.display = 'block';
      } catch (e) {
        statusEl.textContent = '';
        errEl.textContent = e.message || String(e);
        errEl.style.display = 'block';
      }
    }

    document.getElementById('refresh').addEventListener('click', load);
    load();
  </script>
</body>
</html>
`;
