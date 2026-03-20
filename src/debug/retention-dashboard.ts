/** Admin retention & frequency: cohort table, DAU trend, weekly bars (Chart.js, grey palette). */
export const retentionDashboardHtml = `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nest — Retention</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
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
  .sub { font-size: 13px; color: var(--muted); margin-bottom: 16px; max-width: 900px; }
  .toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
  .btn {
    padding: 6px 12px;
    font-size: 13px;
    font-weight: 500;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    cursor: pointer;
  }
  .btn:hover { background: #f9fafb; }
  .status { font-size: 13px; color: var(--muted); }
  .err {
    color: #b91c1c;
    font-size: 13px;
    padding: 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 16px;
  }
  .grid-kpi {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 10px;
    margin-bottom: 20px;
  }
  .kpi {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 14px;
  }
  .kpi { cursor: default; }
  .kpi[title] { cursor: help; }
  .kpi .l { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .kpi .v { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 4px; }
  .kpi .h { font-size: 11px; color: var(--muted); margin-top: 4px; line-height: 1.35; }
  .row2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    margin-bottom: 18px;
  }
  @media (max-width: 960px) { .row2 { grid-template-columns: 1fr; } }
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
  }
  .panel h2 { font-size: 13px; font-weight: 600; margin-bottom: 12px; }
  .panel .cap { font-size: 11px; color: var(--muted); margin-bottom: 10px; line-height: 1.45; }
  .chart-wrap { position: relative; height: 260px; }
  .chart-wrap.tall { height: 300px; }
  table.retention { width: 100%; border-collapse: collapse; font-size: 11px; }
  table.retention th, table.retention td {
    border: 1px solid var(--border);
    padding: 6px 8px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  table.retention th { background: #f9fafb; font-weight: 600; color: var(--muted); }
  table.retention th.row-h { text-align: left; min-width: 88px; }
  table.retention td.row-h { text-align: left; font-weight: 500; background: #fafafa; }
  table.retention .cell-pct { font-weight: 600; }
  table.retention .cell-n { font-size: 10px; color: var(--muted); display: block; }
  .notes { font-size: 12px; color: var(--muted); margin-top: 16px; padding: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
  .notes li { margin-left: 1.2em; margin-top: 4px; }
</style>
</head>
<body>
  <h1>Retention & frequency</h1>
  <p class="sub">
    Built from <code>user_profiles</code> (first_seen, last_seen) and <code>turn_traces</code> (rolling
    <span id="win-days">180</span>-day window from Melbourne midnights). All days and weeks use
    <strong id="tz-label">Australia/Melbourne</strong> (AEST / AEDT). Weeks start Monday. DAU / WAU / MAU use Melbourne calendar days.
  </p>
  <div class="toolbar">
    <button type="button" class="btn" id="refresh">Refresh</button>
    <span class="status" id="status"></span>
  </div>
  <div id="error" class="err" style="display:none;"></div>
  <div id="main" style="display:none;">
    <div class="grid-kpi" id="kpis"></div>
    <div class="panel" style="margin-bottom:18px">
      <h2>Calendar day retention after signup</h2>
      <p class="cap" id="day-ret-def"></p>
      <div class="grid-kpi" id="day-ret-grid"></div>
    </div>
    <div class="panel" style="margin-bottom:18px">
      <h2>Daily active users (turns)</h2>
        <p class="cap">Distinct handles with ≥1 turn per Melbourne calendar day, last 30 days.</p>
      <div class="chart-wrap tall"><canvas id="ch-dau"></canvas></div>
    </div>
    <div class="row2">
      <div class="panel">
        <h2>New profiles by week</h2>
        <p class="cap">Count of loaded <code>user_profiles</code> whose <code>first_seen</code> falls in each Monday week (Melbourne).</p>
        <div class="chart-wrap"><canvas id="ch-signups"></canvas></div>
      </div>
      <div class="panel">
        <h2>Weekly engagement</h2>
        <p class="cap">Unique handles with ≥1 turn per week (bars) and total turn volume (line).</p>
        <div class="chart-wrap tall"><canvas id="ch-weekly"></canvas></div>
      </div>
    </div>
    <div class="row2">
      <div class="panel">
        <h2>Turn frequency (last 30 days)</h2>
        <p class="cap">All user profiles partitioned by turn count in the last 30 Melbourne calendar days.</p>
        <div class="chart-wrap"><canvas id="ch-freq"></canvas></div>
      </div>
      <div class="panel">
        <h2>Distinct active days (last 30 days)</h2>
        <p class="cap">How many different Melbourne calendar days each user had ≥1 turn, counting only days in the last 30 Melbourne days.</p>
        <div class="chart-wrap"><canvas id="ch-days"></canvas></div>
      </div>
    </div>
    <div class="panel">
      <h2>Cohort retention (turn-based)</h2>
      <p class="cap" id="ret-def"></p>
      <div style="overflow-x:auto">
        <table class="retention" id="ret-table"><thead></thead><tbody></tbody></table>
      </div>
    </div>
    <ul class="notes" id="notes" style="display:none"></ul>
  </div>
  <script>
    var charts = [];

    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function destroyCharts() {
      charts.forEach(function (c) { try { c.destroy(); } catch (e) {} });
      charts = [];
    }

    function axisStyle() {
      return {
        ticks: { color: '#6b7280', font: { size: 11 } },
        grid: { color: '#e5e7eb' },
        border: { color: '#e5e7eb' },
      };
    }

    function heatStyle(pct) {
      var p = Math.min(100, Math.max(0, Number(pct) || 0)) / 100;
      var g = Math.round(248 - p * 200);
      return { bg: 'rgb(' + g + ',' + g + ',' + g + ')', fg: p > 0.42 ? '#ffffff' : '#111827' };
    }

    function renderKpis(h) {
      var el = document.getElementById('kpis');
      function k(label, value, hint, explain) {
        var tip = explain ? ' title="' + esc(explain) + '"' : '';
        return (
          '<div class="kpi"' +
          tip +
          '><div class="l">' +
          esc(label) +
          '</div><div class="v">' +
          esc(value) +
          '</div>' +
          (hint ? '<div class="h">' + esc(hint) + '</div>' : '') +
          '</div>'
        );
      }
      el.innerHTML =
        k(
          'Total profiles',
          h.totalProfiles,
          null,
          'How many user profiles we loaded. One profile per Nest handle; this is the full list size in this view.',
        ) +
        k(
          'Verified (active)',
          h.verifiedActiveStatus,
          'user_profiles.status',
          'Profiles marked active in the database. We treat that as verified; pending or other statuses are not included in this count.',
        ) +
        k(
          'New profiles (7d)',
          h.newProfilesLast7d,
          'first_seen',
          'Profiles whose first_seen time falls on one of the last seven Melbourne calendar days—people who showed up as new in that week-long window.',
        ) +
        k(
          'DAU (turns)',
          h.dauTurns,
          'Today (Melbourne day)',
          'How many different people sent at least one message that created a turn trace today, using Melbourne’s date (not UTC midnight).',
        ) +
        k(
          'WAU (turns)',
          h.wauTurns,
          'Last 7 Melbourne days',
          'How many different people had at least one turn on at least one day in the last seven Melbourne days.',
        ) +
        k(
          'MAU (turns)',
          h.mauTurns,
          'Last 30 Melbourne days',
          'How many different people had at least one turn on at least one day in the last thirty Melbourne days.',
        ) +
        k(
          'WAU / MAU',
          h.wauMauStickinessPct != null ? h.wauMauStickinessPct + '%' : '—',
          'Stickiness',
          'Weekly actives divided by monthly actives (as percentages). Roughly: of everyone who used Nest in the last month, what fraction also used it in the last week—higher usually means people keep coming back.',
        ) +
        k(
          'last_seen 1d',
          h.lastSeenActive1d,
          'Melbourne calendar day',
          'Profiles whose last_seen clock falls on today’s Melbourne calendar day. That is a heartbeat from the app or session, and may happen without a new turn.',
        ) +
        k(
          'last_seen 7d',
          h.lastSeenActive7d,
          'Melbourne days',
          'Profiles whose last_seen is on any of the last seven Melbourne days—anyone who checked in or synced recently by that field.',
        ) +
        k(
          'last_seen 30d',
          h.lastSeenActive30d,
          'Melbourne days',
          'Profiles whose last_seen is on any of the last thirty Melbourne days—broader “still around lately” than turns alone.',
        );
    }

    function renderDayRetention(dr) {
      var defEl = document.getElementById('day-ret-def');
      var grid = document.getElementById('day-ret-grid');
      if (!defEl || !grid) return;
      if (!dr || !dr.windows || !dr.windows.length) {
        defEl.textContent = '';
        grid.innerHTML =
          '<div class="kpi" style="grid-column:1/-1"><div class="h">No day retention windows returned.</div></div>';
        return;
      }
      var scope =
        ' Each row only includes users whose signup day plus N falls on or before today and on or after ' +
        esc(dr.dataStartDay) +
        ' (Melbourne), so the target day is inside the loaded turns window.';
      defEl.textContent = (dr.definition || '') + scope;
      grid.innerHTML = dr.windows
        .map(function (w) {
          var pct = w.pct != null ? w.pct + '%' : '—';
          var tip =
            'Eligible: we had turn history covering the Melbourne calendar day that is exactly ' +
            w.days +
            ' days after their signup day. Retained: they logged at least one turn on that day. ' +
            (w.meaning || '');
          return (
            '<div class="kpi" title="' +
            esc(tip) +
            '">' +
            '<div class="l">Day ' +
            esc(w.days) +
            ' (D+' +
            esc(w.days) +
            ')</div>' +
            '<div class="v">' +
            esc(pct) +
            '</div>' +
            '<div class="h">' +
            esc(String(w.retained)) +
            ' retained / ' +
            esc(String(w.eligible)) +
            ' eligible</div>' +
            '<div class="h" style="margin-top:8px">' +
            esc(w.meaning || '') +
            '</div>' +
            '</div>'
          );
        })
        .join('');
    }

    function renderRetentionTable(ret) {
      var thead = document.querySelector('#ret-table thead');
      var tbody = document.querySelector('#ret-table tbody');
      var offs = ret.weekOffsets || [];
      var cohorts = ret.cohorts || [];
      document.getElementById('ret-def').textContent = ret.definition || '';

      var hr = '<tr><th class="row-h">Cohort week</th><th>n</th>';
      offs.forEach(function (o) {
        hr += '<th>W+' + esc(o) + '</th>';
      });
      hr += '</tr>';
      thead.innerHTML = hr;

      tbody.innerHTML = cohorts
        .map(function (row) {
          var cells = offs.map(function (_, i) {
            var pct = row.pctByWeekOffset[i];
            var n = row.activeByWeekOffset[i];
            var st = heatStyle(pct);
            return (
              '<td style="background:' +
              st.bg +
              ';color:' +
              st.fg +
              '"><span class="cell-pct">' +
              esc(pct) +
              '%</span><span class="cell-n">' +
              esc(n) +
              '/' +
              esc(row.size) +
              '</span></td>'
            );
          }).join('');
          return (
            '<tr><td class="row-h mono">' +
            esc(row.cohortWeek) +
            '</td><td>' +
            esc(row.size) +
            '</td>' +
            cells +
            '</tr>'
          );
        })
        .join('');

      if (!cohorts.length) {
        var cw = 2 + offs.length;
        tbody.innerHTML =
          '<tr><td colspan="' +
          cw +
          '" style="text-align:center;color:#6b7280;padding:16px;">Not enough cohort data yet.</td></tr>';
      }
    }

    async function load() {
      var errEl = document.getElementById('error');
      var main = document.getElementById('main');
      var st = document.getElementById('status');
      errEl.style.display = 'none';
      main.style.display = 'none';
      st.textContent = 'Loading…';
      destroyCharts();

      try {
        var r = await fetch('/debug/api/retention-metrics');
        var j = await r.json();
        if (!r.ok) throw new Error(j.error || r.statusText);

        document.getElementById('win-days').textContent = String(j.windowDays || 180);
        var tzEl = document.getElementById('tz-label');
        if (tzEl && j.timezone) tzEl.textContent = j.timezone;
        st.textContent =
          'Updated ' +
          new Date(j.generatedAt).toLocaleString('en-AU') +
          ' · ' +
          (j.turnRowsLoaded || 0) +
          ' turns, ' +
          (j.profileRowsLoaded || 0) +
          ' profiles';

        renderKpis(j.headlines || {});
        renderDayRetention(j.dayRetention || null);

        var notesEl = document.getElementById('notes');
        if (j.notes && j.notes.length) {
          notesEl.style.display = 'block';
          notesEl.innerHTML = '<li>' + j.notes.map(esc).join('</li><li>') + '</li>';
        } else {
          notesEl.style.display = 'none';
        }

        Chart.defaults.color = '#6b7280';
        Chart.defaults.borderColor = '#e5e7eb';
        Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

        var dau = j.dauLast30Days || [];
        charts.push(
          new Chart(document.getElementById('ch-dau'), {
            type: 'line',
            data: {
              labels: dau.map(function (d) { return d.date.slice(5); }),
              datasets: [
                {
                  label: 'DAU',
                  data: dau.map(function (d) { return d.users; }),
                  borderColor: '#374151',
                  backgroundColor: 'rgba(55, 65, 81, 0.08)',
                  fill: true,
                  tension: 0.25,
                  pointRadius: 2,
                  pointHoverRadius: 4,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                x: axisStyle(),
                y: Object.assign({ beginAtZero: true, ticks: { stepSize: 1 } }, axisStyle()),
              },
            },
          }),
        );

        var ws = (j.weeklySignups || []).slice(-26);
        charts.push(
          new Chart(document.getElementById('ch-signups'), {
            type: 'bar',
            data: {
              labels: ws.map(function (x) { return x.week.slice(5); }),
              datasets: [
                {
                  label: 'Signups',
                  data: ws.map(function (x) { return x.count; }),
                  backgroundColor: '#9ca3af',
                  borderRadius: 4,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                x: axisStyle(),
                y: Object.assign({ beginAtZero: true, ticks: { stepSize: 1 } }, axisStyle()),
              },
            },
          }),
        );

        var we = (j.weeklyEngagement || []).slice(-26);
        charts.push(
          new Chart(document.getElementById('ch-weekly'), {
            type: 'bar',
            data: {
              labels: we.map(function (x) { return x.week.slice(5); }),
              datasets: [
                {
                  type: 'bar',
                  label: 'Unique users',
                  data: we.map(function (x) { return x.uniqueUsers; }),
                  backgroundColor: '#d1d5db',
                  borderRadius: 4,
                  yAxisID: 'y',
                },
                {
                  type: 'line',
                  label: 'Turns',
                  data: we.map(function (x) { return x.turns; }),
                  borderColor: '#111827',
                  backgroundColor: 'transparent',
                  yAxisID: 'y1',
                  tension: 0.2,
                  pointRadius: 2,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
              scales: {
                x: axisStyle(),
                y: Object.assign(
                  { beginAtZero: true, position: 'left', title: { display: true, text: 'Users', color: '#9ca3af', font: { size: 10 } } },
                  axisStyle(),
                ),
                y1: Object.assign(
                  {
                    beginAtZero: true,
                    position: 'right',
                    grid: { drawOnChartArea: false },
                    title: { display: true, text: 'Turns', color: '#9ca3af', font: { size: 10 } },
                  },
                  axisStyle(),
                ),
              },
            },
          }),
        );

        var fq = j.frequencyTurnsLast30d || { labels: [], users: [] };
        charts.push(
          new Chart(document.getElementById('ch-freq'), {
            type: 'bar',
            data: {
              labels: fq.labels || [],
              datasets: [
                {
                  data: fq.users || [],
                  backgroundColor: '#6b7280',
                  borderRadius: 4,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                x: axisStyle(),
                y: Object.assign({ beginAtZero: true, ticks: { stepSize: 1 } }, axisStyle()),
              },
            },
          }),
        );

        var da = j.distinctDaysActiveLast30 || { labels: [], users: [] };
        charts.push(
          new Chart(document.getElementById('ch-days'), {
            type: 'bar',
            data: {
              labels: da.labels || [],
              datasets: [
                {
                  data: da.users || [],
                  backgroundColor: '#9ca3af',
                  borderRadius: 4,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                x: axisStyle(),
                y: Object.assign({ beginAtZero: true, ticks: { stepSize: 1 } }, axisStyle()),
              },
            },
          }),
        );

        renderRetentionTable(j.retention || {});

        main.style.display = 'block';
      } catch (e) {
        st.textContent = '';
        errEl.textContent = e.message || String(e);
        errEl.style.display = 'block';
      }
    }

    document.getElementById('refresh').addEventListener('click', load);
    load();
  </script>
</body>
</html>
`;
