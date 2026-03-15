export const comparePageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nest — Model Comparison</title>
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
    --red: #dc2626;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  html, body {
    height: 100%;
    overflow: hidden;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    display: flex;
    flex-direction: column;
  }

  .header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 12px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }

  .header-left { display: flex; align-items: center; gap: 16px; }
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
    text-decoration: none;
  }
  .btn:hover { background: var(--accent-light); }
  .btn-danger { color: var(--red); border-color: var(--red); }
  .btn-danger:hover { background: #fef2f2; }

  .session-badge {
    font-size: 11px;
    color: var(--text-secondary);
    background: var(--accent-light);
    padding: 3px 8px;
    border-radius: 6px;
    font-family: 'SF Mono', 'Menlo', monospace;
  }

  .mode-tabs {
    display: flex;
    align-items: center;
    background: #f3f4f6;
    padding: 2px;
    border-radius: 6px;
    width: fit-content;
  }

  .mode-tab {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 5px 12px;
    font-size: 13px;
    font-weight: 500;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.15s;
  }
  .mode-tab.active { color: var(--text); background: var(--surface); box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
  .mode-tab:not(.active):hover { background: rgba(0,0,0,0.04); }

  .page-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 12px 24px 0;
  }

  /* ── Toolbar row (system prompt toggle + user selector) ── */
  .toolbar-row {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 10px;
    flex-shrink: 0;
  }

  .system-prompt-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-secondary);
    cursor: pointer;
    user-select: none;
    padding: 4px 0;
  }
  .system-prompt-toggle:hover { color: var(--text); }
  .system-prompt-toggle .chevron { transition: transform 0.2s; font-size: 10px; }
  .system-prompt-toggle .chevron.open { transform: rotate(90deg); }

  .user-selector {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .user-selector select {
    padding: 3px 8px;
    font-size: 12px;
    font-family: inherit;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    outline: none;
    cursor: pointer;
    max-width: 260px;
  }
  .user-selector select:focus { border-color: var(--accent); }

  .user-context-badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 6px;
    background: #d1fae5;
    color: #065f46;
    font-weight: 600;
  }

  .system-prompt-area { display: none; margin-bottom: 10px; flex-shrink: 0; }
  .system-prompt-area.visible { display: block; }
  .system-prompt-area textarea {
    width: 100%;
    padding: 10px 14px;
    font-size: 13px;
    font-family: inherit;
    border: 1px solid var(--border);
    border-radius: 6px;
    resize: vertical;
    min-height: 80px;
    max-height: 300px;
    outline: none;
    color: var(--text-secondary);
    background: var(--surface);
  }
  .system-prompt-area textarea:focus { border-color: var(--accent); color: var(--text); }
  .system-prompt-info { font-size: 11px; color: var(--text-secondary); margin-top: 4px; }

  .provider-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .provider-dot.openai { background: #10a37f; }
  .provider-dot.gemini { background: #4285f4; }
  .provider-dot.anthropic { background: #d4a574; }
  .provider-dot.onboard { background: #8b5cf6; }

  .provider-name {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    white-space: nowrap;
  }

  /* ── Dynamic columns ── */
  .columns-container {
    flex: 1;
    display: flex;
    gap: 12px;
    overflow: hidden;
    min-height: 0;
  }

  .compare-column {
    flex: 1;
    min-width: 280px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .col-header {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex-shrink: 0;
  }
  .col-header-top { display: flex; align-items: center; justify-content: space-between; }
  .col-header-left { display: flex; align-items: center; gap: 6px; }
  .col-header-selects { display: flex; gap: 6px; align-items: center; }
  .col-header-selects select {
    padding: 3px 6px;
    font-size: 12px;
    font-family: inherit;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    outline: none;
    cursor: pointer;
  }
  .col-header-selects select:focus { border-color: var(--accent); }

  .col-remove {
    width: 20px; height: 20px;
    border: none; background: none;
    color: var(--text-secondary);
    cursor: pointer; font-size: 14px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 6px; transition: all 0.15s;
  }
  .col-remove:hover { background: #fef2f2; color: var(--red); }

  .msg-count { font-size: 11px; color: var(--text-secondary); font-family: 'SF Mono', 'Menlo', monospace; }

  .column-body { flex: 1; overflow-y: auto; padding: 12px; min-height: 0; }

  .add-column-btn {
    min-width: 48px; max-width: 48px;
    background: var(--surface);
    border: 1px dashed var(--border);
    border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; font-size: 20px; color: var(--text-secondary);
    transition: all 0.15s; flex-shrink: 0;
  }
  .add-column-btn:hover { border-color: var(--accent); color: var(--text); background: var(--accent-light); }

  .message { margin-bottom: 12px; animation: fadeIn 0.2s ease; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

  .message-role { font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 3px; }
  .message-text { font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .message.user .message-text { background: var(--accent-light); padding: 8px 12px; border-radius: 6px; }
  .message.assistant .message-text { padding: 2px 0; }
  .message-meta { margin-top: 4px; font-size: 11px; color: var(--text-secondary); display: flex; gap: 10px; }
  .message-meta .stat-value { font-weight: 600; }
  .message-error { color: var(--red); font-size: 13px; padding: 8px 12px; background: #fef2f2; border-radius: 6px; }

  .loading-indicator { display: flex; align-items: center; gap: 6px; padding: 8px 0; }
  .loading-dots { display: inline-flex; gap: 3px; }
  .loading-dots span { width: 5px; height: 5px; background: var(--text-secondary); border-radius: 50%; animation: dot-pulse 1.2s ease-in-out infinite; }
  .loading-dots span:nth-child(2) { animation-delay: 0.2s; }
  .loading-dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes dot-pulse { 0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); } 40% { opacity: 1; transform: scale(1); } }
  .loading-label { font-size: 11px; color: var(--text-secondary); }

  .empty-state { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-secondary); font-size: 13px; }

  /* ── Input bar — always pinned at bottom ── */
  .input-bar {
    flex-shrink: 0;
    padding: 12px 0 16px;
    background: var(--bg);
  }
  .input-row { display: flex; gap: 10px; align-items: flex-end; }
  .input-wrap { flex: 1; position: relative; }
  .input-wrap textarea {
    width: 100%;
    padding: 12px 14px;
    font-size: 14px;
    font-family: inherit;
    border: 1px solid var(--border);
    border-radius: 6px;
    resize: none;
    min-height: 48px;
    max-height: 120px;
    outline: none;
    transition: border-color 0.15s;
    color: var(--text);
    background: var(--surface);
  }
  .input-wrap textarea:focus { border-color: var(--accent); }
  .btn-send {
    padding: 12px 24px; font-size: 14px; font-weight: 600;
    border-radius: 6px; border: none; background: var(--accent); color: white;
    cursor: pointer; transition: all 0.15s; white-space: nowrap; height: 48px;
  }
  .btn-send:hover { opacity: 0.85; }
  .btn-send:disabled { opacity: 0.4; cursor: not-allowed; }

  /* ── Onboarding mode ── */
  .onboard-layout { flex: 1; display: grid; grid-template-columns: 1fr 300px; gap: 12px; overflow: hidden; min-height: 0; }
  .onboard-columns-area { display: flex; gap: 12px; overflow: hidden; min-height: 0; }
  .onboard-chat { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; display: flex; flex-direction: column; overflow: hidden; }
  .onboard-chat .column-body { flex: 1; overflow-y: auto; padding: 16px; min-height: 0; }
  .onboard-state-panel { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; overflow-y: auto; padding: 16px; }
  .state-section { margin-bottom: 16px; }
  .state-section:last-child { margin-bottom: 0; }
  .state-section-title { font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
  .state-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; font-size: 13px; }
  .state-label { color: var(--text-secondary); }
  .state-value { font-weight: 500; font-family: 'SF Mono', 'Menlo', monospace; font-size: 12px; }
  .state-badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; }
  .state-badge.pending { background: #fef3c7; color: #92400e; }
  .state-badge.sent { background: #d1fae5; color: #065f46; }
  .state-badge.active { background: #dbeafe; color: #1e40af; }
  .onboard-init-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 40px 20px; text-align: center; }
  .onboard-init-state p { font-size: 13px; color: var(--text-secondary); max-width: 300px; }
  .btn-start-session { padding: 10px 20px; font-size: 14px; font-weight: 600; border-radius: 6px; border: none; background: var(--accent); color: white; cursor: pointer; transition: all 0.15s; }
  .btn-start-session:hover { opacity: 0.85; }
  .bubble-separator { display: block; width: 40px; height: 1px; background: var(--border); margin: 6px 0; }

  @media (max-width: 900px) {
    .columns-container { flex-direction: column; }
    .compare-column { min-width: 0; }
    .add-column-btn { min-width: 0; max-width: none; height: 48px; }
    .onboard-layout { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <h1>Nest <span id="pageSubtitle">Model Comparison</span></h1>
    <div class="mode-tabs">
      <button class="mode-tab active" id="tab-compare" onclick="switchMode('compare')">Compare</button>
      <button class="mode-tab" id="tab-onboard" onclick="switchMode('onboard')">Onboarding</button>
    </div>
    <span class="session-badge" id="sessionBadge"></span>
  </div>
  <div class="header-actions">
    <button class="btn btn-danger" id="btnNewConvo" onclick="newConversation()">New Conversation</button>
    <a class="btn" href="/debug">Debug Dashboard</a>
  </div>
</div>

<div class="page-body">
  <!-- ═══ COMPARE MODE ═══ -->
  <div id="compare-mode" style="display:flex; flex-direction:column; flex:1; overflow:hidden;">
    <div class="toolbar-row">
      <div class="system-prompt-toggle" onclick="toggleSystemPrompt()">
        <span class="chevron" id="sysChevron">&#9654;</span>
        <span>System prompt</span>
      </div>
      <div class="user-selector">
        <span>User:</span>
        <select id="userSelect" onchange="onUserChange(this.value)">
          <option value="">None (anonymous)</option>
        </select>
        <span class="user-context-badge" id="userContextBadge" style="display:none;"></span>
      </div>
    </div>
    <div class="system-prompt-area" id="sysPromptArea">
      <textarea id="systemPrompt" placeholder="Loading Nest's default prompt..." rows="6"></textarea>
      <div class="system-prompt-info">Default: Nest's production chat-mode prompt. Edit to override for all columns.</div>
    </div>
    <div class="columns-container" id="columnsContainer"></div>
  </div>

  <!-- ═══ ONBOARDING MODE ═══ -->
  <div id="onboard-mode" style="display:none; flex-direction:column; flex:1; overflow:hidden;">
    <div class="onboard-layout" id="onboardLayout">
      <div class="onboard-columns-area" id="onboardColumnsArea">
        <div style="flex:1; display:flex; align-items:center; justify-content:center; color:var(--text-secondary); font-size:13px;">
          Click "New Session" to start testing onboarding
        </div>
      </div>
      <div class="onboard-state-panel" id="statePanel">
        <div class="state-section">
          <div class="state-section-title">Session</div>
          <div class="state-row"><span class="state-label">Status</span><span class="state-badge pending" id="state-status">No session</span></div>
          <div class="state-row"><span class="state-label">Handle</span><span class="state-value" id="state-handle">-</span></div>
          <div class="state-row"><span class="state-label">Session ID</span><span class="state-value" id="state-sessionId">-</span></div>
        </div>
        <div class="state-section">
          <div class="state-section-title">Onboarding State</div>
          <div class="state-row"><span class="state-label">Turn</span><span class="state-value" id="state-turn">0</span></div>
          <div class="state-row"><span class="state-label">State</span><span class="state-value" id="state-onboardState">-</span></div>
          <div class="state-row"><span class="state-label">Verification</span><span class="state-badge pending" id="state-verification">Not sent</span></div>
        </div>
        <div class="state-section">
          <div class="state-section-title">Experiments</div>
          <div class="state-row"><span class="state-label">Name strategy</span><span class="state-value" id="state-nameVariant">-</span></div>
          <div class="state-row"><span class="state-label">Prompt style</span><span class="state-value" id="state-promptVariant">-</span></div>
        </div>
        <div class="state-section">
          <div class="state-section-title">Verification Link</div>
          <div style="font-size:12px; color:var(--text-secondary); word-break:break-all;" id="state-onboardUrl">-</div>
        </div>
        <div class="state-section">
          <div class="state-section-title">Expected Behaviour</div>
          <div style="font-size:12px; color:var(--text-secondary); line-height:1.5;" id="state-expected">
            <strong>Turn 1:</strong> Sharp opener + extraction question<br>
            <strong>Turn 2:</strong> Entry state classification, show value<br>
            <strong>Turn 3:</strong> Continue showing value, no link yet<br>
            <strong>Turn 4-5:</strong> Verification link MUST appear<br>
            <strong>Turn 6+:</strong> Link can appear naturally if not sent
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="input-bar">
    <div class="input-row">
      <div class="input-wrap">
        <textarea id="prompt" placeholder="Type a message... (Cmd+Enter to send)" rows="1" oninput="autoResize(this)"></textarea>
      </div>
      <button class="btn-send" id="sendBtn" onclick="sendMessage()">Send</button>
    </div>
  </div>
</div>

<script>
const ALL_MODELS = {
  openai: ['gpt-4.1-mini','gpt-4.1','gpt-4.1-nano','gpt-4o','gpt-4o-mini','gpt-5-nano','gpt-5.2','gpt-5.4','o3-mini','o4-mini'],
  gemini: ['gemini-3.1-flash-lite-preview','gemini-2.5-flash','gemini-2.5-pro','gemini-2.0-flash','gemini-2.5-flash-lite','gemini-flash-lite-latest','gemini-2.0-flash-lite','gemini-1.5-pro','gemini-1.5-flash'],
  anthropic: ['claude-sonnet-4-20250514','claude-3-5-sonnet-20241022','claude-3-5-haiku-20241022','claude-3-haiku-20240307','claude-opus-4-20250514'],
  production: ['Full Pipeline (Agent + Tools)'],
};
const PROVIDER_COLORS = { openai: '#10a37f', gemini: '#4285f4', anthropic: '#d4a574', production: '#dc2626' };
const DEFAULT_COLUMNS = [
  { provider: 'gemini', model: 'gemini-3.1-flash-lite-preview' },
  { provider: 'gemini', model: 'gemini-2.5-flash' },
  { provider: 'openai', model: 'gpt-4.1-mini' },
];

let currentMode = 'compare';
let sessionId = generateSessionId();
let isRunning = false;
let defaultSystemPrompt = '';
let userContextBlock = '';
let columns = [];
let colIdCounter = 0;
let onboardSessionId = null;
let onboardColumns = [];
let onboardColIdCounter = 0;

const DEFAULT_ONBOARD_COLUMNS = [
  { provider: 'production', model: 'Full Pipeline (Agent + Tools)' },
  { provider: 'gemini', model: 'gemini-3.1-flash-lite-preview' },
];

function generateSessionId() { return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
function generateColId() { return 'col_' + (colIdCounter++); }

document.getElementById('sessionBadge').textContent = sessionId.slice(0, 16);

fetch('/compare/api/prompt').then(r => r.json()).then(data => {
  defaultSystemPrompt = data.systemPrompt;
  document.getElementById('systemPrompt').value = data.systemPrompt;
}).catch(() => {});

// Load users
fetch('/compare/api/users').then(r => r.json()).then(users => {
  const sel = document.getElementById('userSelect');
  for (const u of users) {
    const opt = document.createElement('option');
    opt.value = u.handle;
    opt.textContent = (u.name || 'Unknown') + ' (' + u.handle + ')';
    sel.appendChild(opt);
  }
}).catch(() => {});

async function onUserChange(handle) {
  const badge = document.getElementById('userContextBadge');
  if (!handle) {
    userContextBlock = '';
    badge.style.display = 'none';
    const sp = document.getElementById('systemPrompt');
    sp.value = defaultSystemPrompt;
    return;
  }
  badge.textContent = 'Loading...';
  badge.style.display = 'inline-block';
  try {
    const resp = await fetch('/compare/api/user-context?handle=' + encodeURIComponent(handle));
    const data = await resp.json();
    if (data.error) { alert(data.error); badge.style.display = 'none'; return; }
    userContextBlock = data.contextBlock || '';

    // Build the full prompt: base + user context + timezone
    let fullPrompt = defaultSystemPrompt + '\\n\\n' + userContextBlock;
    if (data.timezone) {
      const now = new Date();
      const formatted = now.toLocaleString('en-AU', { timeZone: data.timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
      const shortTz = now.toLocaleString('en-AU', { timeZone: data.timezone, timeZoneName: 'short' }).split(' ').pop();
      fullPrompt += '\\n\\nCurrent date and time: ' + formatted + ' ' + shortTz + ' (' + data.timezone + ')';
    }
    const sp = document.getElementById('systemPrompt');
    sp.value = fullPrompt;

    const name = data.profile?.name || handle;
    const parts = [name];
    if (data.accounts?.length) parts.push(data.accounts.length + ' accounts');
    if (data.memoryItems) parts.push(data.memoryItems + ' memories');
    if (data.timezone) parts.push(data.timezone);
    badge.textContent = parts.join(' · ');
  } catch (err) { alert('Failed to load user: ' + err.message); badge.style.display = 'none'; }
}

// ── Column management ──

function addColumn(provider, model) {
  const id = generateColId();
  columns.push({ id, provider, model, msgCount: 0 });
  renderColumns();
  return id;
}

function removeColumn(id) {
  if (columns.length <= 1) return;
  columns = columns.filter(c => c.id !== id);
  renderColumns();
}

function buildModelOptions(provider, selectedModel) {
  return ALL_MODELS[provider].map(m => '<option value="' + m + '"' + (m === selectedModel ? ' selected' : '') + '>' + m + '</option>').join('');
}

function buildProviderOptions(selectedProvider, includeProduction) {
  const providers = ['openai','gemini','anthropic'];
  if (includeProduction) providers.push('production');
  const labels = { openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Anthropic', production: 'Agent (Prod)' };
  return providers.map(p => '<option value="' + p + '"' + (p === selectedProvider ? ' selected' : '') + '>' + (labels[p] || p) + '</option>').join('');
}

function renderColumns() {
  const container = document.getElementById('columnsContainer');
  container.innerHTML = '';
  for (const col of columns) {
    const div = document.createElement('div');
    div.className = 'compare-column';
    div.id = 'wrap-' + col.id;
    const providerColor = PROVIDER_COLORS[col.provider] || '#6b7280';
    div.innerHTML =
      '<div class="col-header">' +
        '<div class="col-header-top">' +
          '<div class="col-header-left">' +
            '<div class="provider-dot" style="background:' + providerColor + '"></div>' +
            '<span class="msg-count" id="count-' + col.id + '">' + col.msgCount + ' msgs</span>' +
          '</div>' +
          (columns.length > 1 ? '<button class="col-remove" onclick="removeColumn(\\'' + col.id + '\\')" title="Remove column">&times;</button>' : '') +
        '</div>' +
        '<div class="col-header-selects">' +
          '<select onchange="onProviderChange(\\'' + col.id + '\\', this.value)" style="width:90px;">' + buildProviderOptions(col.provider, false) + '</select>' +
          '<select id="model-' + col.id + '" onchange="onModelChange(\\'' + col.id + '\\', this.value)" style="flex:1;min-width:0;">' + buildModelOptions(col.provider, col.model) + '</select>' +
        '</div>' +
      '</div>' +
      '<div class="column-body" id="body-' + col.id + '">' +
        '<div class="empty-state">Send a message to begin</div>' +
      '</div>';
    container.appendChild(div);
  }
  const addBtn = document.createElement('div');
  addBtn.className = 'add-column-btn';
  addBtn.onclick = () => addColumn('gemini', 'gemini-3.1-flash-lite-preview');
  addBtn.textContent = '+';
  addBtn.title = 'Add column';
  container.appendChild(addBtn);
}

function onProviderChange(colId, newProvider) {
  const col = columns.find(c => c.id === colId);
  if (!col) return;
  col.provider = newProvider;
  col.model = ALL_MODELS[newProvider][0];
  renderColumns();
}

function onModelChange(colId, newModel) {
  const col = columns.find(c => c.id === colId);
  if (!col) return;
  col.model = newModel;
}

DEFAULT_COLUMNS.forEach(c => addColumn(c.provider, c.model));

// ── Mode switching ──

function switchMode(mode) {
  currentMode = mode;
  document.getElementById('tab-compare').classList.toggle('active', mode === 'compare');
  document.getElementById('tab-onboard').classList.toggle('active', mode === 'onboard');
  const compareEl = document.getElementById('compare-mode');
  const onboardEl = document.getElementById('onboard-mode');
  if (mode === 'compare') {
    compareEl.style.display = 'flex';
    onboardEl.style.display = 'none';
    document.getElementById('pageSubtitle').textContent = 'Model Comparison';
    document.getElementById('btnNewConvo').textContent = 'New Conversation';
    document.getElementById('prompt').placeholder = 'Type a message... (Cmd+Enter to send)';
  } else {
    compareEl.style.display = 'none';
    onboardEl.style.display = 'flex';
    document.getElementById('pageSubtitle').textContent = 'Onboarding Test';
    document.getElementById('btnNewConvo').textContent = 'New Session';
    document.getElementById('prompt').placeholder = onboardSessionId ? 'Type a message as a new user...' : 'Start a session first...';
  }
}

// ── Helpers ──

function toggleSystemPrompt() {
  document.getElementById('sysPromptArea').classList.toggle('visible');
  document.getElementById('sysChevron').classList.toggle('open');
}

function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }

function escapeHtml(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }

function formatBubbles(text) {
  const parts = text.split(/\\n---\\n|\\n---$|^---\\n|\\s+---\\s+|\\s+---$|^---\\s+/);
  if (parts.length <= 1) return escapeHtml(text);
  return parts.map(p => p.trim()).filter(p => p).map(p => escapeHtml(p)).join('<span class="bubble-separator"></span>');
}

// ── Compare message functions ──

function addUserMsg(colId, text) {
  const body = document.getElementById('body-' + colId); if (!body) return;
  if (body.querySelector('.empty-state')) body.innerHTML = '';
  const div = document.createElement('div'); div.className = 'message user';
  div.innerHTML = '<div class="message-role">You</div><div class="message-text">' + escapeHtml(text) + '</div>';
  body.appendChild(div); body.scrollTop = body.scrollHeight;
}

function addLoading(colId) {
  const body = document.getElementById('body-' + colId); if (!body) return;
  const div = document.createElement('div'); div.className = 'loading-indicator'; div.id = 'loading-' + colId;
  div.innerHTML = '<div class="loading-dots"><span></span><span></span><span></span></div><span class="loading-label">thinking...</span>';
  body.appendChild(div); body.scrollTop = body.scrollHeight;
}

function removeLoading(colId) { const el = document.getElementById('loading-' + colId); if (el) el.remove(); }

function addAssistantMsg(colId, modelName, text, latencyMs, tokens) {
  const body = document.getElementById('body-' + colId); if (!body) return;
  const div = document.createElement('div'); div.className = 'message assistant';
  let meta = '<div class="message-meta"><span><span class="stat-value">' + latencyMs + 'ms</span></span>';
  if (tokens) meta += '<span><span class="stat-value">' + tokens + '</span> tokens</span>';
  meta += '</div>';
  div.innerHTML = '<div class="message-role">' + escapeHtml(modelName) + '</div><div class="message-text">' + escapeHtml(text) + '</div>' + meta;
  body.appendChild(div); body.scrollTop = body.scrollHeight;
  const col = columns.find(c => c.id === colId);
  if (col) { col.msgCount += 2; const ce = document.getElementById('count-' + colId); if (ce) ce.textContent = col.msgCount + ' msgs'; }
}

function addErrorMsg(colId, error) {
  const body = document.getElementById('body-' + colId); if (!body) return;
  const div = document.createElement('div'); div.className = 'message';
  div.innerHTML = '<div class="message-error">' + escapeHtml(error) + '</div>';
  body.appendChild(div); body.scrollTop = body.scrollHeight;
}

// ── Onboarding column management ──

function generateOnboardColId() { return 'ob_' + (onboardColIdCounter++); }

function addOnboardColumn(provider, model) {
  const id = generateOnboardColId();
  onboardColumns.push({ id, provider, model, msgCount: 0 });
  renderOnboardColumns();
  return id;
}

function removeOnboardColumn(id) {
  if (onboardColumns.length <= 1) return;
  onboardColumns = onboardColumns.filter(c => c.id !== id);
  renderOnboardColumns();
}

function onOnboardProviderChange(colId, newProvider) {
  const col = onboardColumns.find(c => c.id === colId);
  if (!col) return;
  col.provider = newProvider;
  col.model = ALL_MODELS[newProvider][0];
  renderOnboardColumns();
}

function onOnboardModelChange(colId, newModel) {
  const col = onboardColumns.find(c => c.id === colId);
  if (!col) return;
  col.model = newModel;
}

function renderOnboardColumns() {
  const container = document.getElementById('onboardColumnsArea');
  container.innerHTML = '';
  for (const col of onboardColumns) {
    const div = document.createElement('div');
    div.className = 'compare-column';
    div.id = 'wrap-ob-' + col.id;
    div.style.flex = '1';
    div.style.minWidth = '280px';
    const providerColor = PROVIDER_COLORS[col.provider] || '#8b5cf6';
    div.innerHTML =
      '<div class="col-header">' +
        '<div class="col-header-top">' +
          '<div class="col-header-left">' +
            '<div class="provider-dot" style="background:' + providerColor + '"></div>' +
            '<span class="msg-count" id="count-ob-' + col.id + '">' + col.msgCount + ' msgs</span>' +
          '</div>' +
          (onboardColumns.length > 1 ? '<button class="col-remove" onclick="removeOnboardColumn(\\'' + col.id + '\\')" title="Remove column">&times;</button>' : '') +
        '</div>' +
        '<div class="col-header-selects">' +
          '<select onchange="onOnboardProviderChange(\\'' + col.id + '\\', this.value)" style="width:90px;">' + buildProviderOptions(col.provider, true) + '</select>' +
          '<select id="ob-model-' + col.id + '" onchange="onOnboardModelChange(\\'' + col.id + '\\', this.value)" style="flex:1;min-width:0;"' + (col.provider === 'production' ? ' disabled' : '') + '>' + buildModelOptions(col.provider, col.model) + '</select>' +
        '</div>' +
      '</div>' +
      '<div class="column-body" id="body-ob-' + col.id + '">' +
        (onboardSessionId ? '<div class="empty-state">Send your first message as a new user</div>' : '<div class="empty-state">Click "New Session" to start</div>') +
      '</div>';
    container.appendChild(div);
  }
  const addBtn = document.createElement('div');
  addBtn.className = 'add-column-btn';
  addBtn.onclick = () => addOnboardColumn('gemini', 'gemini-3.1-flash-lite-preview');
  addBtn.textContent = '+';
  addBtn.title = 'Add column';
  container.appendChild(addBtn);
}

async function startOnboardSession() {
  try {
    const resp = await fetch('/compare/api/onboard/new', { method: 'POST' });
    const data = await resp.json();
    if (data.error) { alert('Failed: ' + data.error); return; }
    onboardSessionId = data.sessionId;
    document.getElementById('sessionBadge').textContent = data.sessionId.slice(0, 20);
    document.getElementById('prompt').placeholder = 'Type a message as a new user...';

    // Reset all column message areas
    onboardColumns.forEach(col => {
      col.msgCount = 0;
      const body = document.getElementById('body-ob-' + col.id);
      if (body) body.innerHTML = '<div class="empty-state">Send your first message as a new user</div>';
      const ce = document.getElementById('count-ob-' + col.id);
      if (ce) ce.textContent = '0 msgs';
    });

    document.getElementById('state-status').textContent = 'Active'; document.getElementById('state-status').className = 'state-badge active';
    document.getElementById('state-handle').textContent = data.handle;
    document.getElementById('state-sessionId').textContent = data.sessionId.slice(0, 20);
    document.getElementById('state-turn').textContent = '0';
    document.getElementById('state-onboardState').textContent = 'new_user_unclassified';
    document.getElementById('state-verification').textContent = 'Not sent'; document.getElementById('state-verification').className = 'state-badge pending';
    document.getElementById('state-nameVariant').textContent = data.experimentVariants?.name_first_vs_value_first || '-';
    document.getElementById('state-promptVariant').textContent = data.experimentVariants?.open_vs_guided || '-';
    document.getElementById('state-onboardUrl').textContent = data.onboardUrl;
    document.getElementById('prompt').focus();
  } catch (err) { alert('Failed: ' + err.message); }
}

function addOnboardUserMsg(colId, text) {
  const body = document.getElementById('body-ob-' + colId);
  if (!body) return;
  if (body.querySelector('.empty-state')) body.innerHTML = '';
  const div = document.createElement('div'); div.className = 'message user';
  div.innerHTML = '<div class="message-role">You (new user)</div><div class="message-text">' + escapeHtml(text) + '</div>';
  body.appendChild(div); body.scrollTop = body.scrollHeight;
}

function addOnboardAssistantMsg(colId, modelName, text, latencyMs, tokens, turnNumber) {
  const body = document.getElementById('body-ob-' + colId);
  if (!body) return;
  const div = document.createElement('div'); div.className = 'message assistant';
  let meta = '<div class="message-meta"><span>Turn <span class="stat-value">' + turnNumber + '</span></span>';
  meta += '<span><span class="stat-value">' + latencyMs + 'ms</span></span>';
  if (tokens) meta += '<span><span class="stat-value">' + tokens + '</span> tokens</span>';
  meta += '</div>';
  div.innerHTML = '<div class="message-role">' + escapeHtml(modelName) + '</div><div class="message-text">' + formatBubbles(text) + '</div>' + meta;
  body.appendChild(div); body.scrollTop = body.scrollHeight;
  const col = onboardColumns.find(c => c.id === colId);
  if (col) { col.msgCount += 2; const ce = document.getElementById('count-ob-' + colId); if (ce) ce.textContent = col.msgCount + ' msgs'; }
}

function addOnboardErrorMsg(colId, error) {
  const body = document.getElementById('body-ob-' + colId);
  if (!body) return;
  const div = document.createElement('div'); div.className = 'message';
  div.innerHTML = '<div class="message-error">' + escapeHtml(error) + '</div>';
  body.appendChild(div); body.scrollTop = body.scrollHeight;
}

function updateStatePanel(data) {
  document.getElementById('state-turn').textContent = data.turnNumber || '0';
  document.getElementById('state-onboardState').textContent = data.onboardState || '-';
  if (data.verificationSent) { document.getElementById('state-verification').textContent = 'Sent'; document.getElementById('state-verification').className = 'state-badge sent'; }
  if (data.experimentVariants) {
    document.getElementById('state-nameVariant').textContent = data.experimentVariants.name_first_vs_value_first || '-';
    document.getElementById('state-promptVariant').textContent = data.experimentVariants.open_vs_guided || '-';
  }
  const expectedEl = document.getElementById('state-expected');
  const turn = data.turnNumber || 0;
  const lines = [
    { t: 1, label: 'Turn 1', desc: 'Sharp opener + extraction question' },
    { t: 2, label: 'Turn 2', desc: 'Entry state classification, show value' },
    { t: 3, label: 'Turn 3', desc: 'Continue showing value, no link yet' },
    { t: 45, label: 'Turn 4-5', desc: 'Verification link MUST appear' },
    { t: 6, label: 'Turn 6+', desc: 'Link can appear naturally if not sent' },
  ];
  let html = '';
  for (const line of lines) {
    const isActive = (line.t === turn) || (line.t === 45 && (turn === 4 || turn === 5)) || (line.t === 6 && turn >= 6);
    html += '<div style="' + (isActive ? 'color:var(--text);font-weight:600;' : '') + 'margin-bottom:4px;"><strong>' + line.label + ':</strong> ' + line.desc + '</div>';
  }
  expectedEl.innerHTML = html;
}

// Initialise default onboard columns
DEFAULT_ONBOARD_COLUMNS.forEach(c => addOnboardColumn(c.provider, c.model));

// ── Unified send ──

async function sendMessage() {
  const textarea = document.getElementById('prompt');
  const prompt = textarea.value.trim();
  if (!prompt || isRunning) return;
  if (currentMode === 'onboard') { await sendOnboardMessage(prompt); } else { await sendCompareMessage(prompt); }
}

async function sendCompareMessage(prompt) {
  isRunning = true;
  const btn = document.getElementById('sendBtn'); btn.disabled = true; btn.textContent = 'Sending...';
  document.getElementById('prompt').value = ''; document.getElementById('prompt').style.height = 'auto';
  const systemPrompt = document.getElementById('systemPrompt').value.trim() || undefined;
  columns.forEach(col => { addUserMsg(col.id, prompt); addLoading(col.id); });
  const promises = columns.map(async (col) => {
    try {
      const resp = await fetch('/compare/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, systemPrompt, provider: col.provider, model: col.model, sessionId, columnId: col.id }),
      });
      const data = await resp.json();
      removeLoading(col.id);
      if (data.error) { addErrorMsg(col.id, data.error); } else { addAssistantMsg(col.id, col.model, data.text, data.latencyMs, data.tokens); }
    } catch (err) { removeLoading(col.id); addErrorMsg(col.id, 'Request failed: ' + err.message); }
  });
  await Promise.all(promises);
  isRunning = false; btn.disabled = false; btn.textContent = 'Send'; document.getElementById('prompt').focus();
}

async function sendOnboardMessage(prompt) {
  if (!onboardSessionId) { await startOnboardSession(); if (!onboardSessionId) return; }
  isRunning = true;
  const btn = document.getElementById('sendBtn'); btn.disabled = true; btn.textContent = 'Sending...';
  document.getElementById('prompt').value = ''; document.getElementById('prompt').style.height = 'auto';

  onboardColumns.forEach(col => { addOnboardUserMsg(col.id, prompt); addLoading('ob-' + col.id); });

  const promises = onboardColumns.map(async (col) => {
    try {
      const isAgent = col.provider === 'production';
      const endpoint = isAgent ? '/compare/api/onboard/agent-chat' : '/compare/api/onboard/chat';
      const payload = isAgent
        ? { sessionId: onboardSessionId, message: prompt, columnId: col.id }
        : { sessionId: onboardSessionId, message: prompt, provider: col.provider, model: col.model, columnId: col.id };
      const resp = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      removeLoading('ob-' + col.id);
      if (data.error) {
        addOnboardErrorMsg(col.id, data.error);
      } else {
        const displayModel = isAgent ? (data.model || 'production') + ' (agent)' : col.model;
        let extraMeta = '';
        if (isAgent && data.toolCalls && data.toolCalls.length > 0) {
          extraMeta = ' | tools: ' + data.toolCalls.map(t => t.name).join(', ');
        }
        if (isAgent && data.agentLoopRounds) {
          extraMeta += ' | rounds: ' + data.agentLoopRounds;
        }
        addOnboardAssistantMsg(col.id, displayModel + extraMeta, data.text, data.latencyMs, data.tokens, data.turnNumber);
        updateStatePanel(data);
      }
    } catch (err) {
      removeLoading('ob-' + col.id);
      addOnboardErrorMsg(col.id, 'Request failed: ' + err.message);
    }
  });

  await Promise.all(promises);
  isRunning = false; btn.disabled = false; btn.textContent = 'Send'; document.getElementById('prompt').focus();
}

function newConversation() {
  if (currentMode === 'onboard') { onboardSessionId = null; startOnboardSession(); return; }
  fetch('/compare/api/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) }).catch(() => {});
  sessionId = generateSessionId();
  document.getElementById('sessionBadge').textContent = sessionId.slice(0, 16);
  columns.forEach(col => {
    col.msgCount = 0;
    const body = document.getElementById('body-' + col.id); if (body) body.innerHTML = '<div class="empty-state">Send a message to begin</div>';
    const ce = document.getElementById('count-' + col.id); if (ce) ce.textContent = '0 msgs';
  });
}

document.getElementById('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMessage(); }
  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); sendMessage(); }
});
</script>
</body>
</html>`;
