/** Unified Nest admin shell: light theme, collapsible sidebar, iframe targets for admin tools. */
export const adminPanelHtml = `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nest — Admin</title>
<style>
  :root {
    --bg-main: #f3f4f6;
    --bg-sidebar: #ffffff;
    --bg-hover: rgba(0, 0, 0, 0.04);
    --bg-active: #f3f4f6;
    --border: #e5e7eb;
    --text: #111827;
    --text-muted: #6b7280;
    --text-dim: #9ca3af;
    --radius: 6px;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  html, body { height: 100%; overflow: hidden; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
    background: var(--bg-main);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    display: flex;
    height: 100vh;
  }

  .sidebar {
    width: 280px;
    min-width: 280px;
    background: var(--bg-sidebar);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    height: 100%;
    flex-shrink: 0;
    position: relative;
    z-index: 2;
    transition: width 0.22s ease, min-width 0.22s ease;
  }

  body.sidebar-collapsed .sidebar {
    width: 56px;
    min-width: 56px;
  }

  .sidebar-top {
    padding: 14px 12px 12px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }

  body.sidebar-collapsed .sidebar-top {
    flex-direction: column;
    align-items: center;
    padding: 12px 8px;
  }

  .brand-block { min-width: 0; }

  .brand-name {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  .brand-sub {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  body.sidebar-collapsed .brand-block {
    display: none;
  }

  .sidebar-toggle {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: #ffffff;
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
  }

  .sidebar-toggle:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .sidebar-toggle svg {
    width: 16px;
    height: 16px;
    transition: transform 0.22s ease;
  }

  body.sidebar-collapsed .sidebar-toggle svg {
    transform: rotate(180deg);
  }

  .section-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-dim);
    padding: 16px 14px 8px;
  }

  body.sidebar-collapsed .section-label {
    display: none;
  }

  .nav-list {
    list-style: none;
    padding: 0 8px 12px;
    flex: 1;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    margin-bottom: 2px;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text-muted);
    font-size: 13px;
    font-weight: 500;
    font-family: inherit;
    text-align: left;
    text-decoration: none;
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
    border: none;
    -webkit-tap-highlight-color: transparent;
  }

  .nav-item:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .nav-item.active {
    background: var(--bg-active);
    color: var(--text);
    box-shadow: inset 0 0 0 1px var(--border);
  }

  .nav-icon {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    opacity: 0.88;
  }

  .nav-item.active .nav-icon { opacity: 1; }

  .nav-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  body.sidebar-collapsed .nav-label {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  body.sidebar-collapsed .nav-item {
    justify-content: center;
    padding: 10px 8px;
  }

  .sidebar-footer {
    padding: 12px 14px 14px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.45;
  }

  body.sidebar-collapsed .sidebar-footer {
    display: none;
  }

  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-main);
    position: relative;
    z-index: 1;
  }

  .main-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: #ffffff;
    flex-shrink: 0;
  }

  .main-title {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .main-hint {
    font-size: 12px;
    color: var(--text-dim);
    margin-left: auto;
  }

  iframe#admin-frame {
    flex: 1;
    width: 100%;
    border: none;
    background: var(--bg-main);
    display: block;
    min-height: 0;
  }
</style>
</head>
<body>
  <aside class="sidebar" aria-label="Admin navigation">
    <div class="sidebar-top">
      <div class="brand-block">
        <div class="brand-name">Nest</div>
        <div class="brand-sub">Admin</div>
      </div>
      <button type="button" class="sidebar-toggle" id="sidebar-toggle" aria-expanded="true" aria-controls="admin-nav" title="Collapse sidebar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15 18l-6-6 6-6"/>
        </svg>
      </button>
    </div>
    <div class="section-label">Tools</div>
    <nav id="admin-nav">
      <ul class="nav-list">
        <li>
          <a class="nav-item active" href="/compare" target="admin-frame" data-title="Compare" id="nav-compare" title="Compare">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="7" height="18" rx="1"/>
              <rect x="14" y="3" width="7" height="18" rx="1"/>
            </svg>
            <span class="nav-label">Compare</span>
          </a>
        </li>
        <li>
          <a class="nav-item" href="/debug" target="admin-frame" data-title="Debug" id="nav-debug" title="Debug">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>
              <circle cx="8" cy="6" r="1.25" fill="currentColor" stroke="none"/>
              <circle cx="8" cy="12" r="1.25" fill="currentColor" stroke="none"/>
              <circle cx="8" cy="18" r="1.25" fill="currentColor" stroke="none"/>
            </svg>
            <span class="nav-label">Debug</span>
          </a>
        </li>
        <li>
          <a class="nav-item" href="/automations" target="admin-frame" data-title="Automations" id="nav-automations" title="Automations">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
            </svg>
            <span class="nav-label">Automations</span>
          </a>
        </li>
        <li>
          <a class="nav-item" href="/activity" target="admin-frame" data-title="Activity" id="nav-activity" title="Activity">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 3v18h18"/><path d="M7 16l4-4 4 4 5-7"/>
            </svg>
            <span class="nav-label">Activity</span>
          </a>
        </li>
        <li>
          <a class="nav-item" href="/users" target="admin-frame" data-title="Users" id="nav-users" title="Users">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            <span class="nav-label">Users</span>
          </a>
        </li>
        <li>
          <a class="nav-item" href="/retention" target="admin-frame" data-title="Retention" id="nav-retention" title="Retention">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>
            </svg>
            <span class="nav-label">Retention</span>
          </a>
        </li>
      </ul>
    </nav>
    <div class="sidebar-footer">
      Each tool opens in the panel. You can open <strong>/compare</strong>, <strong>/debug</strong>, <strong>/automations</strong>, <strong>/activity</strong>, <strong>/users</strong>, and <strong>/retention</strong> directly.
    </div>
  </aside>
  <div class="main">
    <header class="main-bar">
      <span class="main-title" id="main-title">Compare</span>
      <span class="main-hint" id="main-src"></span>
    </header>
    <iframe name="admin-frame" id="admin-frame" title="Nest admin content" src="/compare"></iframe>
  </div>
  <script>
    (function () {
      var STORAGE_KEY = 'nest-admin-sidebar-collapsed';
      var frame = document.getElementById('admin-frame');
      var titleEl = document.getElementById('main-title');
      var srcHint = document.getElementById('main-src');
      var links = document.querySelectorAll('a.nav-item');
      var toggle = document.getElementById('sidebar-toggle');
      var body = document.body;

      function setActive(el) {
        links.forEach(function (a) {
          a.classList.toggle('active', a === el);
        });
      }

      function syncChromeFromLink(el) {
        var t = el.getAttribute('data-title');
        var href = el.getAttribute('href') || '';
        titleEl.textContent = t || '';
        srcHint.textContent = href;
      }

      function applyHashFromHref(href) {
        var path = href || '';
        if (path.charAt(0) === '/') path = path.slice(1);
        path = path.split('?')[0].toLowerCase();
        var allowed = { compare: 1, debug: 1, automations: 1, activity: 1, users: 1, retention: 1 };
        if (!allowed[path]) path = 'compare';
        if (location.hash.slice(1) !== path) {
          history.replaceState(null, '', '#' + path);
        }
      }

      links.forEach(function (a) {
        a.addEventListener('click', function () {
          setActive(a);
          syncChromeFromLink(a);
          applyHashFromHref(a.getAttribute('href'));
        });
      });

      var map = { compare: 'nav-compare', debug: 'nav-debug', automations: 'nav-automations', activity: 'nav-activity', users: 'nav-users', retention: 'nav-retention' };
      function fromHash() {
        var key = location.hash.slice(1).toLowerCase();
        if (!key || !map[key]) {
          key = 'compare';
          history.replaceState(null, '', '#compare');
        }
        var el = document.getElementById(map[key]);
        if (!el) return;
        var href = el.getAttribute('href');
        frame.src = href;
        setActive(el);
        syncChromeFromLink(el);
      }

      window.addEventListener('hashchange', fromHash);
      fromHash();

      function setCollapsed(collapsed) {
        body.classList.toggle('sidebar-collapsed', collapsed);
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        toggle.setAttribute('title', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
        try {
          localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
        } catch (e) {}
      }

      toggle.addEventListener('click', function () {
        setCollapsed(!body.classList.contains('sidebar-collapsed'));
      });

      try {
        if (localStorage.getItem(STORAGE_KEY) === '1') {
          setCollapsed(true);
        }
      } catch (e) {}
    })();
  </script>
</body>
</html>
`;
