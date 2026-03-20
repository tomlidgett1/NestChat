/** Admin user directory and per-handle profile (memory, turns, links, onboarding). */
export const usersDashboardHtml = `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nest — Users</title>
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
    padding: 20px 24px 48px;
  }
  h1 { font-size: 18px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 4px; }
  .sub { font-size: 13px; color: var(--muted); margin-bottom: 16px; }
  .layout { display: grid; grid-template-columns: minmax(280px, 380px) 1fr; gap: 16px; align-items: start; }
  @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
  }
  .search-row { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  input[type="search"] {
    flex: 1;
    min-width: 160px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 13px;
  }
  .btn {
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 500;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    cursor: pointer;
  }
  .btn:hover { background: #f9fafb; }
  .user-list { max-height: min(70vh, 640px); overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius); }
  .user-row {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    font-size: 13px;
  }
  .user-row:hover { background: #f9fafb; }
  .user-row.active { background: #f3f4f6; box-shadow: inset 0 0 0 1px var(--border); }
  .user-row .h { font-weight: 600; word-break: break-all; }
  .user-row .m { font-size: 11px; color: var(--muted); margin-top: 2px; }
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
  .badge-active { background: #e5e7eb; color: #111827; }
  .badge-pending { background: #f3f4f6; color: #6b7280; }
  .badge-other { background: #f9fafb; color: #4b5563; border: 1px solid #e5e7eb; }
  .verify-summary {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
    margin-bottom: 16px;
  }
  .verify-summary .title { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  .verify-summary .pct { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; margin-bottom: 6px; }
  .verify-summary .line { font-size: 13px; color: var(--text); font-variant-numeric: tabular-nums; margin-bottom: 8px; }
  .verify-summary .def { font-size: 11px; color: var(--muted); line-height: 1.45; margin-bottom: 10px; }
  .verify-summary .bar { display: flex; height: 8px; border-radius: var(--radius); overflow: hidden; border: 1px solid var(--border); background: #f3f4f6; }
  .verify-summary .bar .s-a { background: #374151; height: 100%; }
  .verify-summary .bar .s-p { background: #d1d5db; height: 100%; }
  .verify-summary .bar .s-o { background: #e5e7eb; height: 100%; }
  .verify-summary .cols { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: var(--muted); margin-top: 10px; }
  .detail-empty { color: var(--muted); font-size: 14px; padding: 24px; text-align: center; }
  .detail-head { margin-bottom: 12px; }
  .detail-head .handle { font-size: 16px; font-weight: 600; word-break: break-all; }
  .detail-head .meta { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .section {
    margin-bottom: 14px;
    padding: 12px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .section h3 { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin-bottom: 8px; }
  pre {
    font-size: 11px;
    background: #f9fafb;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 280px;
    overflow-y: auto;
  }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); }
  tr:last-child td { border-bottom: none; }
  .mono { font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all; }
  .pager { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 12px; color: var(--muted); }
  .err { color: #b91c1c; font-size: 13px; padding: 10px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 12px; }
  .form-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); margin-bottom: 12px; }
  .form-grid label { font-size: 11px; font-weight: 600; color: var(--muted); }
  .inp { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius); font-size: 13px; margin-top: 4px; box-sizing: border-box; }
  textarea.inp { min-height: 120px; font-family: ui-monospace, monospace; font-size: 12px; resize: vertical; }
  .form-hint { font-size: 12px; color: var(--muted); margin-bottom: 12px; line-height: 1.45; }
  .form-msg { font-size: 12px; margin-left: 10px; color: var(--muted); }
  .form-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 4px; }
  .btn-danger { color: #991b1b; border-color: #d1d5db; }
  .btn-danger:hover { background: #fef2f2; }
  .chk { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; color: var(--text); margin-top: 4px; }
  .detail-tabs-wrap {
    position: sticky;
    top: 0;
    z-index: 6;
    background: #f3f4f6;
    padding: 8px 0 12px;
    margin: -4px 0 12px;
    border-bottom: 1px solid var(--border);
  }
  .tabs-container {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
    background: #f3f4f6;
    padding: 2px;
    border-radius: 6px;
    width: fit-content;
    max-width: 100%;
  }
  .tab-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 500;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: #4b5563;
    cursor: pointer;
    font-family: inherit;
    -webkit-tap-highlight-color: transparent;
  }
  .tab-btn:hover { background: rgba(0, 0, 0, 0.04); }
  .tab-btn.active {
    color: #111827;
    background: #ffffff;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
  }
  .tab-panels { min-height: 80px; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  .memory-table-wrap {
    overflow-x: auto;
    margin-bottom: 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: #ffffff;
    -webkit-overflow-scrolling: touch;
  }
  .memory-table-wrap table { margin: 0; }
  .memory-table-wrap th, .memory-table-wrap td { white-space: nowrap; }
  .memory-table-wrap th:nth-child(3), .memory-table-wrap td:nth-child(3) {
    white-space: normal;
    max-width: 280px;
  }
  .memory-raw-heading {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin: 0 0 8px;
  }
  .memory-raw-pre { max-height: 360px; }
  .epoch-preview {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: var(--text);
    margin-bottom: 4px;
  }
  .epoch-preview.muted { color: var(--muted); font-weight: 400; }
</style>
</head>
<body>
  <h1>Users</h1>
  <p class="sub">Search <code>user_profiles</code>, edit allowlisted fields, or permanently delete a handle and related rows. Deleting the Auth user requires a Supabase service role key on this server.</p>
  <div id="verify-summary" class="verify-summary" style="display:none;"></div>
  <div id="err" class="err" style="display:none;"></div>
  <div class="layout">
    <div class="panel">
      <div class="search-row">
        <input type="search" id="q" placeholder="Search handle or name…" autocomplete="off" />
        <button type="button" class="btn" id="go">Search</button>
      </div>
      <div class="user-list" id="list"></div>
      <div class="pager">
        <button type="button" class="btn" id="prev">Previous</button>
        <button type="button" class="btn" id="next">Next</button>
        <span id="page-info"></span>
      </div>
    </div>
    <div id="detail-col">
      <div class="detail-empty" id="placeholder">Select a user to load their profile.</div>
      <div id="detail" style="display:none;"></div>
    </div>
  </div>
  <script>
    var limit = 50;
    var offset = 0;
    var total = 0;
    var selectedHandle = null;

    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function fmtTs(epochSec) {
      if (epochSec == null || epochSec === '') return '—';
      var n = Number(epochSec);
      if (!Number.isFinite(n)) return String(epochSec);
      var d = new Date(n * 1000);
      if (isNaN(d.getTime())) return String(epochSec);
      return d.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
    }

    /** user_profiles.first_seen / last_seen are unix seconds — show for admins with optional epoch suffix. */
    function fmtEpochProfile(sec, withUnixSuffix) {
      if (sec == null) return '—';
      var human = fmtTs(sec);
      if (human === '—' || !withUnixSuffix) return human;
      return human + ' (unix ' + sec + ')';
    }

    function showErr(msg) {
      var e = document.getElementById('err');
      e.textContent = msg;
      e.style.display = msg ? 'block' : 'none';
    }

    async function loadVerificationSummary() {
      var el = document.getElementById('verify-summary');
      try {
        var r = await fetch('/debug/api/user-verification-stats');
        var v = await r.json();
        if (!r.ok) throw new Error(v.error || r.statusText);
        var t = v.totalUserProfiles || 0;
        var a = v.verifiedActive || 0;
        var p = v.pendingVerification || 0;
        var o = v.otherStatus || 0;
        var pct = v.verifiedPercentOfTotal != null ? v.verifiedPercentOfTotal : 0;
        var wA = t > 0 ? (a / t) * 100 : 0;
        var wP = t > 0 ? (p / t) * 100 : 0;
        var wO = t > 0 ? (o / t) * 100 : 0;
        el.innerHTML =
          '<div class="title">Verification across all users</div>' +
          '<div class="pct">' + esc(pct) + '% verified</div>' +
          '<div class="line"><strong>' + esc(a) + '</strong> verified (active) · <strong>' + esc(p) + '</strong> pending · <strong>' + esc(o) + '</strong> other · <strong>' + esc(t) + '</strong> total</div>' +
          '<p class="def">' + esc(v.note || '') + '</p>' +
          '<div class="bar">' +
          (wA > 0 ? '<div class="s-a" style="width:' + wA + '%"></div>' : '') +
          (wP > 0 ? '<div class="s-p" style="width:' + wP + '%"></div>' : '') +
          (wO > 0 ? '<div class="s-o" style="width:' + wO + '%"></div>' : '') +
          '</div>' +
          '<div class="cols">' +
          '<span>Active: ' + esc(v.verifiedPercentOfTotal) + '%</span>' +
          '<span>Pending: ' + esc(v.pendingPercentOfTotal) + '%</span>' +
          (o > 0 ? '<span>Other: ' + esc(v.otherPercentOfTotal) + '%</span>' : '') +
          '</div>';
        el.style.display = 'block';
      } catch (err) {
        el.innerHTML = '<div class="title">Verification stats unavailable</div><p class="def">' + esc(err.message) + '</p>';
        el.style.display = 'block';
      }
    }

    async function fetchList() {
      showErr('');
      var q = document.getElementById('q').value.trim();
      var params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (q) params.set('q', q);
      var r = await fetch('/debug/api/admin-users?' + params.toString());
      var j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      total = j.total || 0;
      document.getElementById('page-info').textContent =
        'Showing ' + (j.users.length ? offset + 1 : 0) + '–' + (offset + j.users.length) + ' of ' + total;
      var list = document.getElementById('list');
      list.innerHTML = j.users.map(function (u) {
        var active = selectedHandle === u.handle ? ' active' : '';
        var bc = 'badge';
        if (u.status === 'active') bc += ' badge-active';
        else if (u.status === 'pending') bc += ' badge-pending';
        else if (u.status) bc += ' badge-other';
        var st = u.status ? '<span class="' + bc + '">' + esc(u.status) + '</span>' : '';
        return '<div class="user-row' + active + '" data-handle="' + esc(u.handle) + '">' +
          '<div class="h">' + esc(u.handle) + st + '</div>' +
          '<div class="m">' + esc(u.name || 'No name') + ' · last seen ' + fmtTs(u.last_seen) + '</div></div>';
      }).join('') || '<div class="user-row" style="cursor:default;color:#6b7280;">No users match.</div>';

      Array.prototype.forEach.call(list.querySelectorAll('.user-row[data-handle]'), function (el) {
        el.addEventListener('click', function () {
          loadDetail(el.getAttribute('data-handle'));
        });
      });
    }

    function renderAccounts(linked) {
      var parts = [];
      (linked.google || []).forEach(function (g) {
        parts.push('Google: ' + g.google_email + (g.is_primary ? ' (primary)' : ''));
      });
      (linked.microsoft || []).forEach(function (m) {
        parts.push('Microsoft: ' + m.microsoft_email + (m.is_primary ? ' (primary)' : ''));
      });
      (linked.granola || []).forEach(function (g) {
        parts.push('Granola: ' + g.granola_email + (g.is_primary ? ' (primary)' : ''));
      });
      return parts.length ? '<pre>' + esc(parts.join('\\n')) + '</pre>' : '<p style="font-size:13px;color:#6b7280;">No linked OAuth accounts.</p>';
    }

    function renderTable(rows, columns) {
      if (!rows || !rows.length) return '<p style="font-size:13px;color:#6b7280;">None</p>';
      var th = columns.map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('');
      var tb = rows.map(function (row) {
        return '<tr>' + columns.map(function (c) {
          var v = typeof c.get === 'function' ? c.get(row) : row[c.key];
          return '<td class="' + (c.mono ? 'mono' : '') + '">' + esc(v) + '</td>';
        }).join('') + '</tr>';
      }).join('');
      return '<table><thead><tr>' + th + '</tr></thead><tbody>' + tb + '</tbody></table>';
    }

    function renderMemoryDigest(items) {
      var rows = Array.isArray(items) ? items : [];
      if (!rows.length) {
        return '<p style="font-size:13px;color:#6b7280;">No active memory items from <code>get_active_memory_items</code>.</p>';
      }
      return renderTable(rows, [
        { label: 'Type', key: 'memory_type' },
        { label: 'Category', key: 'category' },
        {
          label: 'Value',
          get: function (r) {
            var t = r.value_text != null ? String(r.value_text) : '';
            return t.length > 220 ? t.slice(0, 220) + '…' : t;
          },
        },
        {
          label: 'Normalised',
          mono: true,
          get: function (r) {
            var n = r.normalized_value != null ? String(r.normalized_value) : '';
            if (!n) return '—';
            return n.length > 48 ? n.slice(0, 48) + '…' : n;
          },
        },
        {
          label: 'Conf',
          get: function (r) {
            return r.confidence != null ? String(r.confidence) : '—';
          },
        },
        { label: 'Scope', key: 'scope' },
        { label: 'Source', key: 'source_kind' },
        {
          label: 'Last seen',
          get: function (r) {
            return r.last_seen_at ? new Date(r.last_seen_at).toLocaleString('en-AU') : '—';
          },
        },
        {
          label: 'Expires',
          get: function (r) {
            return r.expiry_at ? new Date(r.expiry_at).toLocaleString('en-AU') : '—';
          },
        },
        {
          label: 'Chat',
          mono: true,
          get: function (r) {
            var c = r.chat_id != null ? String(r.chat_id) : '';
            return c || '—';
          },
        },
        {
          label: 'Meta',
          mono: true,
          get: function (r) {
            var m = r.metadata;
            if (m == null) return '—';
            if (typeof m === 'object' && m !== null && !Array.isArray(m) && Object.keys(m).length === 0) return '—';
            var s = typeof m === 'string' ? m : JSON.stringify(m);
            return s.length > 72 ? s.slice(0, 72) + '…' : s;
          },
        },
        { label: 'ID', key: 'id', mono: true },
      ]);
    }

    function wireProfileActions(handle) {
      var saveBtn = document.getElementById('prof-save');
      if (saveBtn) saveBtn.addEventListener('click', function () { void saveProfile(handle); });
      var clearDeepBtn = document.getElementById('prof-clear-deep');
      if (clearDeepBtn) clearDeepBtn.addEventListener('click', function () { void clearDeepSnapshot(handle); });
      var delBtn = document.getElementById('prof-delete');
      if (delBtn) delBtn.addEventListener('click', function () { void runDeleteProfile(handle); });
    }

    function wireUserDetailTabs() {
      var root = document.getElementById('detail');
      var bar = root && root.querySelector('.tabs-container');
      if (!bar) return;
      bar.addEventListener('click', function (ev) {
        var btn = ev.target.closest('.tab-btn');
        if (!btn || !bar.contains(btn)) return;
        var tab = btn.getAttribute('data-tab');
        Array.prototype.forEach.call(bar.querySelectorAll('.tab-btn'), function (b) {
          var on = b === btn;
          b.classList.toggle('active', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        Array.prototype.forEach.call(root.querySelectorAll('.tab-panel'), function (p) {
          var on = p.getAttribute('data-panel') === tab;
          p.classList.toggle('active', on);
        });
      });
    }

    function buildUserDetailTabsHtml(chunks) {
      var defs = [
        ['profile', 'Profile'],
        ['linked', 'Accounts'],
        ['memory', 'Memory'],
        ['activity', 'Activity'],
        ['automations', 'Automations'],
        ['raw', 'JSON'],
        ['danger', 'Delete'],
      ];
      var buttons = defs
        .map(function (d, i) {
          return (
            '<button type="button" class="tab-btn' +
            (i === 0 ? ' active' : '') +
            '" role="tab" data-tab="' +
            esc(d[0]) +
            '" aria-selected="' +
            (i === 0 ? 'true' : 'false') +
            '">' +
            esc(d[1]) +
            '</button>'
          );
        })
        .join('');
      var panels = defs
        .map(function (d, i) {
          var body = chunks[d[0]] || '';
          return (
            '<div class="tab-panel' +
            (i === 0 ? ' active' : '') +
            '" data-panel="' +
            esc(d[0]) +
            '" role="tabpanel">' +
            body +
            '</div>'
          );
        })
        .join('');
      return (
        '<div class="detail-tabs-wrap">' +
        '<div class="tabs-container" role="tablist" aria-label="User detail sections">' +
        buttons +
        '</div></div><div class="tab-panels">' +
        panels +
        '</div>'
      );
    }

    async function clearDeepSnapshot(handle) {
      var msg = document.getElementById('prof-save-msg');
      if (msg) msg.textContent = '';
      var r = await fetch('/debug/api/admin-user?handle=' + encodeURIComponent(handle), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deep_profile_snapshot: null, deep_profile_built_at: null }),
      });
      var j = await r.json();
      if (!r.ok) {
        if (msg) msg.textContent = j.error || 'Failed';
        return;
      }
      if (msg) msg.textContent = 'Deep profile snapshot cleared.';
      await loadDetail(handle);
    }

    async function saveProfile(handle) {
      var msg = document.getElementById('prof-save-msg');
      if (msg) msg.textContent = '';
      var patch = {};
      try {
        var factsRaw = document.getElementById('ed-facts').value.trim();
        patch.facts = factsRaw ? JSON.parse(factsRaw) : [];
        if (!Array.isArray(patch.facts)) throw new Error('facts must be a JSON array');
      } catch (e) {
        if (msg) msg.textContent = 'Facts JSON: ' + e.message;
        return;
      }
      patch.name = document.getElementById('ed-name').value.trim() || null;
      patch.status = document.getElementById('ed-status').value.trim();
      if (!patch.status) {
        if (msg) msg.textContent = 'Status is required.';
        return;
      }
      patch.timezone = document.getElementById('ed-timezone').value.trim() || null;
      patch.bot_number = document.getElementById('ed-bot').value.trim() || null;
      patch.onboard_state = document.getElementById('ed-onboard-state').value.trim() || null;
      patch.use_linq = document.getElementById('ed-use-linq').checked;
      var oc = document.getElementById('ed-onboard-count').value.trim();
      if (oc !== '') {
        var n = parseInt(oc, 10);
        if (!Number.isFinite(n)) {
          if (msg) msg.textContent = 'Onboard count must be a number.';
          return;
        }
        patch.onboard_count = n;
      }
      var as = document.getElementById('ed-activation').value.trim();
      if (as !== '') {
        var n2 = parseInt(as, 10);
        if (!Number.isFinite(n2)) {
          if (msg) msg.textContent = 'Activation score must be a number.';
          return;
        }
        patch.activation_score = n2;
      }
      var fs = document.getElementById('ed-first-seen').value.trim();
      if (fs !== '') {
        var n3 = parseInt(fs, 10);
        if (!Number.isFinite(n3)) {
          if (msg) msg.textContent = 'First seen must be epoch seconds.';
          return;
        }
        patch.first_seen = n3;
      }
      var ls = document.getElementById('ed-last-seen').value.trim();
      if (ls !== '') {
        var n4 = parseInt(ls, 10);
        if (!Number.isFinite(n4)) {
          if (msg) msg.textContent = 'Last seen must be epoch seconds.';
          return;
        }
        patch.last_seen = n4;
      }
      var au = document.getElementById('ed-auth-user').value.trim();
      patch.auth_user_id = au || null;

      var r = await fetch('/debug/api/admin-user?handle=' + encodeURIComponent(handle), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      var j = await r.json();
      if (!r.ok) {
        if (msg) msg.textContent = j.error || 'Save failed';
        return;
      }
      if (msg) msg.textContent = 'Saved.';
      await loadDetail(handle);
      await fetchList();
    }

    async function runDeleteProfile(handle) {
      var msg = document.getElementById('prof-del-msg');
      if (msg) msg.textContent = '';
      var confirmVal = document.getElementById('del-confirm').value.trim();
      if (confirmVal !== handle) {
        if (msg) msg.textContent = 'Type the exact handle to confirm.';
        return;
      }
      var delAuth = document.getElementById('del-auth').checked;
      var w = delAuth
        ? 'This will delete all Nest data for this handle AND remove the Supabase Auth user (OAuth accounts, uploads). Continue?'
        : 'This will delete Nest data for this handle but leave the Auth user (if any). OAuth rows may be orphaned. Continue?';
      if (!window.confirm(w)) return;

      var r = await fetch('/debug/api/admin-user?handle=' + encodeURIComponent(handle), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmHandle: confirmVal, deleteAuthUser: delAuth }),
      });
      var j = await r.json();
      if (!r.ok) {
        if (msg) msg.textContent = j.error || 'Delete failed';
        return;
      }
      if (j.errors && j.errors.length) {
        if (msg) msg.textContent = 'Completed with errors: ' + j.errors.join('; ');
      } else if (msg) {
        msg.textContent = 'Deleted.';
      }
      selectedHandle = null;
      document.getElementById('placeholder').style.display = 'block';
      document.getElementById('detail').style.display = 'none';
      document.getElementById('detail').innerHTML = '';
      await fetchList();
      await loadVerificationSummary();
    }

    async function loadDetail(handle) {
      selectedHandle = handle;
      showErr('');
      document.getElementById('placeholder').style.display = 'none';
      document.getElementById('detail').style.display = 'block';
      document.getElementById('detail').innerHTML = '<p style="color:#6b7280;">Loading…</p>';
      Array.prototype.forEach.call(document.querySelectorAll('.user-row'), function (el) {
        el.classList.toggle('active', el.getAttribute('data-handle') === handle);
      });
      try {
        var r = await fetch('/debug/api/admin-user-detail?handle=' + encodeURIComponent(handle));
        var j = await r.json();
        if (!r.ok) throw new Error(j.error || r.statusText);
        var p = j.profile || {};
        var verLabel = p.status === 'active' ? 'Verified (active)' : p.status === 'pending' ? 'Pending verification' : 'Status: ' + (p.status || '—');
        var head =
          '<div class="detail-head"><div class="handle">' + esc(p.handle) + '</div>' +
          '<div class="meta">' + esc(p.name || '—') + ' · <strong>' + esc(verLabel) + '</strong>' +
          ' · onboard_state ' + esc(p.onboard_state || '—') +
          ' · active memories ' + esc(j.counts && j.counts.active_memory_items) +
          ' · turns (7d) ' + esc(j.counts && j.counts.turns_last_7d) + '</div></div>';

        var factsStr = JSON.stringify(p.facts != null ? p.facts : [], null, 2);
        var editForm =
          '<div class="section" id="edit-profile-section"><h3>Edit profile</h3>' +
          '<p class="form-hint">Updates allowlisted columns on <code>user_profiles</code>. The messaging handle is the primary key and cannot be changed here.</p>' +
          '<div class="form-grid">' +
          '<label style="grid-column:1/-1">Name<br><input type="text" id="ed-name" class="inp" value="' + esc(p.name || '') + '" autocomplete="off" /></label>' +
          '<label>Status<br><input type="text" id="ed-status" class="inp mono" list="status-suggestions" value="' + esc(p.status || '') + '" autocomplete="off" /></label>' +
          '<label>Timezone<br><input type="text" id="ed-timezone" class="inp" value="' + esc(p.timezone || '') + '" autocomplete="off" /></label>' +
          '<label>Bot number<br><input type="text" id="ed-bot" class="inp mono" value="' + esc(p.bot_number || '') + '" autocomplete="off" /></label>' +
          '<label>Onboard state<br><input type="text" id="ed-onboard-state" class="inp mono" value="' + esc(p.onboard_state || '') + '" autocomplete="off" /></label>' +
          '<label>Onboard count<br><input type="number" id="ed-onboard-count" class="inp" value="' + esc(p.onboard_count != null ? String(p.onboard_count) : '') + '" /></label>' +
          '<label>Activation score<br><input type="number" id="ed-activation" class="inp" value="' + esc(p.activation_score != null ? String(p.activation_score) : '') + '" /></label>' +
          '<label>First seen<br><span class="epoch-preview">' +
          esc(fmtEpochProfile(p.first_seen, false)) +
          '</span><span class="epoch-preview muted">Stored as unix seconds (edit below if needed)</span>' +
          '<input type="text" id="ed-first-seen" class="inp mono" value="' +
          esc(p.first_seen != null ? String(p.first_seen) : '') +
          '" autocomplete="off" placeholder="e.g. 1773814602" /></label>' +
          '<label>Last seen<br><span class="epoch-preview">' +
          esc(fmtEpochProfile(p.last_seen, false)) +
          '</span><span class="epoch-preview muted">Stored as unix seconds (edit below if needed)</span>' +
          '<input type="text" id="ed-last-seen" class="inp mono" value="' +
          esc(p.last_seen != null ? String(p.last_seen) : '') +
          '" autocomplete="off" placeholder="e.g. 1773814602" /></label>' +
          '<label style="grid-column:1/-1">Auth user ID (UUID, empty to clear)<br><input type="text" id="ed-auth-user" class="inp mono" value="' + esc(p.auth_user_id || '') + '" autocomplete="off" /></label>' +
          '<label class="chk" style="grid-column:1/-1"><input type="checkbox" id="ed-use-linq" ' + (p.use_linq ? 'checked' : '') + ' /> Use Linq delivery</label>' +
          '<label style="grid-column:1/-1">Facts (JSON array)<br><textarea id="ed-facts" class="inp" autocomplete="off">' + esc(factsStr) + '</textarea></label>' +
          '</div>' +
          '<datalist id="status-suggestions"><option value="active"></option><option value="pending"></option></datalist>' +
          '<div class="form-actions">' +
          '<button type="button" class="btn" id="prof-save">Save changes</button>' +
          '<button type="button" class="btn" id="prof-clear-deep">Clear deep profile snapshot</button>' +
          '<span id="prof-save-msg" class="form-msg"></span></div></div>';

        var flags =
          '<div class="section"><h3>Flags</h3><pre>' +
          esc(JSON.stringify({
            use_linq: p.use_linq,
            timezone: p.timezone,
            bot_number: p.bot_number,
            auth_user_id: p.auth_user_id,
            onboard_count: p.onboard_count,
            activation_score: p.activation_score,
            proactive_ignore_count: p.proactive_ignore_count,
            last_proactive_sent_at: p.last_proactive_sent_at,
            activated_at: p.activated_at,
            first_seen: fmtEpochProfile(p.first_seen, true),
            last_seen: fmtEpochProfile(p.last_seen, true),
          }, null, 2)) +
          '</pre></div>';

        var accounts = '<div class="section"><h3>Linked accounts</h3>' + renderAccounts(j.linkedAccounts || {}) + '</div>';

        var deep =
          '<div class="section"><h3>Deep profile snapshot</h3>' +
          (j.deep_profile_preview
            ? '<p style="font-size:12px;color:#6b7280;margin-bottom:6px;">Built: ' + esc(j.deep_profile_built_at || '—') +
              (j.deep_profile_truncated ? ' (truncated for display)' : '') + '</p><pre>' + esc(j.deep_profile_preview) + '</pre>'
            : '<p style="font-size:13px;color:#6b7280;">No snapshot stored.</p>') +
          '</div>';

        var mem =
          '<div class="section"><h3>Memory (active)</h3>' +
          '<p class="form-hint" style="margin-top:0">Rows from <code>get_active_memory_items</code>. Scan the table first, then use raw JSON for full fields (<code>first_seen_at</code>, <code>created_at</code>, etc.).</p>' +
          '<div class="memory-table-wrap">' +
          renderMemoryDigest(j.memoryItemsSample || []) +
          '</div>' +
          '<h4 class="memory-raw-heading">Raw JSON</h4>' +
          '<pre class="memory-raw-pre">' +
          esc(JSON.stringify(j.memoryItemsSample || [], null, 2)) +
          '</pre></div>';

        var turns = '<div class="section"><h3>Recent turns</h3>' +
          renderTable(j.recentTurns || [], [
            { label: 'When', get: function (r) { return r.created_at ? new Date(r.created_at).toLocaleString('en-AU') : ''; } },
            { label: 'Agent', key: 'agent_name' },
            { label: 'Model', key: 'model_used', mono: true },
            { label: 'Latency ms', key: 'total_latency_ms' },
            { label: 'Error', key: 'error_message', mono: true }
          ]) + '</div>';

        var ob = '<div class="section"><h3>Onboarding events</h3>' +
          renderTable(j.recentOnboardingEvents || [], [
            { label: 'When', get: function (r) { return r.created_at ? new Date(r.created_at).toLocaleString('en-AU') : ''; } },
            { label: 'Type', key: 'event_type' },
            { label: 'State', key: 'current_state' }
          ]) + '</div>';

        var msgs = '<div class="section"><h3>Recent messages (chat_id = handle)</h3>' +
          renderTable(j.recentConversationMessages || [], [
            { label: 'When', get: function (r) { return r.created_at ? new Date(r.created_at).toLocaleString('en-AU') : ''; } },
            { label: 'Role', key: 'role' },
            { label: 'Preview', get: function (r) { return (r.content || '').slice(0, 120); } }
          ]) + '</div>';

        var auto = '<div class="section"><h3>Automation runs</h3>' +
          renderTable(j.recentAutomationRuns || [], [
            { label: 'Sent', get: function (r) { return r.sent_at ? new Date(r.sent_at).toLocaleString('en-AU') : ''; } },
            { label: 'Type', key: 'automation_type' },
            { label: 'Ignored', key: 'ignored' }
          ]) + '</div>';

        var summ = '<div class="section"><h3>Conversation summaries</h3><pre>' +
          esc(JSON.stringify(j.conversationSummaries || [], null, 2)) + '</pre></div>';

        var delSection =
          '<div class="section"><h3>Delete user data</h3>' +
          '<p class="form-hint">Removes rows for this handle: messages, memory, turns, webhooks, RAG documents, automations, reminders, notification watches, group memberships, and the <code>user_profiles</code> row. Optionally also calls <code>auth.admin.deleteUser</code> (needs service role key on this server).</p>' +
          '<label class="chk"><input type="checkbox" id="del-auth" /> Also delete Supabase Auth user (OAuth + uploads cascade)</label>' +
          '<label style="display:block;margin-top:10px;font-size:11px;font-weight:600;color:var(--muted);">Type handle to confirm<br>' +
          '<input type="text" id="del-confirm" class="inp mono" style="max-width:100%" autocomplete="off" placeholder="' + esc(handle) + '" /></label>' +
          '<div class="form-actions" style="margin-top:12px">' +
          '<button type="button" class="btn btn-danger" id="prof-delete">Delete permanently</button>' +
          '<span id="prof-del-msg" class="form-msg"></span></div></div>';

        var pForDisplay = Object.assign({}, p);
        if (p.first_seen != null) {
          pForDisplay.first_seen = fmtEpochProfile(p.first_seen, true);
        }
        if (p.last_seen != null) {
          pForDisplay.last_seen = fmtEpochProfile(p.last_seen, true);
        }
        var raw =
          '<div class="section"><h3>Full profile row (JSON)</h3>' +
          '<p class="form-hint" style="margin-top:0"><code>first_seen</code> and <code>last_seen</code> are shown as local timestamps plus unix seconds; the database still stores integers.</p>' +
          '<pre>' +
          esc(JSON.stringify(pForDisplay, null, 2)) +
          '</pre></div>';

        var tabChunks = {
          profile: head + editForm + flags,
          linked: accounts + deep,
          memory: mem,
          activity: turns + msgs + summ,
          automations: ob + auto,
          raw: raw,
          danger: delSection,
        };
        document.getElementById('detail').innerHTML = buildUserDetailTabsHtml(tabChunks);
        wireProfileActions(handle);
        wireUserDetailTabs();
      } catch (e) {
        document.getElementById('detail').innerHTML = '<p class="err" style="display:block;">' + esc(e.message) + '</p>';
      }
    }

    document.getElementById('go').addEventListener('click', function () { offset = 0; fetchList().catch(function (e) { showErr(e.message); }); });
    document.getElementById('q').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { offset = 0; fetchList().catch(function (e) { showErr(e.message); }); }
    });
    document.getElementById('prev').addEventListener('click', function () {
      offset = Math.max(0, offset - limit);
      fetchList().catch(function (e) { showErr(e.message); });
    });
    document.getElementById('next').addEventListener('click', function () {
      if (offset + limit < total) offset += limit;
      fetchList().catch(function (e) { showErr(e.message); });
    });

    loadVerificationSummary();
    fetchList().catch(function (e) { showErr(e.message); });
  </script>
</body>
</html>
`;
