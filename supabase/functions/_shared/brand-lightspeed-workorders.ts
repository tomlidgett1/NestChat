import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const LIGHTSPEED_PROVIDER = 'lightspeed';

const WORKORDER_STATUS_LABELS: Record<number, string> = {
  1: 'Open',
  4: 'Finished (awaiting collection/payment)',
  8: 'Due Today',
};

function statusLabel(id: number | null | undefined): string {
  if (id == null) return 'Unknown';
  return WORKORDER_STATUS_LABELS[id] ?? `Status ${id}`;
}

/** Triggers a read from mirrored `nest_brand_lightspeed_workorder` rows. */
export const WORKORDER_QUERY_RE =
  /(\bwork\s*orders?\b|\bworkorders?\b|\bservice\b|\bservicing\b|\bservices\b|\brepairs?\b|\brepaired\b|\bbike\s+service\b|\bbikes?\s+being\s+serviced\b|\bworkshop\b|\bjobs?\b|\bdrop.?off\b|\bdropped\s+off\b|\bcollect(?:ion|ed)?\b|\bdue\s+today\b|\bdue\s+tomorrow\b|\beta\b|\bfinished\b|\bawaiting\b|\bpick\s*up\b|\bready\b|\bbike\s+done\b|\bdone\s+yet\b|\bstatus\s+of\b|how\s+many\s+bikes|any\s+(?:services?|repairs?|jobs?|work)\s+(?:in|on|due|for|tomorrow|today|this\s+week)|(?:is|are)\s+\w+(?:'s)?\s+bike)/i;

export function messageSuggestsWorkorderQuery(message: string): boolean {
  return WORKORDER_QUERY_RE.test(message.trim());
}

function melbourneYmd(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function melbourneWeekday(d: Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    weekday: 'long',
  }).format(d);
}

function melbourneLongDate(dateStr: string): string {
  const parts = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d);
}

type DateWindow = { label: string; fromYmd: string; toYmd: string };

function resolveDateWindow(message: string): DateWindow | null {
  const now = new Date();
  const todayYmd = melbourneYmd(now);
  const lower = message.toLowerCase();

  const yesterdayDate = new Date(now.getTime() - 86_400_000);
  const yesterdayYmd = melbourneYmd(yesterdayDate);
  const tomorrowDate = new Date(now.getTime() + 86_400_000);
  const tomorrowYmd = melbourneYmd(tomorrowDate);

  if (/\byesterday\b/.test(lower)) {
    return { label: `Yesterday (${melbourneLongDate(yesterdayYmd)})`, fromYmd: yesterdayYmd, toYmd: yesterdayYmd };
  }
  if (/\btomorrow\b/.test(lower)) {
    return { label: `Tomorrow (${melbourneLongDate(tomorrowYmd)})`, fromYmd: tomorrowYmd, toYmd: tomorrowYmd };
  }
  if (/\btoday\b|\bdue today\b/.test(lower)) {
    return { label: `Today (${melbourneLongDate(todayYmd)})`, fromYmd: todayYmd, toYmd: todayYmd };
  }

  const dayNames = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  for (const dayName of dayNames) {
    if (new RegExp(`\\b${dayName}\\b`, 'i').test(lower)) {
      for (let offset = -7; offset <= 7; offset++) {
        const candidate = new Date(now.getTime() + offset * 86_400_000);
        const candidateDay = new Intl.DateTimeFormat('en-AU', {
          timeZone: 'Australia/Melbourne',
          weekday: 'long',
        }).format(candidate).toLowerCase();
        if (candidateDay === dayName) {
          const ymd = melbourneYmd(candidate);
          if (/\blast\b/.test(lower) && offset < 0) {
            return { label: `Last ${dayName.charAt(0).toUpperCase() + dayName.slice(1)} (${melbourneLongDate(ymd)})`, fromYmd: ymd, toYmd: ymd };
          }
          if (offset > 0 && !/\blast\b/.test(lower)) {
            return { label: `${dayName.charAt(0).toUpperCase() + dayName.slice(1)} (${melbourneLongDate(ymd)})`, fromYmd: ymd, toYmd: ymd };
          }
          if (offset <= 0) {
            return { label: `${dayName.charAt(0).toUpperCase() + dayName.slice(1)} (${melbourneLongDate(ymd)})`, fromYmd: ymd, toYmd: ymd };
          }
        }
      }
    }
  }

  if (/\bthis\s+week\b/.test(lower)) {
    const dayOfWeek = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'long' }).format(now).toLowerCase();
    const dayIdx = dayNames.indexOf(dayOfWeek);
    const mondayOffset = dayIdx >= 0 ? -dayIdx : 0;
    const mondayDate = new Date(now.getTime() + mondayOffset * 86_400_000);
    const sundayDate = new Date(mondayDate.getTime() + 6 * 86_400_000);
    return { label: 'This week', fromYmd: melbourneYmd(mondayDate), toYmd: melbourneYmd(sundayDate) };
  }

  if (/\blast\s+week\b/.test(lower)) {
    const dayOfWeek = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'long' }).format(now).toLowerCase();
    const dayIdx = dayNames.indexOf(dayOfWeek);
    const thisMonOffset = dayIdx >= 0 ? -dayIdx : 0;
    const lastMonDate = new Date(now.getTime() + (thisMonOffset - 7) * 86_400_000);
    const lastSunDate = new Date(lastMonDate.getTime() + 6 * 86_400_000);
    return { label: 'Last week', fromYmd: melbourneYmd(lastMonDate), toYmd: melbourneYmd(lastSunDate) };
  }

  if (/\bnext\s+week\b/.test(lower)) {
    const dayOfWeek = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'long' }).format(now).toLowerCase();
    const dayIdx = dayNames.indexOf(dayOfWeek);
    const thisMonOffset = dayIdx >= 0 ? -dayIdx : 0;
    const nextMonDate = new Date(now.getTime() + (thisMonOffset + 7) * 86_400_000);
    const nextSunDate = new Date(nextMonDate.getTime() + 6 * 86_400_000);
    return { label: 'Next week', fromYmd: melbourneYmd(nextMonDate), toYmd: melbourneYmd(nextSunDate) };
  }

  if (/\bthis\s+month\b/.test(lower)) {
    const parts = todayYmd.split('-');
    return { label: 'This month', fromYmd: `${parts[0]}-${parts[1]}-01`, toYmd: todayYmd };
  }

  if (/\blast\s+month\b/.test(lower)) {
    const melbMonth = Number(todayYmd.split('-')[1]);
    const melbYear = Number(todayYmd.split('-')[0]);
    const prevMonth = melbMonth === 1 ? 12 : melbMonth - 1;
    const prevYear = melbMonth === 1 ? melbYear - 1 : melbYear;
    const firstDay = `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`;
    const lastDay = `${melbYear}-${String(melbMonth).padStart(2, '0')}-01`;
    const lastOfPrev = new Date(new Date(lastDay + 'T12:00:00Z').getTime() - 86_400_000);
    return { label: 'Last month', fromYmd: firstDay, toYmd: melbourneYmd(lastOfPrev) };
  }

  const nDaysMatch = lower.match(/\b(?:last|past)\s+(\d+)\s+days?\b/);
  if (nDaysMatch) {
    const n = Math.min(Number(nDaysMatch[1]), 365);
    const from = new Date(now.getTime() - n * 86_400_000);
    return { label: `Last ${n} days`, fromYmd: melbourneYmd(from), toYmd: todayYmd };
  }

  const nWeeksMatch = lower.match(/\b(?:last|past)\s+(\d+)\s+weeks?\b/);
  if (nWeeksMatch) {
    const n = Math.min(Number(nWeeksMatch[1]) * 7, 365);
    return { label: `Last ${nWeeksMatch[1]} weeks`, fromYmd: melbourneYmd(new Date(now.getTime() - n * 86_400_000)), toYmd: todayYmd };
  }

  const nMonthsMatch = lower.match(/\b(?:last|past|previous)\s+(\d+)\s+months?\b/);
  if (nMonthsMatch) {
    const n = Math.min(Number(nMonthsMatch[1]) * 30, 365);
    return { label: `Last ${nMonthsMatch[1]} months`, fromYmd: melbourneYmd(new Date(now.getTime() - n * 86_400_000)), toYmd: todayYmd };
  }

  return null;
}

type WorkorderRow = {
  workorder_id: number;
  workorder_status_id: number | null;
  customer_name: string | null;
  notes: string | null;
  time_in_melbourne: string | null;
  eta_out_melbourne: string | null;
  time_stamp_melbourne: string | null;
  updated_at_melbourne: string | null;
  archived: boolean | null;
  warranty: boolean | null;
  workorder_line_items: unknown;
};

function truncateNotes(notes: string | null, maxLen = 120): string {
  if (!notes) return '(no notes)';
  const oneLine = notes.replace(/\n/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 1)}…`;
}

function formatLineItems(items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) return '';
  const labels: string[] = [];
  for (const item of items.slice(0, 15)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const label = o.display_label ?? o.description ?? null;
    if (typeof label === 'string' && label.trim()) {
      labels.push(label.trim());
    }
  }
  if (labels.length === 0) return '';
  return labels.map((l) => `    - ${l}`).join('\n');
}

function formatWorkorderLine(r: WorkorderRow): string {
  const status = statusLabel(r.workorder_status_id);
  const customer = r.customer_name?.trim() || '(unknown customer)';
  const timeIn = r.time_in_melbourne ?? '—';
  const etaOut = r.eta_out_melbourne ?? '—';
  const notes = truncateNotes(r.notes);
  const warranty = r.warranty ? ' · (warranty)' : '';

  let line = `- WO #${r.workorder_id} — ${customer}${warranty}\n`;
  line += `  Status: ${status} · Dropped off: ${timeIn} · ETA out: ${etaOut}\n`;
  line += `  Notes: ${notes}`;

  const lineItems = formatLineItems(r.workorder_line_items);
  if (lineItems) {
    line += `\n  Line items:\n${lineItems}`;
  }

  return line;
}

/**
 * When a message relates to workshop / workorders / servicing, inject a factual block
 * from the mirrored Lightspeed workorder data in Supabase.
 */
export async function buildLightspeedWorkorderPrefix(opts: {
  supabase: SupabaseClient;
  brandKey: string;
  message: string;
  force?: boolean;
}): Promise<string> {
  if (!opts.force && !messageSuggestsWorkorderQuery(opts.message)) return '';

  const { data: conn } = await opts.supabase
    .from('nest_brand_portal_connections')
    .select('api_endpoint')
    .eq('brand_key', opts.brandKey)
    .eq('provider', LIGHTSPEED_PROVIDER)
    .maybeSingle();

  const { count: totalRows, error: countErr } = await opts.supabase
    .from('nest_brand_lightspeed_workorder')
    .select('*', { count: 'exact', head: true })
    .eq('brand_key', opts.brandKey);

  if (countErr) {
    console.error('[brand-lightspeed-workorders] count error:', countErr.message);
    return [
      '[LIVE LIGHTSPEED WORKORDERS]',
      '**Workorder lookup error** — could not read the mirrored Lightspeed workorder table.',
      '---',
      '',
    ].join('\n');
  }

  const n = totalRows ?? 0;
  if (n === 0 && !conn) {
    return [
      '[LIVE LIGHTSPEED WORKORDERS]',
      '**Lightspeed is not connected** and there are **no workorder records** in Nest yet.',
      'Ask the business to connect Lightspeed in the portal.',
      '---',
      '',
    ].join('\n');
  }

  if (n === 0) {
    return [
      '[LIVE LIGHTSPEED WORKORDERS]',
      'Lightspeed is connected, but **no workorder rows** are stored yet.',
      'The sync job may still be running — try again later or sync from the portal.',
      '---',
      '',
    ].join('\n');
  }

  const dateWindow = resolveDateWindow(opts.message);

  let query = opts.supabase
    .from('nest_brand_lightspeed_workorder')
    .select(
      'workorder_id, workorder_status_id, customer_name, notes, time_in_melbourne, eta_out_melbourne, time_stamp_melbourne, updated_at_melbourne, archived, warranty, workorder_line_items',
    )
    .eq('brand_key', opts.brandKey)
    .eq('archived', false);

  if (dateWindow) {
    query = query
      .gte('eta_out_melbourne', dateWindow.fromYmd)
      .lt('eta_out_melbourne', dateWindow.toYmd + 'z');
  } else {
    query = query.in('workorder_status_id', [1, 4, 8]);
  }

  query = query.order('eta_out_melbourne', { ascending: true, nullsFirst: false });

  const queryLimit = dateWindow ? 300 : 100;
  const { data: rawRows, error: selErr } = await query.limit(queryLimit);
  if (selErr) {
    console.error('[brand-lightspeed-workorders] select error:', selErr.message);
    return [
      '[LIVE LIGHTSPEED WORKORDERS]',
      `**Query error**: ${selErr.message}`,
      '---',
      '',
    ].join('\n');
  }

  const rows = (rawRows ?? []) as WorkorderRow[];

  const now = new Date();
  const todayYmd = melbourneYmd(now);
  const todayLabel = melbourneLongDate(todayYmd);

  const header = [
    "[LIVE LIGHTSPEED WORKORDERS — from Nest's latest Lightspeed snapshot in Supabase; not a live POS lookup]",
    `Today (Melbourne): ${todayLabel} (${melbourneWeekday(now)}).`,
    '**For your reply**: **Bold only topic headings** (e.g. **Workshop**, **Workorders**). Job lines, names, and statuses plain. Blank line between jobs when listing several; one fact per line.',
    '',
    `Total workorder rows in snapshot: ${n}.`,
    dateWindow
      ? `Filter: workorders with ETA out on ${dateWindow.label}.`
      : 'Filter: active workorders (open, finished awaiting collection, or due today).',
    'Status key: 1 = Open, 4 = Finished (awaiting collection/payment), 8 = Due Today.',
    '',
  ];

  if (rows.length === 0) {
    return [
      ...header,
      '**Matching workorders**\nNone.',
      dateWindow
        ? `No workorders have an ETA out on ${dateWindow.label}.`
        : 'No active workorders found (all may be archived or completed).',
      '---',
      '',
    ].join('\n');
  }

  const openCount = rows.filter((r) => r.workorder_status_id === 1).length;
  const finishedCount = rows.filter((r) => r.workorder_status_id === 4).length;
  const todayCount = rows.filter((r) => r.workorder_status_id === 8).length;

  const summaryParts: string[] = [];
  if (openCount > 0) summaryParts.push(`${openCount} open`);
  if (finishedCount > 0) summaryParts.push(`${finishedCount} finished (awaiting collection)`);
  if (todayCount > 0) summaryParts.push(`${todayCount} due today`);

  const summary = summaryParts.length > 0
    ? `**Summary**\n${rows.length} workorder(s) returned — ${summaryParts.join(', ')}.`
    : `**Summary**\n${rows.length} workorder(s) returned.`;

  const lines = rows.slice(0, 60).map(formatWorkorderLine);
  const woLineSep = opts.force ? '\n\n' : '\n';

  return [
    ...header,
    summary,
    '',
    '**Workorders**',
    lines.join(woLineSep),
    rows.length > 60 ? `\n(${rows.length} total; showing first 60.)` : '',
    '---',
    '',
  ].join('\n');
}
