import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { requireAnyEnv, requireEnv } from '../_shared/env.ts';
import { authorizeInternalRequest, internalJsonHeaders } from '../_shared/internal-auth.ts';

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

/**
 * Sequential bootstrap: inventory first (so work order lines can resolve item descriptions),
 * then sales and work orders. Invoked by Postgres after OAuth handshake timestamp is set.
 */
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

  const brandKey = typeof body.brand_key === 'string' ? body.brand_key.trim() : '';
  if (!brandKey) {
    return json({ error: 'brand_key required' }, 400);
  }

  const base = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const headers = {
    ...internalJsonHeaders(),
  } as const;
  const payload = JSON.stringify({ brand_key: brandKey });

  let inventoryStatus = 0;
  let inventoryBody = '';
  try {
    const inv = await fetch(`${base}/functions/v1/lightspeed-inventory-cron`, {
      method: 'POST',
      headers,
      body: payload,
    });
    inventoryStatus = inv.status;
    inventoryBody = await inv.text();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[lightspeed-initial-sync] inventory fetch failed', msg);
    return json({ ok: false, step: 'inventory', error: msg }, 502);
  }

  let salesStatus = 0;
  let salesBody = '';
  try {
    const sw = await fetch(`${base}/functions/v1/lightspeed-sync-sales-workorders`, {
      method: 'POST',
      headers,
      body: payload,
    });
    salesStatus = sw.status;
    salesBody = await sw.text();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[lightspeed-initial-sync] sales/workorders fetch failed', msg);
    return json(
      {
        ok: false,
        step: 'sales_workorders',
        error: msg,
        inventory: { status: inventoryStatus, body_head: inventoryBody.slice(0, 240) },
      },
      502,
    );
  }

  console.log('[lightspeed-initial-sync] done', brandKey, inventoryStatus, salesStatus);

  return json({
    ok: true,
    brand_key: brandKey,
    inventory: { status: inventoryStatus, body_head: inventoryBody.slice(0, 240) },
    sales_workorders: { status: salesStatus, body_head: salesBody.slice(0, 240) },
  });
});
