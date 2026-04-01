/** Brand admin UI for Nest server — same API as website BrandAdmin (/api/admin-brands). */
export const brandsAdminHtml = `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nest — Brand admin</title>
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
    min-height: 100dvh;
  }
  .hidden { display: none !important; }
  .card {
    width: 100%;
    max-width: 420px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 24px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.04);
  }
  .card h1 { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
  .card p { font-size: 13px; color: var(--muted); margin-bottom: 16px; }
  .card code { font-size: 11px; background: #f3f4f6; padding: 2px 6px; border-radius: var(--radius); }
  input[type="password"], input[type="text"], textarea {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 13px;
    font-family: inherit;
    margin-bottom: 12px;
  }
  textarea { min-height: 120px; resize: vertical; font-family: ui-monospace, monospace; font-size: 12px; }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 500;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    cursor: pointer;
    font-family: inherit;
  }
  .btn:hover { background: #f9fafb; }
  .btn-primary { background: #111827; color: #fff; border-color: #111827; }
  .btn-primary:hover { background: #374151; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .alert {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 12px;
    font-size: 13px;
    color: #991b1b;
    margin-bottom: 12px;
  }
  #main-app header {
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    position: sticky;
    top: 0;
    z-index: 5;
    padding: 12px 16px;
  }
  .header-inner {
    max-width: 1152px;
    margin: 0 auto;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    justify-content: space-between;
  }
  .header-inner h1 { font-size: 18px; font-weight: 600; }
  .header-inner .sub { font-size: 11px; color: var(--muted); }
  .header-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .wrap {
    max-width: 1152px;
    margin: 0 auto;
    padding: 24px 16px 48px;
  }
  .layout { display: flex; flex-direction: column; gap: 24px; }
  @media (min-width: 1024px) {
    .layout { flex-direction: row; align-items: flex-start; }
    .col-list { flex: 1; min-width: 0; }
    .col-edit { width: min(100%, 480px); flex-shrink: 0; }
  }
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .panel-h { padding: 12px 16px; border-bottom: 1px solid #f3f4f6; font-size: 13px; font-weight: 600; color: #374151; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 11px; font-weight: 600; color: var(--muted); padding: 8px 16px; border-bottom: 1px solid #f3f4f6; }
  td { padding: 10px 16px; border-bottom: 1px solid #f9fafb; vertical-align: top; }
  tr.row-brand { cursor: pointer; }
  tr.row-brand:hover { background: #fafafa; }
  tr.row-brand.active { background: #f3f4f6; box-shadow: inset 0 0 0 1px var(--border); }
  .mono { font-family: ui-monospace, monospace; font-size: 11px; }
  .badge {
    display: inline-block;
    font-size: 10px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 6px;
    background: #f3f4f6;
    color: #374151;
  }
  .editor-body { padding: 16px; max-height: calc(100dvh - 220px); overflow-y: auto; }
  label.block { display: block; margin-bottom: 12px; }
  label.block span { display: block; font-size: 11px; font-weight: 600; color: #4b5563; margin-bottom: 4px; }
  .hint-box {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 12px;
    font-size: 11px;
    color: #4b5563;
    margin-bottom: 16px;
  }
  .empty { padding: 32px; text-align: center; color: var(--muted); font-size: 13px; }
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    z-index: 50;
    animation: fadeIn 0.2s ease-out;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  .modal {
    width: 100%;
    max-width: 420px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.12);
    animation: popIn 0.3s ease-out;
  }
  @keyframes popIn {
    from { opacity: 0; transform: translateY(8px) scale(0.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .modal h2 { font-size: 17px; font-weight: 600; margin-bottom: 4px; }
  .modal-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  a.link { color: #374151; font-size: 11px; }
  .spin { animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div id="main-app">
    <header>
      <div class="header-inner">
        <div>
          <h1>Brand admin</h1>
          <div class="sub">Manage triggers, prompts, and onboarding</div>
        </div>
        <div class="header-actions">
          <button type="button" class="btn" id="btn-refresh">Refresh</button>
          <button type="button" class="btn btn-primary" id="btn-new">New brand</button>
        </div>
      </div>
    </header>
    <div class="wrap">
      <div id="app-err" class="alert hidden" style="margin-bottom:16px"></div>
      <div class="layout">
        <div class="col-list panel">
          <div class="panel-h">All brands</div>
          <div style="overflow-x:auto">
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Name</th>
                  <th>Prompt</th>
                  <th>Job</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="brand-tbody"></tbody>
            </table>
            <div id="brand-empty" class="empty hidden">No brands in config yet.</div>
          </div>
        </div>
        <div class="col-edit panel">
          <div class="panel-h">Editor</div>
          <div class="editor-body" id="editor-body">
            <p class="empty" style="padding:0">Select a brand from the table.</p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="modal-root" class="hidden"></div>

  <script>
(function () {
  var appErr = document.getElementById('app-err');
  var tbody = document.getElementById('brand-tbody');
  var brandEmpty = document.getElementById('brand-empty');
  var editorBody = document.getElementById('editor-body');
  var modalRoot = document.getElementById('modal-root');

  var list = [];
  var selectedKey = null;
  var detail = null;
  var loading = false;

  function authHeaders() {
    return { 'Content-Type': 'application/json' };
  }

  function showAppErr(msg) {
    appErr.textContent = msg;
    appErr.classList.remove('hidden');
  }
  function hideAppErr() {
    appErr.classList.add('hidden');
  }

  async function refreshList() {
    hideAppErr();
    loading = true;
    try {
      var res = await fetch('/api/admin-brands?list=1', { headers: authHeaders() });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'List failed');
      list = data.brands || [];
      renderTable();
      if (selectedKey) await loadDetail(selectedKey);
    } catch (e) {
      showAppErr(e.message || 'List failed');
    } finally {
      loading = false;
    }
  }

  function renderTable() {
    tbody.innerHTML = '';
    if (!list.length) {
      brandEmpty.classList.remove('hidden');
      return;
    }
    brandEmpty.classList.add('hidden');
    list.forEach(function (row) {
      var tr = document.createElement('tr');
      tr.className = 'row-brand' + (selectedKey === row.brand_key ? ' active' : '');
      var job = row.last_job;
      var jobCell = '—';
      if (job) {
        jobCell = '<span class="badge">' + String(job.status).replace(/</g, '') + '</span>';
      }
      var promptCell = row.has_prompt ? (Number(row.prompt_chars).toLocaleString() + ' chars') : '—';
      tr.innerHTML =
        '<td class="mono">' + escapeHtml(row.brand_key) + '</td>' +
        '<td>' + escapeHtml(row.business_display_name || '—') + '</td>' +
        '<td class="mono" style="font-size:11px">' + promptCell + '</td>' +
        '<td>' + jobCell + '</td>' +
        '<td><a class="link" href="/try/' + encodeURIComponent(row.brand_key) + '" target="_blank" rel="noopener">PLG ↗</a></td>';
      tr.addEventListener('click', function (e) {
        if (e.target.closest('a')) return;
        loadDetail(row.brand_key);
      });
      tbody.appendChild(tr);
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function loadDetail(brandKey) {
    selectedKey = brandKey;
    renderTable();
    editorBody.innerHTML = '<p class="empty" style="padding:0">Loading…</p>';
    hideAppErr();
    try {
      var res = await fetch('/api/admin-brands?brandKey=' + encodeURIComponent(brandKey), { headers: authHeaders() });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Load failed');
      detail = data.brand;
      detail._aliasesInput = (detail.activation_aliases || []).join(', ');
      renderEditor();
    } catch (e) {
      editorBody.innerHTML = '<p class="empty" style="padding:0;color:#991b1b">' + escapeHtml(e.message) + '</p>';
    }
  }

  function fieldVal(key) {
    var el = document.getElementById('f-' + key);
    return el ? el.value : '';
  }

  function renderEditor() {
    if (!detail) return;
    var d = detail;
    var h =
      '<div class="hint-box">Primary trigger: <strong class="mono">Hey ' + escapeHtml(d.brand_key) + '</strong><br/>' +
      'Aliases are extra single words (no spaces). Same as iMessage activation format.</div>' +
      '<label class="block"><span>Business display name</span><input type="text" id="f-business_display_name" value="' + escapeAttr(d.business_display_name || '') + '" /></label>' +
      '<label class="block"><span>Extra trigger words (comma-separated)</span><input type="text" id="f-aliases" class="mono" value="' + escapeAttr(d._aliasesInput || '') + '" placeholder="reformer, reform" /></label>' +
      '<label class="block"><span>Core system prompt</span><textarea id="f-core_system_prompt">' + escapeHtml(d.core_system_prompt || '') + '</textarea></label>' +
      '<label class="block"><span>Opening line</span><textarea id="f-opening_line">' + escapeHtml(d.opening_line || '') + '</textarea></label>' +
      '<label class="block"><span>Contact</span><textarea id="f-contact_text">' + escapeHtml(d.contact_text || '') + '</textarea></label>' +
      '<label class="block"><span>Hours</span><textarea id="f-hours_text">' + escapeHtml(d.hours_text || '') + '</textarea></label>' +
      '<label class="block"><span>Pricing</span><textarea id="f-prices_text">' + escapeHtml(d.prices_text || '') + '</textarea></label>' +
      '<label class="block"><span>Services / products</span><textarea id="f-services_products_text">' + escapeHtml(d.services_products_text || '') + '</textarea></label>' +
      '<label class="block"><span>Booking</span><textarea id="f-booking_info_text">' + escapeHtml(d.booking_info_text || '') + '</textarea></label>' +
      '<label class="block"><span>Policies</span><textarea id="f-policies_text">' + escapeHtml(d.policies_text || '') + '</textarea></label>' +
      '<label class="block"><span>Extra knowledge</span><textarea id="f-extra_knowledge">' + escapeHtml(d.extra_knowledge || '') + '</textarea></label>' +
      '<label class="block"><span>Style template</span><input type="text" id="f-style_template" value="' + escapeAttr(d.style_template || '') + '" /></label>' +
      '<label class="block"><span>Style notes</span><textarea id="f-style_notes">' + escapeHtml(d.style_notes || '') + '</textarea></label>' +
      '<label class="block"><span>Topics to avoid</span><textarea id="f-topics_to_avoid">' + escapeHtml(d.topics_to_avoid || '') + '</textarea></label>' +
      '<label class="block"><span>Escalation</span><textarea id="f-escalation_text">' + escapeHtml(d.escalation_text || '') + '</textarea></label>' +
      '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">' +
      '<button type="button" class="btn btn-primary" id="btn-save">Save changes</button>' +
      '<button type="button" class="btn" id="btn-gen">Run prompt generation</button>' +
      '<a class="btn" href="/signup" target="_blank" rel="noopener" style="text-decoration:none">Full onboarding flow</a>' +
      '</div>' +
      '<div id="gen-msg" class="hint-box hidden" style="margin-top:12px"></div>';
    editorBody.innerHTML = h;
    document.getElementById('btn-save').addEventListener('click', saveDetail);
    document.getElementById('btn-gen').addEventListener('click', triggerGenerate);
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  async function saveDetail() {
    if (!detail) return;
    var aliases = fieldVal('aliases').split(/[,;\\s]+/).map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
    hideAppErr();
    var body = {
      brandKey: detail.brand_key,
      business_display_name: fieldVal('business_display_name'),
      activation_aliases: aliases,
      core_system_prompt: fieldVal('core_system_prompt'),
      opening_line: fieldVal('opening_line'),
      hours_text: fieldVal('hours_text'),
      prices_text: fieldVal('prices_text'),
      services_products_text: fieldVal('services_products_text'),
      policies_text: fieldVal('policies_text'),
      contact_text: fieldVal('contact_text'),
      booking_info_text: fieldVal('booking_info_text'),
      extra_knowledge: fieldVal('extra_knowledge'),
      style_template: fieldVal('style_template'),
      style_notes: fieldVal('style_notes'),
      topics_to_avoid: fieldVal('topics_to_avoid'),
      escalation_text: fieldVal('escalation_text')
    };
    var btn = document.getElementById('btn-save');
    btn.disabled = true;
    try {
      var res = await fetch('/api/admin-brands', { method: 'PATCH', headers: authHeaders(), body: JSON.stringify(body) });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Save failed');
      await refreshList();
    } catch (e) {
      showAppErr(e.message || 'Save failed');
    } finally {
      btn.disabled = false;
    }
  }

  async function triggerGenerate() {
    var jobId = window.prompt('Paste nest_brand_onboard_jobs.id (UUID) after scrape has finished:');
    if (!jobId || !jobId.trim()) return;
    var msgEl = document.getElementById('gen-msg');
    msgEl.classList.add('hidden');
    try {
      var res = await fetch('/api/admin-brands', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ action: 'trigger_generate', jobId: jobId.trim() })
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Generate failed');
      msgEl.textContent = 'Generation started. Wait a few minutes, then refresh the list.';
      msgEl.classList.remove('hidden');
      await refreshList();
    } catch (e) {
      msgEl.textContent = e.message || 'Failed';
      msgEl.classList.remove('hidden');
    }
  }

  function openModal() {
    modalRoot.classList.remove('hidden');
    modalRoot.innerHTML =
      '<div class="modal-backdrop" id="mb">' +
      '<div class="modal" id="md">' +
      '<h2>New brand</h2>' +
      '<p style="font-size:11px;color:#6b7280;margin-bottom:12px">Creates <code>nest_brand_chat_config</code> and portal secret. Optional: start website scrape.</p>' +
      '<input type="text" id="m-key" placeholder="brand_key (lowercase)" style="margin-bottom:8px" />' +
      '<input type="text" id="m-name" placeholder="Business display name" style="margin-bottom:8px" />' +
      '<input type="text" id="m-url" placeholder="Website URL (for scrape)" style="margin-bottom:8px" />' +
      '<input type="password" id="m-pw" placeholder="Portal password (default = brand key)" style="margin-bottom:8px" />' +
      '<input type="text" id="m-alias" placeholder="Extra triggers, comma-separated" class="mono" style="margin-bottom:8px" />' +
      '<div id="m-err" class="alert hidden"></div>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn" id="m-cancel">Cancel</button>' +
      '<button type="button" class="btn" id="m-create">Create only</button>' +
      '<button type="button" class="btn btn-primary" id="m-scrape">Create + scrape</button>' +
      '</div></div></div>';
    document.getElementById('m-cancel').addEventListener('click', closeModal);
    document.getElementById('mb').addEventListener('click', function (e) { if (e.target.id === 'mb') closeModal(); });
    document.getElementById('m-create').addEventListener('click', function () { submitModal(false); });
    document.getElementById('m-scrape').addEventListener('click', function () { submitModal(true); });
    document.getElementById('m-key').addEventListener('input', function (e) {
      e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    });
  }

  function closeModal() {
    modalRoot.classList.add('hidden');
    modalRoot.innerHTML = '';
  }

  async function submitModal(scrape) {
    var key = document.getElementById('m-key').value.trim();
    var name = document.getElementById('m-name').value.trim();
    var url = document.getElementById('m-url').value.trim();
    var pw = document.getElementById('m-pw').value.trim();
    var alias = document.getElementById('m-alias').value;
    var mErr = document.getElementById('m-err');
    mErr.classList.add('hidden');
    if (!key || !name) {
      mErr.textContent = 'brand key and name are required';
      mErr.classList.remove('hidden');
      return;
    }
    if (scrape && !url) {
      mErr.textContent = 'Website URL is required for scrape';
      mErr.classList.remove('hidden');
      return;
    }
    try {
      var res = await fetch('/api/admin-brands', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          action: scrape ? 'create_and_scrape' : 'create',
          brandKey: key,
          businessDisplayName: name,
          websiteUrl: url,
          portalPassword: pw || key,
          activationAliases: alias.split(/[,;\\s]+/).filter(Boolean)
        })
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Create failed');
      closeModal();
      await refreshList();
    } catch (e) {
      mErr.textContent = e.message || 'Failed';
      mErr.classList.remove('hidden');
    }
  }

  document.getElementById('btn-refresh').addEventListener('click', refreshList);
  document.getElementById('btn-new').addEventListener('click', openModal);

  refreshList();
})();
  </script>
</body>
</html>`;
