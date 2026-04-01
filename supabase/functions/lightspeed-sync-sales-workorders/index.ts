import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getAdminClient } from '../_shared/supabase.ts';
import { authorizeInternalRequest } from '../_shared/internal-auth.ts';
import {
  buildAccountResourceUrl,
  ensureValidLightspeedAccessToken,
  exchangeRefreshToken,
  fetchAllPages,
  normaliseRelationArray,
  parseBigIntLoose,
  parseBoolLoose,
  parseIsoTimestamptz,
  parseNumberLoose,
  persistRefreshedTokens,
  type LightspeedPortalConnection,
} from '../_shared/lightspeed-client.ts';

const PROVIDER = 'lightspeed';
const RETENTION_DAYS = 90;
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function isoLowerBoundDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

type SaleRow = Record<string, unknown>;
type SaleLineRow = Record<string, unknown>;

function mapSaleToDb(brandKey: string, sale: SaleRow) {
  const saleId = parseBigIntLoose(sale.saleID);
  if (saleId === null) return null;
  const stripLines = { ...sale };
  delete stripLines.SaleLines;
  delete stripLines.SalePayments;
  delete stripLines.Customer;
  return {
    brand_key: brandKey,
    sale_id: Number(saleId),
    completed: parseBoolLoose(sale.completed),
    voided: parseBoolLoose(sale.voided),
    archived: parseBoolLoose(sale.archived),
    shop_id: parseNumberLoose(sale.shopID) ?? undefined,
    customer_id: parseNumberLoose(sale.customerID) ?? undefined,
    employee_id: parseNumberLoose(sale.employeeID) ?? undefined,
    create_time: parseIsoTimestamptz(sale.createTime),
    complete_time: parseIsoTimestamptz(sale.completeTime),
    time_stamp: parseIsoTimestamptz(sale.timeStamp),
    calc_total: parseNumberLoose(sale.calcTotal),
    total: parseNumberLoose(sale.total),
    balance: parseNumberLoose(sale.balance),
    raw: stripLines,
    updated_at: new Date().toISOString(),
  };
}

function extractSaleLines(sale: SaleRow): SaleLineRow[] {
  const sl = sale.SaleLines;
  return normaliseRelationArray<SaleLineRow>(sl, 'SaleLine');
}

function mapSaleLineToDb(brandKey: string, saleId: bigint, line: SaleLineRow) {
  const lineId = parseBigIntLoose(line.saleLineID);
  if (lineId === null) return null;
  return {
    brand_key: brandKey,
    sale_line_id: Number(lineId),
    sale_id: Number(saleId),
    item_id: parseNumberLoose(line.itemID) ?? undefined,
    unit_quantity: parseNumberLoose(line.unitQuantity),
    unit_price: parseNumberLoose(line.unitPrice),
    calc_line_total: parseNumberLoose(line.calcLineTotal),
    note: typeof line.note === 'string' ? line.note : null,
    is_layaway: parseBoolLoose(line.isLayaway),
    raw: line,
    updated_at: new Date().toISOString(),
  };
}

type ItemLookupMeta = { description: string | null; custom_sku: string | null };

/**
 * Lightspeed sometimes returns relations as `{ SaleLine: {...} }`, sometimes as an array of those
 * wrappers, sometimes as bare row objects. `normaliseRelationArray` alone misses the array-of-wrappers case.
 */
function extractLightspeedRelationRows(node: unknown, relationNames: string[]): Record<string, unknown>[] {
  if (node == null) return [];
  if (Array.isArray(node)) {
    const out: Record<string, unknown>[] = [];
    for (const el of node) {
      if (!el || typeof el !== 'object') continue;
      const o = el as Record<string, unknown>;
      let unwrapped = false;
      for (const name of relationNames) {
        const inner = o[name];
        if (inner == null) continue;
        unwrapped = true;
        if (Array.isArray(inner)) {
          for (const x of inner) {
            if (x && typeof x === 'object') out.push(x as Record<string, unknown>);
          }
        } else if (typeof inner === 'object') {
          out.push(inner as Record<string, unknown>);
        }
        break;
      }
      if (!unwrapped) out.push(o);
    }
    return out;
  }
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    for (const name of relationNames) {
      const inner = o[name];
      if (inner == null) continue;
      if (Array.isArray(inner)) {
        return inner.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
      }
      if (typeof inner === 'object') return [inner as Record<string, unknown>];
    }
  }
  return [];
}

function listWorkorderLineRows(wo: Record<string, unknown>): Record<string, unknown>[] {
  const node = wo.WorkorderLines ?? wo.workorderLines;
  return extractLightspeedRelationRows(node, ['WorkorderLine', 'workorderLine']);
}

function listWorkorderItemRows(wo: Record<string, unknown>): Record<string, unknown>[] {
  const node = wo.WorkorderItems ?? wo.workorderItems;
  return extractLightspeedRelationRows(node, ['WorkorderItem', 'workorderItem']);
}

function pickTrimmedString(o: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.length > 0) return t;
    }
  }
  return '';
}

function getWorkorderCustomerNode(wo: Record<string, unknown>): unknown {
  return wo.Customer ?? wo.customer;
}

function formatNameFromCustomerLikeRecord(o: Record<string, unknown>): string | null {
  const first = pickTrimmedString(o, 'firstName', 'FirstName');
  const last = pickTrimmedString(o, 'lastName', 'LastName');
  const company = pickTrimmedString(o, 'company', 'Company');
  const person = [first, last].filter(Boolean).join(' ').trim();
  if (company && person) return `${person} (${company})`;
  if (person) return person;
  if (company) return company;
  const title = pickTrimmedString(o, 'title', 'Title');
  if (title) return title;
  return null;
}

function formatCustomerName(customer: unknown): string | null {
  if (customer == null) return null;
  if (typeof customer === 'string') {
    const t = customer.trim();
    if (!t) return null;
    try {
      const parsed = JSON.parse(t) as unknown;
      return formatCustomerName(parsed);
    } catch {
      return t;
    }
  }
  if (typeof customer !== 'object') return null;
  const o = customer as Record<string, unknown>;
  const direct = formatNameFromCustomerLikeRecord(o);
  if (direct) return direct;
  const contact = o.Contact ?? o.contact;
  if (contact && typeof contact === 'object') {
    return formatNameFromCustomerLikeRecord(contact as Record<string, unknown>);
  }
  return null;
}

function lineItemId(row: Record<string, unknown>): number | null {
  const n = parseNumberLoose(row.itemID ?? row.ItemID);
  if (n == null || !Number.isFinite(n)) return null;
  const t = Math.trunc(n);
  return t > 0 ? t : null;
}

function collectWorkorderItemIds(wo: Record<string, unknown>): number[] {
  const ids = new Set<number>();
  for (const line of listWorkorderLineRows(wo)) {
    const t = lineItemId(line);
    if (t != null) ids.add(t);
  }
  for (const it of listWorkorderItemRows(wo)) {
    const t = lineItemId(it);
    if (t != null) ids.add(t);
  }
  return [...ids];
}

function buildWorkorderLineItems(
  wo: Record<string, unknown>,
  itemById: Map<number, ItemLookupMeta>,
): unknown[] {
  const out: unknown[] = [];
  for (const line of listWorkorderLineRows(wo)) {
    const tid = lineItemId(line);
    const meta = tid != null ? itemById.get(tid) : undefined;
    const desc = meta?.description ?? null;
    const sku = meta?.custom_sku ?? null;
    out.push({
      source: 'WorkorderLine',
      item_id: tid,
      description: desc,
      custom_sku: sku,
      display_label: desc ?? (tid != null ? `Item #${tid}` : null),
      unit_quantity: parseNumberLoose(line.unitQuantity ?? line.UnitQuantity),
      unit_price_override: parseNumberLoose(line.unitPriceOverride ?? line.UnitPriceOverride),
      note: typeof line.note === 'string' ? line.note : null,
      workorder_line_id: parseNumberLoose(line.workorderLineID ?? line.WorkorderLineID),
    });
  }
  for (const it of listWorkorderItemRows(wo)) {
    const tid = lineItemId(it);
    const meta = tid != null ? itemById.get(tid) : undefined;
    const desc = meta?.description ?? null;
    const sku = meta?.custom_sku ?? null;
    out.push({
      source: 'WorkorderItem',
      item_id: tid,
      description: desc,
      custom_sku: sku,
      display_label: desc ?? (tid != null ? `Item #${tid}` : null),
      unit_quantity: parseNumberLoose(it.unitQuantity ?? it.UnitQuantity ?? it.qty ?? it.quantity),
      unit_price: parseNumberLoose(it.unitPrice ?? it.UnitPrice),
      unit_price_override: parseNumberLoose(it.unitPriceOverride ?? it.UnitPriceOverride),
      workorder_item_id: parseNumberLoose(it.workorderItemID ?? it.WorkorderItemID),
    });
  }
  return out;
}

async function loadItemLookupByIds(
  supabase: ReturnType<typeof getAdminClient>,
  brandKey: string,
  itemIds: number[],
): Promise<Map<number, ItemLookupMeta>> {
  const map = new Map<number, ItemLookupMeta>();
  const unique = [...new Set(itemIds)].filter((n) => n > 0);
  const chunkSize = 100;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    const { data, error } = await supabase
      .from('nest_brand_lightspeed_item')
      .select('item_id, description, custom_sku')
      .eq('brand_key', brandKey)
      .in('item_id', chunk);
    if (error) throw new Error(`item lookup: ${error.message}`);
    for (const row of data ?? []) {
      const id = Number(row.item_id);
      if (!Number.isFinite(id)) continue;
      map.set(Math.trunc(id), {
        description: typeof row.description === 'string' ? row.description : null,
        custom_sku: typeof row.custom_sku === 'string' ? row.custom_sku : null,
      });
    }
  }
  return map;
}

function mapWorkorderToDb(
  brandKey: string,
  wo: Record<string, unknown>,
  itemById: Map<number, ItemLookupMeta>,
) {
  const id = parseBigIntLoose(wo.workorderID);
  if (id === null) return null;
  const note = typeof wo.note === 'string' ? wo.note : '';
  const internal = typeof wo.internalNote === 'string' ? wo.internalNote : '';
  const combined = [note, internal].filter(Boolean).join('\n');
  const notes = combined.length > 4000 ? `${combined.slice(0, 3997)}…` : combined;
  return {
    brand_key: brandKey,
    workorder_id: Number(id),
    time_in: parseIsoTimestamptz(wo.timeIn),
    eta_out: parseIsoTimestamptz(wo.etaOut),
    archived: parseBoolLoose(wo.archived),
    warranty: parseBoolLoose(wo.warranty),
    workorder_status_id: parseNumberLoose(wo.workorderStatusID) ?? undefined,
    customer_id: parseNumberLoose(wo.customerID) ?? undefined,
    customer_name: formatCustomerName(getWorkorderCustomerNode(wo)),
    employee_id: parseNumberLoose(wo.employeeID) ?? undefined,
    shop_id: parseNumberLoose(wo.shopID) ?? undefined,
    serialized_id: parseNumberLoose(wo.serializedID) ?? undefined,
    sale_id: parseNumberLoose(wo.saleID) ?? undefined,
    system_sku: typeof wo.systemSku === 'string' ? wo.systemSku : null,
    time_stamp: parseIsoTimestamptz(wo.timeStamp),
    notes: notes || null,
    workorder_line_items: buildWorkorderLineItems(wo, itemById),
    payload: wo,
    updated_at: new Date().toISOString(),
  };
}

function maxIsoTimestamps(rows: { time_stamp: string | null }[]): string | null {
  let best: string | null = null;
  for (const r of rows) {
    const t = r.time_stamp;
    if (!t) continue;
    if (!best || t > best) best = t;
  }
  return best;
}

async function syncBrand(
  supabase: ReturnType<typeof getAdminClient>,
  row: LightspeedPortalConnection,
): Promise<{ brand_key: string; sales_upserted: number; lines_upserted: number; workorders_upserted: number }> {
  const { accessToken, accountId } = await ensureValidLightspeedAccessToken(supabase, row);
  const brandKey = row.brand_key;

  const { data: wmRows } = await supabase
    .from('nest_brand_lightspeed_sync_state')
    .select('resource, last_time_stamp')
    .eq('brand_key', brandKey);

  const saleWm = wmRows?.find((r) => r.resource === 'sale')?.last_time_stamp as string | null | undefined;
  const woWm = wmRows?.find((r) => r.resource === 'workorder')?.last_time_stamp as string | null | undefined;

  const lower90 = isoLowerBoundDaysAgo(RETENTION_DAYS);
  let saleCutoff: string;
  let saleOp: '>' | '>=';
  if (!saleWm) {
    saleCutoff = lower90;
    saleOp = '>=';
  } else if (saleWm > lower90) {
    saleCutoff = saleWm;
    saleOp = '>';
  } else {
    saleCutoff = lower90;
    saleOp = '>=';
  }
  const saleTsParam = `${saleOp},${saleCutoff}`;

  const saleUrl = buildAccountResourceUrl(accountId, 'Sale.json', {
    limit: '100',
    sort: 'timeStamp',
    archived: 'false',
    timeStamp: saleTsParam,
    load_relations: '["SaleLines"]',
  });

  const salePages = await fetchAllPages(accessToken, saleUrl);
  let salesUpserted = 0;
  let linesUpserted = 0;
  const saleRowsForWm: { time_stamp: string | null }[] = [];

  for (const page of salePages) {
    const saleBatch: ReturnType<typeof mapSaleToDb>[] = [];
    const lineBatch: NonNullable<ReturnType<typeof mapSaleLineToDb>>[] = [];

    for (const item of page.items) {
      if (!item || typeof item !== 'object') continue;
      const sale = item as SaleRow;
      const mapped = mapSaleToDb(brandKey, sale);
      if (!mapped) continue;
      saleBatch.push(mapped);
      saleRowsForWm.push({ time_stamp: mapped.time_stamp ?? null });

      const saleId = parseBigIntLoose(sale.saleID);
      if (saleId === null) continue;
      for (const line of extractSaleLines(sale)) {
        const lr = mapSaleLineToDb(brandKey, saleId, line);
        if (lr) lineBatch.push(lr);
      }
    }

    if (saleBatch.length > 0) {
      const { error: e1 } = await supabase.from('nest_brand_lightspeed_sale').upsert(saleBatch, {
        onConflict: 'brand_key,sale_id',
      });
      if (e1) throw new Error(`sale upsert: ${e1.message}`);
      salesUpserted += saleBatch.length;
    }

    if (lineBatch.length > 0) {
      const { error: e2 } = await supabase.from('nest_brand_lightspeed_sale_line').upsert(lineBatch, {
        onConflict: 'brand_key,sale_line_id',
      });
      if (e2) throw new Error(`sale_line upsert: ${e2.message}`);
      linesUpserted += lineBatch.length;
    }
  }

  const saleWatermark = maxIsoTimestamps(saleRowsForWm) ?? saleWm ?? null;
  if (saleWatermark) {
    await supabase.from('nest_brand_lightspeed_sync_state').upsert(
      {
        brand_key: brandKey,
        resource: 'sale',
        last_time_stamp: saleWatermark,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'brand_key,resource' },
    );
  }

  const woLower = isoLowerBoundDaysAgo(RETENTION_DAYS);
  let woCut: string;
  let woOp: '>' | '>=';
  if (!woWm) {
    woCut = woLower;
    woOp = '>=';
  } else if (woWm > woLower) {
    woCut = woWm;
    woOp = '>';
  } else {
    woCut = woLower;
    woOp = '>=';
  }
  const woTsParam = `${woOp},${woCut}`;

  const woUrl = buildAccountResourceUrl(accountId, 'Workorder.json', {
    limit: '100',
    sort: 'timeStamp',
    archived: 'false',
    timeStamp: woTsParam,
    load_relations: '["Customer","Employee","WorkorderStatus","Serialized","WorkorderLines","WorkorderItems","Images"]',
  });

  const woPages = await fetchAllPages(accessToken, woUrl);
  let workordersUpserted = 0;
  const woForWm: { time_stamp: string | null }[] = [];

  const rawWorkorders: Record<string, unknown>[] = [];
  for (const page of woPages) {
    for (const item of page.items) {
      if (!item || typeof item !== 'object') continue;
      rawWorkorders.push(item as Record<string, unknown>);
    }
  }

  const allWoItemIds: number[] = [];
  for (const wo of rawWorkorders) {
    allWoItemIds.push(...collectWorkorderItemIds(wo));
  }
  const itemById = await loadItemLookupByIds(supabase, brandKey, allWoItemIds);

  const woBatch: NonNullable<ReturnType<typeof mapWorkorderToDb>>[] = [];
  for (const wo of rawWorkorders) {
    const mapped = mapWorkorderToDb(brandKey, wo, itemById);
    if (!mapped) continue;
    woBatch.push(mapped);
    woForWm.push({ time_stamp: mapped.time_stamp ?? null });
  }

  if (woBatch.length > 0) {
    const { error: e3 } = await supabase.from('nest_brand_lightspeed_workorder').upsert(woBatch, {
      onConflict: 'brand_key,workorder_id',
    });
    if (e3) throw new Error(`workorder upsert: ${e3.message}`);
    workordersUpserted = woBatch.length;
  }

  const woWatermark = maxIsoTimestamps(woForWm) ?? woWm ?? null;
  if (woWatermark) {
    await supabase.from('nest_brand_lightspeed_sync_state').upsert(
      {
        brand_key: brandKey,
        resource: 'workorder',
        last_time_stamp: woWatermark,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'brand_key,resource' },
    );
  }

  const cutoff = isoLowerBoundDaysAgo(RETENTION_DAYS);
  await supabase.from('nest_brand_lightspeed_sale').delete().eq('brand_key', brandKey).lt('time_stamp', cutoff);

  await supabase.from('nest_brand_lightspeed_workorder').delete().eq('brand_key', brandKey).lt('time_stamp', cutoff);
  await supabase
    .from('nest_brand_lightspeed_workorder')
    .delete()
    .eq('brand_key', brandKey)
    .is('time_stamp', null)
    .lt('time_in', cutoff);

  return {
    brand_key: brandKey,
    sales_upserted: salesUpserted,
    lines_upserted: linesUpserted,
    workorders_upserted: workordersUpserted,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  if (!authorizeInternalRequest(req)) {
    return json({ error: 'unauthorised' }, 401);
  }

  let body: { brand_key?: string } = {};
  if (req.method === 'POST') {
    try {
      const t = await req.text();
      if (t.trim()) body = JSON.parse(t) as { brand_key?: string };
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
  }

  const supabase = getAdminClient();

  let query = supabase
    .from('nest_brand_portal_connections')
    .select('brand_key, access_token, refresh_token, api_endpoint, access_expires_at')
    .eq('provider', PROVIDER);

  if (body.brand_key && typeof body.brand_key === 'string') {
    query = query.eq('brand_key', body.brand_key.trim());
  }

  const { data: rows, error } = await query;
  if (error) return json({ error: error.message }, 500);
  if (!rows?.length) return json({ ok: true, message: 'no_lightspeed_connections', results: [] });

  const results: Record<string, unknown>[] = [];
  for (const r of rows as LightspeedPortalConnection[]) {
    try {
      const summary = await syncBrand(supabase, r);
      results.push({ ok: true, ...summary });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('unauthor') || msg.includes('401')) {
        try {
          const tokens = await exchangeRefreshToken(r.refresh_token);
          await persistRefreshedTokens(supabase, r.brand_key, tokens);
          const retryRow: LightspeedPortalConnection = {
            ...r,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            access_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          };
          const summary = await syncBrand(supabase, retryRow);
          results.push({ ok: true, retried_after_refresh: true, ...summary });
          continue;
        } catch {
          /* fall through */
        }
      }
      results.push({ ok: false, brand_key: r.brand_key, error: msg });
    }
  }

  return json({ ok: true, results });
});
