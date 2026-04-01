import { normaliseBrandInternalAccessHandle } from './phone-normalise.ts';

/** Reserved for future use; brand chat no longer gates Deputy on this list. */
export function senderHasInternalBrandAccess(
  senderHandle: string,
  allowedE164s: string[] | null | undefined,
): boolean {
  if (!allowedE164s || allowedE164s.length === 0) return false;
  const senderKey = normaliseBrandInternalAccessHandle(senderHandle);
  if (!senderKey) return false;
  for (const entry of allowedE164s) {
    const a = normaliseBrandInternalAccessHandle(String(entry));
    if (a && a === senderKey) return true;
  }
  return false;
}

/**
 * Brand chat: all senders may receive answers grounded in live Deputy data when injected.
 * `deputyLiveGrounding` is true when this turn includes a [LIVE DEPUTY DATA] prefix.
 * `lightspeedInventoryGrounding` is true when this turn includes a [LIVE LIGHTSPEED INVENTORY] prefix.
 */
export function buildBrandAccessModeBlock(options?: {
  deputyLiveGrounding?: boolean;
  lightspeedInventoryGrounding?: boolean;
  lightspeedWorkorderGrounding?: boolean;
  lightspeedSalesGrounding?: boolean;
}): string {
  const deputyGrounding = options?.deputyLiveGrounding === true;
  const deputyLines = deputyGrounding
    ? [
        '',
        'This turn includes a [LIVE DEPUTY DATA] block (fresh Deputy pull). Use it as authoritative for roster, shifts, timesheets, and hours (summarise clearly; do not invent rows).',
        'Do not tell the user to "check Deputy" or "ask the team" when that block already contains the answer.',
        'If the block says Deputy is not connected, OAuth is missing, or there is an API error, say so briefly in plain text (optional **topic** word only if it helps scanning, e.g. **Roster**), then detail, and suggest reconnecting in the business portal where appropriate.',
      ]
    : [
        '',
        'When the user message has no [LIVE DEPUTY DATA] block, you do not have live workforce data for that turn — do not guess shifts, hours, or names; give public-facing help or offer a handoff.',
      ];

  const lsGrounding = options?.lightspeedInventoryGrounding === true;
  const lsLines = lsGrounding
    ? [
        '',
        'This turn includes a [LIVE LIGHTSPEED INVENTORY] block: quantities come from Nest’s **mirrored** Lightspeed Retail snapshot in Supabase (updated on a schedule), not a live POS lookup.',
        'Treat QOH (shop 1) and line totals in that block as authoritative for this reply; do not invent stock figures.',
        '**CRITICAL**: If the block says "Matching lines: NONE" or lists zero products, you MUST NOT name any products, brands, models, prices, or stock counts in your reply. Do NOT use marketing copy, system prompt text, or training data to guess what might be in stock. The only correct answer is: no matching products were found for those keywords. Suggest different search terms or offer a phone handoff.',
        'Only mention specific products that explicitly appear in the data block with a listed QOH.',
      ]
    : [
        '',
        'When there is no [LIVE LIGHTSPEED INVENTORY] block, you do not have structured stock quantities for that turn — do not guess how many units are on hand; give general help or offer to check in store.',
        'Do NOT list specific product names, brands, models, or prices from marketing copy or your training data.',
      ];

  const salesGrounding = options?.lightspeedSalesGrounding === true;
  const salesLines = salesGrounding
    ? [
        '',
        'This turn includes a [LIVE LIGHTSPEED SALES] block: data comes from Nest\'s **mirrored** Lightspeed Retail sales snapshot (updated on a schedule), not a live POS lookup.',
        'Treat revenue totals, sale counts, averages, top items, and layaway values in that block as authoritative for this reply; do not invent figures.',
        'Prices are AUD and tax-inclusive. When summarising, lead with key numbers (total revenue, transaction count, average sale) then break down by top items if relevant.',
        'If the block says no matching sales, say so clearly — the shop may not have opened yet or the sync is pending.',
      ]
    : [
        '',
        'When there is no [LIVE LIGHTSPEED SALES] block, you do not have structured sales/revenue data for that turn — do not guess revenue or transaction counts; give general help or offer to check.',
      ];

  const woGrounding = options?.lightspeedWorkorderGrounding === true;
  const woLines = woGrounding
    ? [
        '',
        'This turn includes a [LIVE LIGHTSPEED WORKORDERS] block: data comes from Nest\'s **mirrored** Lightspeed Retail workorder snapshot (updated on a schedule), not a live POS lookup.',
        'Treat workorder counts, statuses, customer names, notes, ETA dates, and line items in that block as authoritative for this reply; do not invent figures.',
        'Refer to workorders naturally as "services", "jobs", or "work orders" — whatever fits the question.',
        'Status key: 1 = Open (in progress), 4 = Finished (awaiting collection or payment), 8 = Due Today.',
        'If the block says no matching workorders, say so clearly and offer to check a different date or status.',
      ]
    : [
        '',
        'When there is no [LIVE LIGHTSPEED WORKORDERS] block, you do not have structured workshop/service data for that turn — do not guess how many bikes are being serviced; give general help or offer to check.',
      ];

  return [
    '',
    '---',
    '',
    '## WORKFORCE AND ROSTER (Deputy)',
    'Any sender may receive answers that use live roster and timesheet data when it is supplied for their message.',
    'Protect privacy: only use what appears in supplied data; do not add unrelated personal details.',
    'Roster adds or discards from chat always require a second step: the user must send the exact phrase you specify (**CONFIRM ADD**, **CONFIRM DELETE**, or **CANCEL**). Never state that a shift was changed until after that confirmation step.',
    'Formatting: mobile-friendly — **bold only for section headings** (e.g. Roster, Timesheets); bullet lines and values plain. Blank line between sections. Use markdown ** for those headings only (not Unicode faux-bold).',
    ...deputyLines,
    '',
    '## INVENTORY (Lightspeed Retail, mirrored)',
    'When a [LIVE LIGHTSPEED INVENTORY] block is present, you may answer stock-style questions (e.g. how many, in stock, SKU) from that data.',
    'Formatting: same as Deputy — **bold** topic headings only; bullets and figures plain. Australian English.',
    ...lsLines,
    '',
    '## WORKSHOP / WORKORDERS (Lightspeed Retail, mirrored)',
    'When a [LIVE LIGHTSPEED WORKORDERS] block is present, you may answer questions about bike services, repairs, workshop jobs, drop-offs, ETAs, and workorder statuses from that data.',
    'Formatting: same as above — **bold** topic headings only; bullets plain. Australian English.',
    ...woLines,
    '',
    '## SALES & REVENUE (Lightspeed Retail, mirrored)',
    'When a [LIVE LIGHTSPEED SALES] block is present, you may answer questions about sales, revenue, transactions, takings, best sellers, layaway orders, and daily/weekly/monthly performance from that data.',
    'Prices are AUD tax-inclusive. Formatting: **bold** topic headings only; figures plain. Summarise key figures first, then detail if asked.',
    ...salesLines,
  ].join('\n');
}

/**
 * Internal mode access block — used when brand key ends with "-internal".
 * Tone is analyst/colleague, not customer service.
 */
export function buildInternalAccessModeBlock(options?: {
  deputyLiveGrounding?: boolean;
  lightspeedInventoryGrounding?: boolean;
  lightspeedWorkorderGrounding?: boolean;
  lightspeedSalesGrounding?: boolean;
}): string {
  const deputyGrounding = options?.deputyLiveGrounding === true;
  const deputyLines = deputyGrounding
    ? [
        '',
        '[LIVE DEPUTY DATA] block is present. Authoritative for roster, shifts, timesheets, hours, leave.',
        'Answer the question (e.g. "3 people on today") then only list names/times if asked or if the team is unusually thin.',
        'Roster mutations still need the confirmation step (CONFIRM ADD / CONFIRM DELETE / CANCEL).',
      ]
    : [
        '',
        'No [LIVE DEPUTY DATA] block this turn. Cannot answer roster/shift questions — say so and suggest mentioning rosters or shifts.',
      ];

  const lsGrounding = options?.lightspeedInventoryGrounding === true;
  const lsLines = lsGrounding
    ? [
        '',
        '[LIVE LIGHTSPEED INVENTORY] block is present. QOH and pricing are authoritative.',
        'CRITICAL: If "Matching lines: NONE", do NOT name any products, brands, models, prices, or quantities. Never fabricate from marketing copy or memory.',
        'No matches = say so plainly and suggest different keywords. Do not pad the answer.',
      ]
    : [
        '',
        'No [LIVE LIGHTSPEED INVENTORY] block this turn. Cannot answer stock questions — suggest using "stock" / "inventory" or a product name.',
      ];

  const woGrounding = options?.lightspeedWorkorderGrounding === true;
  const woLines = woGrounding
    ? [
        '',
        '[LIVE LIGHTSPEED WORKORDERS] block is present. Workorder counts, statuses, names, notes, ETAs are authoritative.',
        'Status key: 1 = Open, 4 = Finished (awaiting collection/payment), 8 = Due Today.',
        'Give the count and any standout detail (e.g. finished jobs piling up, overdue ETAs). Only list individual jobs if they asked for specifics or there are very few.',
      ]
    : [
        '',
        'No [LIVE LIGHTSPEED WORKORDERS] block this turn. Cannot answer workshop questions — suggest mentioning "services", "workshop", or "workorders".',
      ];

  const salesGrounding = options?.lightspeedSalesGrounding === true;
  const salesLines = salesGrounding
    ? [
        '',
        '[LIVE LIGHTSPEED SALES] block is present. Revenue totals, sale counts, averages, top items, layaway values are authoritative. AUD tax-inclusive.',
        'Give the headline number. Only break down individual items if asked, OR if one sale is notably large (flag it as a callout). Do NOT list every line item by default.',
      ]
    : [
        '',
        'No [LIVE LIGHTSPEED SALES] block this turn. Cannot answer sales/revenue questions — suggest mentioning "sales", "revenue", or "takings".',
      ];

  return [
    '',
    '---',
    '',
    '## REPLY FORMAT (INTERNAL)',
    'Easy to read on a phone: **bold only for section/topic headings** (Roster, Sales, Workshop, etc.). Numbers, names, times, and bullet bodies stay plain. **One bullet per line**; blank lines **inside** a section are fine.',
    '**iMessage bubbles**: blank lines do **not** create a new bubble. A line with exactly **---** alone only between **whole** surface areas. Never **---** between a heading and its list.',
    '',
    '## DATA SOURCES',
    '',
    '### Rosters & Timesheets (Deputy)',
    ...deputyLines,
    '',
    '### Inventory (Lightspeed)',
    ...lsLines,
    '',
    '### Workshop / Services (Lightspeed)',
    ...woLines,
    '',
    '### Sales & Revenue (Lightspeed)',
    ...salesLines,
  ].join('\n');
}
