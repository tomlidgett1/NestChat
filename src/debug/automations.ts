export const automationsDashboardHtml = `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nest — Automations</title>
<style>
  :root {
    --bg: #f3f4f6;
    --surface: #ffffff;
    --surface-muted: #f9fafb;
    --border: #e5e7eb;
    --text: #111827;
    --text-secondary: #6b7280;
    --text-muted: #9ca3af;
    --accent: #111827;
    --accent-inverse: #ffffff;
    --success: #059669;
    --success-soft: #ecfdf5;
    --warning: #b45309;
    --warning-soft: #fffbeb;
    --danger: #dc2626;
    --danger-soft: #fef2f2;
    --radius: 6px;
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
    padding: 12px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .header-title-wrap { min-width: 0; }
  .header h1 { font-size: 15px; font-weight: 600; letter-spacing: -0.02em; }
  .header h1 span { color: var(--text-secondary); font-weight: 400; margin-left: 6px; }
  .header-sub { font-size: 12px; color: var(--text-muted); margin-top: 2px; max-width: 42rem; }

  .header-stats { display: flex; gap: 14px; font-size: 12px; color: var(--text-secondary); flex-wrap: wrap; }
  .header-stats .stat { display: flex; align-items: center; gap: 4px; }
  .header-stats .stat-val { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }

  .header-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }

  .btn {
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 500;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease;
    font-family: inherit;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
  }
  .btn:hover { background: var(--surface-muted); border-color: #d1d5db; }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-inverse); }
  .btn-primary:hover { opacity: 0.92; background: var(--accent); }

  .layout { display: flex; height: calc(100vh - 52px); min-height: 0; }

  .user-list {
    width: 300px;
    min-width: 260px;
    max-width: 340px;
    border-right: 1px solid var(--border);
    background: var(--surface);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .search-bar {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--surface);
    z-index: 10;
  }
  .search-bar input {
    width: 100%;
    padding: 8px 10px;
    background: var(--surface-muted);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font-size: 13px;
    font-family: inherit;
    outline: none;
  }
  .search-bar input:focus { border-color: #9ca3af; box-shadow: 0 0 0 1px #e5e7eb; }
  .search-bar input::placeholder { color: var(--text-muted); }

  .user-card {
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background 0.1s ease;
  }
  .user-card:hover { background: var(--surface-muted); }
  .user-card.active {
    background: #f3f4f6;
    box-shadow: inset 3px 0 0 0 var(--accent);
  }
  .user-card-header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 4px; }
  .user-card-name { font-size: 13px; font-weight: 600; }
  .user-card-handle { font-size: 11px; color: var(--text-muted); font-family: ui-monospace, monospace; }
  .user-card-meta { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
  .tag {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: var(--radius);
    font-weight: 500;
    background: var(--surface-muted);
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }
  .tag-emphasis { font-weight: 600; color: var(--text); }
  .user-card-last { font-size: 11px; color: var(--text-muted); margin-top: 6px; }

  .main-panel {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    background: var(--bg);
  }

  .profile-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100%;
    padding: 40px 24px;
    text-align: center;
    color: var(--text-secondary);
    font-size: 14px;
    max-width: 28rem;
    margin: 0 auto;
    line-height: 1.6;
  }

  .profile-empty strong { color: var(--text); font-weight: 600; }

  .profile { padding: 0 0 48px; }

  .profile-header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 20px 24px 18px;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 20px;
    flex-wrap: wrap;
  }
  .profile-name { font-size: 18px; font-weight: 600; letter-spacing: -0.02em; }
  .profile-handle { font-size: 12px; color: var(--text-muted); font-family: ui-monospace, monospace; margin-top: 4px; }
  .profile-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
  .profile-meta-col { font-size: 12px; color: var(--text-secondary); text-align: right; }
  .profile-meta-col div + div { margin-top: 4px; }

  .detail-tabs-wrap {
    background: var(--bg);
    padding: 12px 24px 0;
    position: sticky;
    top: 0;
    z-index: 8;
    border-bottom: 1px solid var(--border);
  }

  .detail-tabs {
    display: flex;
    align-items: center;
    background: #f3f4f6;
    padding: 2px;
    border-radius: var(--radius);
    width: fit-content;
    gap: 2px;
    flex-wrap: wrap;
  }

  .detail-tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 500;
    border: none;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-family: inherit;
    transition: background 0.12s ease, color 0.12s ease, box-shadow 0.12s ease;
  }
  .detail-tab:hover { color: var(--text); background: rgba(0,0,0,0.04); }
  .detail-tab.active {
    color: var(--text);
    background: var(--surface);
    box-shadow: 0 1px 2px rgba(0,0,0,0.06);
  }

  .detail-panel { display: none; padding: 20px 24px 32px; }
  .detail-panel.active { display: block; }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 12px;
    margin-bottom: 24px;
  }
  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
  }
  .stat-card-label { font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
  .stat-card-value { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  .stat-card-sub { font-size: 12px; color: var(--text-muted); margin-top: 4px; }

  .section { margin-bottom: 28px; }
  .section-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 10px;
    letter-spacing: -0.01em;
  }
  .section-intro { font-size: 12px; color: var(--text-secondary); margin: -4px 0 12px; max-width: 52rem; line-height: 1.5; }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
  }

  .milestones-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .milestones-table th,
  .milestones-table td {
    padding: 10px 14px;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .milestones-table th {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-secondary);
    background: var(--surface-muted);
  }
  .milestones-table tr:last-child td { border-bottom: none; }
  .milestones-table td:last-child { color: var(--text-secondary); font-size: 12px; }

  .onboard-steps {
    display: flex;
    gap: 0;
    align-items: flex-start;
    padding: 4px 0 8px;
    overflow-x: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
  }
  .onboard-step {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 130px;
    position: relative;
  }
  .onboard-step:not(:last-child)::after {
    content: '';
    position: absolute;
    right: 0;
    top: 14px;
    width: calc(100% - 28px);
    height: 2px;
    background: var(--border);
    transform: translateX(50%);
    z-index: 0;
  }
  .onboard-step.done:not(:last-child)::after { background: #d1d5db; }
  .onboard-dot {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 600;
    z-index: 1;
    border: 2px solid var(--border);
    background: var(--surface);
    color: var(--text-muted);
  }
  .onboard-step.done .onboard-dot { background: var(--text); border-color: var(--text); color: var(--surface); }
  .onboard-step.current .onboard-dot { background: var(--surface); border-color: var(--text); color: var(--text); box-shadow: 0 0 0 2px var(--surface); }
  .onboard-label { font-size: 11px; font-weight: 600; color: var(--text); margin-top: 8px; text-align: center; }
  .onboard-detail { font-size: 11px; color: var(--text-secondary); margin-top: 4px; text-align: center; max-width: 120px; line-height: 1.35; }

  .breakdown-list { display: flex; flex-direction: column; gap: 8px; }
  .breakdown-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 13px;
  }
  .breakdown-row span:last-child { font-weight: 600; font-variant-numeric: tabular-nums; color: var(--text-secondary); }

  .summary-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 20px;
    padding: 14px 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 16px;
    font-size: 13px;
    color: var(--text-secondary);
  }
  .summary-bar strong { color: var(--text); font-weight: 600; }

  .elig-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 12px;
  }
  .elig-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
    border-left-width: 3px;
    border-left-style: solid;
    border-left-color: var(--border);
  }
  .elig-card.elig-ready { border-left-color: var(--success); }
  .elig-card.elig-waiting { border-left-color: #ca8a04; }
  .elig-card.elig-blocked { border-left-color: var(--danger); }
  .elig-card.elig-not_applicable { border-left-color: #d1d5db; }
  .elig-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 8px; }
  .elig-name { font-size: 14px; font-weight: 600; }
  .elig-status {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: var(--radius);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    flex-shrink: 0;
    border: 1px solid var(--border);
    background: var(--surface-muted);
    color: var(--text-secondary);
  }
  .elig-status-ready { border-color: #a7f3d0; background: var(--success-soft); color: var(--success); }
  .elig-status-waiting { border-color: #fde68a; background: var(--warning-soft); color: var(--warning); }
  .elig-status-blocked { border-color: #fecaca; background: var(--danger-soft); color: var(--danger); }
  .elig-status-not_applicable { color: var(--text-muted); }
  .elig-schedule { font-size: 11px; color: var(--text-muted); margin-bottom: 8px; }
  .elig-label { font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; line-height: 1.45; }
  .elig-conditions { list-style: none; margin: 0; padding: 0; }
  .elig-conditions li {
    font-size: 12px;
    padding: 4px 0;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    color: var(--text-secondary);
    border-top: 1px solid var(--border);
  }
  .elig-conditions li:first-child { border-top: none; padding-top: 0; }
  .elig-check { font-size: 11px; flex-shrink: 0; margin-top: 2px; width: 1rem; }
  .elig-check.pass { color: var(--success); }
  .elig-check.fail { color: var(--danger); }

  .timeline { display: flex; flex-direction: column; gap: 10px; }
  .timeline-item {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
  }
  .timeline-item-header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
  .timeline-type { font-size: 12px; font-weight: 600; color: var(--text); }
  .timeline-time { font-size: 11px; color: var(--text-muted); font-family: ui-monospace, monospace; }
  .timeline-content {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.5;
    padding: 12px 14px;
    background: var(--surface-muted);
    border-radius: var(--radius);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .timeline-meta { font-size: 11px; color: var(--text-muted); margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .badge {
    padding: 2px 8px;
    border-radius: var(--radius);
    font-weight: 500;
    font-size: 10px;
    border: 1px solid var(--border);
    background: var(--surface-muted);
    color: var(--text-secondary);
  }
  .badge-replied { background: var(--success-soft); border-color: #a7f3d0; color: var(--success); }
  .badge-ignored { background: var(--danger-soft); border-color: #fecaca; color: var(--danger); }
  .badge-await { background: #f3f4f6; color: var(--text-secondary); }
  .badge-manual { background: var(--warning-soft); border-color: #fde68a; color: var(--warning); }

  .trigger-panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; }
  .trigger-intro { font-size: 13px; color: var(--text-secondary); margin-bottom: 14px; line-height: 1.5; }
  .trigger-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
  .trigger-btn {
    padding: 12px 14px;
    background: var(--surface-muted);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
    text-align: left;
    transition: border-color 0.12s ease, background 0.12s ease;
    font-family: inherit;
    color: var(--text);
  }
  .trigger-btn:hover:not(:disabled) { border-color: #9ca3af; background: var(--surface); }
  .trigger-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .trigger-btn-name { font-size: 13px; font-weight: 600; display: block; }
  .trigger-btn-desc { font-size: 11px; color: var(--text-secondary); margin-top: 4px; display: block; line-height: 1.4; }
  .trigger-btn.sending { border-color: #ca8a04; }
  .trigger-btn.sent { border-color: var(--success); }
  .trigger-btn.failed { border-color: var(--danger); }

  .toast {
    position: fixed;
    bottom: 20px;
    right: 20px;
    padding: 12px 18px;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 500;
    z-index: 999;
    animation: toast-in 0.2s ease-out;
    transition: opacity 0.3s;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 10px 40px rgba(0,0,0,0.12);
  }
  .toast-success { border-color: #a7f3d0; }
  .toast-error { border-color: #fecaca; }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 48px 24px;
    color: var(--text-secondary);
    font-size: 13px;
  }
  .spinner {
    width: 18px;
    height: 18px;
    border: 2px solid var(--border);
    border-top-color: var(--text-muted);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    margin-right: 10px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes toast-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

  .empty-inline { font-size: 13px; color: var(--text-secondary); padding: 16px 0; }

  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: #9ca3af; }
</style>
</head>
<body>

<div class="header">
  <div class="header-title-wrap">
    <h1>Nest <span>Automations</span></h1>
    <p class="header-sub">Pick a user on the left, then use the tabs to review summary, what can run next, history, and manual sends.</p>
  </div>
  <div class="header-stats" id="headerStats"></div>
  <div class="header-actions">
    <button type="button" class="btn btn-primary" onclick="loadUsers()">Refresh list</button>
    <a href="/admin#automations" class="btn">Admin</a>
    <a href="/debug" class="btn">Debug</a>
    <a href="/compare" class="btn">Compare</a>
  </div>
</div>

<div class="layout">
  <div class="user-list">
    <div class="search-bar">
      <input type="search" id="searchInput" placeholder="Search by name or handle…" autocomplete="off" oninput="filterUsers()">
    </div>
    <div id="userListContent"></div>
  </div>
  <div class="main-panel" id="mainPanel">
    <div class="profile-empty"><strong>Select a user</strong> from the list to see onboarding progress, eligibility, automation history, and manual triggers.</div>
  </div>
</div>

<script>
let allUsers = [];
let selectedHandle = null;
let userHistory = {};
let userContext = {};
let userEligibility = {};

const AUTOMATION_TYPES = {
  onboarding_morning:       { label: 'Day 2 morning' },
  onboarding_feature:       { label: 'Day 3 reminders tip' },
  morning_briefing:         { label: 'Morning briefing' },
  calendar_heads_up:        { label: 'Calendar heads-up' },
  feature_discovery:        { label: 'Feature discovery' },
  inactivity_reengagement:  { label: 'Inactivity re-engagement' },
  follow_up_loop:           { label: 'Follow-up loop' },
  recovery_nudge:           { label: 'Recovery nudge' },
  memory_moment:            { label: 'Memory moment' },
};

const JOURNEY_STEPS = [
  { key: 'first_seen', label: 'First seen', field: 'first_seen', isEpoch: true },
  { key: 'first_value', label: 'First value', field: 'first_value_delivered_at' },
  { key: 'follow_through', label: 'Follow-through', field: 'follow_through_delivered_at' },
  { key: 'second_engage', label: 'Second engagement', field: 'second_engagement_at' },
  { key: 'memory_moment', label: 'Memory moment', field: 'memory_moment_delivered_at' },
  { key: 'activated', label: 'Activated', field: 'activated_at' },
];

const TRIGGER_TYPES = [
  { type: 'onboarding_morning', name: 'Day 2 morning', desc: 'Onboarding greeting or briefing', requiresAccounts: false },
  { type: 'onboarding_feature', name: 'Day 3 reminders', desc: 'Reminders feature tip', requiresAccounts: false },
  { type: 'morning_briefing', name: 'Morning briefing', desc: 'Calendar and email summary', requiresAccounts: true },
  { type: 'calendar_heads_up', name: 'Calendar heads-up', desc: 'Next upcoming event', requiresAccounts: true },
  { type: 'feature_discovery', name: 'Feature tip', desc: 'Unused feature suggestion', requiresAccounts: false },
  { type: 'inactivity_reengagement', name: 'Re-engagement', desc: 'Nudge for inactive users', requiresAccounts: false },
  { type: 'follow_up_loop', name: 'Follow-up', desc: 'Close an open loop', requiresAccounts: false },
];

function showAutomationPanel(panelId) {
  document.querySelectorAll('.detail-tab').forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-panel') === panelId);
  });
  document.querySelectorAll('.detail-panel').forEach(function (p) {
    p.classList.toggle('active', p.id === 'panel-' + panelId);
  });
}

async function loadUsers() {
  const container = document.getElementById('userListContent');
  container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading users…</div>';

  try {
    const resp = await fetch('/automations/api/users');
    allUsers = await resp.json();
    renderUserList();
    updateHeaderStats();
  } catch (err) {
    container.innerHTML = '<div class="loading" style="color:var(--danger)">Could not load users. Check the server and try Refresh.</div>';
  }
}

function updateHeaderStats() {
  const stats = document.getElementById('headerStats');
  const total = allUsers.length;
  const withAutomations = allUsers.filter(function (u) { return u.total_automations_sent > 0; }).length;
  const totalSent = allUsers.reduce(function (s, u) { return s + (u.total_automations_sent || 0); }, 0);
  const totalReplied = allUsers.reduce(function (s, u) { return s + (u.automations_replied || 0); }, 0);

  stats.innerHTML = [
    '<div class="stat"><span class="stat-val">' + total + '</span> users</div>',
    '<div class="stat"><span class="stat-val">' + withAutomations + '</span> with sends</div>',
    '<div class="stat"><span class="stat-val">' + totalSent + '</span> sent</div>',
    '<div class="stat"><span class="stat-val">' + (totalSent > 0 ? Math.round(totalReplied / totalSent * 100) : 0) + '%</span> replies</div>',
  ].join('');
}

function filterUsers() {
  renderUserList();
}

function renderUserList() {
  const container = document.getElementById('userListContent');
  const query = document.getElementById('searchInput').value.toLowerCase();

  const filtered = allUsers.filter(function (u) {
    const name = (u.name || '').toLowerCase();
    const handle = (u.handle || '').toLowerCase();
    return name.includes(query) || handle.includes(query);
  });

  container.innerHTML = filtered.map(function (u) {
    const isActive = u.handle === selectedHandle;
    const name = u.name || 'Unknown';
    const handle = u.handle || '';
    const lastSeen = u.last_seen ? timeAgo(u.last_seen * 1000) : 'never';

    let tags = '';
    if (u.onboard_state === 'activated') tags += '<span class="tag tag-emphasis">Activated</span>';
    else if (u.onboard_state === 'at_risk') tags += '<span class="tag tag-emphasis">At risk</span>';
    else tags += '<span class="tag">' + escHtml(u.onboard_state || 'new') + '</span>';

    if (u.total_automations_sent > 0) tags += '<span class="tag">' + u.total_automations_sent + ' sent</span>';
    if (u.automations_replied > 0) tags += '<span class="tag">' + u.automations_replied + ' replies</span>';

    return '<div class="user-card' + (isActive ? ' active' : '') + '" onclick="selectUser(\\'' + u.handle + '\\')">'
      + '<div class="user-card-header">'
      + '<span class="user-card-name">' + escHtml(name) + '</span>'
      + '<span class="user-card-handle">' + escHtml(handle.replace(/\\+/g, '')) + '</span>'
      + '</div>'
      + '<div class="user-card-meta">' + tags + '</div>'
      + '<div class="user-card-last">Last seen ' + lastSeen
      + (u.last_automation_type ? ' · Last: ' + escHtml(AUTOMATION_TYPES[u.last_automation_type]?.label || u.last_automation_type) : '')
      + '</div>'
      + '</div>';
  }).join('');
}

async function selectUser(handle) {
  selectedHandle = handle;
  renderUserList();
  const panel = document.getElementById('mainPanel');
  panel.innerHTML = '<div class="loading"><div class="spinner"></div>Loading profile…</div>';

  try {
    const [histResp, ctxResp, eligResp] = await Promise.all([
      fetch('/automations/api/history?handle=' + encodeURIComponent(handle)),
      fetch('/automations/api/user-detail?handle=' + encodeURIComponent(handle)),
      fetch('/automations/api/eligibility?handle=' + encodeURIComponent(handle)),
    ]);

    userHistory[handle] = await histResp.json();
    userContext[handle] = await ctxResp.json();
    userEligibility[handle] = await eligResp.json();

    renderProfile(handle);
  } catch (err) {
    panel.innerHTML = '<div class="loading" style="color:var(--danger)">Failed to load this user. Try again.</div>';
  }
}

function renderProfile(handle) {
  const ctx = userContext[handle];
  const history = userHistory[handle] || [];
  const user = allUsers.find(function (u) { return u.handle === handle; }) || {};
  const panel = document.getElementById('mainPanel');

  if (!ctx) {
    panel.innerHTML = '<div class="profile-empty">No profile data for this user.</div>';
    return;
  }

  const name = ctx.name || user.name || 'Unknown';
  const tz = ctx.timezone || 'Unknown';
  const firstSeen = ctx.first_seen ? new Date(ctx.first_seen * 1000).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const lastSeen = ctx.last_seen ? timeAgo(ctx.last_seen * 1000) : 'never';
  const daysSinceFirst = ctx.first_seen ? Math.round((Date.now() / 1000 - ctx.first_seen) / 86400) : 0;

  let stateBadge = '';
  const state = ctx.onboard_state || user.onboard_state || 'new';
  if (state === 'activated') stateBadge = '<span class="tag tag-emphasis">Activated</span>';
  else if (state === 'at_risk') stateBadge = '<span class="tag tag-emphasis">At risk</span>';
  else stateBadge = '<span class="tag">' + escHtml(state) + '</span>';

  const accountCount = ctx.connected_accounts || 0;
  const accountBadge = accountCount > 0
    ? '<span class="tag tag-emphasis">' + accountCount + ' account' + (accountCount !== 1 ? 's' : '') + ' connected</span>'
    : '<span class="tag">No accounts connected</span>';

  const totalSent = history.length;
  const replied = history.filter(function (h) { return h.replied_at; }).length;
  const ignored = history.filter(function (h) { return h.ignored; }).length;
  const replyRate = totalSent > 0 ? Math.round(replied / totalSent * 100) : 0;

  const typeCounts = {};
  for (let i = 0; i < history.length; i++) {
    const t = history[i].automation_type;
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }

  const milestonesHtml = renderMilestonesTable(ctx);
  const timelineHtml = renderTimeline(history);
  const triggerHtml = renderTriggerPanel(handle, ctx);
  const eligHtml = renderEligibilityPanel(handle);

  panel.innerHTML = ''
    + '<div class="profile">'
    + '<div class="profile-header">'
    + '<div>'
    + '<div class="profile-name">' + escHtml(name) + '</div>'
    + '<div class="profile-handle">' + escHtml(handle) + '</div>'
    + '<div class="profile-badges">' + stateBadge + accountBadge + '</div>'
    + '</div>'
    + '<div class="profile-meta-col">'
    + '<div>Timezone: <strong>' + escHtml(tz) + '</strong></div>'
    + '<div>Joined: <strong>' + firstSeen + '</strong> (' + daysSinceFirst + 'd ago)</div>'
    + '<div>Last seen: <strong>' + lastSeen + '</strong></div>'
    + '</div>'
    + '</div>'

    + '<div class="detail-tabs-wrap">'
    + '<div class="detail-tabs" role="tablist">'
    + '<button type="button" class="detail-tab active" data-panel="overview" onclick="showAutomationPanel(\\'overview\\')">Overview</button>'
    + '<button type="button" class="detail-tab" data-panel="eligibility" onclick="showAutomationPanel(\\'eligibility\\')">What can run</button>'
    + '<button type="button" class="detail-tab" data-panel="history" onclick="showAutomationPanel(\\'history\\')">History</button>'
    + '<button type="button" class="detail-tab" data-panel="manual" onclick="showAutomationPanel(\\'manual\\')">Manual send</button>'
    + '</div></div>'

    + '<div id="panel-overview" class="detail-panel active">'
    + '<div class="stats-grid">'
    + statCard('Automations sent', String(totalSent), 'Recorded sends for this user')
    + statCard('Reply rate', replyRate + '%', replied + ' replied · ' + ignored + ' ignored')
    + statCard('Messages (inbound)', String(ctx.onboard_count || 0), 'User messages to Nest')
    + statCard('Activation score', String(ctx.activation_score || 0) + ' / 6', 'Engagement composite')
    + statCard('Ignore streak', String(ctx.proactive_ignore_count || 0), 'Consecutive ignores')
    + statCard('Days since first', String(daysSinceFirst), 'Since first interaction')
    + '</div>'

    + '<div class="section">'
    + '<div class="section-title">Onboarding sequence</div>'
    + '<p class="section-intro">Calendar-day steps after sign-up. At most one proactive automation per day.</p>'
    + renderOnboardingTimeline(ctx, history)
    + '</div>'

    + '<div class="section">'
    + '<div class="section-title">Lifecycle milestones</div>'
    + '<p class="section-intro">Technical timestamps from the profile (for debugging journey timing).</p>'
    + milestonesHtml
    + '</div>'

    + '<div class="section">'
    + '<div class="section-title">Counts by type</div>'
    + '<p class="section-intro">How many times each automation type has been sent.</p>'
    + renderAutomationBreakdown(typeCounts)
    + '</div>'
    + '</div>'

    + '<div id="panel-eligibility" class="detail-panel">'
    + '<p class="section-intro" style="margin-bottom:16px">Shows local time, daily cap, and per-automation rules. Use this to see why something is waiting or blocked.</p>'
    + eligHtml
    + '</div>'

    + '<div id="panel-history" class="detail-panel">'
    + '<div class="section-title">Automation history</div>'
    + '<p class="section-intro">' + totalSent + ' ' + (totalSent === 1 ? 'entry' : 'entries') + ', newest activity first in the list below.</p>'
    + timelineHtml
    + '</div>'

    + '<div id="panel-manual" class="detail-panel">'
    + '<div class="section-title">Manual send</div>'
    + triggerHtml
    + '</div>'

    + '</div>';
}

function statCard(label, value, sub) {
  return '<div class="stat-card">'
    + '<div class="stat-card-label">' + label + '</div>'
    + '<div class="stat-card-value">' + value + '</div>'
    + '<div class="stat-card-sub">' + sub + '</div>'
    + '</div>';
}

function renderMilestonesTable(ctx) {
  let rows = '';
  for (let i = 0; i < JOURNEY_STEPS.length; i++) {
    const step = JOURNEY_STEPS[i];
    let value = ctx[step.field];
    if (step.isEpoch && value) value = new Date(value * 1000).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    else if (value && typeof value === 'string') {
      try {
        const d = new Date(value);
        if (!isNaN(d.getTime())) value = d.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
      } catch (e) {}
    }
    rows += '<tr><td>' + escHtml(step.label) + '</td><td>' + (value ? escHtml(String(value)) : '—') + '</td></tr>';
  }
  if (ctx.onboard_state === 'at_risk') {
    rows += '<tr><td>Onboarding state</td><td>At risk (activation not complete)</td></tr>';
  }
  return '<table class="milestones-table"><thead><tr><th>Milestone</th><th>When</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderAutomationBreakdown(typeCounts) {
  const types = Object.keys(typeCounts);
  if (types.length === 0) return '<div class="empty-inline">No automations sent yet.</div>';

  return '<div class="breakdown-list">' + types.map(function (t) {
    const info = AUTOMATION_TYPES[t] || { label: t };
    return '<div class="breakdown-row"><span>' + escHtml(info.label) + '</span><span>' + typeCounts[t] + '×</span></div>';
  }).join('') + '</div>';
}

function renderTimeline(history) {
  if (history.length === 0) return '<div class="empty-inline">No automation history yet.</div>';

  let html = '<div class="timeline">';
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    const info = AUTOMATION_TYPES[h.automation_type] || { label: h.automation_type };
    const sentAt = new Date(h.sent_at);
    const timeStr = sentAt.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });

    let statusBadge = '';
    if (h.replied_at) {
      statusBadge = '<span class="badge badge-replied">Replied ' + timeAgo(new Date(h.replied_at).getTime()) + '</span>';
    } else if (h.ignored) {
      statusBadge = '<span class="badge badge-ignored">Ignored</span>';
    } else {
      statusBadge = '<span class="badge badge-await">Awaiting reply</span>';
    }
    if (h.manual_trigger) statusBadge += '<span class="badge badge-manual">Manual</span>';

    let metaStr = '';
    if (h.metadata) {
      const m = typeof h.metadata === 'string' ? JSON.parse(h.metadata) : h.metadata;
      const metaParts = [];
      if (m.tier) metaParts.push('Tier: ' + m.tier);
      if (m.event_title) metaParts.push('Event: ' + m.event_title);
      if (m.tip_day) metaParts.push('Day ' + m.tip_day);
      if (m.feature) metaParts.push('Feature: ' + m.feature);
      if (m.open_loops) metaParts.push('Loops: ' + m.open_loops.length);
      if (m.trigger) metaParts.push('Trigger: ' + m.trigger);
      if (metaParts.length > 0) metaStr = metaParts.join(' · ');
    }

    html += '<div class="timeline-item">'
      + '<div class="timeline-item-header">'
      + '<span class="timeline-type">' + escHtml(info.label) + '</span>'
      + '<span class="timeline-time">' + timeStr + '</span>'
      + '</div>'
      + '<div class="timeline-content">' + escHtml(h.content) + '</div>'
      + '<div class="timeline-meta">' + statusBadge + (metaStr ? '<span>' + escHtml(metaStr) + '</span>' : '') + '</div>'
      + '</div>';
  }
  html += '</div>';
  return html;
}

function renderEligibilityPanel(handle) {
  const elig = userEligibility[handle];
  if (!elig || !elig.automations) {
    return '<div class="empty-inline">Eligibility data not available.</div>';
  }

  let globalHtml = '<div class="summary-bar">'
    + '<div>Local time: <strong>' + escHtml(elig.localTime) + '</strong> (' + escHtml(elig.timezone) + ')</div>'
    + '<div>' + (elig.quietHours ? '<strong>Quiet hours</strong> (9pm–7am local)' : '<strong>Awake hours</strong>') + '</div>'
    + '<div>Today: <strong>' + elig.dailyCap.used + '</strong> / ' + elig.dailyCap.max + ' automation' + (elig.dailyCap.reached ? ' — <strong>daily limit reached</strong>' : ' — slot available') + '</div>';

  if (elig.tooNew) {
    globalHtml += '<div><strong>Day 1</strong> (sign-up day): first automation from tomorrow 8:15am local.</div>';
  } else if (elig.isOnboarding) {
    globalHtml += '<div><strong>Onboarding</strong> day ' + (elig.calendarDay + 1) + ' — onboarding rules only (max 1/day).</div>';
  } else {
    globalHtml += '<div><strong>Day ' + (elig.calendarDay + 1) + '</strong> — regular automations (max 1/day).</div>';
  }

  if (elig.spamHold.active) {
    globalHtml += '<div><strong>Spam hold</strong> until ' + escHtml(elig.spamHold.until) + ' (last message ignored).</div>';
  } else if (elig.spamHold.ignoreCount > 0) {
    globalHtml += '<div>Ignore streak: <strong>' + elig.spamHold.ignoreCount + '</strong> / ' + elig.spamHold.ignoreMax + '</div>';
  }

  globalHtml += '</div>';

  let cardsHtml = '<div class="elig-grid">';
  for (let i = 0; i < elig.automations.length; i++) {
    const auto = elig.automations[i];
    const statusCls = 'elig-' + auto.status;

    let countdownHtml = '';
    if (auto.countdown && auto.status !== 'blocked' && auto.status !== 'not_applicable') {
      countdownHtml = ' <span style="font-weight:600;color:var(--text-secondary)">(' + escHtml(auto.countdown) + ')</span>';
    }

    const statusLabel = auto.status === 'ready' ? 'Ready' : auto.status === 'waiting' ? 'Waiting' : auto.status === 'blocked' ? 'Blocked' : 'N/A';

    cardsHtml += '<div class="elig-card ' + statusCls + '">'
      + '<div class="elig-header">'
      + '<span class="elig-name">' + escHtml(auto.name) + countdownHtml + '</span>'
      + '<span class="elig-status elig-status-' + auto.status + '">' + statusLabel + '</span>'
      + '</div>'
      + '<div class="elig-schedule">' + escHtml(auto.schedule) + '</div>'
      + '<div class="elig-label">' + escHtml(auto.statusLabel) + '</div>'
      + '<ul class="elig-conditions">';

    for (let j = 0; j < auto.conditions.length; j++) {
      const c = auto.conditions[j];
      const icon = c.met ? '✓' : '✕';
      const cls = c.met ? 'pass' : 'fail';
      cardsHtml += '<li><span class="elig-check ' + cls + '">' + icon + '</span><span><strong>' + escHtml(c.label) + ':</strong> ' + escHtml(c.detail) + '</span></li>';
    }

    cardsHtml += '</ul></div>';
  }
  cardsHtml += '</div>';

  return globalHtml + cardsHtml;
}

function renderOnboardingTimeline(ctx, history) {
  const firstSeen = ctx.first_seen;
  if (!firstSeen) return '<div class="empty-inline">No first-seen timestamp.</div>';

  const tz = ctx.timezone || 'Australia/Sydney';
  const joinDate = new Date(firstSeen * 1000);

  let calendarDays = 0;
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    const d1 = new Date(fmt.format(joinDate) + 'T00:00:00');
    const d2 = new Date(fmt.format(new Date()) + 'T00:00:00');
    calendarDays = Math.round((d2.getTime() - d1.getTime()) / 86400000);
  } catch (e) {
    calendarDays = Math.floor((Date.now() / 1000 - firstSeen) / 86400);
  }

  const day2Sent = history.some(function (h) { return h.automation_type === 'onboarding_morning'; });
  const day2Replied = history.some(function (h) { return h.automation_type === 'onboarding_morning' && h.replied_at; });
  const day3Sent = history.some(function (h) { return h.automation_type === 'onboarding_feature'; });

  const steps = [
    {
      label: 'Day 1 — Sign-up',
      detail: joinDate.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz }),
      status: 'done',
    },
    {
      label: 'Day 2 — Morning',
      detail: day2Sent ? (day2Replied ? 'Sent · replied' : 'Sent · no reply yet') : (calendarDays >= 1 ? 'Due ~8:15am' : 'From tomorrow 8:15am'),
      status: day2Sent ? 'done' : (calendarDays >= 1 ? 'current' : 'upcoming'),
    },
    {
      label: 'Day 3 — Reminders tip',
      detail: day3Sent ? 'Sent' : (day2Replied ? 'Eligible after Day 2 reply' : (day2Sent ? 'Waiting on Day 2 reply' : 'After Day 2')),
      status: day3Sent ? 'done' : (calendarDays >= 2 && day2Replied ? 'current' : 'upcoming'),
    },
    {
      label: 'Day 4+ — Regular',
      detail: calendarDays >= 3 ? 'Active' : 'Starts calendar day 4',
      status: calendarDays >= 3 ? 'current' : 'upcoming',
    },
  ];

  let html = '<p class="section-intro">Calendar day ' + calendarDays + ' since sign-up.</p>'
    + '<div class="onboard-steps">';

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    let stepClass = '';
    if (s.status === 'done') stepClass = 'done';
    else if (s.status === 'current') stepClass = 'current';
    let icon = String(i + 1);
    if (s.status === 'done') icon = '✓';

    html += '<div class="onboard-step ' + stepClass + '">'
      + '<div class="onboard-dot">' + icon + '</div>'
      + '<div class="onboard-label">' + escHtml(s.label) + '</div>'
      + '<div class="onboard-detail">' + escHtml(s.detail) + '</div>'
      + '</div>';
  }

  html += '</div>';
  return html;
}

function renderTriggerPanel(handle, ctx) {
  const hasAccounts = (ctx.connected_accounts || 0) > 0;

  let html = '<div class="trigger-panel">'
    + '<p class="trigger-intro">Sends immediately and <strong>bypasses</strong> normal scheduling and quiet hours. Use for testing only.</p>'
    + '<div class="trigger-grid">';

  for (let i = 0; i < TRIGGER_TYPES.length; i++) {
    const t = TRIGGER_TYPES[i];
    const disabled = t.requiresAccounts && !hasAccounts;
    html += '<button type="button" class="trigger-btn" id="trigger-' + t.type + '" '
      + (disabled ? 'disabled title="Requires connected accounts"' : '')
      + ' onclick="triggerAutomation(\\'' + handle + '\\', \\'' + t.type + '\\')">'
      + '<span class="trigger-btn-name">' + t.name + '</span>'
      + '<span class="trigger-btn-desc">' + t.desc + (disabled ? ' (needs accounts)' : '') + '</span>'
      + '</button>';
  }

  html += '</div></div>';
  return html;
}

async function triggerAutomation(handle, type) {
  const btn = document.getElementById('trigger-' + type);
  if (!btn) return;

  btn.classList.add('sending');
  btn.disabled = true;

  try {
    const resp = await fetch('/automations/api/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: handle, automation_type: type }),
    });

    const data = await resp.json();

    if (resp.ok && data.success) {
      btn.classList.remove('sending');
      btn.classList.add('sent');
      showToast('Sent ' + (AUTOMATION_TYPES[type]?.label || type) + ' to ' + handle, 'success');

      setTimeout(function () {
        btn.classList.remove('sent');
        btn.disabled = false;
        selectUser(handle);
      }, 2000);
    } else {
      btn.classList.remove('sending');
      btn.classList.add('failed');
      showToast('Failed: ' + (data.error || data.reason || 'Unknown error'), 'error');
      setTimeout(function () { btn.classList.remove('failed'); btn.disabled = false; }, 3000);
    }
  } catch (err) {
    btn.classList.remove('sending');
    btn.classList.add('failed');
    showToast('Network error', 'error');
    setTimeout(function () { btn.classList.remove('failed'); btn.disabled = false; }, 3000);
  }
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  if (days < 7) return days + 'd ago';
  return Math.floor(days / 7) + 'w ago';
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(msg, type) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = msg;
  document.body.appendChild(toast);

  setTimeout(function () { toast.style.opacity = '0'; setTimeout(function () { toast.remove(); }, 300); }, 3000);
}

loadUsers();
</script>

</body>
</html>`;
