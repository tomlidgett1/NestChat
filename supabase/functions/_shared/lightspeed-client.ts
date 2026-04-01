/**
 * Lightspeed Retail (R-Series) API + OAuth helpers for Edge Functions.
 * Base: https://api.lightspeedapp.com/API/V3/Account/{accountID}/…
 * Token: https://cloud.lightspeedapp.com/auth/oauth/token
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { getOptionalEnv } from './env.ts';

export const LIGHTSPEED_API_ORIGIN = 'https://api.lightspeedapp.com';
export const LIGHTSPEED_TOKEN_URL = 'https://cloud.lightspeedapp.com/auth/oauth/token';

export type LightspeedPortalConnection = {
  brand_key: string;
  access_token: string;
  refresh_token: string;
  api_endpoint: string;
  access_expires_at: string | null;
};

export type LightspeedTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

function pickClientCreds(): { clientId: string; clientSecret: string } {
  const clientId =
    getOptionalEnv('LIGHTSPEED_OAUTH_CLIENT_ID') ?? getOptionalEnv('NEST_LIGHTSPEED_OAUTH_CLIENT_ID') ?? '';
  const clientSecret =
    getOptionalEnv('LIGHTSPEED_OAUTH_CLIENT_SECRET') ??
    getOptionalEnv('NEST_LIGHTSPEED_OAUTH_CLIENT_SECRET') ??
    '';
  if (!clientId || !clientSecret) {
    throw new Error(
      'Lightspeed OAuth client is not configured (LIGHTSPEED_OAUTH_CLIENT_ID / LIGHTSPEED_OAUTH_CLIENT_SECRET)',
    );
  }
  return { clientId, clientSecret };
}

export async function exchangeRefreshToken(refreshToken: string): Promise<LightspeedTokenResponse> {
  const { clientId, clientSecret } = pickClientCreds();
  const res = await fetch(LIGHTSPEED_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Lightspeed token refresh: non-JSON response (${res.status})`);
  }
  if (!res.ok) {
    const hint = typeof data.hint === 'string' ? data.hint : '';
    const err = typeof data.error === 'string' ? data.error : 'token_error';
    throw new Error(`Lightspeed token refresh failed: ${err}${hint ? ` — ${hint}` : ''}`);
  }
  const access_token = data.access_token;
  const refresh_token = data.refresh_token;
  const expires_in = Number(data.expires_in);
  if (typeof access_token !== 'string' || typeof refresh_token !== 'string' || !Number.isFinite(expires_in)) {
    throw new Error('Lightspeed token refresh: invalid response shape');
  }
  return { access_token, refresh_token, expires_in };
}

/** Persist new tokens after refresh (Lightspeed rotates refresh tokens). */
export async function persistRefreshedTokens(
  supabase: SupabaseClient,
  brandKey: string,
  tokens: LightspeedTokenResponse,
): Promise<void> {
  const accessExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const { error } = await supabase
    .from('nest_brand_portal_connections')
    .update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      access_expires_at: accessExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq('brand_key', brandKey)
    .eq('provider', 'lightspeed');
  if (error) throw new Error(`Lightspeed token save failed: ${error.message}`);
}

const EXPIRY_SKEW_MS = 120_000;

function accessTokenNeedsRefresh(accessExpiresAt: string | null): boolean {
  if (!accessExpiresAt) return true;
  const t = new Date(accessExpiresAt).getTime();
  if (!Number.isFinite(t)) return true;
  return t <= Date.now() + EXPIRY_SKEW_MS;
}

export async function ensureValidLightspeedAccessToken(
  supabase: SupabaseClient,
  row: LightspeedPortalConnection,
): Promise<{ accessToken: string; accountId: string }> {
  const accountId = row.api_endpoint.trim();
  if (!accountId) throw new Error('Lightspeed connection missing account ID (api_endpoint)');

  let accessToken = row.access_token;
  if (accessTokenNeedsRefresh(row.access_expires_at)) {
    const tokens = await exchangeRefreshToken(row.refresh_token);
    await persistRefreshedTokens(supabase, row.brand_key, tokens);
    accessToken = tokens.access_token;
  }
  return { accessToken, accountId };
}

export type LightspeedListEnvelope = {
  attrs: Record<string, string>;
  items: unknown[];
};

export function getAttributes(root: Record<string, unknown>): Record<string, string> {
  const raw = root['@attributes'];
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v != null) out[k] = String(v);
  }
  return out;
}

export function normaliseRelationArray<T = Record<string, unknown>>(node: unknown, relationKey: string): T[] {
  if (node == null) return [];
  if (Array.isArray(node)) {
    return node.filter((x) => x && typeof x === 'object') as T[];
  }
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    const inner = o[relationKey];
    if (inner == null) return [];
    if (Array.isArray(inner)) return inner.filter((x) => x && typeof x === 'object') as T[];
    if (typeof inner === 'object') return [inner as T];
  }
  return [];
}

/**
 * Unwrap Lightspeed relation blobs: `{ ItemShop: {...} }`, arrays of those wrappers, or bare rows.
 * `normaliseRelationArray` alone keeps wrapper objects when the parent is an array.
 */
export function extractLightspeedRelationRows(
  node: unknown,
  relationNames: string[],
): Record<string, unknown>[] {
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

/** Flat ItemShop rows from an Item payload (`ItemShops` / `itemShops`). */
export function normaliseItemShopsFromItem(item: Record<string, unknown>): unknown[] {
  const node = item.ItemShops ?? item.itemShops;
  return extractLightspeedRelationRows(node, ['ItemShop', 'itemShop']) as unknown[];
}

export function normaliseRootItems(root: Record<string, unknown>, entityKey: string): unknown[] {
  const node = root[entityKey];
  if (node == null) return [];
  if (Array.isArray(node)) return node;
  if (typeof node === 'object') return [node];
  return [];
}

export async function lightspeedGetJson(
  accessToken: string,
  url: string,
  opts?: { signal?: AbortSignal; max429Retries?: number },
): Promise<Record<string, unknown>> {
  const max429 = opts?.max429Retries ?? 8;
  let attempt429 = 0;

  while (true) {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: opts?.signal,
    });
    const text = await res.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`Lightspeed API non-JSON (${res.status}) for ${url.slice(0, 120)}`);
    }

    if (res.status === 429 && attempt429 < max429) {
      attempt429++;
      const ra = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(ra) && ra > 0
        ? Math.min(ra * 1000, 60_000)
        : Math.min(2000 * attempt429, 30_000);
      console.warn(`[lightspeed] 429, backing off ${waitMs}ms (attempt ${attempt429}/${max429})`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (res.status === 401) {
      throw new Error('Lightspeed API unauthorised (access token may be expired)');
    }
    if (!res.ok) {
      const msg = typeof data.message === 'string' ? data.message : text.slice(0, 200);
      throw new Error(`Lightspeed API ${res.status}: ${msg}`);
    }
    return data;
  }
}

/** Follow @attributes.next until exhausted. */
export async function fetchAllPages(
  accessToken: string,
  firstUrl: string,
  onRateLimitMs = 350,
): Promise<LightspeedListEnvelope[]> {
  const pages: LightspeedListEnvelope[] = [];
  let url: string | null = firstUrl;
  while (url) {
    const data = await lightspeedGetJson(accessToken, url);
    const attrs = getAttributes(data);
    const keys = Object.keys(data).filter((k) => k !== '@attributes');
    const entityKey = keys.find((k) => k !== 'message') ?? keys[0] ?? '';
    const items = entityKey ? normaliseRootItems(data, entityKey) : [];
    pages.push({ attrs, items });
    const next = attrs.next?.trim();
    url = next && next.length > 0 ? next : null;
    if (url && onRateLimitMs > 0) {
      await new Promise((r) => setTimeout(r, onRateLimitMs));
    }
  }
  return pages;
}

export function buildAccountResourceUrl(
  accountId: string,
  resourcePath: string,
  query: Record<string, string | undefined>,
): string {
  const path = resourcePath.replace(/^\//, '');
  const base = `${LIGHTSPEED_API_ORIGIN}/API/V3/Account/${encodeURIComponent(accountId)}/${path}`;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') sp.set(k, v);
  }
  const q = sp.toString();
  return q ? `${base}?${q}` : base;
}

export function parseBoolLoose(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

export function parseBigIntLoose(v: unknown): bigint | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  const s = String(v).trim();
  if (!s || !/^-?\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

/** Item payloads sometimes nest the id under `@attributes` (Lightspeed JSON variants). */
export function parseLightspeedItemId(item: Record<string, unknown>): bigint | null {
  const direct = parseBigIntLoose(item.itemID);
  if (direct !== null) return direct;
  const attrs = item['@attributes'];
  if (attrs && typeof attrs === 'object') {
    const a = attrs as Record<string, unknown>;
    return parseBigIntLoose(a.itemID);
  }
  return null;
}

export function parseNumberLoose(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Default sell price from Item JSON: `Prices.ItemPrice[]` (per Retail API samples), or top-level `ItemPrice` / `ItemPrices`.
 * Prefer `useType` Default / `useTypeID` 1.
 */
export function parseLightspeedItemDefaultPrice(item: Record<string, unknown>): number | null {
  const rows: Record<string, unknown>[] = [];

  const pricesNode = item.Prices ?? item.prices;
  if (pricesNode && typeof pricesNode === 'object') {
    for (const r of normaliseRelationArray<Record<string, unknown>>(pricesNode, 'ItemPrice')) {
      rows.push(r);
    }
  }

  const ip = item.ItemPrice ?? item.itemPrice;
  if (ip != null) {
    if (Array.isArray(ip)) {
      for (const x of ip) {
        if (x && typeof x === 'object') rows.push(x as Record<string, unknown>);
      }
    } else if (typeof ip === 'object') {
      const nested = normaliseRelationArray<Record<string, unknown>>(ip, 'ItemPrice');
      if (nested.length > 0) {
        for (const r of nested) rows.push(r);
      } else if ((ip as Record<string, unknown>).amount != null || (ip as Record<string, unknown>).Amount != null) {
        rows.push(ip as Record<string, unknown>);
      }
    }
  }

  const itemPrices = item.ItemPrices ?? item.itemPrices;
  if (itemPrices && typeof itemPrices === 'object') {
    for (const r of normaliseRelationArray<Record<string, unknown>>(itemPrices, 'ItemPrice')) {
      rows.push(r);
    }
  }

  if (rows.length === 0) return null;

  const pickAmount = (r: Record<string, unknown>): number | null =>
    parseNumberLoose(r.amount ?? r.Amount);

  const defaultRow = rows.find((r) => String(r.useType ?? r.UseType ?? '').toLowerCase() === 'default');
  if (defaultRow) {
    const a = pickAmount(defaultRow);
    if (a != null) return a;
  }
  const idRow = rows.find((r) => String(r.useTypeID ?? r.UseTypeID ?? '') === '1');
  if (idRow) {
    const a = pickAmount(idRow);
    if (a != null) return a;
  }
  return pickAmount(rows[0]);
}

export function parseIsoTimestamptz(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** Sum `qoh` for ItemShop rows matching `shopId` (Lightspeed uses string shopID, e.g. "1"). */
export function sumItemShopQohForShop(itemShops: unknown, shopId: number): number {
  if (!Array.isArray(itemShops)) return 0;
  let t = 0;
  for (const s of itemShops) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    const sidRaw = o.shopID ?? o.ShopID;
    const sid =
      typeof sidRaw === 'number' && Number.isFinite(sidRaw)
        ? Math.trunc(sidRaw)
        : Number(String(sidRaw ?? '').trim());
    if (!Number.isFinite(sid) || Math.trunc(sid) !== shopId) continue;
    const q = o.qoh ?? o.QOH;
    if (typeof q === 'number' && Number.isFinite(q)) {
      t += q;
      continue;
    }
    if (typeof q === 'string' && q.trim() !== '') {
      const n = Number(q.trim());
      if (Number.isFinite(n)) t += n;
    }
  }
  return Math.trunc(t);
}
