/** Admin view: browse user↔Nest threads from conversation_messages in an iPhone-style frame (light chrome). */
export const messagesDashboardHtml = `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nest — Messages</title>
<style>
  :root {
    --bg: #f3f4f6;
    --surface: #ffffff;
    --border: #e5e7eb;
    --text: #111827;
    --muted: #6b7280;
    --radius: 6px;
    --nest-avatar: #525252;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .shell {
    display: flex;
    height: 100vh;
    min-height: 0;
  }
  .chat-sidebar {
    width: min(360px, 38vw);
    min-width: 260px;
    border-right: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }
  .chat-sidebar-head {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  .chat-sidebar-head h1 {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin-bottom: 2px;
  }
  .chat-sidebar-head .hint {
    font-size: 11px;
    color: var(--muted);
    line-height: 1.4;
    margin-bottom: 10px;
  }
  .search-row {
    display: flex;
    gap: 8px;
  }
  input[type="search"] {
    flex: 1;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 13px;
    background: #fff;
  }
  .btn {
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 500;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    cursor: pointer;
    font-family: inherit;
  }
  .btn:hover { background: #f9fafb; }
  .chat-list {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }
  .chat-row {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    font-size: 13px;
  }
  .chat-row:hover { background: #f9fafb; }
  .chat-row.active { background: #f3f4f6; box-shadow: inset 0 0 0 1px var(--border); }
  .chat-row .title { font-weight: 600; word-break: break-all; }
  .chat-row .sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .chat-row .preview {
    font-size: 12px;
    color: #4b5563;
    margin-top: 4px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .badge {
    display: inline-block;
    font-size: 10px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 6px;
    background: #f3f4f6;
    color: #374151;
    margin-left: 6px;
    vertical-align: middle;
  }
  .stage {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    overflow: auto;
    background: var(--bg);
  }
  .err {
    color: #b91c1c;
    font-size: 13px;
    padding: 10px 14px;
    margin: 10px 14px;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .empty-stage {
    font-size: 14px;
    color: var(--muted);
    text-align: center;
    max-width: 280px;
  }

  /* iPhone frame (interior matches Compare / iMessage; outer page stays light) */
  .phone-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .iphone-frame {
    width: 320px;
    height: min(720px, calc(100vh - 48px));
    min-height: 420px;
    background: #000;
    border-radius: 44px;
    border: 3px solid #333;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 20px 50px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.06);
    position: relative;
  }
  .dynamic-island {
    position: absolute;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    width: 100px;
    height: 28px;
    background: #000;
    border-radius: 20px;
    z-index: 10;
  }
  .ios-status-bar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 24px 4px;
    background: #F2F2F7;
    position: relative;
    z-index: 5;
  }
  .ios-time { font-size: 14px; font-weight: 600; color: #000; letter-spacing: -0.2px; }
  .ios-icons { display: flex; gap: 5px; align-items: center; }
  .ios-icons svg { height: 11px; width: auto; }
  .imessage-header {
    flex-shrink: 0;
    background: #F2F2F7;
    border-bottom: 0.5px solid rgba(0,0,0,0.12);
    padding: 6px 12px 8px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .imessage-header-row { display: flex; align-items: center; width: 100%; }
  .imessage-back {
    display: flex;
    align-items: center;
    gap: 2px;
    width: 40px;
  }
  .imessage-back svg { width: 10px; height: 17px; }
  .imessage-avatar-wrap { flex: 1; display: flex; justify-content: center; }
  .imessage-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--nest-avatar);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 600;
    color: white;
  }
  .imessage-facetime { width: 40px; display: flex; justify-content: flex-end; }
  .imessage-name { font-size: 11px; color: #000; font-weight: 400; margin-top: 2px; text-align: center; max-width: 100%; padding: 0 8px; }
  .imessage-body {
    flex: 1;
    overflow-y: auto;
    padding: 12px 12px 16px;
    background: #FFFFFF;
    min-height: 0;
  }
  .imessage-body::-webkit-scrollbar { width: 0; }
  .msg-row { margin-bottom: 4px; display: flex; }
  .msg-row.user { justify-content: flex-end; }
  .msg-row.assistant { justify-content: flex-start; }
  .msg-row.system { justify-content: center; }
  .msg-bubble {
    max-width: 78%;
    padding: 8px 14px;
    font-size: 15px;
    line-height: 1.4;
    word-break: break-word;
    white-space: pre-wrap;
  }
  .msg-bubble.user {
    background: #007AFF;
    color: white;
    border-radius: 18px 18px 4px 18px;
  }
  .msg-bubble.assistant {
    background: #E9E9EB;
    color: #000;
    border-radius: 18px 18px 18px 4px;
  }
  .msg-bubble.system {
    background: #f3f4f6;
    color: var(--muted);
    font-size: 11px;
    max-width: 92%;
    border-radius: 8px;
    border: 1px solid var(--border);
  }
  .msg-row.assistant + .msg-row.assistant { margin-top: -2px; }
  .msg-row.assistant + .msg-row.assistant .msg-bubble.assistant {
    border-radius: 18px 18px 18px 4px;
  }
  .msg-time-row {
    display: flex;
    margin-bottom: 6px;
    margin-top: 2px;
  }
  .msg-time-row.user-side { justify-content: flex-end; }
  .msg-time-row.assistant-side { justify-content: flex-start; }
  .msg-time-row.system-side { justify-content: center; }
  .msg-time {
    font-size: 9px;
    color: #9ca3af;
    padding: 0 8px;
  }
  .imessage-input-bar {
    flex-shrink: 0;
    background: #F2F2F7;
    border-top: 0.5px solid rgba(0,0,0,0.12);
    padding: 8px 12px 10px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .imessage-fake-input {
    flex: 1;
    background: #fff;
    border: 1px solid rgba(0,0,0,0.12);
    border-radius: 18px;
    padding: 8px 14px;
    font-size: 15px;
    color: #8e8e93;
  }
  .imessage-send-icon {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: #007AFF;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .imessage-send-icon svg { width: 14px; height: 14px; }
  .loading { font-size: 13px; color: var(--muted); padding: 16px; text-align: center; }
  @media (max-width: 800px) {
    .shell { flex-direction: column; }
    .chat-sidebar { width: 100%; min-width: 0; max-height: 42vh; border-right: none; border-bottom: 1px solid var(--border); }
    .iphone-frame { width: min(320px, 100%); }
  }
</style>
</head>
<body>
<div class="shell">
  <aside class="chat-sidebar">
    <div class="chat-sidebar-head">
      <h1>Conversations</h1>
      <p class="hint">Non-expired rows in <code>conversation_messages</code>. <code>chat_id</code> is the user handle.</p>
      <div class="search-row">
        <input type="search" id="q" placeholder="Search handle or message…" autocomplete="off" />
        <button type="button" class="btn" id="reload" title="Reload">Refresh</button>
      </div>
    </div>
    <div id="listErr"></div>
    <div class="chat-list" id="chatList"><div class="loading">Loading…</div></div>
  </aside>
  <main class="stage">
    <div class="phone-wrap" id="phoneWrap" style="display:none;">
      <div class="iphone-frame" id="iphone">
        <div class="dynamic-island"></div>
        <div class="ios-status-bar">
          <span class="ios-time" id="iosTime">9:41</span>
          <div class="ios-icons">
            <svg viewBox="0 0 16 12" fill="none"><path d="M1.5 8.5C3.5 6 6 4.5 8 4.5s4.5 1.5 6.5 4" stroke="#000" stroke-width="1.5" stroke-linecap="round"/><path d="M4 10.5C5.2 9 6.5 8 8 8s2.8 1 4 2.5" stroke="#000" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="12" r="1.2" fill="#000"/></svg>
            <svg viewBox="0 0 25 12" fill="none"><rect x="0" y="0.5" width="21" height="11" rx="2" stroke="#000" stroke-width="1"/><rect x="1.5" y="2" width="16" height="8" rx="1" fill="#000"/><rect x="22" y="3.5" width="2.5" height="5" rx="1" fill="#000" opacity="0.3"/></svg>
          </div>
        </div>
        <div class="imessage-header">
          <div class="imessage-header-row">
            <div class="imessage-back"><svg viewBox="0 0 10 17" fill="none"><path d="M9 1L1.5 8.5L9 16" stroke="#007AFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
            <div class="imessage-avatar-wrap"><div class="imessage-avatar" id="hdrAvatar">N</div></div>
            <div class="imessage-facetime"></div>
          </div>
          <div class="imessage-name" id="hdrName">Nest</div>
        </div>
        <div class="imessage-body" id="msgBody"></div>
        <div class="imessage-input-bar">
          <div class="imessage-fake-input">iMessage</div>
          <div class="imessage-send-icon"><svg viewBox="0 0 24 24" fill="none"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="white"/></svg></div>
        </div>
      </div>
    </div>
    <div class="empty-stage" id="emptyStage">Select a conversation to preview messages.</div>
  </main>
</div>
<script>
(function () {
  var chatRows = [];
  var selectedHandle = null;
  var searchTimer = null;

  function escapeHtml(text) {
    var d = document.createElement('div');
    d.textContent = text == null ? '' : String(text);
    return d.innerHTML;
  }

  /** Same rules as server \`splitBubbles\` in index.ts (---, \\n\\n, 2000-char chunks). */
  var SEPARATOR_RE = /\\n---\\n|\\n---$|^---\\n|\\s+---\\s+|\\s+---$|^---\\s+/;
  var MAX_BUBBLE_LENGTH = 2000;

  function splitByParagraphs(text) {
    var chunks = [];
    var current = '';
    var paras = text.split('\\n\\n');
    for (var pi = 0; pi < paras.length; pi++) {
      var paragraph = paras[pi];
      if (current && current.length + paragraph.length + 2 > MAX_BUBBLE_LENGTH) {
        chunks.push(current.trim());
        current = paragraph;
      } else {
        current = current ? current + '\\n\\n' + paragraph : paragraph;
      }
    }
    if (current.trim()) {
      var remaining = current.trim();
      if (remaining.length <= MAX_BUBBLE_LENGTH) {
        chunks.push(remaining);
      } else {
        for (var i = 0; i < remaining.length; i += MAX_BUBBLE_LENGTH) {
          chunks.push(remaining.slice(i, i + MAX_BUBBLE_LENGTH));
        }
      }
    }
    return chunks.length > 0 ? chunks : [text.slice(0, MAX_BUBBLE_LENGTH)];
  }

  function splitBubbles(text) {
    var s = text == null ? '' : String(text);
    var hasSeparator = s.indexOf('---') !== -1;
    var parts = hasSeparator
      ? s.split(SEPARATOR_RE)
      : s.indexOf('\\n\\n') !== -1
        ? s.split(/\\n\\n+/)
        : [s];
    var chunks = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].trim();
      if (!part) continue;
      if (part.length <= MAX_BUBBLE_LENGTH) {
        chunks.push(part);
      } else {
        var sub = splitByParagraphs(part);
        for (var j = 0; j < sub.length; j++) chunks.push(sub[j]);
      }
    }
    return chunks.length > 0 ? chunks : [s.trim().slice(0, MAX_BUBBLE_LENGTH)];
  }

  function renderMarkdown(text) {
    var html = escapeHtml(text);
    html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');
    return html;
  }

  function formatTime(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    } catch (e) { return iso; }
  }

  function tickClock() {
    var el = document.getElementById('iosTime');
    if (!el) return;
    var now = new Date();
    var h = now.getHours();
    var m = now.getMinutes();
    el.textContent = ((h % 12) || 12) + ':' + (m < 10 ? '0' : '') + m;
  }

  function setListError(msg) {
    var box = document.getElementById('listErr');
    box.innerHTML = msg ? '<div class="err">' + escapeHtml(msg) + '</div>' : '';
  }

  async function loadChats() {
    var q = document.getElementById('q').value.trim();
    var url = '/messages/api/chats' + (q ? '?q=' + encodeURIComponent(q) : '');
    setListError('');
    document.getElementById('chatList').innerHTML = '<div class="loading">Loading…</div>';
    try {
      var r = await fetch(url);
      var data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to load');
      chatRows = data.chats || [];
      renderList();
    } catch (e) {
      document.getElementById('chatList').innerHTML = '';
      setListError(e.message || String(e));
    }
  }

  function renderList() {
    var list = document.getElementById('chatList');
    if (!chatRows.length) {
      list.innerHTML = '<div class="loading">No conversations match.</div>';
      return;
    }
    var h = '';
    for (var i = 0; i < chatRows.length; i++) {
      var c = chatRows[i];
      var active = c.chat_id === selectedHandle ? ' active' : '';
      var title = c.displayName ? escapeHtml(c.displayName) + ' <span class="badge">' + escapeHtml(c.chat_id) + '</span>' : escapeHtml(c.chat_id);
      var roleLabel = (c.previewRole || '').toLowerCase() === 'user' ? 'User' : 'Nest';
      h += '<div class="chat-row' + active + '" data-handle="' + escapeHtml(c.chat_id) + '">';
      h += '<div class="title">' + title + '</div>';
      h += '<div class="sub">' + escapeHtml(formatTime(c.lastMessageAt)) + ' · ' + escapeHtml(roleLabel) + '</div>';
      h += '<div class="preview">' + escapeHtml(c.preview) + '</div>';
      h += '</div>';
    }
    list.innerHTML = h;
    list.querySelectorAll('.chat-row').forEach(function (row) {
      row.addEventListener('click', function () {
        selectChat(row.getAttribute('data-handle'));
      });
    });
  }

  function bubbleClass(role) {
    var r = (role || '').toLowerCase();
    if (r === 'user') return 'user';
    if (r === 'system') return 'system';
    return 'assistant';
  }

  function appendBubbles(htmlArr, role, content, createdAt) {
    var bc = bubbleClass(role);
    if (bc === 'system') {
      htmlArr.push('<div class="msg-row system"><div class="msg-bubble system">' + renderMarkdown(content) + '</div></div>');
      htmlArr.push('<div class="msg-time-row system-side"><span class="msg-time">' + escapeHtml(formatTime(createdAt)) + '</span></div>');
      return;
    }
    if (bc === 'user') {
      htmlArr.push('<div class="msg-row user"><div class="msg-bubble user">' + renderMarkdown(content) + '</div></div>');
      htmlArr.push('<div class="msg-time-row user-side"><span class="msg-time">' + escapeHtml(formatTime(createdAt)) + '</span></div>');
      return;
    }
    var parts = splitBubbles(content);
    for (var i = 0; i < parts.length; i++) {
      htmlArr.push('<div class="msg-row assistant"><div class="msg-bubble assistant">' + renderMarkdown(parts[i]) + '</div></div>');
    }
    htmlArr.push('<div class="msg-time-row assistant-side"><span class="msg-time">' + escapeHtml(formatTime(createdAt)) + '</span></div>');
  }

  async function selectChat(handle) {
    if (!handle) return;
    selectedHandle = handle;
    renderList();
    document.getElementById('emptyStage').style.display = 'none';
    document.getElementById('phoneWrap').style.display = 'flex';
    var body = document.getElementById('msgBody');
    body.innerHTML = '<div class="loading">Loading messages…</div>';

    try {
      var r = await fetch('/messages/api/conversation?handle=' + encodeURIComponent(handle));
      var data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to load thread');

      var profile = data.profile;
      var display = (profile && profile.name) ? profile.name : handle;
      document.getElementById('hdrName').textContent = display;
      document.getElementById('hdrAvatar').textContent = (display || 'N').charAt(0).toUpperCase();

      var msgs = data.messages || [];
      if (!msgs.length) {
        body.innerHTML = '<div class="loading">No non-expired messages for this chat.</div>';
        return;
      }
      var parts = [];
      for (var j = 0; j < msgs.length; j++) {
        appendBubbles(parts, msgs[j].role, msgs[j].content, msgs[j].created_at);
      }
      var html = parts.join('');
      if (data.truncated) {
        html += '<div class="msg-row system"><div class="msg-bubble system">Older messages omitted (limit reached).</div></div>';
      }
      body.innerHTML = html;
      body.scrollTop = body.scrollHeight;
    } catch (e) {
      body.innerHTML = '<div class="loading" style="color:#b91c1c;">' + escapeHtml(e.message || String(e)) + '</div>';
    }
  }

  document.getElementById('reload').addEventListener('click', loadChats);
  document.getElementById('q').addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadChats, 280);
  });

  tickClock();
  setInterval(tickClock, 30000);
  loadChats();
})();
</script>
</body>
</html>
`;
