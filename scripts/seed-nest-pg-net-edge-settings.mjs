#!/usr/bin/env node
/**
 * Seeds public.nest_pg_net_edge_settings (singleton) so pg_cron net.http_post can call Edge Functions.
 * Uses fetch + PostgREST only (no @supabase/supabase-js in Nest/).
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const k = m[1];
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadEnvFile(envPath);

const url = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
const key = (
  process.env.SUPABASE_SECRET_KEY ||
  process.env.NEW_SUPABASE_SECRET_KEY ||
  ''
).trim();
const internalSharedSecret = (
  process.env.INTERNAL_EDGE_SHARED_SECRET ||
  process.env.NEST_INTERNAL_EDGE_SHARED_SECRET ||
  ''
).trim();

if (!url || !key || !internalSharedSecret) {
  console.error(
    'Missing SUPABASE_URL, SUPABASE_SECRET_KEY (or NEW_SUPABASE_SECRET_KEY), or INTERNAL_EDGE_SHARED_SECRET (Nest/.env or env).',
  );
  process.exit(1);
}

const rest = `${url}/rest/v1`;
const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal,resolution=merge-duplicates',
};

const row = {
  id: 1,
  supabase_url: url,
  service_role_key: null,
  internal_shared_secret: internalSharedSecret,
  updated_at: new Date().toISOString(),
};

const up = await fetch(`${rest}/nest_pg_net_edge_settings`, {
  method: 'POST',
  headers,
  body: JSON.stringify(row),
});

if (!up.ok) {
  const t = await up.text();
  console.error('Upsert nest_pg_net_edge_settings failed:', up.status, t.slice(0, 500));
  process.exit(1);
}

console.log('OK: nest_pg_net_edge_settings row id=1 upserted for project', url);

const ping = await fetch(`${rest}/rpc/nest_pg_net_lightspeed_sales_ping`, {
  method: 'POST',
  headers,
  body: '{}',
});

const pingText = await ping.text();
if (!ping.ok) {
  console.error('RPC nest_pg_net_lightspeed_sales_ping failed:', ping.status, pingText.slice(0, 500));
  process.exit(1);
}

let pingId;
try {
  pingId = JSON.parse(pingText);
} catch {
  pingId = pingText;
}

console.log('OK: nest_pg_net_lightspeed_sales_ping pg_net request_id:', pingId);
