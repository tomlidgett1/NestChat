/** Full-page editor for nest-chat-system-prompt.txt (loaded in /admin iframe). */

export const systemPromptEditorHtml = `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nest · System prompt</title>
<style>
  :root {
    --bg: #f3f4f6;
    --surface: #ffffff;
    --border: #e5e7eb;
    --text: #111827;
    --text-secondary: #6b7280;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    display: flex;
    flex-direction: column;
    min-height: 100%;
    padding: 16px 20px 20px;
  }
  .header {
    flex-shrink: 0;
    margin-bottom: 12px;
  }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 6px; }
  .meta {
    font-size: 12px;
    color: var(--text-secondary);
    word-break: break-all;
    margin-bottom: 8px;
  }
  .notice {
    font-size: 12px;
    color: var(--text-secondary);
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 12px;
    margin-bottom: 12px;
    line-height: 1.45;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-bottom: 10px;
  }
  .btn {
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 500;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: #fff;
    color: var(--text);
    cursor: pointer;
    font-family: inherit;
  }
  .btn:hover { background: #f9fafb; }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn-primary {
    background: #111827;
    color: #fff;
    border-color: #111827;
  }
  .btn-primary:hover { opacity: 0.92; }
  .status { font-size: 12px; color: var(--text-secondary); min-height: 18px; }
  .status.ok { color: #047857; }
  .status.err { color: #b91c1c; }
  .editor-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  textarea {
    flex: 1;
    width: 100%;
    min-height: min(70vh, 720px);
    padding: 14px 16px;
    font-size: 13px;
    line-height: 1.45;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    border: 1px solid var(--border);
    border-radius: 6px;
    resize: vertical;
    background: #fff;
    color: var(--text);
    outline: none;
  }
  textarea:focus { border-color: #9ca3af; }
</style>
</head>
<body>
  <div class="header">
    <h1>System prompt</h1>
    <div class="meta" id="filePath">Loading…</div>
    <div class="notice">
      This is the <strong>full chat system prompt</strong> Nest uses for Compare (and Anthropic direct fallback).
      <strong>Save</strong> writes to the file on disk shown above. Reload Compare to pick up changes (or send a new message).
      Production Supabase still uses <code>supabase/functions/_shared/agents/prompt-layers.ts</code> — mirror changes there when you deploy.
    </div>
    <div class="toolbar">
      <button type="button" class="btn btn-primary" id="btnSave">Save to file</button>
      <button type="button" class="btn" id="btnReload">Reload from disk</button>
    </div>
    <div class="status" id="status"></div>
  </div>
  <div class="editor-wrap">
    <textarea id="editor" spellcheck="false" placeholder="Loading prompt…"></textarea>
  </div>
<script>
(function () {
  var editor = document.getElementById('editor');
  var filePathEl = document.getElementById('filePath');
  var statusEl = document.getElementById('status');
  var btnSave = document.getElementById('btnSave');
  var btnReload = document.getElementById('btnReload');

  function setStatus(msg, cls) {
    statusEl.textContent = msg || '';
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
  }

  async function load() {
    setStatus('Loading…');
    btnSave.disabled = true;
    btnReload.disabled = true;
    try {
      var r = await fetch('/admin/api/chat-system-prompt-file');
      var data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Load failed');
      filePathEl.textContent = data.path || '';
      editor.value = data.content || '';
      setStatus(data.persistedToDisk ? 'Loaded from disk.' : 'Using inline default (file missing or empty until you save).', 'ok');
    } catch (e) {
      setStatus(e.message || 'Load failed', 'err');
    } finally {
      btnSave.disabled = false;
      btnReload.disabled = false;
    }
  }

  async function save() {
    setStatus('Saving…');
    btnSave.disabled = true;
    btnReload.disabled = true;
    try {
      var r = await fetch('/admin/api/chat-system-prompt-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editor.value }),
      });
      var data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Save failed');
      setStatus('Saved (' + (data.bytes || 0) + ' bytes).', 'ok');
    } catch (e) {
      setStatus(e.message || 'Save failed', 'err');
    } finally {
      btnSave.disabled = false;
      btnReload.disabled = false;
    }
  }

  btnSave.addEventListener('click', save);
  btnReload.addEventListener('click', load);
  load();
})();
</script>
</body>
</html>`;
