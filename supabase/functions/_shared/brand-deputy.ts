import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { getOptionalEnv } from './env.ts';

const PROVIDER = 'deputy';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** Triggers live Deputy roster/timesheet fetch (read-only QUERY). */
const WORKFORCE_QUERY_RE =
  /(\broster(?:ed|s)?\b|\bshift\b|\bshifts\b|\btimesheet\b|\btimesheets\b|\bdeputy\b|\bon\s+shift\b|who'?s?\s+(?:working|on\b|in\b|rostered)|who\s+(?:is|was)\s+(?:working|on\b|in\b|rostered)|who\s+work(?:s|ed)?\b|who\s+(?:closed?|opened?)\b|who\s+(?:has|have)\s+(?:worked|been\s+working)|working\s+(?:tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this\s+week|next\s+week|last\s+week)|work(?:ed|ing)?\s+(?:last|this|next)\s+week|when\s+(?:do(?:es)?|did|is|am)\s+\w+\s+work|(?:am\s+i|is\s+\w+)\s+working|hours?\s+(?:logged|worked)|how\s+many\s+hours|staff(?:ing)?\s+on|(?:what|whos?)\s+(?:time|day)\s+does\s+\w+\s+(?:start|finish|work)|how\s+many\s+(?:people|staff)|did\s+\w+\s+work|\bwho\s+was\s+on\b)/i;

export function messageSuggestsWorkforceQuery(message: string): boolean {
  return WORKFORCE_QUERY_RE.test(message.trim());
}

export interface DeputyConnectionRow {
  brand_key: string;
  access_token: string;
  refresh_token: string;
  api_endpoint: string;
  access_expires_at: string | null;
}

export type DeputyConnectionFailureCode =
  | 'oauth_missing'
  | 'db_error'
  | 'not_connected'
  | 'token_refresh';

export type DeputyConnectionResult =
  | {
    ok: true;
    apiHost: string;
    accessToken: string;
    connection: DeputyConnectionRow;
    secrets: { clientId: string; clientSecret: string; redirectUri: string };
  }
  | { ok: false; code: DeputyConnectionFailureCode; detail?: string };

function normaliseApiHost(endpoint: string): string {
  let h = endpoint.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return h;
}

function deputyOAuthSecrets():
  | { clientId: string; clientSecret: string; redirectUri: string }
  | null {
  const clientId =
    getOptionalEnv('DEPUTY_OAUTH_CLIENT_ID') ?? getOptionalEnv('NEST_DEPUTY_OAUTH_CLIENT_ID');
  const clientSecret =
    getOptionalEnv('DEPUTY_OAUTH_CLIENT_SECRET') ?? getOptionalEnv('NEST_DEPUTY_OAUTH_CLIENT_SECRET');
  const redirectUri =
    getOptionalEnv('DEPUTY_OAUTH_REDIRECT_URI') ?? getOptionalEnv('NEST_DEPUTY_OAUTH_REDIRECT_URI');
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

function melbourneYmdForInstant(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/** Start of calendar day YYYY-MM-DD in Australia/Melbourne (unix ms). */
function melbourneMidnightMsForYmd(ymd: string): number {
  const [y, mo, d] = ymd.split('-').map(Number);
  let lo = Date.UTC(y, mo - 1, d) - 48 * 3600 * 1000;
  let hi = Date.UTC(y, mo - 1, d) + 48 * 3600 * 1000;
  while (hi - lo > 60 * 1000) {
    const mid = Math.floor((lo + hi) / 2);
    const midYmd = melbourneYmdForInstant(mid);
    if (midYmd < ymd) lo = mid;
    else hi = mid;
  }
  let t = hi;
  while (melbourneYmdForInstant(t - 60 * 1000) === ymd) t -= 60 * 1000;
  return t;
}

/** Next calendar date after `ymd` in Australia/Melbourne. */
function nextMelbourneYmd(ymd: string): string {
  const ms = melbourneMidnightMsForYmd(ymd) + 30 * 3600 * 1000;
  return melbourneYmdForInstant(ms);
}

function resolveTimesheetLookbackDays(message: string): number {
  const lower = message.toLowerCase();
  const nDays = lower.match(/\b(?:last|past)\s+(\d+)\s+days?\b/);
  if (nDays) return Math.min(Number(nDays[1]), 90);
  const nWeeks = lower.match(/\b(?:last|past)\s+(\d+)\s+weeks?\b/);
  if (nWeeks) return Math.min(Number(nWeeks[1]) * 7, 90);
  const nMonths = lower.match(/\b(?:last|past)\s+(\d+)\s+months?\b/);
  if (nMonths) return Math.min(Number(nMonths[1]) * 30, 90);
  if (/\bthis\s+month\b/.test(lower)) return 31;
  if (/\blast\s+month\b/.test(lower)) return 60;
  if (/\blast\s+week\b/.test(lower)) return 7;
  if (/\b(?:last|past)\s+quarter\b/.test(lower)) return 90;
  return 14;
}

function resolveRosterForwardDays(message: string): number {
  const lower = message.toLowerCase();
  const nDays = lower.match(/\b(?:next|coming)\s+(\d+)\s+days?\b/);
  if (nDays) return Math.min(Number(nDays[1]), 90);
  const nWeeks = lower.match(/\b(?:next|coming)\s+(\d+)\s+weeks?\b/);
  if (nWeeks) return Math.min(Number(nWeeks[1]) * 7, 90);
  const nMonths = lower.match(/\b(?:next|coming)\s+(\d+)\s+months?\b/);
  if (nMonths) return Math.min(Number(nMonths[1]) * 30, 90);
  if (/\bnext\s+month\b/.test(lower)) return 45;
  if (/\bnext\s+week\b/.test(lower)) return 14;
  if (/\brest\s+of\s+(?:the\s+)?month\b/.test(lower)) return 31;
  return 14;
}

function resolveRosterLookbackDays(message: string): number {
  const lower = message.toLowerCase();
  if (/\bweek\s+before\s+(?:last|that)\b/.test(lower)) return 21;
  const nWeeks = lower.match(/\b(?:last|past|previous)\s+(\d+)\s+weeks?\b/);
  if (nWeeks) return Math.min(Number(nWeeks[1]) * 7 + 7, 90);
  const nDays = lower.match(/\b(?:last|past)\s+(\d+)\s+days?\b/);
  if (nDays) return Math.min(Number(nDays[1]), 90);
  const nMonths = lower.match(/\b(?:last|past|previous)\s+(\d+)\s+months?\b/);
  if (nMonths) return Math.min(Number(nMonths[1]) * 30, 90);
  if (/\blast\s+week\b/.test(lower)) return 14;
  if (/\blast\s+month\b/.test(lower)) return 45;
  if (/\bvs\b.*\b(?:last|before)\b|\b(?:last|before)\b.*\bvs\b/.test(lower)) return 21;
  if (/\bcompar/.test(lower) && /\b(?:week|month|period)\b/.test(lower)) return 21;
  return 0;
}

function formatUnixMelbourne(unixSec: number): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(unixSec * 1000));
}

/** Time-of-day only (for roster lines under a day heading). */
function formatTimeOnlyMelbourne(unixSec: number): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(unixSec * 1000));
}

function melbourneDayKeyFromUnix(unixSec: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(unixSec * 1000));
}

function melbourneLongDayHeadingFromUnix(unixSec: number): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(unixSec * 1000));
}

function unwrapDeputyResult(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    if (Array.isArray(o.result)) return o.result as Record<string, unknown>[];
    if (Array.isArray(o.data)) return o.data as Record<string, unknown>[];
  }
  return [];
}

function displayNameFromRow(row: Record<string, unknown>): string {
  const meta = row._DPMetaData as Record<string, unknown> | undefined;
  const emp = meta?.EmployeeInfo as Record<string, unknown> | undefined;
  const n = emp?.DisplayName;
  if (typeof n === 'string' && n.trim()) return n.trim();
  const e = row.Employee;
  return typeof e === 'number' || typeof e === 'string' ? `Employee ${e}` : 'Unknown';
}

export async function deputyResourceQuery(
  apiHost: string,
  accessToken: string,
  resource: string,
  search: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const url = `https://${apiHost}/api/v1/resource/${resource}/QUERY`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ search }),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${resource} QUERY: non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const msg =
      json && typeof json === 'object' && 'error' in json
        ? String((json as Record<string, unknown>).error)
        : text.slice(0, 200);
    throw new Error(`${resource} QUERY failed (HTTP ${res.status}): ${msg}`);
  }
  return unwrapDeputyResult(json);
}

async function refreshDeputyAccessToken(
  supabase: SupabaseClient,
  row: DeputyConnectionRow,
  secrets: { clientId: string; clientSecret: string; redirectUri: string },
): Promise<string> {
  const host = normaliseApiHost(row.api_endpoint);
  const url = `https://${host}/oauth/access_token`;
  const body = new URLSearchParams({
    client_id: secrets.clientId,
    client_secret: secrets.clientSecret,
    redirect_uri: secrets.redirectUri,
    grant_type: 'refresh_token',
    refresh_token: row.refresh_token,
    scope: 'longlife_refresh_token',
  });

  const tr = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await tr.text();
  let tokenJson: Record<string, unknown>;
  try {
    tokenJson = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('Deputy token refresh: invalid JSON');
  }
  if (!tr.ok) {
    const msg =
      typeof tokenJson.error === 'string'
        ? tokenJson.error
        : typeof tokenJson.message === 'string'
          ? tokenJson.message
          : 'refresh_failed';
    throw new Error(`Deputy token refresh: ${msg}`);
  }

  const accessToken = tokenJson.access_token;
  const refreshToken = tokenJson.refresh_token;
  const expiresIn = tokenJson.expires_in;
  const endpointRaw = tokenJson.endpoint;

  if (typeof accessToken !== 'string') {
    throw new Error('Deputy token refresh: missing access_token');
  }

  const newRefresh = typeof refreshToken === 'string' ? refreshToken : row.refresh_token;
  const expiresSec = typeof expiresIn === 'number' ? expiresIn : Number(expiresIn);
  const accessExpiresAt =
    Number.isFinite(expiresSec) && expiresSec > 0
      ? new Date(Date.now() + expiresSec * 1000).toISOString()
      : null;

  let apiEndpoint = host;
  if (typeof endpointRaw === 'string' && endpointRaw.trim()) {
    const n = normaliseApiHost(endpointRaw);
    if (n) apiEndpoint = n;
  }

  const { error: upErr } = await supabase
    .from('nest_brand_portal_connections')
    .update({
      access_token: accessToken,
      refresh_token: newRefresh,
      api_endpoint: apiEndpoint,
      access_expires_at: accessExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq('brand_key', row.brand_key)
    .eq('provider', PROVIDER);

  if (upErr) {
    console.error('[brand-deputy] failed to persist refreshed tokens:', upErr.message);
  }

  return accessToken;
}

async function ensureValidAccessToken(
  supabase: SupabaseClient,
  row: DeputyConnectionRow,
  secrets: { clientId: string; clientSecret: string; redirectUri: string },
): Promise<string> {
  const exp = row.access_expires_at ? new Date(row.access_expires_at).getTime() : 0;
  const needsRefresh = !exp || exp - TOKEN_REFRESH_BUFFER_MS <= Date.now();
  if (!needsRefresh) return row.access_token;
  return refreshDeputyAccessToken(supabase, row, secrets);
}

/** Shared resolver for read and write Deputy API calls. */
export async function resolveDeputyConnection(
  supabase: SupabaseClient,
  brandKey: string,
): Promise<DeputyConnectionResult> {
  const secrets = deputyOAuthSecrets();
  if (!secrets) {
    console.warn('[brand-deputy] OAuth secrets not configured on edge function');
    return { ok: false, code: 'oauth_missing' };
  }

  const { data: row, error } = await supabase
    .from('nest_brand_portal_connections')
    .select('brand_key, access_token, refresh_token, api_endpoint, access_expires_at')
    .eq('brand_key', brandKey)
    .eq('provider', PROVIDER)
    .maybeSingle();

  if (error) {
    console.error('[brand-deputy] connection load error:', error.message);
    return { ok: false, code: 'db_error', detail: error.message };
  }

  if (!row?.access_token || !row.refresh_token || !row.api_endpoint) {
    return { ok: false, code: 'not_connected' };
  }

  const connection = row as DeputyConnectionRow;
  try {
    const accessToken = await ensureValidAccessToken(supabase, connection, secrets);
    return {
      ok: true,
      apiHost: normaliseApiHost(connection.api_endpoint),
      accessToken,
      connection,
      secrets,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[brand-deputy] token refresh failed:', msg);
    return { ok: false, code: 'token_refresh', detail: msg };
  }
}

function liveDataBlockForFailure(code: DeputyConnectionFailureCode, detail?: string): string {
  if (code === 'oauth_missing') {
    return [
      '[LIVE DEPUTY DATA]',
      '**Status**: Deputy OAuth is not configured for this environment (missing client id, secret, or redirect URI on the function).',
      'When you reply, optional **topic** heading (e.g. **Roster**) then plain explanation — do not bold figures or names.',
      '---',
      '',
    ].join('\n');
  }
  if (code === 'db_error') {
    return [
      '[LIVE DEPUTY DATA]',
      '**Status**: could not load the Deputy connection from the database.',
      '---',
      '',
    ].join('\n');
  }
  if (code === 'not_connected') {
    return [
      '[LIVE DEPUTY DATA]',
      '**Status**: Deputy is not connected for this brand. Ask them to connect from the business portal (**Connections**).',
      '---',
      '',
    ].join('\n');
  }
  return [
    '[LIVE DEPUTY DATA]',
    `**Status**: could not refresh Deputy access — ${detail ?? 'unknown error'}`,
    '---',
    '',
  ].join('\n');
}

function formatRosterBlock(rows: Record<string, unknown>[], startUnix: number, endUnix: number, forwardDays = 14, lookbackDays = 0): string {
  const filtered = rows
    .filter((r) => {
      const st = r.StartTime;
      if (typeof st !== 'number') return false;
      return st >= startUnix && st < endUnix;
    })
    .sort((a, b) => (a.StartTime as number) - (b.StartTime as number))
    .slice(0, 200);

  if (filtered.length === 0) {
    return '**Roster**\nNo shifts in this window.';
  }

  const byDay = new Map<string, Record<string, unknown>[]>();
  for (const r of filtered) {
    const st = r.StartTime as number;
    const key = melbourneDayKeyFromUnix(st);
    const list = byDay.get(key) ?? [];
    list.push(r);
    byDay.set(key, list);
  }

  const dayKeys = [...byDay.keys()].sort();
  const windowLabel = lookbackDays > 0
    ? `~${lookbackDays}d back + ~${forwardDays}d ahead`
    : `~${forwardDays} days from today`;
  const parts: string[] = [
    `**Roster** (${filtered.length} shift(s), ${windowLabel}, Melbourne time)`,
    '',
  ];

  for (const key of dayKeys) {
    const dayRows = byDay.get(key)!;
    const firstStart = dayRows[0].StartTime as number;
    parts.push(`${melbourneLongDayHeadingFromUnix(firstStart)}`, '');
    for (const r of dayRows) {
      const name = displayNameFromRow(r);
      const st = r.StartTime as number;
      const et = r.EndTime;
      const tStart = formatTimeOnlyMelbourne(st);
      const timePart = typeof et === 'number'
        ? `${tStart}–${formatTimeOnlyMelbourne(et)}`
        : `${formatUnixMelbourne(st)}`;
      const unit = (r._DPMetaData as Record<string, unknown> | undefined)?.OperationalUnitInfo as
        | Record<string, unknown>
        | undefined;
      const area =
        typeof unit?.OperationalUnitName === 'string' ? unit.OperationalUnitName : '—';
      const rid = typeof r.Id === 'number' ? r.Id : null;
      const idPart = rid != null ? ` · Roster id ${rid}` : '';
      parts.push(`- ${name} · ${timePart} · ${area}${idPart}`);
    }
    parts.push('');
  }

  return parts.join('\n').trimEnd();
}

function formatTimesheetBlock(
  rows: Record<string, unknown>[],
  startUnix: number,
  endExclusiveUnix: number,
): string {
  const filtered = rows
    .filter((r) => {
      const st = r.StartTime;
      if (typeof st !== 'number') return false;
      return st >= startUnix && st < endExclusiveUnix;
    })
    .slice(0, 200);

  if (filtered.length === 0) {
    return '**Timesheets**\nNo entries in this window.';
  }

  let totalHours = 0;
  const byName = new Map<string, number>();

  for (const r of filtered) {
    const name = displayNameFromRow(r);
    const tt = r.TotalTime;
    const h = typeof tt === 'number' && Number.isFinite(tt) ? tt : 0;
    totalHours += h;
    byName.set(name, (byName.get(name) ?? 0) + h);
  }

  const top = [...byName.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([n, h]) => `- ${n}: ${h.toFixed(1)} h`)
    .join('\n');

  return [
    `**Timesheets** (${filtered.length} record(s) in window)`,
    '',
    '**Hours by person**',
    top || 'No per-person totals.',
    '',
    `Total hours (approx.): ${totalHours.toFixed(1)}`,
  ].join('\n');
}

function employeeDisplayLine(r: Record<string, unknown>): string {
  const dn = r.DisplayName;
  if (typeof dn === 'string' && dn.trim()) return dn.trim();
  return displayNameFromRow(r);
}

function formatEmployeeRefBlock(rows: Record<string, unknown>[]): string {
  const lines = rows.slice(0, 100).map((r) => {
    const id = r.Id;
    const name = employeeDisplayLine(r);
    const idStr = typeof id === 'number' && Number.isFinite(id) ? String(id) : '?';
    return `- **id ${idStr}** — ${name}`;
  });
  return ['**Employees** (use **id** as `employee_id` when adding a shift)', '', ...lines].join('\n');
}

function formatOperationalUnitRefBlock(rows: Record<string, unknown>[]): string {
  const lines = rows.slice(0, 80).map((r) => {
    const id = r.Id;
    const meta = r._DPMetaData as Record<string, unknown> | undefined;
    const ou = meta?.OperationalUnitInfo as Record<string, unknown> | undefined;
    const n =
      typeof ou?.OperationalUnitName === 'string'
        ? ou.OperationalUnitName
        : typeof r.OperationalUnitName === 'string'
          ? r.OperationalUnitName
          : `Unit ${id}`;
    const idStr = typeof id === 'number' && Number.isFinite(id) ? String(id) : '?';
    return `- **id ${idStr}** — ${n}`;
  });
  return ['**Areas / operational units** (use **id** as `operational_unit_id`)', '', ...lines].join('\n');
}

export type DeputyMutationRefResult =
  | {
    ok: true;
    referencePrefix: string;
    apiHost: string;
    accessToken: string;
    connection: DeputyConnectionRow;
    secrets: { clientId: string; clientSecret: string; redirectUri: string };
  }
  | { ok: false };

/** Roster window + employee + area ids for Gemini roster add/remove tool calls. */
export async function buildDeputyMutationReferencePrefix(
  supabase: SupabaseClient,
  brandKey: string,
): Promise<DeputyMutationRefResult> {
  const resolved = await resolveDeputyConnection(supabase, brandKey);
  if (!resolved.ok) return { ok: false };

  const { apiHost, accessToken, connection, secrets } = resolved;
  const nowMs = Date.now();
  const todayYmd = melbourneYmdForInstant(nowMs);
  const rosterStartMs = melbourneMidnightMsForYmd(todayYmd);
  const rosterEndMs = rosterStartMs + 14 * 24 * 60 * 60 * 1000;
  const rosterStartUnix = Math.floor(rosterStartMs / 1000);
  const rosterEndUnix = Math.floor(rosterEndMs / 1000);
  const rosterSearch = { s1: { field: 'StartTime', type: 'gt' as const, data: rosterStartUnix - 1 } };

  let token = accessToken;
  let rosterRows: Record<string, unknown>[] = [];
  let employees: Record<string, unknown>[] = [];
  let units: Record<string, unknown>[] = [];

  const idSearch = { s1: { field: 'Id', type: 'gt' as const, data: 0 } };
  const loadAll = async (t: string) => {
    rosterRows = await deputyResourceQuery(apiHost, t, 'Roster', rosterSearch);
    employees = await deputyResourceQuery(apiHost, t, 'Employee', idSearch);
    units = await deputyResourceQuery(apiHost, t, 'OperationalUnit', idSearch);
  };

  try {
    await loadAll(token);
  } catch (e) {
    const firstErr = e instanceof Error ? e.message : String(e);
    if (!/HTTP 401|HTTP 403/.test(firstErr)) {
      console.error('[brand-deputy] mutation reference QUERY error:', firstErr);
      return { ok: false };
    }
    try {
      const { data: fresh, error: loadErr } = await supabase
        .from('nest_brand_portal_connections')
        .select('brand_key, access_token, refresh_token, api_endpoint, access_expires_at')
        .eq('brand_key', brandKey)
        .eq('provider', PROVIDER)
        .maybeSingle();
      if (loadErr || !fresh?.refresh_token) return { ok: false };
      token = await refreshDeputyAccessToken(supabase, fresh as DeputyConnectionRow, secrets);
      await loadAll(token);
    } catch (e2) {
      console.error('[brand-deputy] mutation reference retry failed:', e2);
      return { ok: false };
    }
  }

  const rosterBlock = formatRosterBlock(rosterRows, rosterStartUnix, rosterEndUnix);
  const referencePrefix = [
    '[DEPUTY ROSTER EDIT REFERENCE — Australia/Melbourne; use numeric ids from lists below]',
    '**Roster** is the only bold topic in the roster block; shift lines are plain. Match that when describing shifts.',
    '',
    rosterBlock,
    '',
    formatEmployeeRefBlock(employees),
    '',
    formatOperationalUnitRefBlock(units),
    '---',
    '',
  ].join('\n');

  return {
    ok: true,
    referencePrefix,
    apiHost,
    accessToken: token,
    connection,
    secrets,
  };
}

/**
 * Returns a user-message prefix with live Deputy data for internal roster/timesheet questions.
 * Empty string when not applicable or when Deputy should not be called.
 */
export async function buildDeputyLiveDataPrefix(opts: {
  supabase: SupabaseClient;
  brandKey: string;
  message: string;
  force?: boolean;
}): Promise<string> {
  if (!opts.force && !messageSuggestsWorkforceQuery(opts.message)) return '';

  const resolved = await resolveDeputyConnection(opts.supabase, opts.brandKey);
  if (!resolved.ok) {
    return liveDataBlockForFailure(resolved.code, resolved.detail);
  }

  const { apiHost, accessToken, connection, secrets } = resolved;

  const nowMs = Date.now();
  const todayYmd = melbourneYmdForInstant(nowMs);
  const todayMidnightMs = melbourneMidnightMsForYmd(todayYmd);
  const rosterForwardDays = resolveRosterForwardDays(opts.message);
  const rosterLookbackDays = resolveRosterLookbackDays(opts.message);
  const rosterStartMs = todayMidnightMs - rosterLookbackDays * 24 * 60 * 60 * 1000;
  const rosterEndMs = todayMidnightMs + rosterForwardDays * 24 * 60 * 60 * 1000;
  const rosterStartUnix = Math.floor(rosterStartMs / 1000);
  const rosterEndUnix = Math.floor(rosterEndMs / 1000);

  const tsLookbackDays = Math.max(resolveTimesheetLookbackDays(opts.message), rosterLookbackDays);
  const tsStartMs = todayMidnightMs - tsLookbackDays * 24 * 60 * 60 * 1000;
  const tsStartUnix = Math.floor(tsStartMs / 1000);
  const nextDayYmd = nextMelbourneYmd(todayYmd);
  const tsEndExclusiveUnix = Math.floor(melbourneMidnightMsForYmd(nextDayYmd) / 1000);

  const rosterSearch = { s1: { field: 'StartTime', type: 'gt' as const, data: rosterStartUnix - 1 } };
  const tsSearch = { s1: { field: 'StartTime', type: 'gt' as const, data: tsStartUnix - 1 } };

  let rosterRows: Record<string, unknown>[] = [];
  let timesheetRows: Record<string, unknown>[] = [];
  let queryErr: string | null = null;

  const runQuery = async (token: string) => {
    rosterRows = await deputyResourceQuery(apiHost, token, 'Roster', rosterSearch);
    timesheetRows = await deputyResourceQuery(apiHost, token, 'Timesheet', tsSearch);
  };

  try {
    await runQuery(accessToken);
  } catch (e) {
    const firstErr = e instanceof Error ? e.message : String(e);
    if (/HTTP 401|HTTP 403/.test(firstErr)) {
      try {
        const { data: fresh, error: loadErr } = await opts.supabase
          .from('nest_brand_portal_connections')
          .select('brand_key, access_token, refresh_token, api_endpoint, access_expires_at')
          .eq('brand_key', opts.brandKey)
          .eq('provider', PROVIDER)
          .maybeSingle();
        if (loadErr || !fresh?.refresh_token) {
          throw new Error(loadErr?.message ?? 'Could not reload Deputy connection');
        }
        accessToken = await refreshDeputyAccessToken(opts.supabase, fresh as DeputyConnectionRow, secrets);
        await runQuery(accessToken);
      } catch (e2) {
        queryErr = e2 instanceof Error ? e2.message : String(e2);
      }
    } else {
      queryErr = firstErr;
    }
  }

  if (queryErr) {
    console.error('[brand-deputy] QUERY error:', queryErr);
    return ['[LIVE DEPUTY DATA]', `**Deputy API error**: ${queryErr}`, '---', ''].join('\n');
  }

  const rosterBlock = formatRosterBlock(rosterRows, rosterStartUnix, rosterEndUnix, rosterForwardDays, rosterLookbackDays);
  const tsBlock = formatTimesheetBlock(timesheetRows, tsStartUnix, tsEndExclusiveUnix);

  const body = [
    '[LIVE DEPUTY DATA — fetched from Deputy for this message; Australia/Melbourne calendar context]',
    '**For your reply**: **Bold only topic headings** (e.g. **Roster**, **Timesheets**). Names, times, and figures plain. Blank line between roster vs timesheet; one bullet per line.',
    '',
    `**Window**: roster ${rosterLookbackDays > 0 ? `~${rosterLookbackDays} days back and ` : ''}~${rosterForwardDays} days ahead from today; timesheets ~${tsLookbackDays} days through end of today.`,
    '',
    rosterBlock,
    '',
    tsBlock,
    '---',
    '',
  ].join('\n');

  return body;
}
