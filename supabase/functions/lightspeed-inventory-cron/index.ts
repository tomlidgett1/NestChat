import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getAdminClient } from '../_shared/supabase.ts';
import { requireAnyEnv, requireEnv, getOptionalEnv } from '../_shared/env.ts';
import { authorizeInternalRequest, internalJsonHeaders } from '../_shared/internal-auth.ts';
import {
  buildAccountResourceUrl,
  ensureValidLightspeedAccessToken,
  exchangeRefreshToken,
  getAttributes,
  lightspeedGetJson,
  normaliseItemShopsFromItem,
  normaliseRootItems,
  parseBoolLoose,
  parseLightspeedItemDefaultPrice,
  parseLightspeedItemId,
  parseNumberLoose,
  persistRefreshedTokens,
  sumItemShopQohForShop,
  type LightspeedPortalConnection,
} from '../_shared/lightspeed-client.ts';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const PROVIDER = 'lightspeed';
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function maxPagesPerRun(): number {
  const raw = getOptionalEnv('LIGHTSPEED_INVENTORY_MAX_PAGES');
  const n = raw ? Number(raw) : 50;
  if (!Number.isFinite(n)) return 50;
  return Math.min(50, Math.max(3, Math.trunc(n)));
}

/**
 * Wall clock per HTTP invocation (ms). Stops before Supabase ~150s gateway 504 so the client gets JSON
 * and can resume (cursor in DB). Set LIGHTSPEED_INVENTORY_SYNC_WALL_MS=0 for no wall (large catalogues
 * often 504 instead). Increase project Edge Function max duration if you raise this a lot.
 */
function inventorySyncWallMs(): number {
  const raw = getOptionalEnv('LIGHTSPEED_INVENTORY_SYNC_WALL_MS');
  if (raw == null || String(raw).trim() === '') return 130_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(3_600_000, Math.trunc(n));
}

/** Only guards runaway pagination bugs — not a normal business limit. */
function maxInventoryChunkSafetyLoops(): number {
  const raw = getOptionalEnv('LIGHTSPEED_INVENTORY_MAX_CHUNK_LOOPS');
  const n = raw ? Number(raw) : 50_000;
  if (!Number.isFinite(n)) return 50_000;
  return Math.min(500_000, Math.max(1, Math.trunc(n)));
}

function pageDelayMs(): number {
  const raw = getOptionalEnv('LIGHTSPEED_INVENTORY_PAGE_DELAY_MS');
  const n = raw ? Number(raw) : 650;
  if (!Number.isFinite(n)) return 650;
  return Math.min(2000, Math.max(200, Math.trunc(n)));
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function mapItemRow(brandKey: string, item: Record<string, unknown>, syncedAt: string) {
  const itemId = parseLightspeedItemId(item);
  if (itemId === null) return null;
  const defaultPrice = parseLightspeedItemDefaultPrice(item);
  const shops = normaliseItemShopsFromItem(item);
  const raw = { ...item };
  delete raw.ItemShops;
  delete raw.Prices;
  delete raw.ItemPrice;
  delete raw.ItemPrices;
  return {
    brand_key: brandKey,
    item_id: Number(itemId),
    synced_at: syncedAt,
    description: typeof item.description === 'string' ? item.description : null,
    custom_sku: typeof item.customSku === 'string' ? item.customSku : null,
    upc: typeof item.upc === 'string' ? item.upc : null,
    ean: typeof item.ean === 'string' ? item.ean : null,
    archived: parseBoolLoose(item.archived),
    item_type: typeof item.itemType === 'string' ? item.itemType : null,
    category_id: parseNumberLoose(item.categoryID) ?? undefined,
    manufacturer_id: parseNumberLoose(item.manufacturerID) ?? undefined,
    default_cost: parseNumberLoose(item.defaultCost),
    default_price: defaultPrice,
    qoh: sumItemShopQohForShop(shops, 1),
    item_shops: shops,
    raw,
    updated_at: new Date().toISOString(),
  };
}

type ItemSyncState = {
  inventory_next_page_url: string | null;
  inventory_run_synced_at: string | null;
};

async function loadItemSyncState(
  supabase: ReturnType<typeof getAdminClient>,
  brandKey: string,
): Promise<ItemSyncState | null> {
  const { data, error } = await supabase
    .from('nest_brand_lightspeed_sync_state')
    .select('inventory_next_page_url, inventory_run_synced_at')
    .eq('brand_key', brandKey)
    .eq('resource', 'item')
    .maybeSingle();
  if (error) throw new Error(`item sync state read: ${error.message}`);
  if (!data) return null;
  return {
    inventory_next_page_url: data.inventory_next_page_url as string | null,
    inventory_run_synced_at: data.inventory_run_synced_at as string | null,
  };
}

async function persistItemSyncProgress(
  supabase: ReturnType<typeof getAdminClient>,
  brandKey: string,
  runSyncedAt: string,
  nextPageUrl: string | null,
): Promise<void> {
  const { error } = await supabase.from('nest_brand_lightspeed_sync_state').upsert(
    {
      brand_key: brandKey,
      resource: 'item',
      inventory_run_synced_at: runSyncedAt,
      inventory_next_page_url: nextPageUrl,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'brand_key,resource' },
  );
  if (error) throw new Error(`item sync state write: ${error.message}`);
}

async function markItemSyncComplete(
  supabase: ReturnType<typeof getAdminClient>,
  brandKey: string,
  runSyncedAt: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { error: e1 } = await supabase.from('nest_brand_lightspeed_sync_state').upsert(
    {
      brand_key: brandKey,
      resource: 'item',
      inventory_run_synced_at: null,
      inventory_next_page_url: null,
      inventory_last_completed_at: now,
      updated_at: now,
    },
    { onConflict: 'brand_key,resource' },
  );
  if (e1) throw new Error(`item sync complete state: ${e1.message}`);

  const { error: e2 } = await supabase
    .from('nest_brand_lightspeed_item')
    .delete()
    .eq('brand_key', brandKey)
    .lt('synced_at', runSyncedAt);
  if (e2) throw new Error(`item stale delete: ${e2.message}`);
}

async function flushItemBatch(
  supabase: ReturnType<typeof getAdminClient>,
  batch: NonNullable<ReturnType<typeof mapItemRow>>[],
): Promise<void> {
  if (batch.length === 0) return;
  const { error } = await supabase.from('nest_brand_lightspeed_item').upsert(batch, {
    onConflict: 'brand_key,item_id',
  });
  if (error) throw new Error(`item upsert: ${error.message}`);
}

/**
 * Fetches up to `maxPagesPerRun()` Item pages, persists cursor, returns whether more pages remain.
 */
async function syncInventoryChunkForBrand(
  supabase: ReturnType<typeof getAdminClient>,
  row: LightspeedPortalConnection,
): Promise<{ brand_key: string; upserted: number; incomplete: boolean }> {
  const { accessToken, accountId } = await ensureValidLightspeedAccessToken(supabase, row);
  const brandKey = row.brand_key;

  const firstUrl = buildAccountResourceUrl(accountId, 'Item.json', {
    limit: '100',
    archived: 'true',
    // Retail API includes `Prices.ItemPrice` on Item.json by default; extra ItemPrice load_relations can omit it.
    load_relations: '["ItemShops"]',
  });

  const existing = await loadItemSyncState(supabase, brandKey);
  let runSyncedAt: string;
  let url: string;

  if (existing?.inventory_next_page_url && existing.inventory_run_synced_at) {
    runSyncedAt = existing.inventory_run_synced_at;
    url = existing.inventory_next_page_url;
  } else {
    runSyncedAt = new Date().toISOString();
    url = firstUrl;
    await persistItemSyncProgress(supabase, brandKey, runSyncedAt, null);
  }

  const maxPages = maxPagesPerRun();
  const delayMs = pageDelayMs();
  let upserted = 0;
  const batch: NonNullable<ReturnType<typeof mapItemRow>>[] = [];
  let pagesDone = 0;
  let nextUrl: string | null = url;

  while (nextUrl && pagesDone < maxPages) {
    const data = await lightspeedGetJson(accessToken, nextUrl);
    const attrs = getAttributes(data);
    const keys = Object.keys(data).filter((k) => k !== '@attributes');
    const entityKey = keys.find((k) => k !== 'message') ?? keys[0] ?? '';
    const items = entityKey ? normaliseRootItems(data, entityKey) : [];

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const mapped = mapItemRow(brandKey, item as Record<string, unknown>, runSyncedAt);
      if (!mapped) continue;
      batch.push(mapped);
      if (batch.length >= 80) {
        await flushItemBatch(supabase, batch);
        upserted += batch.length;
        batch.length = 0;
      }
    }

    pagesDone++;
    const next = attrs.next?.trim();
    nextUrl = next && next.length > 0 ? next : null;

    if (nextUrl) {
      await persistItemSyncProgress(supabase, brandKey, runSyncedAt, nextUrl);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  if (batch.length > 0) {
    await flushItemBatch(supabase, batch);
    upserted += batch.length;
  }

  if (nextUrl) {
    return { brand_key: brandKey, upserted, incomplete: true };
  }

  await markItemSyncComplete(supabase, brandKey, runSyncedAt);
  return { brand_key: brandKey, upserted, incomplete: false };
}

/**
 * Runs inventory chunks back-to-back until the catalogue is complete, this invocation hits the optional
 * wall clock, or the safety loop cap. Re-reads the connection row each iteration for fresh tokens.
 */
async function runInventoryChunkLoops(
  supabase: ReturnType<typeof getAdminClient>,
  brandKey: string,
): Promise<{ upserted: number; incomplete: boolean; chunk_loops: number; stopped_for_wall: boolean }> {
  let totalUpserted = 0;
  let incomplete = false;
  let chunkLoops = 0;
  let stoppedForWall = false;
  const wallMs = inventorySyncWallMs();
  const deadline = wallMs > 0 ? Date.now() + wallMs : null;
  const safetyMax = maxInventoryChunkSafetyLoops();

  for (let i = 0; i < safetyMax; i++) {
    if (deadline !== null && Date.now() >= deadline) {
      incomplete = true;
      stoppedForWall = true;
      break;
    }

    const { data: fresh, error } = await supabase
      .from('nest_brand_portal_connections')
      .select('brand_key, access_token, refresh_token, api_endpoint, access_expires_at')
      .eq('provider', PROVIDER)
      .eq('brand_key', brandKey)
      .maybeSingle();
    if (error) throw new Error(`connection read: ${error.message}`);
    if (!fresh) throw new Error('Lightspeed connection row missing during inventory sync');

    const summary = await syncInventoryChunkForBrand(supabase, fresh as LightspeedPortalConnection);
    totalUpserted += summary.upserted;
    chunkLoops = i + 1;
    if (!summary.incomplete) {
      incomplete = false;
      break;
    }
    incomplete = true;
  }

  return { upserted: totalUpserted, incomplete, chunk_loops: chunkLoops, stopped_for_wall: stoppedForWall };
}

function scheduleInventoryContinue(): void {
  try {
    const base = requireEnv('SUPABASE_URL').replace(/\/$/, '');
    const fnUrl = `${base}/functions/v1/lightspeed-inventory-cron`;
    EdgeRuntime.waitUntil(
      fetch(fnUrl, {
        method: 'POST',
        headers: internalJsonHeaders(),
        body: JSON.stringify({ resume_only: true }),
      })
        .then((res) => res.text())
        .then((t) => {
          console.log('[lightspeed-inventory-cron] chained chunk ok, body head:', t.slice(0, 180));
        })
        .catch((e) => console.error('[lightspeed-inventory-cron] chained chunk failed', e)),
    );
  } catch (e) {
    console.error('[lightspeed-inventory-cron] schedule continue failed', e);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  if (!authorizeInternalRequest(req)) {
    return json({ error: 'unauthorised' }, 401);
  }

  let body: { brand_key?: string; resume_only?: boolean } = {};
  if (req.method === 'POST') {
    try {
      const t = await req.text();
      if (t.trim()) body = JSON.parse(t) as { brand_key?: string; resume_only?: boolean };
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

  let connections = rows as LightspeedPortalConnection[];

  if (body.resume_only === true) {
    const { data: partial, error: pe } = await supabase
      .from('nest_brand_lightspeed_sync_state')
      .select('brand_key')
      .eq('resource', 'item')
      .not('inventory_next_page_url', 'is', null);
    if (pe) return json({ error: pe.message }, 500);
    const want = new Set((partial ?? []).map((p) => p.brand_key as string));
    connections = connections.filter((c) => want.has(c.brand_key));
    if (!connections.length) {
      return json({ ok: true, message: 'nothing_to_resume', results: [] });
    }
  }

  const results: Record<string, unknown>[] = [];
  let anyIncomplete = false;

  for (const r of connections) {
    try {
      const out = await runInventoryChunkLoops(supabase, r.brand_key);
      if (out.incomplete) anyIncomplete = true;
      results.push({
        ok: true,
        brand_key: r.brand_key,
        upserted: out.upserted,
        incomplete: out.incomplete,
        chunk_loops: out.chunk_loops,
        stopped_for_wall: out.stopped_for_wall,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('unauthor') || msg.includes('401')) {
        try {
          const tokens = await exchangeRefreshToken(r.refresh_token);
          await persistRefreshedTokens(supabase, r.brand_key, tokens);
          const out = await runInventoryChunkLoops(supabase, r.brand_key);
          if (out.incomplete) anyIncomplete = true;
          results.push({
            ok: true,
            retried_after_refresh: true,
            brand_key: r.brand_key,
            upserted: out.upserted,
            incomplete: out.incomplete,
            chunk_loops: out.chunk_loops,
            stopped_for_wall: out.stopped_for_wall,
          });
          continue;
        } catch {
          /* fall through */
        }
      }
      results.push({ ok: false, brand_key: r.brand_key, error: msg });
    }
  }

  if (anyIncomplete && typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
    scheduleInventoryContinue();
  }

  return json({
    ok: true,
    resume_only: body.resume_only === true,
    max_pages_per_run: maxPagesPerRun(),
    inventory_sync_wall_ms: inventorySyncWallMs(),
    max_chunk_safety_loops: maxInventoryChunkSafetyLoops(),
    chained_continue: anyIncomplete,
    results,
  });
});
