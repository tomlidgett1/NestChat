export const comparePageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nest — Model Comparison</title>
<style>
  :root {
    --bg: #0a0a0a;
    --surface: #1a1a1a;
    --border: rgba(255,255,255,0.08);
    --text: #f5f5f5;
    --text-secondary: #888;
    --accent: #007AFF;
    --green: #34C759;
    --red: #FF3B30;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    display: flex;
    flex-direction: column;
  }

  /* -- Header -- */
  .header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 10px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }
  .header-left { display: flex; align-items: center; gap: 16px; }
  .header h1 { font-size: 16px; font-weight: 600; }
  .header h1 span { color: var(--text-secondary); font-weight: 400; margin-left: 8px; }
  .header-actions { display: flex; gap: 8px; align-items: center; }

  .mode-tabs {
    display: flex; align-items: center;
    background: rgba(255,255,255,0.06); padding: 2px; border-radius: 8px;
  }
  .mode-tab {
    padding: 5px 14px; font-size: 13px; font-weight: 500; border-radius: 6px;
    border: none; background: transparent; color: var(--text-secondary);
    cursor: pointer; transition: all 0.15s;
  }
  .mode-tab.active { color: var(--text); background: rgba(255,255,255,0.1); }
  .mode-tab:not(.active):hover { background: rgba(255,255,255,0.04); }

  .btn {
    padding: 6px 14px; font-size: 13px; font-weight: 500; border-radius: 8px;
    border: 1px solid var(--border); background: var(--surface); color: var(--text);
    cursor: pointer; transition: all 0.15s; text-decoration: none;
  }
  .btn:hover { background: rgba(255,255,255,0.08); }
  .btn-danger { color: var(--red); border-color: rgba(255,59,48,0.3); }
  .btn-danger:hover { background: rgba(255,59,48,0.1); }

  .session-badge {
    font-size: 11px; color: var(--text-secondary);
    background: rgba(255,255,255,0.06); padding: 3px 8px; border-radius: 6px;
    font-family: 'SF Mono', 'Menlo', monospace;
  }

  /* -- Page body -- */
  .page-body {
    flex: 1; display: flex; flex-direction: column; overflow: hidden;
    padding: 16px 24px 0;
  }

  /* -- Toolbar -- */
  .toolbar-row {
    display: flex; align-items: center; gap: 16px; margin-bottom: 12px; flex-shrink: 0;
  }
  .system-prompt-toggle {
    display: flex; align-items: center; gap: 6px; font-size: 12px;
    color: var(--text-secondary); cursor: pointer; user-select: none;
  }
  .system-prompt-toggle:hover { color: var(--text); }
  .system-prompt-toggle .chevron { transition: transform 0.2s; font-size: 10px; }
  .system-prompt-toggle .chevron.open { transform: rotate(90deg); }

  .user-selector { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); }
  .user-selector select {
    padding: 4px 8px; font-size: 12px; font-family: inherit;
    border: 1px solid var(--border); border-radius: 6px;
    background: var(--surface); color: var(--text); outline: none; cursor: pointer; max-width: 260px;
  }
  .user-context-badge {
    font-size: 10px; padding: 2px 6px; border-radius: 6px;
    background: rgba(52,199,89,0.15); color: #34C759; font-weight: 600;
  }

  .system-prompt-area { display: none; margin-bottom: 10px; flex-shrink: 0; }
  .system-prompt-area.visible { display: block; }
  .system-prompt-area textarea {
    width: 100%; padding: 10px 14px; font-size: 13px; font-family: inherit;
    border: 1px solid var(--border); border-radius: 8px; resize: vertical;
    min-height: 80px; max-height: 200px; outline: none;
    color: var(--text-secondary); background: var(--surface);
  }
  .system-prompt-area textarea:focus { border-color: var(--accent); color: var(--text); }
  .system-prompt-info { font-size: 11px; color: var(--text-secondary); margin-top: 4px; }

  /* -- Main content area with optional detail panel -- */
  .content-with-panel {
    flex: 1; display: flex; overflow: hidden; min-height: 0; gap: 0;
  }
  .content-main {
    flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0;
  }

  /* -- iPhone columns -- */
  .phones-container {
    flex: 1; display: flex; gap: 20px; overflow: hidden; min-height: 0;
    justify-content: center; align-items: stretch; padding-bottom: 8px;
  }

  .phone-wrapper {
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    min-width: 0;
  }

  /* Provider/model selectors above phone */
  .phone-selectors {
    display: flex; gap: 6px; align-items: center; flex-shrink: 0;
  }
  .phone-selectors select {
    padding: 4px 8px; font-size: 11px; font-family: inherit;
    border: 1px solid var(--border); border-radius: 6px;
    background: var(--surface); color: var(--text); outline: none; cursor: pointer;
  }
  .phone-selectors select:disabled { opacity: 0.4; }
  .phone-remove {
    width: 20px; height: 20px; border: none; background: none;
    color: var(--text-secondary); cursor: pointer; font-size: 14px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 6px; transition: all 0.15s;
  }
  .phone-remove:hover { background: rgba(255,59,48,0.15); color: var(--red); }

  /* iPhone frame */
  .iphone-frame {
    width: 320px; flex: 1; min-height: 0;
    background: #000; border-radius: 44px;
    border: 3px solid #333;
    display: flex; flex-direction: column; overflow: hidden;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05);
    position: relative;
  }

  /* Dynamic island */
  .dynamic-island {
    position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
    width: 100px; height: 28px; background: #000; border-radius: 20px; z-index: 10;
  }

  /* iOS status bar */
  .ios-status-bar {
    flex-shrink: 0; display: flex; align-items: center; justify-content: space-between;
    padding: 16px 24px 4px; background: #F2F2F7; position: relative; z-index: 5;
  }
  .ios-time { font-size: 14px; font-weight: 600; color: #000; letter-spacing: -0.2px; }
  .ios-icons { display: flex; gap: 5px; align-items: center; }
  .ios-icons svg { height: 11px; width: auto; }

  /* iMessage header */
  .imessage-header {
    flex-shrink: 0; background: #F2F2F7; border-bottom: 0.5px solid rgba(0,0,0,0.12);
    padding: 6px 12px 8px; display: flex; flex-direction: column; align-items: center;
  }
  .imessage-header-row { display: flex; align-items: center; width: 100%; }
  .imessage-back {
    display: flex; align-items: center; gap: 2px; width: 40px;
  }
  .imessage-back svg { width: 10px; height: 17px; }
  .imessage-avatar-wrap { flex: 1; display: flex; justify-content: center; }
  .imessage-avatar {
    width: 32px; height: 32px; border-radius: 50%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: 600; color: white;
  }
  .imessage-facetime { width: 40px; display: flex; justify-content: flex-end; }
  .imessage-name { font-size: 11px; color: #000; font-weight: 400; margin-top: 2px; }

  /* Message area */
  .imessage-body {
    flex: 1; overflow-y: auto; padding: 12px 12px 16px;
    background: #FFFFFF; min-height: 0;
  }

  .imessage-body::-webkit-scrollbar { width: 0; }

  .msg-row { margin-bottom: 4px; display: flex; }
  .msg-row.user { justify-content: flex-end; }
  .msg-row.assistant { justify-content: flex-start; }

  .msg-bubble {
    max-width: 78%; padding: 8px 14px; font-size: 15px; line-height: 1.4;
    word-break: break-word; white-space: pre-wrap; cursor: pointer;
    transition: opacity 0.15s;
  }
  .msg-bubble:hover { opacity: 0.85; }
  .msg-bubble.selected { outline: 2px solid var(--accent); outline-offset: 2px; }
  .msg-bubble.user {
    background: #007AFF; color: white;
    border-radius: 18px 18px 4px 18px;
  }
  .msg-bubble.assistant {
    background: #E9E9EB; color: #000;
    border-radius: 18px 18px 18px 4px;
  }
  /* Consecutive assistant bubbles get tighter spacing */
  .msg-row.assistant + .msg-row.assistant { margin-top: -2px; }
  .msg-row.assistant + .msg-row.assistant .msg-bubble.assistant {
    border-radius: 18px 18px 18px 4px;
  }

  .msg-meta {
    display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; padding: 0 4px;
    font-size: 10px; color: #999;
  }
  .msg-meta .val { font-weight: 600; color: #bbb; }

  /* Typing indicator */
  .typing-row { display: flex; align-items: flex-end; gap: 4px; margin-bottom: 4px; }
  .typing-dots {
    display: flex; align-items: center; gap: 4px;
    background: #E9E9EB; border-radius: 18px; padding: 10px 16px;
  }
  .typing-dots span {
    width: 6px; height: 6px; background: #999; border-radius: 50%;
    animation: tdot 1.2s ease-in-out infinite;
  }
  .typing-dots span:nth-child(2) { animation-delay: 0.2s; }
  .typing-dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes tdot { 0%,80%,100% { opacity: 0.3; transform: scale(0.8); } 40% { opacity: 1; transform: scale(1); } }

  /* Bottom fake input */
  .imessage-input-bar {
    flex-shrink: 0; background: #F2F2F7; border-top: 0.5px solid rgba(0,0,0,0.12);
    padding: 8px 12px 26px; display: flex; align-items: center; gap: 8px;
  }
  .imessage-fake-input {
    flex: 1; background: #fff; border: 0.5px solid rgba(0,0,0,0.12);
    border-radius: 20px; padding: 8px 14px; font-size: 14px; color: #C7C7CC;
  }
  .imessage-send-icon {
    width: 30px; height: 30px; border-radius: 50%;
    background: #007AFF; display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; opacity: 0.3;
  }
  .imessage-send-icon svg { width: 14px; height: 14px; }

  /* Add phone button */
  .add-phone-btn {
    width: 60px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
    border: 1px dashed var(--border); border-radius: 44px;
    cursor: pointer; color: var(--text-secondary); font-size: 24px;
    transition: all 0.15s; min-height: 400px; align-self: center;
  }
  .add-phone-btn:hover { border-color: rgba(255,255,255,0.2); color: var(--text); background: rgba(255,255,255,0.03); }

  /* -- Detail Panel (right side) -- */
  .detail-panel {
    width: 0; overflow: hidden; transition: width 0.25s ease;
    border-left: 1px solid var(--border); background: var(--surface);
    flex-shrink: 0; display: flex; flex-direction: column;
  }
  .detail-panel.open { width: 380px; }
  .detail-panel-header {
    padding: 12px 16px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;
  }
  .detail-panel-header h3 { font-size: 13px; font-weight: 600; }
  .detail-panel-close {
    width: 24px; height: 24px; border: none; background: none; color: var(--text-secondary);
    cursor: pointer; font-size: 16px; border-radius: 6px; display: flex; align-items: center; justify-content: center;
  }
  .detail-panel-close:hover { background: rgba(255,255,255,0.08); color: var(--text); }
  .detail-panel-header-actions { display: flex; align-items: center; gap: 6px; }
  .detail-copy-json {
    padding: 4px 10px; font-size: 11px; font-weight: 500; border-radius: 6px;
    border: 1px solid var(--border); background: transparent; color: var(--text-secondary);
    cursor: pointer; transition: all 0.15s; font-family: 'SF Mono', 'Menlo', monospace;
    display: flex; align-items: center; gap: 4px;
  }
  .detail-copy-json:hover { background: rgba(255,255,255,0.08); color: var(--text); border-color: rgba(255,255,255,0.15); }
  .detail-copy-json.copied { background: rgba(52,199,89,0.15); color: #34C759; border-color: rgba(52,199,89,0.3); }
  .detail-panel-body {
    flex: 1; overflow-y: auto; padding: 16px;
  }
  .detail-section { margin-bottom: 16px; }
  .detail-section:last-child { margin-bottom: 0; }
  .detail-section-title {
    font-size: 10px; font-weight: 700; color: var(--text-secondary);
    text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px;
  }
  .detail-row {
    display: flex; justify-content: space-between; align-items: flex-start;
    padding: 4px 0; font-size: 13px;
  }
  .detail-label { color: var(--text-secondary); flex-shrink: 0; margin-right: 12px; }
  .detail-value {
    font-weight: 500; font-family: 'SF Mono', 'Menlo', monospace; font-size: 12px;
    text-align: right; word-break: break-all;
  }
  .detail-badge {
    display: inline-block; padding: 2px 8px; border-radius: 6px;
    font-size: 11px; font-weight: 600;
  }
  .detail-badge.route { background: rgba(37,99,235,0.15); color: #60a5fa; }
  .detail-badge.agent { background: rgba(139,92,246,0.15); color: #a78bfa; }
  .detail-badge.tool { background: rgba(52,199,89,0.15); color: #34C759; }
  .detail-tools-list {
    display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;
  }
  .detail-tool-tag {
    padding: 2px 8px; border-radius: 6px; font-size: 11px;
    background: rgba(255,255,255,0.06); color: var(--text-secondary);
    font-family: 'SF Mono', 'Menlo', monospace;
  }
  .detail-tool-tag.used { background: rgba(52,199,89,0.15); color: #34C759; }
  .detail-full-text {
    font-size: 13px; line-height: 1.6; white-space: pre-wrap;
    word-break: break-word; color: var(--text);
    background: rgba(255,255,255,0.04); padding: 10px 12px;
    border-radius: 8px; max-height: 300px; overflow-y: auto;
  }
  .detail-system-prompt {
    font-size: 11px; line-height: 1.5; white-space: pre-wrap;
    word-break: break-word; color: var(--text-secondary);
    background: rgba(255,255,255,0.03); padding: 10px 12px;
    border-radius: 8px; max-height: 200px; overflow-y: auto;
    font-family: 'SF Mono', 'Menlo', monospace;
  }
  .detail-tool-card {
    background: rgba(255,255,255,0.04); border: 1px solid var(--border);
    border-radius: 8px; padding: 10px 12px; margin-top: 6px;
  }
  .detail-tool-card-name {
    font-size: 12px; font-weight: 600; font-family: 'SF Mono', 'Menlo', monospace;
    display: flex; align-items: center; gap: 6px; margin-bottom: 4px;
  }
  .detail-tool-outcome {
    display: inline-block; width: 7px; height: 7px; border-radius: 50%;
  }
  .detail-tool-outcome.success { background: var(--green); }
  .detail-tool-outcome.error { background: var(--red); }
  .detail-tool-outcome.timeout { background: #d97706; }
  .detail-kv { display: flex; gap: 6px; padding: 2px 0; font-size: 11px; }
  .detail-kv-key { color: var(--text-secondary); min-width: 70px; flex-shrink: 0; }
  .detail-kv-val { color: var(--text); font-family: 'SF Mono', 'Menlo', monospace; font-size: 11px; word-break: break-all; }
  .detail-stats-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 4px;
  }
  .detail-stat-box {
    background: rgba(255,255,255,0.04); border-radius: 6px; padding: 8px 10px;
  }
  .detail-stat-label { font-size: 10px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
  .detail-stat-value { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .detail-stat-unit { font-size: 11px; font-weight: 400; color: var(--text-secondary); }
  .detail-ns-list { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .detail-ns-tag {
    font-size: 10px; padding: 2px 6px; border-radius: 4px;
    background: rgba(255,255,255,0.06); color: var(--text-secondary);
    font-family: 'SF Mono', 'Menlo', monospace;
  }
  .detail-section-toggle {
    cursor: pointer; user-select: none; display: flex; align-items: center; gap: 6px;
  }
  .detail-section-toggle:hover .detail-section-title { color: var(--text); }
  .detail-toggle-chevron { font-size: 10px; transition: transform 0.2s; color: var(--text-secondary); }
  .detail-toggle-chevron.open { transform: rotate(90deg); }
  .detail-collapsible { display: none; }
  .detail-collapsible.open { display: block; }

  /* -- Onboard state panel -- */
  .onboard-state-sidebar {
    width: 280px; flex-shrink: 0; overflow-y: auto; padding: 16px;
    border-left: 1px solid var(--border); background: var(--surface);
  }
  .state-section { margin-bottom: 16px; }
  .state-section:last-child { margin-bottom: 0; }
  .state-section-title { font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
  .state-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; font-size: 13px; }
  .state-label { color: var(--text-secondary); }
  .state-value { font-weight: 500; font-family: 'SF Mono', 'Menlo', monospace; font-size: 12px; }
  .state-badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; }
  .state-badge.pending { background: rgba(217,119,6,0.15); color: #d97706; }
  .state-badge.sent { background: rgba(52,199,89,0.15); color: #34C759; }
  .state-badge.active { background: rgba(37,99,235,0.15); color: #60a5fa; }

  /* -- Input bar -- */
  .input-bar { flex-shrink: 0; padding: 10px 0 14px; }
  .input-row { display: flex; gap: 10px; align-items: flex-end; }
  .input-wrap { flex: 1; position: relative; }
  .input-wrap textarea {
    width: 100%; padding: 12px 16px; font-size: 14px; font-family: inherit;
    border: 1px solid var(--border); border-radius: 10px; resize: none;
    min-height: 48px; max-height: 120px; outline: none; transition: border-color 0.15s;
    color: var(--text); background: var(--surface);
  }
  .input-wrap textarea:focus { border-color: var(--accent); }
  .btn-send {
    padding: 12px 24px; font-size: 14px; font-weight: 600;
    border-radius: 10px; border: none; background: var(--accent); color: white;
    cursor: pointer; transition: all 0.15s; white-space: nowrap; height: 48px;
  }
  .btn-send:hover { opacity: 0.85; }
  .btn-send:disabled { opacity: 0.4; cursor: not-allowed; }

  @media (max-width: 1100px) {
    .iphone-frame { width: 280px; border-radius: 36px; }
    .dynamic-island { width: 80px; height: 24px; top: 8px; }
    .detail-panel.open { width: 320px; }
    .onboard-state-sidebar { width: 240px; }
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
  <!-- COMPARE MODE -->
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
    <div class="content-with-panel">
      <div class="content-main">
        <div class="phones-container" id="phonesContainer"></div>
      </div>
      <div class="detail-panel" id="detailPanel">
        <div class="detail-panel-header">
          <h3>Message Details</h3>
          <div class="detail-panel-header-actions">
            <button class="detail-copy-json" onclick="copyDetailJson()" id="copyJsonBtn" title="Copy full debug data as JSON">&#x2398; JSON</button>
            <button class="detail-panel-close" onclick="closeDetailPanel()">&times;</button>
          </div>
        </div>
        <div class="detail-panel-body" id="detailPanelBody"></div>
      </div>
    </div>
  </div>

  <!-- ONBOARDING MODE -->
  <div id="onboard-mode" style="display:none; flex-direction:column; flex:1; overflow:hidden;">
    <div class="content-with-panel" style="flex:1;">
      <div class="content-main">
        <div class="phones-container" id="onboardPhonesContainer">
          <div style="flex:1; display:flex; align-items:center; justify-content:center; color:var(--text-secondary); font-size:13px;">
            Click "New Session" to start testing onboarding
          </div>
        </div>
      </div>
      <div class="onboard-state-sidebar" id="statePanel">
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
      <div class="detail-panel" id="onboardDetailPanel">
        <div class="detail-panel-header">
          <h3>Message Details</h3>
          <div class="detail-panel-header-actions">
            <button class="detail-copy-json" onclick="copyDetailJson()" title="Copy full debug data as JSON">&#x2398; JSON</button>
            <button class="detail-panel-close" onclick="closeDetailPanel()">&times;</button>
          </div>
        </div>
        <div class="detail-panel-body" id="onboardDetailPanelBody"></div>
      </div>
    </div>
  </div>

  <div class="input-bar">
    <div class="input-row">
      <div class="input-wrap">
        <textarea id="prompt" placeholder="Type a message... (Enter to send)" rows="1" oninput="autoResize(this); autoCapitalize(this)" autocapitalize="sentences"></textarea>
      </div>
      <button class="btn-send" id="sendBtn" onclick="sendMessage()">Send</button>
    </div>
  </div>
</div>

<script>
const MAX_PHONES = 3;
const ALL_MODELS = {
  openai: ['gpt-4.1-mini','gpt-4.1','gpt-4.1-nano','gpt-4o','gpt-4o-mini','gpt-5-nano','gpt-5.2','gpt-5.4','o3-mini','o4-mini'],
  gemini: ['gemini-3.1-flash-lite-preview','gemini-2.5-flash','gemini-2.5-pro','gemini-2.0-flash','gemini-2.5-flash-lite','gemini-flash-lite-latest','gemini-2.0-flash-lite','gemini-1.5-pro','gemini-1.5-flash'],
  anthropic: ['claude-sonnet-4-20250514','claude-3-5-sonnet-20241022','claude-3-5-haiku-20241022','claude-3-haiku-20240307','claude-opus-4-20250514'],
  production: ['Full Pipeline (Agent + Tools)'],
};
const PROVIDER_LABELS = { openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Anthropic', production: 'Agent (Prod)' };
const PROVIDER_COLORS = { openai: '#10a37f', gemini: '#4285f4', anthropic: '#d4a574', production: '#FF3B30' };
const DEFAULT_COLUMNS = [
  { provider: 'production', model: 'Full Pipeline (Agent + Tools)' },
  { provider: 'gemini', model: 'gemini-2.5-flash' },
];
const DEFAULT_ONBOARD_COLUMNS = [
  { provider: 'production', model: 'Full Pipeline (Agent + Tools)' },
  { provider: 'gemini', model: 'gemini-3.1-flash-lite-preview' },
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

// Message metadata store: msgId -> { text, latencyMs, tokens, production, provider, model, role, colId, turnNumber }
const msgMetaStore = new Map();
let msgIdCounter = 0;
let selectedMsgId = null;

function generateSessionId() { return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
function generateColId() { return 'col_' + (colIdCounter++); }
function generateOnboardColId() { return 'ob_' + (onboardColIdCounter++); }
function generateMsgId() { return 'msg_' + (msgIdCounter++); }

document.getElementById('sessionBadge').textContent = sessionId.slice(0, 16);

fetch('/compare/api/prompt').then(r => r.json()).then(data => {
  defaultSystemPrompt = data.systemPrompt;
  document.getElementById('systemPrompt').value = data.systemPrompt;
}).catch(() => {});

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
    document.getElementById('systemPrompt').value = defaultSystemPrompt;
    return;
  }
  badge.textContent = 'Loading...';
  badge.style.display = 'inline-block';
  try {
    const resp = await fetch('/compare/api/user-context?handle=' + encodeURIComponent(handle));
    const data = await resp.json();
    if (data.error) { alert(data.error); badge.style.display = 'none'; return; }
    userContextBlock = data.contextBlock || '';
    let fullPrompt = defaultSystemPrompt + '\\n\\n' + userContextBlock;
    if (data.timezone) {
      const now = new Date();
      const formatted = now.toLocaleString('en-AU', { timeZone: data.timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
      const shortTz = now.toLocaleString('en-AU', { timeZone: data.timezone, timeZoneName: 'short' }).split(' ').pop();
      fullPrompt += '\\n\\nCurrent date and time: ' + formatted + ' ' + shortTz + ' (' + data.timezone + ')';
    }
    document.getElementById('systemPrompt').value = fullPrompt;
    const name = data.profile?.name || handle;
    const parts = [name];
    if (data.accounts?.length) parts.push(data.accounts.length + ' accounts');
    if (data.memoryItems) parts.push(data.memoryItems + ' memories');
    if (data.timezone) parts.push(data.timezone);
    badge.textContent = parts.join(' \\u00b7 ');
  } catch (err) { alert('Failed: ' + err.message); badge.style.display = 'none'; }
}

// -- Helpers --

function escapeHtml(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }

function renderMarkdown(text) {
  // Escape HTML first, then apply bold markdown
  let html = escapeHtml(text);
  // **bold** -> <b>bold</b>
  html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');
  return html;
}

function splitIntoBubbles(text) {
  // Match production splitBubbles logic: prefer --- delimiters, fall back to double newlines
  const hasSeparator = text.includes('---');
  const parts = hasSeparator
    ? text.split(/\\n---\\n|\\n---$|^---\\n|\\s+---\\s+|\\s+---$|^---\\s+/)
    : text.includes('\\n\\n')
      ? text.split(/\\n\\n+/)
      : [text];
  return parts.map(p => p.trim()).filter(p => p.length > 0);
}

function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }

function autoCapitalize(el) {
  if (el.value.length === 1 && el.selectionStart === 1) {
    el.value = el.value.charAt(0).toUpperCase() + el.value.slice(1);
  }
}

function toggleSystemPrompt() {
  document.getElementById('sysPromptArea').classList.toggle('visible');
  document.getElementById('sysChevron').classList.toggle('open');
}

// -- Detail Panel --

let detailToggleCounter = 0;
function detailToggle(id) {
  const el = document.getElementById('dtc-' + id);
  const chev = document.getElementById('dtchev-' + id);
  if (el) el.classList.toggle('open');
  if (chev) chev.classList.toggle('open');
}

function showDetailPanel(msgId) {
  const meta = msgMetaStore.get(msgId);
  if (!meta) return;

  // Deselect previous
  if (selectedMsgId) {
    document.querySelectorAll('.msg-bubble.selected').forEach(el => el.classList.remove('selected'));
  }
  selectedMsgId = msgId;

  // Highlight clicked bubble
  const bubbleEl = document.querySelector('[data-msg-id="' + msgId + '"]');
  if (bubbleEl) bubbleEl.classList.add('selected');

  const isOnboard = currentMode === 'onboard';
  const panel = document.getElementById(isOnboard ? 'onboardDetailPanel' : 'detailPanel');
  const body = document.getElementById(isOnboard ? 'onboardDetailPanelBody' : 'detailPanelBody');

  let html = '';
  const prod = meta.production;
  const t = prod && prod.trace ? prod.trace : null;

  // If we have a full trace, render the complete decision tree (like debug dashboard)
  if (t) {
    // Stats grid
    html += '<div class="detail-section">';
    html += '<div class="detail-stats-grid">';
    html += '<div class="detail-stat-box"><div class="detail-stat-label">Total Latency</div><div class="detail-stat-value">' + (t.totalLatencyMs || meta.latencyMs || '?') + '<span class="detail-stat-unit">ms</span></div></div>';
    html += '<div class="detail-stat-box"><div class="detail-stat-label">Agent Rounds</div><div class="detail-stat-value">' + (t.agentLoopRounds || 0) + '</div></div>';
    html += '<div class="detail-stat-box"><div class="detail-stat-label">Tool Calls</div><div class="detail-stat-value">' + (t.toolCallCount || 0) + '</div></div>';
    html += '<div class="detail-stat-box"><div class="detail-stat-label">Model</div><div class="detail-stat-value" style="font-size:11px">' + escapeHtml(t.modelUsed || '?') + '</div></div>';
    html += '<div class="detail-stat-box"><div class="detail-stat-label">Input Tokens</div><div class="detail-stat-value">' + (t.inputTokens || 0).toLocaleString() + '</div></div>';
    html += '<div class="detail-stat-box"><div class="detail-stat-label">Output Tokens</div><div class="detail-stat-value">' + (t.outputTokens || 0).toLocaleString() + '</div></div>';
    html += '</div></div>';

    // Error banner
    if (t.errorMessage) {
      html += '<div class="detail-section"><div style="background:rgba(255,59,48,0.1);border:1px solid rgba(255,59,48,0.3);border-radius:8px;padding:10px 12px;font-size:12px;color:var(--red);"><b>Error at ' + escapeHtml(t.errorStage || 'unknown') + ':</b> ' + escapeHtml(t.errorMessage) + '</div></div>';
    }

    // 1. Routing Decision
    html += '<div class="detail-section">';
    html += '<div class="detail-section-title">1 - Routing Decision</div>';
    html += '<div class="detail-row"><span class="detail-label">Method</span><span class="detail-value">' + (t.routeFastPath ? 'Fast-path' : 'LLM Router') + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Agent</span><span class="detail-badge agent">' + escapeHtml(t.agentName || '?') + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Mode</span><span class="detail-value">' + escapeHtml(t.routeMode || '-') + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Route Layer</span><span class="detail-badge route">' + escapeHtml(prod.routeLayer || '-') + '</span></div>';
    if (t.routeReason) html += '<div class="detail-row"><span class="detail-label">Reason</span><span class="detail-value">' + escapeHtml(t.routeReason) + '</span></div>';
    if (t.routeConfidence != null) html += '<div class="detail-row"><span class="detail-label">Confidence</span><span class="detail-value">' + (t.routeConfidence * 100).toFixed(0) + '%</span></div>';
    if (t.matchedDisqualifierBucket) html += '<div class="detail-row"><span class="detail-label">Disqualifier</span><span class="detail-value">' + escapeHtml(t.matchedDisqualifierBucket) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Pending State</span><span class="detail-value">' + (t.hadPendingState ? 'Yes' : 'No') + '</span></div>';
    if (t.classifierLatencyMs) html += '<div class="detail-row"><span class="detail-label">Classifier</span><span class="detail-value">' + t.classifierLatencyMs + 'ms</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Onboarding</span><span class="detail-value">' + (prod.isOnboarding ? 'Yes' : 'No') + '</span></div>';
    if (t.timezoneResolved) html += '<div class="detail-row"><span class="detail-label">Timezone</span><span class="detail-value">' + escapeHtml(t.timezoneResolved) + '</span></div>';
    // Namespaces
    if (t.routeNamespaces && t.routeNamespaces.length > 0) {
      html += '<div class="detail-row"><span class="detail-label">Namespaces</span><span class="detail-value"></span></div>';
      html += '<div class="detail-ns-list">';
      t.routeNamespaces.forEach(function(ns) { html += '<span class="detail-ns-tag">' + escapeHtml(ns) + '</span>'; });
      html += '</div>';
    }
    if (t.routeLatencyMs) html += '<div class="detail-row"><span class="detail-label">Route Time</span><span class="detail-value">' + t.routeLatencyMs + 'ms</span></div>';
    html += '</div>';

    // 2. Context Assembly
    html += '<div class="detail-section">';
    html += '<div class="detail-section-title">2 - Context Assembly</div>';
    html += '<div class="detail-row"><span class="detail-label">Context Path</span><span class="detail-value">' + escapeHtml(t.contextPath || '-') + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">History Msgs</span><span class="detail-value">' + (t.historyMessagesCount || 0) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Memory Items</span><span class="detail-value">' + (t.memoryItemsLoaded || 0) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Summaries</span><span class="detail-value">' + (t.summariesLoaded || 0) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">RAG Evidence</span><span class="detail-value">' + (t.ragEvidenceBlocks || 0) + ' blocks</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Accounts</span><span class="detail-value">' + (t.connectedAccountsCount || 0) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Prompt Size</span><span class="detail-value">' + (t.systemPromptLength || 0).toLocaleString() + ' chars</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Build Time</span><span class="detail-value">' + (t.contextBuildLatencyMs || 0) + 'ms</span></div>';
    html += '</div>';

    // 3. Agent Loop
    html += '<div class="detail-section">';
    html += '<div class="detail-section-title">3 - Agent Loop</div>';
    html += '<div class="detail-row"><span class="detail-label">Agent</span><span class="detail-badge agent">' + escapeHtml(t.agentName || '?') + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Model</span><span class="detail-value">' + escapeHtml(t.modelUsed || '?') + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Rounds</span><span class="detail-value">' + (t.agentLoopRounds || 0) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Loop Time</span><span class="detail-value">' + (t.agentLoopLatencyMs || 0) + 'ms</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Prompt Compose</span><span class="detail-value">' + (t.promptComposeMs || 0) + 'ms</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Tool Filter</span><span class="detail-value">' + (t.toolFilterMs || 0) + 'ms</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Input Tokens</span><span class="detail-value">' + (t.inputTokens || 0).toLocaleString() + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Output Tokens</span><span class="detail-value">' + (t.outputTokens || 0).toLocaleString() + '</span></div>';
    html += '</div>';

    // 4. Tool Execution (detailed cards)
    var toolCalls = t.toolCalls || [];
    var blockedCalls = t.toolCallsBlocked || [];
    if (toolCalls.length > 0 || blockedCalls.length > 0) {
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">4 - Tool Execution (' + (t.toolTotalLatencyMs || 0) + 'ms)</div>';
      for (var ti = 0; ti < toolCalls.length; ti++) {
        var tc = toolCalls[ti];
        html += '<div class="detail-tool-card">';
        html += '<div class="detail-tool-card-name"><span class="detail-tool-outcome ' + (tc.outcome || 'success') + '"></span>' + escapeHtml(tc.name) + '<span style="font-weight:400;color:var(--text-secondary);font-size:10px;">' + (tc.latencyMs || tc.latency_ms || 0) + 'ms</span></div>';
        html += '<div class="detail-kv"><span class="detail-kv-key">Namespace</span><span class="detail-kv-val">' + escapeHtml(tc.namespace || '-') + '</span></div>';
        html += '<div class="detail-kv"><span class="detail-kv-key">Side Effect</span><span class="detail-kv-val">' + escapeHtml(tc.sideEffect || tc.side_effect || '-') + '</span></div>';
        html += '<div class="detail-kv"><span class="detail-kv-key">Outcome</span><span class="detail-kv-val">' + escapeHtml(tc.outcome || 'success') + '</span></div>';
        if (tc.inputSummary || tc.input_summary) html += '<div class="detail-kv"><span class="detail-kv-key">Input</span><span class="detail-kv-val">' + escapeHtml(tc.inputSummary || tc.input_summary) + '</span></div>';
        if (tc.approvalMethod || tc.approval_method) html += '<div class="detail-kv"><span class="detail-kv-key">Approval</span><span class="detail-kv-val">' + escapeHtml(tc.approvalMethod || tc.approval_method) + ' (' + ((tc.approvalGranted || tc.approval_granted) ? 'granted' : 'denied') + ')</span></div>';
        html += '</div>';
      }
      for (var bi = 0; bi < blockedCalls.length; bi++) {
        var bc = blockedCalls[bi];
        html += '<div class="detail-tool-card" style="border-color:rgba(255,59,48,0.3);background:rgba(255,59,48,0.05);">';
        html += '<div class="detail-tool-card-name" style="color:var(--red);"><b>' + escapeHtml(bc.name) + '</b> - BLOCKED</div>';
        html += '<div class="detail-kv"><span class="detail-kv-key">Reason</span><span class="detail-kv-val">' + escapeHtml(bc.reason || '-') + '</span></div>';
        html += '<div class="detail-kv"><span class="detail-kv-key">Namespace</span><span class="detail-kv-val">' + escapeHtml(bc.namespace || '-') + '</span></div>';
        html += '</div>';
      }
      html += '</div>';
    }

    // 5. Tools Available
    var availTools = t.availableToolNames || [];
    if (availTools.length > 0) {
      var toggleId = detailToggleCounter++;
      html += '<div class="detail-section">';
      html += '<div class="detail-section-toggle" onclick="detailToggle(' + toggleId + ')">';
      html += '<span class="detail-toggle-chevron" id="dtchev-' + toggleId + '">&#9654;</span>';
      html += '<span class="detail-section-title" style="margin-bottom:0">Tools Available (' + availTools.length + ')</span>';
      html += '</div>';
      html += '<div class="detail-collapsible" id="dtc-' + toggleId + '">';
      html += '<div class="detail-tools-list" style="margin-top:8px;">';
      var usedSet = new Set((t.toolCalls || []).map(function(tc) { return tc.name; }));
      for (var ai = 0; ai < availTools.length; ai++) {
        var cls = usedSet.has(availTools[ai]) ? 'detail-tool-tag used' : 'detail-tool-tag';
        html += '<span class="' + cls + '">' + escapeHtml(availTools[ai]) + '</span>';
      }
      html += '</div></div></div>';
    }

    // 6. Response
    html += '<div class="detail-section">';
    html += '<div class="detail-section-title">5 - Response (' + (t.responseLength || 0) + ' chars)</div>';
    html += '<div class="detail-full-text">' + escapeHtml(meta.text) + '</div>';
    html += '</div>';

    // 7. System Prompt (collapsible)
    if (t.systemPrompt) {
      var spToggleId = detailToggleCounter++;
      html += '<div class="detail-section">';
      html += '<div class="detail-section-toggle" onclick="detailToggle(' + spToggleId + ')">';
      html += '<span class="detail-toggle-chevron" id="dtchev-' + spToggleId + '">&#9654;</span>';
      html += '<span class="detail-section-title" style="margin-bottom:0">System Prompt (' + t.systemPrompt.length.toLocaleString() + ' chars)</span>';
      html += '</div>';
      html += '<div class="detail-collapsible" id="dtc-' + spToggleId + '">';
      html += '<div class="detail-system-prompt" style="margin-top:8px;">' + escapeHtml(t.systemPrompt) + '</div>';
      html += '</div></div>';
    }

  } else {
    // Non-production provider: show basic info
    html += '<div class="detail-section">';
    html += '<div class="detail-section-title">Overview</div>';
    html += '<div class="detail-row"><span class="detail-label">Role</span><span class="detail-value">' + escapeHtml(meta.role) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Provider</span><span class="detail-value">' + escapeHtml(meta.provider || '-') + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Model</span><span class="detail-value">' + escapeHtml(meta.model || '-') + '</span></div>';
    if (meta.latencyMs != null) html += '<div class="detail-row"><span class="detail-label">Latency</span><span class="detail-value">' + meta.latencyMs + 'ms</span></div>';
    if (meta.tokens != null) html += '<div class="detail-row"><span class="detail-label">Tokens</span><span class="detail-value">' + meta.tokens + '</span></div>';
    if (meta.turnNumber != null) html += '<div class="detail-row"><span class="detail-label">Turn</span><span class="detail-value">' + meta.turnNumber + '</span></div>';
    html += '</div>';

    // Onboard tool calls
    if (meta.toolCalls && meta.toolCalls.length > 0) {
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">Tools Called</div>';
      html += '<div class="detail-tools-list">';
      for (var oi = 0; oi < meta.toolCalls.length; oi++) {
        var otc = meta.toolCalls[oi];
        html += '<span class="detail-tool-tag used">' + escapeHtml(otc.name || otc) + '</span>';
      }
      html += '</div></div>';
    }

    // Full response text
    html += '<div class="detail-section">';
    html += '<div class="detail-section-title">Full Response</div>';
    html += '<div class="detail-full-text">' + escapeHtml(meta.text) + '</div>';
    html += '</div>';
  }

  body.innerHTML = html;
  panel.classList.add('open');
}

function closeDetailPanel() {
  document.getElementById('detailPanel').classList.remove('open');
  document.getElementById('onboardDetailPanel').classList.remove('open');
  if (selectedMsgId) {
    document.querySelectorAll('.msg-bubble.selected').forEach(el => el.classList.remove('selected'));
    selectedMsgId = null;
  }
}

function copyDetailJson() {
  if (!selectedMsgId) return;
  var meta = msgMetaStore.get(selectedMsgId);
  if (!meta) return;
  var jsonStr = JSON.stringify(meta, null, 2);
  navigator.clipboard.writeText(jsonStr).then(function() {
    // Visual feedback on all copy buttons
    document.querySelectorAll('.detail-copy-json').forEach(function(btn) {
      btn.classList.add('copied');
      btn.innerHTML = '&#x2714; Copied';
      setTimeout(function() {
        btn.classList.remove('copied');
        btn.innerHTML = '&#x2398; JSON';
      }, 1500);
    });
  });
}

// -- iPhone frame builder (shared between compare + onboard) --

function buildIPhoneFrame(col, bodyId, providerColor, label) {
  return '<div class="dynamic-island"></div>' +
    '<div class="ios-status-bar">' +
      '<span class="ios-time">9:41</span>' +
      '<div class="ios-icons">' +
        '<svg viewBox="0 0 16 12" fill="none"><path d="M1.5 8.5C3.5 6 6 4.5 8 4.5s4.5 1.5 6.5 4" stroke="#000" stroke-width="1.5" stroke-linecap="round"/><path d="M4 10.5C5.2 9 6.5 8 8 8s2.8 1 4 2.5" stroke="#000" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="12" r="1.2" fill="#000"/></svg>' +
        '<svg viewBox="0 0 25 12" fill="none"><rect x="0" y="0.5" width="21" height="11" rx="2" stroke="#000" stroke-width="1"/><rect x="1.5" y="2" width="16" height="8" rx="1" fill="#000"/><rect x="22" y="3.5" width="2.5" height="5" rx="1" fill="#000" opacity="0.3"/></svg>' +
      '</div>' +
    '</div>' +
    '<div class="imessage-header">' +
      '<div class="imessage-header-row">' +
        '<div class="imessage-back"><svg viewBox="0 0 10 17" fill="none"><path d="M9 1L1.5 8.5L9 16" stroke="#007AFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
        '<div class="imessage-avatar-wrap"><div class="imessage-avatar" style="background:' + providerColor + ';">' + label.charAt(0) + '</div></div>' +
        '<div class="imessage-facetime"></div>' +
      '</div>' +
      '<div class="imessage-name">' + escapeHtml(label) + '</div>' +
    '</div>' +
    '<div class="imessage-body" id="' + bodyId + '"></div>' +
    '<div class="imessage-input-bar">' +
      '<div class="imessage-fake-input">iMessage</div>' +
      '<div class="imessage-send-icon"><svg viewBox="0 0 24 24" fill="none"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="white"/></svg></div>' +
    '</div>';
}

// -- Compare: iPhone column management --

function buildModelOptions(provider, selectedModel) {
  return ALL_MODELS[provider].map(m => '<option value="' + m + '"' + (m === selectedModel ? ' selected' : '') + '>' + m + '</option>').join('');
}

function buildProviderOptions(selectedProvider) {
  return Object.keys(ALL_MODELS).map(p =>
    '<option value="' + p + '"' + (p === selectedProvider ? ' selected' : '') + '>' + (PROVIDER_LABELS[p] || p) + '</option>'
  ).join('');
}

function addColumn(provider, model) {
  if (columns.length >= MAX_PHONES) return;
  const id = generateColId();
  columns.push({ id, provider, model, msgCount: 0 });
  renderPhones();
  return id;
}

function removeColumn(id) {
  if (columns.length <= 1) return;
  columns = columns.filter(c => c.id !== id);
  renderPhones();
}

function onProviderChange(colId, newProvider) {
  const col = columns.find(c => c.id === colId);
  if (!col) return;
  col.provider = newProvider;
  col.model = ALL_MODELS[newProvider][0];
  renderPhones();
}

function onModelChange(colId, newModel) {
  const col = columns.find(c => c.id === colId);
  if (!col) return;
  col.model = newModel;
}

function getPhoneLabel(col) {
  if (col.provider === 'production') return 'Production';
  return PROVIDER_LABELS[col.provider] || col.provider;
}

function renderPhones() {
  const container = document.getElementById('phonesContainer');
  container.innerHTML = '';

  for (const col of columns) {
    const wrapper = document.createElement('div');
    wrapper.className = 'phone-wrapper';

    const providerColor = PROVIDER_COLORS[col.provider] || '#888';
    const isProd = col.provider === 'production';
    const label = getPhoneLabel(col);
    wrapper.innerHTML =
      '<div class="phone-selectors">' +
        (columns.length > 1 ? '<button class="phone-remove" onclick="removeColumn(\\'' + col.id + '\\')" title="Remove">&times;</button>' : '') +
        '<select onchange="onProviderChange(\\'' + col.id + '\\', this.value)">' + buildProviderOptions(col.provider) + '</select>' +
        '<select id="model-' + col.id + '" onchange="onModelChange(\\'' + col.id + '\\', this.value)"' + (isProd ? ' disabled' : '') + '>' + buildModelOptions(col.provider, col.model) + '</select>' +
      '</div>';

    const phone = document.createElement('div');
    phone.className = 'iphone-frame';
    phone.innerHTML = buildIPhoneFrame(col, 'body-' + col.id, providerColor, label);

    wrapper.appendChild(phone);
    container.appendChild(wrapper);
  }

  if (columns.length < MAX_PHONES) {
    const addBtn = document.createElement('div');
    addBtn.className = 'add-phone-btn';
    addBtn.onclick = () => addColumn('gemini', 'gemini-3.1-flash-lite-preview');
    addBtn.textContent = '+';
    addBtn.title = 'Add phone (max ' + MAX_PHONES + ')';
    container.appendChild(addBtn);
  }
}

// -- iMessage bubble rendering --

function addUserBubble(bodyId, text, meta) {
  const body = document.getElementById(bodyId);
  if (!body) return;
  const msgId = generateMsgId();
  if (meta) msgMetaStore.set(msgId, { ...meta, text, role: 'user' });
  const row = document.createElement('div');
  row.className = 'msg-row user';
  row.innerHTML = '<div class="msg-bubble user" data-msg-id="' + msgId + '" onclick="showDetailPanel(\\'' + msgId + '\\')">' + renderMarkdown(text) + '</div>';
  body.appendChild(row);
  body.scrollTop = body.scrollHeight;
}

function addTypingIndicator(bodyId) {
  const body = document.getElementById(bodyId);
  if (!body) return;
  const row = document.createElement('div');
  row.className = 'typing-row';
  row.id = 'typing-' + bodyId;
  row.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  body.appendChild(row);
  body.scrollTop = body.scrollHeight;
}

function removeTypingIndicator(bodyId) {
  const el = document.getElementById('typing-' + bodyId);
  if (el) el.remove();
}

function addAssistantBubbles(bodyId, text, meta) {
  const body = document.getElementById(bodyId);
  if (!body) return;

  const msgId = generateMsgId();
  msgMetaStore.set(msgId, { ...meta, text, role: 'assistant' });

  // Split into separate bubbles via ---
  const bubbles = splitIntoBubbles(text);

  for (let i = 0; i < bubbles.length; i++) {
    const row = document.createElement('div');
    row.className = 'msg-row assistant';
    // Only first bubble is clickable to show detail (all share same msgId)
    const clickAttr = 'data-msg-id="' + msgId + '" onclick="showDetailPanel(\\'' + msgId + '\\')"';
    row.innerHTML = '<div class="msg-bubble assistant" ' + clickAttr + '>' + renderMarkdown(bubbles[i]) + '</div>';
    body.appendChild(row);
  }

  // Compact meta line below bubbles
  const latencyMs = meta.latencyMs;
  const tokens = meta.tokens;
  const prod = meta.production;
  let metaHtml = '<span><span class="val">' + (latencyMs || '?') + 'ms</span></span>';
  if (tokens) metaHtml += '<span><span class="val">' + tokens + '</span> tok</span>';
  if (prod) {
    if (prod.agent) metaHtml += '<span>' + escapeHtml(prod.agent) + '</span>';
    if (prod.routeLayer) metaHtml += '<span>' + escapeHtml(prod.routeLayer) + '</span>';
    if (prod.tools && prod.tools.length > 0) metaHtml += '<span>\\ud83d\\udee0 ' + prod.tools.map(t => escapeHtml(t)).join(', ') + '</span>';
    if (prod.rounds > 1) metaHtml += '<span>' + prod.rounds + ' rounds</span>';
  }
  if (meta.turnNumber != null) metaHtml += '<span>turn ' + meta.turnNumber + '</span>';
  const metaDiv = document.createElement('div');
  metaDiv.className = 'msg-meta';
  metaDiv.innerHTML = metaHtml;
  body.appendChild(metaDiv);

  body.scrollTop = body.scrollHeight;
}

function addErrorBubble(bodyId, error) {
  const body = document.getElementById(bodyId);
  if (!body) return;
  const div = document.createElement('div');
  div.className = 'msg-row assistant';
  div.innerHTML = '<div class="msg-bubble assistant" style="background:#FFE5E5;color:#c00;">' + escapeHtml(error) + '</div>';
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
}

// Init compare columns
DEFAULT_COLUMNS.forEach(c => addColumn(c.provider, c.model));

// -- Mode switching --

function switchMode(mode) {
  currentMode = mode;
  closeDetailPanel();
  document.getElementById('tab-compare').classList.toggle('active', mode === 'compare');
  document.getElementById('tab-onboard').classList.toggle('active', mode === 'onboard');
  const compareEl = document.getElementById('compare-mode');
  const onboardEl = document.getElementById('onboard-mode');
  if (mode === 'compare') {
    compareEl.style.display = 'flex';
    onboardEl.style.display = 'none';
    document.getElementById('pageSubtitle').textContent = 'Model Comparison';
    document.getElementById('btnNewConvo').textContent = 'New Conversation';
    document.getElementById('prompt').placeholder = 'Type a message... (Enter to send)';
  } else {
    compareEl.style.display = 'none';
    onboardEl.style.display = 'flex';
    document.getElementById('pageSubtitle').textContent = 'Onboarding Test';
    document.getElementById('btnNewConvo').textContent = 'New Session';
    document.getElementById('prompt').placeholder = onboardSessionId ? 'Type a message as a new user...' : 'Start a session first...';
  }
}

// -- Compare send --

async function sendCompareMessage(prompt) {
  isRunning = true;
  const btn = document.getElementById('sendBtn'); btn.disabled = true; btn.textContent = 'Sending...';
  document.getElementById('prompt').value = ''; document.getElementById('prompt').style.height = 'auto';
  const systemPrompt = document.getElementById('systemPrompt').value.trim() || undefined;

  columns.forEach(col => {
    addUserBubble('body-' + col.id, prompt, { provider: col.provider, model: col.model });
    addTypingIndicator('body-' + col.id);
  });

  const promises = columns.map(async (col) => {
    try {
      const resp = await fetch('/compare/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, systemPrompt, provider: col.provider, model: col.model, sessionId, columnId: col.id }),
      });
      const data = await resp.json();
      removeTypingIndicator('body-' + col.id);
      if (data.error) {
        addErrorBubble('body-' + col.id, data.error);
      } else {
        addAssistantBubbles('body-' + col.id, data.text, {
          latencyMs: data.latencyMs,
          tokens: data.tokens,
          provider: col.provider,
          model: data.production?.model || col.model,
          production: data.production || null,
          colId: col.id,
        });
      }
    } catch (err) {
      removeTypingIndicator('body-' + col.id);
      addErrorBubble('body-' + col.id, 'Request failed: ' + err.message);
    }
  });
  await Promise.all(promises);
  isRunning = false; btn.disabled = false; btn.textContent = 'Send'; document.getElementById('prompt').focus();
}

// -- Onboarding: iPhone column management --

function addOnboardColumn(provider, model) {
  if (onboardColumns.length >= MAX_PHONES) return;
  const id = generateOnboardColId();
  onboardColumns.push({ id, provider, model, msgCount: 0 });
  renderOnboardPhones();
  return id;
}

function removeOnboardColumn(id) {
  if (onboardColumns.length <= 1) return;
  onboardColumns = onboardColumns.filter(c => c.id !== id);
  renderOnboardPhones();
}

function onOnboardProviderChange(colId, newProvider) {
  const col = onboardColumns.find(c => c.id === colId);
  if (!col) return;
  col.provider = newProvider;
  col.model = ALL_MODELS[newProvider][0];
  renderOnboardPhones();
}

function onOnboardModelChange(colId, newModel) {
  const col = onboardColumns.find(c => c.id === colId);
  if (!col) return;
  col.model = newModel;
}

function renderOnboardPhones() {
  const container = document.getElementById('onboardPhonesContainer');
  container.innerHTML = '';

  for (const col of onboardColumns) {
    const wrapper = document.createElement('div');
    wrapper.className = 'phone-wrapper';

    const providerColor = PROVIDER_COLORS[col.provider] || '#888';
    const isProd = col.provider === 'production';
    const label = getPhoneLabel(col);
    wrapper.innerHTML =
      '<div class="phone-selectors">' +
        (onboardColumns.length > 1 ? '<button class="phone-remove" onclick="removeOnboardColumn(\\'' + col.id + '\\')" title="Remove">&times;</button>' : '') +
        '<select onchange="onOnboardProviderChange(\\'' + col.id + '\\', this.value)">' + buildProviderOptions(col.provider) + '</select>' +
        '<select id="ob-model-' + col.id + '" onchange="onOnboardModelChange(\\'' + col.id + '\\', this.value)"' + (isProd ? ' disabled' : '') + '>' + buildModelOptions(col.provider, col.model) + '</select>' +
      '</div>';

    const phone = document.createElement('div');
    phone.className = 'iphone-frame';
    phone.innerHTML = buildIPhoneFrame(col, 'body-ob-' + col.id, providerColor, label);

    wrapper.appendChild(phone);
    container.appendChild(wrapper);
  }

  if (onboardColumns.length < MAX_PHONES) {
    const addBtn = document.createElement('div');
    addBtn.className = 'add-phone-btn';
    addBtn.onclick = () => addOnboardColumn('gemini', 'gemini-3.1-flash-lite-preview');
    addBtn.textContent = '+';
    addBtn.title = 'Add phone (max ' + MAX_PHONES + ')';
    container.appendChild(addBtn);
  }
}

// Init onboard columns
DEFAULT_ONBOARD_COLUMNS.forEach(c => addOnboardColumn(c.provider, c.model));

// -- Onboarding session --

async function startOnboardSession() {
  try {
    const resp = await fetch('/compare/api/onboard/new', { method: 'POST' });
    const data = await resp.json();
    if (data.error) { alert('Failed: ' + data.error); return; }
    onboardSessionId = data.sessionId;
    document.getElementById('sessionBadge').textContent = data.sessionId.slice(0, 20);
    document.getElementById('prompt').placeholder = 'Type a message as a new user...';

    // Clear phone bodies
    onboardColumns.forEach(col => {
      col.msgCount = 0;
      const body = document.getElementById('body-ob-' + col.id);
      if (body) body.innerHTML = '';
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

function updateStatePanel(data) {
  document.getElementById('state-turn').textContent = data.turnNumber || '0';
  document.getElementById('state-onboardState').textContent = data.onboardState || '-';
  if (data.verificationSent) { document.getElementById('state-verification').textContent = 'Sent'; document.getElementById('state-verification').className = 'state-badge sent'; }
  if (data.experimentVariants) {
    document.getElementById('state-nameVariant').textContent = data.experimentVariants.name_first_vs_value_first || '-';
    document.getElementById('state-promptVariant').textContent = data.experimentVariants.open_vs_guided || '-';
  }
}

// -- Unified send --

async function sendMessage() {
  const textarea = document.getElementById('prompt');
  const prompt = textarea.value.trim();
  if (!prompt || isRunning) return;
  if (currentMode === 'onboard') { await sendOnboardMessage(prompt); } else { await sendCompareMessage(prompt); }
}

async function sendOnboardMessage(prompt) {
  if (!onboardSessionId) { await startOnboardSession(); if (!onboardSessionId) return; }
  isRunning = true;
  const btn = document.getElementById('sendBtn'); btn.disabled = true; btn.textContent = 'Sending...';
  document.getElementById('prompt').value = ''; document.getElementById('prompt').style.height = 'auto';

  onboardColumns.forEach(col => {
    addUserBubble('body-ob-' + col.id, prompt, { provider: col.provider, model: col.model });
    addTypingIndicator('body-ob-' + col.id);
  });

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
      removeTypingIndicator('body-ob-' + col.id);
      if (data.error) {
        addErrorBubble('body-ob-' + col.id, data.error);
      } else {
        const displayModel = isAgent ? (data.model || 'production') : col.model;
        addAssistantBubbles('body-ob-' + col.id, data.text, {
          latencyMs: data.latencyMs,
          tokens: data.tokens,
          provider: col.provider,
          model: displayModel,
          turnNumber: data.turnNumber,
          toolCalls: data.toolCalls || [],
          production: isAgent ? {
            agent: data.agent || 'onboard',
            model: data.model,
            routeLayer: data.routeLayer,
            tools: (data.toolCalls || []).map(t => t.name || t),
            toolNames: data.toolNames || [],
            rounds: data.agentLoopRounds,
            isOnboarding: true,
            trace: data.trace || null,
          } : null,
          colId: col.id,
        });
        updateStatePanel(data);
      }
    } catch (err) {
      removeTypingIndicator('body-ob-' + col.id);
      addErrorBubble('body-ob-' + col.id, 'Request failed: ' + err.message);
    }
  });
  await Promise.all(promises);
  isRunning = false; btn.disabled = false; btn.textContent = 'Send'; document.getElementById('prompt').focus();
}

function newConversation() {
  closeDetailPanel();
  if (currentMode === 'onboard') { onboardSessionId = null; startOnboardSession(); return; }
  fetch('/compare/api/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) }).catch(() => {});
  sessionId = generateSessionId();
  document.getElementById('sessionBadge').textContent = sessionId.slice(0, 16);
  renderPhones();
}

document.getElementById('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMessage(); }
  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); sendMessage(); }
});
</script>
</body>
</html>`;
