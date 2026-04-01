export const morningBriefDashboardHtml = `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nest — Morning brief</title>
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
    z-index: 10;
  }
  .header h1 { font-size: 15px; font-weight: 600; letter-spacing: -0.02em; }
  .header-sub { font-size: 12px; color: var(--text-muted); margin-top: 2px; max-width: 40rem; }
  .btn {
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 500;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    font-family: inherit;
  }
  .btn:hover { background: var(--surface-muted); }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-inverse); }
  .btn-primary:hover { opacity: 0.92; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .layout { padding: 20px; max-width: 52rem; }
  label { display: block; font-size: 12px; font-weight: 500; color: var(--text-secondary); margin-bottom: 6px; }
  select {
    width: 100%;
    max-width: 28rem;
    padding: 8px 10px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    font-size: 13px;
    font-family: inherit;
  }
  .row { margin-bottom: 16px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .panel {
    margin-top: 20px;
    padding: 14px 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 13px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 50vh;
    overflow: auto;
  }
  .panel.error { border-color: #fecaca; background: #fef2f2; color: #991b1b; }
  .panel.ok { border-color: #bbf7d0; background: #f0fdf4; color: #166534; }
  .muted { color: var(--text-muted); font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
  <header class="header">
    <div>
      <h1>Morning brief</h1>
      <p class="header-sub">Generate a ~45s ElevenLabs audio brief from mail, calendars, RAG, weather, and interests. Sends via Linq (dry run previews script only).</p>
    </div>
  </header>
  <div class="layout">
    <div class="row">
      <label for="userSelect">Account</label>
      <select id="userSelect"><option value="">Loading…</option></select>
      <p class="muted">Uses connected Google/Microsoft mail and calendars. Requires <code>ELEVENLABS_API_KEY</code> on the Edge function for send.</p>
    </div>
    <div class="actions">
      <button type="button" class="btn" id="btnDryRun" disabled>Dry run</button>
      <button type="button" class="btn btn-primary" id="btnSend" disabled>Generate and send</button>
    </div>
    <div id="out" class="panel" style="display:none;"></div>
  </div>
  <script>
    (function () {
      var sel = document.getElementById('userSelect');
      var btnDry = document.getElementById('btnDryRun');
      var btnSend = document.getElementById('btnSend');
      var out = document.getElementById('out');

      function showPanel(text, cls) {
        out.style.display = 'block';
        out.className = 'panel ' + (cls || '');
        out.textContent = text;
      }

      async function loadUsers() {
        try {
          var r = await fetch('/compare/api/users');
          var data = await r.json();
          var users = Array.isArray(data) ? data : (data.users || []);
          sel.innerHTML = '<option value="">Select a user…</option>';
          users.forEach(function (u) {
            var h = typeof u === 'string' ? u : (u.handle || u.phone || '');
            if (!h) return;
            var opt = document.createElement('option');
            opt.value = h;
            opt.textContent = h + (u.name ? ' — ' + u.name : '');
            sel.appendChild(opt);
          });
          btnDry.disabled = false;
          btnSend.disabled = false;
        } catch (e) {
          sel.innerHTML = '<option value="">Failed to load users</option>';
          showPanel('Could not load /compare/api/users: ' + e, 'error');
        }
      }

      async function run(dryRun) {
        var handle = sel.value;
        if (!handle) {
          showPanel('Select a user first.', 'error');
          return;
        }
        btnDry.disabled = true;
        btnSend.disabled = true;
        showPanel(dryRun ? 'Running dry run…' : 'Generating audio and sending…', '');
        try {
          var r = await fetch('/morning-brief/api/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handle: handle, dry_run: dryRun }),
          });
          var j = await r.json();
          if (!r.ok || j.ok === false) {
            showPanel(JSON.stringify(j, null, 2), 'error');
          } else {
            showPanel(JSON.stringify(j, null, 2), 'ok');
          }
        } catch (e) {
          showPanel(String(e), 'error');
        }
        btnDry.disabled = false;
        btnSend.disabled = false;
      }

      btnDry.addEventListener('click', function () { run(true); });
      btnSend.addEventListener('click', function () { run(false); });
      loadUsers();
    })();
  </script>
</body>
</html>
`;
