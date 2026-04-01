import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const LIGHTSPEED_PROVIDER = 'lightspeed';

/** Triggers a read from mirrored sale / sale_line tables. */
export const SALES_QUERY_RE =
  /(\bsales?\b|\bsold\b|\bsell\b|\brevenue\b|\bturnover\b|\btakings?\b|\btaken\b|\btransactions?\b|\btill\b|\breceipt\b|\blayaway\b|\blay\s*away\b|\bbest\s*sell(?:ing|er)\b|\btop\s*sell(?:ing|er)\b|\bhow\s+much\s+.*\bwe\s+(?:sell|sold|make|made|take|taken|do|done)\b|\bwhat\s+(?:did|have)\s+we\s+(?:sell|sold|make|made|take|taken)\b|\baverage\s+(?:sale|transaction|order)\b|\btotal\s+(?:sales?|revenue|takings?)\b|\bsale\s+value\b|\bdaily\s+(?:sales?|take|revenue)\b|\bweekly\s+(?:sales?|take|revenue)\b|\bmonthly\s+(?:sales?|take|revenue)\b)/i;

export function messageSuggestsSalesQuery(message: string): boolean {
  return SALES_QUERY_RE.test(message.trim());
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

function formatAud(n: number): string {
  try {
    return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

type DateWindow = { label: string; fromYmd: string; toYmd: string };

function resolveSalesDateWindow(message: string): DateWindow | null {
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
  if (/\btoday\b/.test(lower)) {
    return { label: `Today (${melbourneLongDate(todayYmd)})`, fromYmd: todayYmd, toYmd: todayYmd };
  }
  if (/\btomorrow\b/.test(lower)) {
    return { label: `Tomorrow (${melbourneLongDate(tomorrowYmd)})`, fromYmd: tomorrowYmd, toYmd: tomorrowYmd };
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
          const isPast = offset < 0 || (offset === 0);
          if (/\blast\b/.test(lower) && offset < 0) {
            return { label: `Last ${dayName.charAt(0).toUpperCase() + dayName.slice(1)} (${melbourneLongDate(ymd)})`, fromYmd: ymd, toYmd: ymd };
          }
          if (!isPast && !/\blast\b/.test(lower)) continue;
          if (isPast) {
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
    return { label: 'This week', fromYmd: melbourneYmd(mondayDate), toYmd: todayYmd };
  }

  if (/\blast\s+week\b/.test(lower)) {
    const dayOfWeek = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'long' }).format(now).toLowerCase();
    const dayIdx = dayNames.indexOf(dayOfWeek);
    const thisMonOffset = dayIdx >= 0 ? -dayIdx : 0;
    const lastMonDate = new Date(now.getTime() + (thisMonOffset - 7) * 86_400_000);
    const lastSunDate = new Date(lastMonDate.getTime() + 6 * 86_400_000);
    return { label: 'Last week', fromYmd: melbourneYmd(lastMonDate), toYmd: melbourneYmd(lastSunDate) };
  }

  if (/\bthis\s+month\b/.test(lower)) {
    const parts = todayYmd.split('-');
    const firstOfMonth = `${parts[0]}-${parts[1]}-01`;
    return { label: 'This month', fromYmd: firstOfMonth, toYmd: todayYmd };
  }

  if (/\blast\s+month\b/.test(lower)) {
    const d = new Date(now.getTime());
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
    const n = Math.min(Number(nWeeksMatch[1]), 52);
    const from = new Date(now.getTime() - n * 7 * 86_400_000);
    return { label: `Last ${n} weeks`, fromYmd: melbourneYmd(from), toYmd: todayYmd };
  }

  const nMonthsMatch = lower.match(/\b(?:last|past|previous)\s+(\d+)\s+months?\b/);
  if (nMonthsMatch) {
    const n = Math.min(Number(nMonthsMatch[1]), 24);
    const from = new Date(now.getTime() - n * 30 * 86_400_000);
    return { label: `Last ${n} months`, fromYmd: melbourneYmd(from), toYmd: todayYmd };
  }

  if (/\b(?:last|past)\s+(?:quarter|90\s*days)\b/.test(lower)) {
    const from = new Date(now.getTime() - 90 * 86_400_000);
    return { label: 'Last quarter', fromYmd: melbourneYmd(from), toYmd: todayYmd };
  }

  if (/\b(?:this\s+year|year\s+to\s+date|ytd)\b/.test(lower)) {
    const ymd = todayYmd.split('-');
    return { label: 'Year to date', fromYmd: `${ymd[0]}-01-01`, toYmd: todayYmd };
  }

  return null;
}

type SaleRow = {
  sale_id: number;
  completed: boolean | null;
  voided: boolean | null;
  archived: boolean | null;
  total: number | null;
  calc_total: number | null;
  create_time_melbourne: string | null;
  complete_time_melbourne: string | null;
  time_stamp_melbourne: string | null;
};

type SaleLineRow = {
  sale_line_id: number;
  sale_id: number;
  item_id: number | null;
  unit_quantity: number | null;
  unit_price: number | null;
  calc_line_total: number | null;
  is_layaway: boolean | null;
  note: string | null;
};

type ItemLookup = { description: string | null; custom_sku: string | null };

async function lookupItemDescriptions(
  supabase: SupabaseClient,
  brandKey: string,
  itemIds: number[],
): Promise<Map<number, ItemLookup>> {
  const map = new Map<number, ItemLookup>();
  const unique = [...new Set(itemIds)].filter((n) => n > 0);
  const chunkSize = 100;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const { data } = await supabase
      .from('nest_brand_lightspeed_item')
      .select('item_id, description, custom_sku')
      .eq('brand_key', brandKey)
      .in('item_id', chunk);
    for (const row of data ?? []) {
      map.set(Number(row.item_id), {
        description: typeof row.description === 'string' ? row.description : null,
        custom_sku: typeof row.custom_sku === 'string' ? row.custom_sku : null,
      });
    }
  }
  return map;
}

function saleTotal(s: SaleRow): number {
  const t = s.total ?? s.calc_total ?? 0;
  return typeof t === 'number' && Number.isFinite(t) ? t : 0;
}

function lineTotal(l: SaleLineRow): number {
  if (typeof l.calc_line_total === 'number' && Number.isFinite(l.calc_line_total)) return l.calc_line_total;
  const qty = l.unit_quantity ?? 1;
  const price = l.unit_price ?? 0;
  return qty * price;
}

function buildTopItemsSummary(
  lines: SaleLineRow[],
  itemMap: Map<number, ItemLookup>,
  maxItems = 15,
): string {
  const byItem = new Map<number, { desc: string; qty: number; rev: number }>();
  for (const l of lines) {
    const id = l.item_id;
    if (!id || id <= 0) continue;
    const existing = byItem.get(id);
    const desc = itemMap.get(id)?.description ?? `Item #${id}`;
    const qty = l.unit_quantity ?? 1;
    const rev = lineTotal(l);
    if (existing) {
      existing.qty += qty;
      existing.rev += rev;
    } else {
      byItem.set(id, { desc, qty, rev });
    }
  }

  const sorted = [...byItem.values()]
    .filter((r) => r.rev > 0)
    .sort((a, b) => b.rev - a.rev)
    .slice(0, maxItems);

  if (sorted.length === 0) return '';

  const itemLines = sorted.map(
    (r) => `  - ${r.desc} — ${r.qty} sold — ${formatAud(r.rev)}`,
  );
  return ['', '**Top items by revenue**', ...itemLines].join('\n');
}

function buildLayawaySummary(sales: SaleRow[], lines: SaleLineRow[], itemMap: Map<number, ItemLookup>): string {
  const layawayLinesBySale = new Map<number, SaleLineRow[]>();
  for (const l of lines) {
    if (!l.is_layaway) continue;
    const list = layawayLinesBySale.get(l.sale_id) ?? [];
    list.push(l);
    layawayLinesBySale.set(l.sale_id, list);
  }

  if (layawayLinesBySale.size === 0) return '';

  const layawaySales = sales.filter((s) => layawayLinesBySale.has(s.sale_id));
  let totalLayawayValue = 0;
  const itemLines: string[] = [];

  for (const s of layawaySales.slice(0, 20)) {
    const saleLines = layawayLinesBySale.get(s.sale_id) ?? [];
    for (const l of saleLines) {
      const desc = l.item_id && l.item_id > 0
        ? (itemMap.get(l.item_id)?.description ?? `Item #${l.item_id}`)
        : '(no item)';
      const val = lineTotal(l);
      totalLayawayValue += val;
      itemLines.push(`  - ${desc} — ${formatAud(l.unit_price ?? 0)} (Sale #${s.sale_id})`);
    }
  }

  return [
    '',
    '**Layaway / on-hold orders**',
    `${layawayLinesBySale.size} sale(s), total value ${formatAud(totalLayawayValue)}`,
    ...itemLines.slice(0, 20),
    layawayLinesBySale.size > 20 ? `  (${layawayLinesBySale.size} total; showing first 20)` : '',
  ].filter(Boolean).join('\n');
}

function isoWeekLabel(dateStr: string): string {
  const parts = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
  const dayOfWeek = (d.getUTCDay() + 6) % 7;
  const monday = new Date(d.getTime() - dayOfWeek * 86_400_000);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  const fmt = (dt: Date) => `${dt.getUTCDate()}/${dt.getUTCMonth() + 1}`;
  return `${fmt(monday)}–${fmt(sunday)}`;
}

function buildDailyAggregation(sales: SaleRow[]): string {
  const byDay = new Map<string, { count: number; revenue: number }>();
  for (const s of sales) {
    if (s.completed !== true) continue;
    const dayKey = (s.complete_time_melbourne ?? s.create_time_melbourne ?? '').slice(0, 10);
    if (!dayKey) continue;
    const existing = byDay.get(dayKey) ?? { count: 0, revenue: 0 };
    existing.count++;
    existing.revenue += saleTotal(s);
    byDay.set(dayKey, existing);
  }
  if (byDay.size === 0) return '';
  const sorted = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const lines = sorted.map(([day, d]) => `  - ${melbourneLongDate(day)}: ${d.count} sales, ${formatAud(d.revenue)}`);
  return ['', '**Daily breakdown**', ...lines].join('\n');
}

function buildWeeklyAggregation(sales: SaleRow[]): string {
  const byWeek = new Map<string, { count: number; revenue: number; from: string; to: string }>();
  for (const s of sales) {
    if (s.completed !== true) continue;
    const dayKey = (s.complete_time_melbourne ?? s.create_time_melbourne ?? '').slice(0, 10);
    if (!dayKey) continue;
    const wk = isoWeekLabel(dayKey);
    const existing = byWeek.get(wk) ?? { count: 0, revenue: 0, from: dayKey, to: dayKey };
    existing.count++;
    existing.revenue += saleTotal(s);
    if (dayKey < existing.from) existing.from = dayKey;
    if (dayKey > existing.to) existing.to = dayKey;
    byWeek.set(wk, existing);
  }
  if (byWeek.size === 0) return '';
  const sorted = [...byWeek.entries()].sort((a, b) => a[1].from.localeCompare(b[1].from));
  const lines = sorted.map(([wk, d]) => `  - Week of ${wk}: ${d.count} sales, ${formatAud(d.revenue)}`);
  const bestWeek = sorted.reduce((best, curr) => curr[1].revenue > best[1].revenue ? curr : best, sorted[0]);
  lines.push(`  - Best week: ${bestWeek[0]} — ${formatAud(bestWeek[1].revenue)} (${bestWeek[1].count} sales)`);
  return ['', '**Weekly breakdown**', ...lines].join('\n');
}

/**
 * When a message relates to sales / revenue / transactions, inject a factual block
 * from the mirrored Lightspeed sale + sale_line data in Supabase.
 */
export async function buildLightspeedSalesPrefix(opts: {
  supabase: SupabaseClient;
  brandKey: string;
  message: string;
  force?: boolean;
}): Promise<string> {
  if (!opts.force && !messageSuggestsSalesQuery(opts.message)) return '';

  const now = new Date();
  const todayYmd = melbourneYmd(now);

  const { data: conn } = await opts.supabase
    .from('nest_brand_portal_connections')
    .select('api_endpoint')
    .eq('brand_key', opts.brandKey)
    .eq('provider', LIGHTSPEED_PROVIDER)
    .maybeSingle();

  const { count: totalSales, error: countErr } = await opts.supabase
    .from('nest_brand_lightspeed_sale')
    .select('*', { count: 'exact', head: true })
    .eq('brand_key', opts.brandKey);

  if (countErr) {
    console.error('[brand-lightspeed-sales] count error:', countErr.message);
    return [
      '[LIVE LIGHTSPEED SALES]',
      '**Sales lookup error** — could not read the mirrored Lightspeed sales table.',
      '---',
      '',
    ].join('\n');
  }

  const n = totalSales ?? 0;
  if (n === 0 && !conn) {
    return [
      '[LIVE LIGHTSPEED SALES]',
      '**Lightspeed is not connected** and there are **no sales records** in Nest yet.',
      'Ask the business to connect Lightspeed in the portal.',
      '---',
      '',
    ].join('\n');
  }

  if (n === 0) {
    return [
      '[LIVE LIGHTSPEED SALES]',
      'Lightspeed is connected, but **no sales rows** are stored yet.',
      'The sync job may still be running — try again later or sync from the portal.',
      '---',
      '',
    ].join('\n');
  }

  let dateWindow = resolveSalesDateWindow(opts.message);
  const isLayawayQuery = /\blayaway\b|\blay\s*away\b|\bon\s*hold\b/i.test(opts.message);

  if (!dateWindow && opts.force && !isLayawayQuery) {
    const defaultFrom = new Date(now.getTime() - 30 * 86_400_000);
    dateWindow = { label: 'Last 30 days (auto)', fromYmd: melbourneYmd(defaultFrom), toYmd: todayYmd };
  }

  let saleQuery = opts.supabase
    .from('nest_brand_lightspeed_sale')
    .select(
      'sale_id, completed, voided, archived, total, calc_total, create_time_melbourne, complete_time_melbourne, time_stamp_melbourne',
    )
    .eq('brand_key', opts.brandKey)
    .eq('voided', false);

  if (dateWindow) {
    saleQuery = saleQuery
      .gte('complete_time_melbourne', dateWindow.fromYmd)
      .lt('complete_time_melbourne', dateWindow.toYmd + 'z');
  } else if (!isLayawayQuery) {
    saleQuery = saleQuery
      .gte('complete_time_melbourne', todayYmd)
      .lt('complete_time_melbourne', todayYmd + 'z');
  }

  saleQuery = saleQuery.order('complete_time_melbourne', { ascending: false, nullsFirst: true });

  const queryLimit = dateWindow && dateWindow.label !== `Today (${melbourneLongDate(todayYmd)})` ? 500 : 200;
  const { data: rawSales, error: saleErr } = await saleQuery.limit(queryLimit);
  if (saleErr) {
    console.error('[brand-lightspeed-sales] sale select error:', saleErr.message);
    return [
      '[LIVE LIGHTSPEED SALES]',
      `**Query error**: ${saleErr.message}`,
      '---',
      '',
    ].join('\n');
  }

  let sales = (rawSales ?? []) as SaleRow[];

  if (isLayawayQuery && !dateWindow) {
    const { data: layawaySales } = await opts.supabase
      .from('nest_brand_lightspeed_sale')
      .select(
        'sale_id, completed, voided, archived, total, calc_total, create_time_melbourne, complete_time_melbourne, time_stamp_melbourne',
      )
      .eq('brand_key', opts.brandKey)
      .eq('voided', false)
      .eq('completed', false)
      .order('create_time_melbourne', { ascending: false, nullsFirst: true })
      .limit(100);
    sales = (layawaySales ?? []) as SaleRow[];
  }

  const saleIds = sales.map((s) => s.sale_id);

  let allLines: SaleLineRow[] = [];
  if (saleIds.length > 0) {
    const lineChunkSize = 50;
    for (let i = 0; i < saleIds.length; i += lineChunkSize) {
      const chunk = saleIds.slice(i, i + lineChunkSize);
      const { data: lineData } = await opts.supabase
        .from('nest_brand_lightspeed_sale_line')
        .select('sale_line_id, sale_id, item_id, unit_quantity, unit_price, calc_line_total, is_layaway, note')
        .eq('brand_key', opts.brandKey)
        .in('sale_id', chunk);
      allLines.push(...((lineData ?? []) as SaleLineRow[]));
    }
  }

  const itemIds = allLines.map((l) => l.item_id).filter((id): id is number => id != null && id > 0);
  const itemMap = itemIds.length > 0
    ? await lookupItemDescriptions(opts.supabase, opts.brandKey, itemIds)
    : new Map<number, ItemLookup>();

  const todayLabel = melbourneLongDate(todayYmd);

  const completedSales = sales.filter((s) => s.completed === true);
  const incompleteSales = sales.filter((s) => s.completed !== true);

  const totalRevenue = completedSales.reduce((sum, s) => sum + saleTotal(s), 0);
  const completedCount = completedSales.length;
  const avgSale = completedCount > 0 ? totalRevenue / completedCount : 0;

  const totalItems = allLines.reduce((sum, l) => sum + (l.unit_quantity ?? 1), 0);

  const filterLabel = dateWindow
    ? `Filter: sales completed on ${dateWindow.label}.`
    : isLayawayQuery
      ? 'Filter: incomplete / layaway sales (not yet fully paid).'
      : `Filter: sales completed today (${todayLabel}).`;

  const header = [
    "[LIVE LIGHTSPEED SALES — from Nest's latest Lightspeed snapshot in Supabase; not a live POS lookup]",
    `Today (Melbourne): ${todayLabel} (${melbourneWeekday(now)}).`,
    '**For your reply**: **Bold only topic headings** (e.g. **Sales**, **Summary**, **Top items**). Dollar amounts and line items plain. Blank line between major blocks; one bullet per line. Prices are AUD (tax inclusive).',
    '',
    `Total sale rows in snapshot: ${n}.`,
    filterLabel,
    '',
  ];

  if (sales.length === 0) {
    return [
      ...header,
      '**Matching sales**\nNone.',
      dateWindow
        ? `No completed sales found for ${dateWindow.label}.`
        : isLayawayQuery
          ? 'No layaway / incomplete sales found.'
          : 'No completed sales found for today (the shop may not have opened yet, or sync is pending).',
      '---',
      '',
    ].join('\n');
  }

  const summaryLines = [
    `**Summary**`,
    `- Completed sales: ${completedCount}`,
    `- Total revenue: ${formatAud(totalRevenue)}`,
    `- Average sale: ${formatAud(avgSale)}`,
    `- Total items sold: ${Math.round(totalItems)}`,
  ];

  if (incompleteSales.length > 0) {
    summaryLines.push(`- Incomplete / layaway sales: ${incompleteSales.length}`);
  }

  const topItems = buildTopItemsSummary(allLines.filter((l) => !l.is_layaway), itemMap);
  const layaway = buildLayawaySummary(sales, allLines, itemMap);

  const windowDays = dateWindow
    ? Math.max(1, Math.round((new Date(dateWindow.toYmd + 'T12:00:00Z').getTime() - new Date(dateWindow.fromYmd + 'T12:00:00Z').getTime()) / 86_400_000) + 1)
    : 1;
  const isWideWindow = windowDays > 7;

  const aggregation = isWideWindow
    ? buildWeeklyAggregation(completedSales) + buildDailyAggregation(completedSales)
    : '';

  const saleDetails: string[] = [];
  const maxDetails = isWideWindow ? 10 : 30;
  const salesToShow = completedSales.slice(0, maxDetails);
  if (salesToShow.length > 0) {
    saleDetails.push('', `**${isWideWindow ? 'Most recent' : 'Recent'} completed sales**`);
    for (const s of salesToShow) {
      const t = saleTotal(s);
      const time = s.complete_time_melbourne ?? s.create_time_melbourne ?? '—';
      const saleLines = allLines.filter((l) => l.sale_id === s.sale_id && !l.is_layaway);
      const itemDescs = saleLines.slice(0, 5).map((l) => {
        const desc = l.item_id && l.item_id > 0
          ? (itemMap.get(l.item_id)?.description ?? `Item #${l.item_id}`)
          : l.note ?? '(item)';
        return desc;
      });
      const itemList = itemDescs.length > 0 ? ` — ${itemDescs.join(', ')}` : '';
      const more = saleLines.length > 5 ? ` (+${saleLines.length - 5} more)` : '';
      saleDetails.push(`- Sale #${s.sale_id} — ${formatAud(t)} — ${time}${itemList}${more}`);
    }
    if (completedSales.length > maxDetails) {
      saleDetails.push(`(${completedSales.length} total; showing ${maxDetails} most recent)`);
    }
  }

  return [
    ...header,
    ...summaryLines,
    aggregation,
    topItems,
    layaway,
    ...saleDetails,
    '',
    '---',
    '',
  ].join('\n');
}
