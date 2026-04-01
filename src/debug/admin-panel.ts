/** Unified Nest admin shell: light theme, collapsible sidebar, iframe targets for admin tools. */
import { getNestWebsiteOrigin } from '../lib/nest-website-origin.js';
import { getNestImessageSmsHref } from './nest-imessage-url.js';

const ADMIN_PANEL_TEMPLATE = `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nest — Admin</title>
<style>
  :root {
    --bg-main: #efe8dc;
    --bg-sidebar: #f5efe6;
    --bg-bar: #f2ebe2;
    --bg-hover: rgba(55, 40, 25, 0.07);
    --bg-active: #e5ddd0;
    --border: #d9d0c2;
    --text: #1c1917;
    --text-muted: #5c5346;
    --text-dim: #8a8174;
    --radius: 6px;
    --sidebar-width: 220px;
    --sidebar-collapsed-width: 52px;
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
    width: var(--sidebar-width);
    min-width: var(--sidebar-width);
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
    width: var(--sidebar-collapsed-width);
    min-width: var(--sidebar-collapsed-width);
  }

  .sidebar-top {
    padding: 12px 10px 10px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 6px;
  }

  body.sidebar-collapsed .sidebar-top {
    flex-direction: column;
    align-items: center;
    padding: 10px 6px;
    gap: 8px;
  }

  .sidebar-brand-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }

  body.sidebar-collapsed .sidebar-brand-row {
    justify-content: center;
    flex: 0;
  }

  .brand-logo {
    width: 32px;
    height: 32px;
    border-radius: var(--radius);
    flex-shrink: 0;
    object-fit: cover;
    display: block;
  }

  body.sidebar-collapsed .brand-logo {
    width: 28px;
    height: 28px;
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
    background: var(--bg-bar);
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
  }

  .sidebar-toggle:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .sidebar-toggle-icon {
    width: 18px;
    height: 18px;
    transition: transform 0.22s ease;
  }

  body.sidebar-collapsed .sidebar-toggle-icon {
    transform: rotate(180deg);
  }

  .section-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-dim);
    padding: 12px 12px 6px;
  }

  body.sidebar-collapsed .section-label {
    display: none;
  }

  #admin-nav {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .nav-list {
    list-style: none;
    padding: 0 6px 12px;
  }

  .nav-list-main {
    flex: 1;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .sidebar-footer {
    flex-shrink: 0;
    border-top: 1px solid var(--border);
    padding-top: 4px;
    margin-top: 2px;
  }

  .sidebar-footer .nav-list {
    padding-bottom: 10px;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 8px;
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

  .nav-item--disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .nav-icon-imessage {
    opacity: 1;
  }

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
    padding: 10px 6px;
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
      <div class="sidebar-brand-row">
        <img class="brand-logo" src="/nest-admin-logo.png" width="32" height="32" alt="" />
        <div class="brand-block">
          <div class="brand-name">Nest</div>
          <div class="brand-sub">Admin</div>
        </div>
      </div>
      <button type="button" class="sidebar-toggle" id="sidebar-toggle" aria-expanded="true" aria-controls="admin-nav" title="Collapse sidebar">
        <svg class="sidebar-toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2"/>
          <line x1="9" y1="4" x2="9" y2="20"/>
          <path d="m15 15-3-3 3-3"/>
        </svg>
      </button>
    </div>
    <div class="section-label">Tools</div>
    <nav id="admin-nav">
      <ul class="nav-list nav-list-main">
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
          <a class="nav-item" href="/admin/system-prompt" target="admin-frame" data-title="System prompt" id="nav-system-prompt" title="Edit chat system prompt file on disk">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <path d="M14 2v6h6"/>
              <path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>
            </svg>
            <span class="nav-label">System prompt</span>
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
          <a class="nav-item" href="/admin/brands" target="admin-frame" data-title="Brands" id="nav-brands" title="Business brands — triggers, prompts, onboarding">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/>
              <path d="M3 6h18"/>
              <path d="M16 10a4 4 0 0 1-8 0"/>
            </svg>
            <span class="nav-label">Brands</span>
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
          <a class="nav-item" href="/admin/moments" target="_blank" data-title="Moments" id="nav-moments" title="Moments — configurable automations">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
            </svg>
            <span class="nav-label">Moments</span>
          </a>
        </li>
        <li>
          <a class="nav-item" href="__MOMENT_V2_HREF__" target="_blank" rel="noopener noreferrer" id="nav-moment-v2" title="Website Automations (user_automations) — opens in a new tab (the site cannot be embedded in an iframe)">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="7" height="7" rx="1"/>
              <rect x="14" y="3" width="7" height="7" rx="1"/>
              <rect x="3" y="14" width="7" height="7" rx="1"/>
              <rect x="14" y="14" width="7" height="7" rx="1"/>
            </svg>
            <span class="nav-label">Moment V2</span>
          </a>
        </li>
        <li>
          <a class="nav-item" href="/morning-brief" target="admin-frame" data-title="Morning brief" id="nav-morning-brief" title="Morning audio brief (ElevenLabs + Linq)">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 12v6"/><path d="M8 14h8"/><circle cx="12" cy="9" r="2"/>
            </svg>
            <span class="nav-label">Morning brief</span>
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
          <a class="nav-item" href="/messages" target="admin-frame" data-title="Messages" id="nav-messages" title="Messages">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <span class="nav-label">Messages</span>
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
        <li>
          <a class="nav-item" href="/costs" target="admin-frame" data-title="Costs" id="nav-costs" title="API cost tracking — OpenAI, Gemini, Anthropic">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
            </svg>
            <span class="nav-label">Costs</span>
          </a>
        </li>
      </ul>
      <div class="sidebar-footer">
        <div class="section-label">Nest</div>
        <ul class="nav-list">
          <li>
            <a class="__IMESSAGE_NAV_CLASSES__" href="__IMESSAGE_HREF__" id="nav-imessage" title="__IMESSAGE_TITLE__"__IMESSAGE_EXTRAS__>
              <svg class="nav-icon nav-icon-imessage" viewBox="0 0 24 24" aria-hidden="true">
                <defs>
                  <linearGradient id="nestImessageGrad" x1="15%" y1="5%" x2="85%" y2="95%">
                    <stop offset="0%" stop-color="#5FE26C"/>
                    <stop offset="100%" stop-color="#34C759"/>
                  </linearGradient>
                </defs>
                <path fill="url(#nestImessageGrad)" d="M12 20.5c-1.15 0-2.25-.16-3.28-.46l-3.65 1.05 1.02-3.5a8.42 8.42 0 0 1-1.59-4.95C3.5 7.86 7.2 4 12 4s8.5 3.86 8.5 8.6c0 4.75-3.7 8.6-8.5 8.6z"/>
                <path fill="#fff" fill-opacity="0.92" d="M7.25 9.4h9.5v1.15h-9.5V9.4zm0 2.55h6.4v1.15H7.25v-1.15z"/>
              </svg>
              <span class="nav-label">Open in iMessage</span>
            </a>
          </li>
        </ul>
      </div>
    </nav>
  </aside>
  <div class="main">
    <iframe name="admin-frame" id="admin-frame" title="Compare — Nest admin" src="/compare"></iframe>
  </div>
  <script>
    (function () {
      var STORAGE_KEY = 'nest-admin-sidebar-collapsed';
      var frame = document.getElementById('admin-frame');
      var links = document.querySelectorAll('a.nav-item[target="admin-frame"]');
      var toggle = document.getElementById('sidebar-toggle');
      var body = document.body;

      function setActive(el) {
        links.forEach(function (a) {
          a.classList.toggle('active', a === el);
        });
      }

      function setFrameTitleFromNav(el) {
        var t = el.getAttribute('data-title') || 'Nest admin';
        frame.setAttribute('title', t + ' — Nest admin');
      }

      function applyHashFromHref(href) {
        var path = href || '';
        if (path.charAt(0) === '/') path = path.slice(1);
        path = path.split('?')[0].toLowerCase();
        if (path === 'admin/brands') path = 'brands';
        if (path === 'admin/system-prompt') path = 'system-prompt';
        var allowed = { compare: 1, 'system-prompt': 1, debug: 1, brands: 1, automations: 1, 'morning-brief': 1, activity: 1, messages: 1, users: 1, retention: 1, costs: 1 };
        if (!allowed[path]) path = 'compare';
        if (location.hash.slice(1) !== path) {
          history.replaceState(null, '', '#' + path);
        }
      }

      links.forEach(function (a) {
        a.addEventListener('click', function () {
          setActive(a);
          setFrameTitleFromNav(a);
          applyHashFromHref(a.getAttribute('href'));
        });
      });

      var map = { compare: 'nav-compare', 'system-prompt': 'nav-system-prompt', debug: 'nav-debug', brands: 'nav-brands', automations: 'nav-automations', 'morning-brief': 'nav-morning-brief', activity: 'nav-activity', messages: 'nav-messages', users: 'nav-users', retention: 'nav-retention', costs: 'nav-costs' };
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
        setFrameTitleFromNav(el);
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

      var imessageLink = document.getElementById('nav-imessage');
      if (imessageLink && imessageLink.classList.contains('nav-item--disabled')) {
        imessageLink.addEventListener('click', function (e) {
          e.preventDefault();
        });
      }
    })();
  </script>
</body>
</html>
`;

export function getAdminPanelHtml(): string {
  const sms = getNestImessageSmsHref();
  const href = sms ?? '#';
  const navClasses = sms ? 'nav-item' : 'nav-item nav-item--disabled';
  const title = sms
    ? 'Open Nest in iMessage'
    : 'Set LINQ_AGENT_BOT_NUMBERS or NEST_IMESSAGE_NUMBER in Nest/.env';
  const extras = sms ? '' : ' tabindex="-1" aria-disabled="true"';
  const momentV2Href = `${getNestWebsiteOrigin()}/admin/moment-v2`;
  return ADMIN_PANEL_TEMPLATE.replaceAll('__IMESSAGE_HREF__', href)
    .replaceAll('__IMESSAGE_NAV_CLASSES__', navClasses)
    .replaceAll('__IMESSAGE_TITLE__', title)
    .replaceAll('__IMESSAGE_EXTRAS__', extras)
    .replaceAll('__MOMENT_V2_HREF__', momentV2Href);
}
