// Google Calendar + Outlook Calendar helpers.
// Ingestion functions + live agent-facing API functions.

import {
  getGoogleAccessToken,
  getMicrosoftAccessToken,
  getAllGoogleTokens,
  type TokenResult,
} from './token-broker.ts';
import { getAdminClient } from './supabase.ts';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const GRAPH_API = 'https://graph.microsoft.com/v1.0/me';
const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_TZ = 'UTC';

// ── Fetch helpers ───────────────────────────────────────────────

function fetchWithTimeout(url: string | URL, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function retryFetch(url: string | URL, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const MAX_ATTEMPTS = 2;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, init, timeoutMs);
      if (resp.ok || (resp.status >= 400 && resp.status < 500 && resp.status !== 429)) return resp;
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 1500));
        continue;
      }
      return resp;
    } catch (e) {
      lastError = e as Error;
      if (attempt < MAX_ATTEMPTS - 1) await new Promise(r => setTimeout(r, (attempt + 1) * 1500));
    }
  }
  throw lastError ?? new Error('retryFetch: max attempts exceeded');
}

export function isGoogleAuthError(msg: string): boolean {
  return msg.includes('invalid_grant') || msg.includes('insufficient_scope') ||
    msg.includes('Google token refresh failed') || msg.includes('Token has been expired or revoked');
}

export function isMicrosoftAuthError(msg: string): boolean {
  return msg.includes('Microsoft token refresh failed') || msg.includes('AADSTS') || msg.includes('InvalidAuthenticationToken');
}

// ── Token resolution (multi-account) ────────────────────────────

export interface ResolvedCalendarToken {
  accessToken: string;
  email: string;
  provider: 'google' | 'microsoft';
}

async function detectProvider(userId: string, accountEmail: string): Promise<'google' | 'microsoft'> {
  const supabase = getAdminClient();
  const { data } = await supabase
    .from('user_microsoft_accounts')
    .select('id')
    .eq('user_id', userId)
    .eq('microsoft_email', accountEmail)
    .maybeSingle();
  return data ? 'microsoft' : 'google';
}

export async function resolveCalendarToken(userId: string, accountEmail?: string): Promise<ResolvedCalendarToken> {
  if (accountEmail) {
    const provider = await detectProvider(userId, accountEmail);
    if (provider === 'microsoft') {
      const result = await getMicrosoftAccessToken(userId, { email: accountEmail });
      return { accessToken: result.accessToken, email: result.email, provider: 'microsoft' };
    }
    const result = await getGoogleAccessToken(userId, { email: accountEmail });
    return { accessToken: result.accessToken, email: result.email, provider: 'google' };
  }
  const result = await getGoogleAccessToken(userId);
  return { accessToken: result.accessToken, email: result.email, provider: 'google' };
}

export async function getAllCalendarTokens(userId: string): Promise<Array<ResolvedCalendarToken & { isPrimary?: boolean }>> {
  const tokens: Array<ResolvedCalendarToken & { isPrimary?: boolean }> = [];
  const googleTokens = await getAllGoogleTokens(userId).catch(() => [] as TokenResult[]);
  for (const t of googleTokens) {
    tokens.push({ accessToken: t.accessToken, email: t.email, provider: 'google' });
  }
  const supabase = getAdminClient();
  const { data: msAccounts } = await supabase
    .from('user_microsoft_accounts')
    .select('id, microsoft_email, refresh_token')
    .eq('user_id', userId);
  if (msAccounts) {
    for (const acct of msAccounts) {
      try {
        const result = await getMicrosoftAccessToken(userId, { email: acct.microsoft_email });
        tokens.push({ accessToken: result.accessToken, email: result.email, provider: 'microsoft' });
      } catch (e) {
        console.warn(`[calendar-helpers] Microsoft token failed for ${acct.microsoft_email}:`, (e as Error).message);
      }
    }
  }
  return tokens;
}

// ── Timezone helpers ────────────────────────────────────────────

function getLocalDateParts(date: Date, tz: string): { year: number; month: number; day: number } {
  const str = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const [y, m, d] = str.split('-').map(Number);
  return { year: y, month: m, day: d };
}

function getUtcOffsetMs(date: Date, tz: string): number {
  const utcStr = date.toLocaleString('sv-SE', { timeZone: 'UTC' });
  const localStr = date.toLocaleString('sv-SE', { timeZone: tz });
  return new Date(localStr + 'Z').getTime() - new Date(utcStr + 'Z').getTime();
}

export async function fetchCalendarTimezone(accessToken: string): Promise<string> {
  try {
    const resp = await fetchWithTimeout(`${CALENDAR_API}/users/me/settings/timezone`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return DEFAULT_TZ;
    const data = await resp.json();
    return data.value ?? DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

export async function fetchOutlookTimezone(accessToken: string): Promise<string> {
  try {
    const resp = await fetchWithTimeout(`${GRAPH_API}/mailboxSettings`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return DEFAULT_TZ;
    const data = await resp.json();
    const windowsTz = data.timeZone ?? '';
    return windowsToIana(windowsTz) || DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

const WINDOWS_TZ_MAP: Record<string, string> = {
  'AUS Eastern Standard Time': 'Australia/Sydney', 'AUS Central Standard Time': 'Australia/Darwin',
  'Cen. Australia Standard Time': 'Australia/Adelaide', 'E. Australia Standard Time': 'Australia/Brisbane',
  'W. Australia Standard Time': 'Australia/Perth', 'Tasmania Standard Time': 'Australia/Hobart',
  'New Zealand Standard Time': 'Pacific/Auckland', 'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw', 'E. Europe Standard Time': 'Europe/Bucharest',
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix', 'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage', 'Atlantic Standard Time': 'America/Halifax',
  'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul',
  'Singapore Standard Time': 'Asia/Singapore', 'Taipei Standard Time': 'Asia/Taipei',
  'Arabian Standard Time': 'Asia/Dubai', 'SE Asia Standard Time': 'Asia/Bangkok',
  'Israel Standard Time': 'Asia/Jerusalem', 'South Africa Standard Time': 'Africa/Johannesburg',
  'E. South America Standard Time': 'America/Sao_Paulo', 'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'Central America Standard Time': 'America/Guatemala', 'Canada Central Standard Time': 'America/Regina',
  'SA Pacific Standard Time': 'America/Bogota', 'UTC': 'UTC',
};

function windowsToIana(windowsTz: string): string | null {
  if (!windowsTz) return null;
  if (windowsTz.includes('/')) return windowsTz;
  return WINDOWS_TZ_MAP[windowsTz] ?? null;
}

// ── Time range resolution ───────────────────────────────────────

export function resolveTimeRange(range: string, tz: string): { timeMin: string; timeMax: string } {
  const now = new Date();
  const todayLocal = getLocalDateParts(now, tz);
  const utcOffsetMs = getUtcOffsetMs(now, tz);
  const lower = (range ?? 'today').toLowerCase().trim();

  const makeDay = (year: number, month: number, day: number) => ({
    timeMin: new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - utcOffsetMs).toISOString(),
    timeMax: new Date(Date.UTC(year, month - 1, day, 23, 59, 59) - utcOffsetMs).toISOString(),
  });

  const makeRange = (startDate: Date, endDate: Date) => ({
    timeMin: makeDay(startDate.getFullYear(), startDate.getMonth() + 1, startDate.getDate()).timeMin,
    timeMax: makeDay(endDate.getFullYear(), endDate.getMonth() + 1, endDate.getDate()).timeMax,
  });

  switch (lower) {
    case 'today':
      return makeDay(todayLocal.year, todayLocal.month, todayLocal.day);
    case 'tomorrow': {
      const d = new Date(todayLocal.year, todayLocal.month - 1, todayLocal.day + 1);
      return makeDay(d.getFullYear(), d.getMonth() + 1, d.getDate());
    }
    case 'yesterday': {
      const d = new Date(todayLocal.year, todayLocal.month - 1, todayLocal.day - 1);
      return makeDay(d.getFullYear(), d.getMonth() + 1, d.getDate());
    }
    case 'this_week':
    case 'this week': {
      const base = new Date(todayLocal.year, todayLocal.month - 1, todayLocal.day);
      const dow = base.getDay();
      const mondayOffset = dow === 0 ? -6 : 1 - dow;
      const monday = new Date(base); monday.setDate(monday.getDate() + mondayOffset);
      const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 6);
      return makeRange(monday, sunday);
    }
    case 'next_week':
    case 'next week': {
      const base = new Date(todayLocal.year, todayLocal.month - 1, todayLocal.day);
      const dow = base.getDay();
      const daysToNextMonday = dow === 0 ? 1 : 8 - dow;
      const monday = new Date(base); monday.setDate(monday.getDate() + daysToNextMonday);
      const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 6);
      return makeRange(monday, sunday);
    }
    case 'last_week':
    case 'last week': {
      const base = new Date(todayLocal.year, todayLocal.month - 1, todayLocal.day);
      const dow = base.getDay();
      const daysBackToLastMonday = dow === 0 ? 13 : dow + 6;
      const monday = new Date(base); monday.setDate(monday.getDate() - daysBackToLastMonday);
      const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 6);
      return makeRange(monday, sunday);
    }
    default: break;
  }

  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const isNext = lower.startsWith('next ');
  const dayName = lower.replace('next ', '').trim();
  const targetDay = days.indexOf(dayName);
  if (targetDay !== -1) {
    const base = new Date(todayLocal.year, todayLocal.month - 1, todayLocal.day);
    const currentDay = base.getDay();
    let daysAhead = targetDay - currentDay;
    if (daysAhead <= 0 || isNext) daysAhead += 7;
    const target = new Date(base); target.setDate(target.getDate() + daysAhead);
    return makeDay(target.getFullYear(), target.getMonth() + 1, target.getDate());
  }

  const nextDays = lower.match(/next\s+(\d+)\s+days?/);
  if (nextDays) {
    const n = parseInt(nextDays[1]);
    const end = new Date(todayLocal.year, todayLocal.month - 1, todayLocal.day + n);
    return makeRange(new Date(todayLocal.year, todayLocal.month - 1, todayLocal.day), end);
  }
  const nextWeeks = lower.match(/next\s+(\d+)\s+weeks?/);
  if (nextWeeks) {
    const n = parseInt(nextWeeks[1]) * 7;
    const end = new Date(todayLocal.year, todayLocal.month - 1, todayLocal.day + n);
    return makeRange(new Date(todayLocal.year, todayLocal.month - 1, todayLocal.day), end);
  }
  const nextMonths = lower.match(/next\s+(\d+)\s+months?/);
  if (nextMonths) {
    const end = new Date(todayLocal.year, todayLocal.month - 1 + parseInt(nextMonths[1]), todayLocal.day);
    return makeRange(new Date(todayLocal.year, todayLocal.month - 1, todayLocal.day), end);
  }
  const pastDays = lower.match(/(?:past|last)\s+(\d+)\s+days?/);
  if (pastDays) {
    const start = new Date(todayLocal.year, todayLocal.month - 1, todayLocal.day - parseInt(pastDays[1]));
    return makeRange(start, new Date(todayLocal.year, todayLocal.month - 1, todayLocal.day));
  }
  const pastWeeks = lower.match(/(?:past|last)\s+(\d+)\s+weeks?/);
  if (pastWeeks) {
    const start = new Date(todayLocal.year, todayLocal.month - 1, todayLocal.day - parseInt(pastWeeks[1]) * 7);
    return makeRange(start, new Date(todayLocal.year, todayLocal.month - 1, todayLocal.day));
  }
  const pastMonths = lower.match(/(?:past|last)\s+(\d+)\s+months?/);
  if (pastMonths) {
    const start = new Date(todayLocal.year, todayLocal.month - 1 - parseInt(pastMonths[1]), todayLocal.day);
    return makeRange(start, new Date(todayLocal.year, todayLocal.month - 1, todayLocal.day));
  }

  return makeDay(todayLocal.year, todayLocal.month, todayLocal.day);
}

// ── Live event formatting ───────────────────────────────────────

export interface FormattedCalendarEvent {
  event_id: string;
  title: string;
  start: string;
  end: string;
  start_iso: string;
  end_iso: string;
  all_day: boolean;
  day: string | null;
  timezone: string;
  location: string | null;
  description: string | null;
  attendees: string[];
  organiser: string | null;
  html_link: string | null;
  recurring: boolean;
  response_status: string | null;
  meet_link?: string;
  calendar: string;
  account: string;
  provider: 'google' | 'microsoft';
  status: 'HAPPENING_NOW' | 'UPCOMING' | 'ALREADY_HAPPENED';
}

export function formatGoogleEvent(e: any, tz: string, calendarName: string, accountEmail: string): FormattedCalendarEvent {
  const startRaw = e.start?.dateTime ?? e.start?.date ?? '';
  const endRaw = e.end?.dateTime ?? e.end?.date ?? '';
  const isAllDay = !!e.start?.date;
  const eventTz = tz ?? e.start?.timeZone ?? 'UTC';

  let startLocal = startRaw;
  let endLocal = endRaw;
  let dayLabel: string | null = null;

  if (!isAllDay && startRaw) {
    const sd = new Date(startRaw);
    const ed = new Date(endRaw);
    startLocal = sd.toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: eventTz });
    endLocal = ed.toLocaleString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: eventTz });
    dayLabel = sd.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: eventTz });
  }

  const now = new Date();
  const startDate = new Date(startRaw);
  const endDate = new Date(endRaw);
  let eventStatus: FormattedCalendarEvent['status'] = 'UPCOMING';
  if (endDate < now) eventStatus = 'ALREADY_HAPPENED';
  else if (startDate <= now && endDate >= now) eventStatus = 'HAPPENING_NOW';

  const result: FormattedCalendarEvent = {
    event_id: e.id, title: e.summary ?? '(no title)', start: startLocal, end: endLocal,
    start_iso: startRaw, end_iso: endRaw, all_day: isAllDay, day: dayLabel, timezone: eventTz,
    location: e.location ?? null, description: e.description ? e.description.slice(0, 300) : null,
    attendees: (e.attendees ?? []).map((a: any) => a.email),
    organiser: e.organizer?.email ?? null, html_link: e.htmlLink ?? null,
    recurring: !!e.recurringEventId,
    response_status: (e.attendees ?? []).find((a: any) => a.self)?.responseStatus ?? null,
    calendar: calendarName, account: accountEmail, provider: 'google', status: eventStatus,
  };
  const meet = e.conferenceData?.entryPoints?.find((ep: any) => ep.entryPointType === 'video');
  if (meet) result.meet_link = meet.uri;
  return result;
}

export function formatMicrosoftEvent(e: any, tz: string, calendarName: string, accountEmail: string): FormattedCalendarEvent {
  const isAllDay = !!e.isAllDay;
  const startRaw = isAllDay ? e.start?.dateTime?.split('T')[0] : e.start?.dateTime;
  const endRaw = isAllDay ? e.end?.dateTime?.split('T')[0] : e.end?.dateTime;
  const eventTz = tz ?? e.start?.timeZone ?? 'UTC';

  let startLocal = startRaw ?? '';
  let endLocal = endRaw ?? '';
  let dayLabel: string | null = null;

  if (!isAllDay && startRaw) {
    const sd = new Date(startRaw);
    const ed = new Date(endRaw);
    startLocal = sd.toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: eventTz });
    endLocal = ed.toLocaleString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: eventTz });
    dayLabel = sd.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: eventTz });
  }

  const now = new Date();
  const startDate = new Date(startRaw ?? '');
  const endDate = new Date(endRaw ?? '');
  let eventStatus: FormattedCalendarEvent['status'] = 'UPCOMING';
  if (endDate < now) eventStatus = 'ALREADY_HAPPENED';
  else if (startDate <= now && endDate >= now) eventStatus = 'HAPPENING_NOW';

  const result: FormattedCalendarEvent = {
    event_id: e.id, title: e.subject ?? '(no title)', start: startLocal, end: endLocal,
    start_iso: startRaw ?? '', end_iso: endRaw ?? '', all_day: isAllDay, day: dayLabel, timezone: eventTz,
    location: e.location?.displayName ?? null,
    description: e.body?.content ? e.body.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) : null,
    attendees: (e.attendees ?? []).map((a: any) => a.emailAddress?.address).filter(Boolean),
    organiser: e.organizer?.emailAddress?.address ?? null, html_link: e.webLink ?? null,
    recurring: !!e.recurrence, response_status: null,
    calendar: calendarName, account: accountEmail, provider: 'microsoft', status: eventStatus,
  };
  const meetLink = e.onlineMeetingUrl || e.onlineMeeting?.joinUrl;
  if (meetLink) result.meet_link = meetLink;
  return result;
}

// ── Live calendar lookup (agent-facing) ─────────────────────────

export async function liveCalendarLookup(
  userId: string,
  range: string,
  timezone: string,
  query?: string,
  accountEmail?: string,
  maxResults = 25,
): Promise<{ events: FormattedCalendarEvent[]; _format?: string; _hint?: string }> {
  const { timeMin, timeMax } = resolveTimeRange(range, timezone);

  let tokens: Array<ResolvedCalendarToken & { isPrimary?: boolean }>;
  if (accountEmail) {
    const t = await resolveCalendarToken(userId, accountEmail);
    tokens = [t];
  } else {
    tokens = await getAllCalendarTokens(userId);
  }

  if (tokens.length === 0) {
    return { events: [] };
  }

  const allEvents: FormattedCalendarEvent[] = [];
  const seenIds = new Set<string>();

  for (const token of tokens) {
    try {
      if (token.provider === 'google') {
        const calendars = await listGoogleCalendarsLive(token.accessToken);
        for (const cal of calendars.slice(0, 15)) {
          try {
            const events = await fetchGoogleEventsLive(token.accessToken, cal.id, timeMin, timeMax, timezone, maxResults);
            for (const evt of events) {
              const formatted = formatGoogleEvent(evt, timezone, cal.summary, token.email);
              if (!seenIds.has(formatted.event_id)) {
                seenIds.add(formatted.event_id);
                allEvents.push(formatted);
              }
            }
          } catch (e) {
            console.warn(`[calendar-helpers] Google cal ${cal.id} failed:`, (e as Error).message);
          }
        }
      } else {
        const calendars = await listOutlookCalendarsLive(token.accessToken);
        if (calendars.length === 0) {
          const events = await fetchOutlookEventsLive(token.accessToken, null, timeMin, timeMax, timezone, maxResults);
          for (const evt of events) {
            const formatted = formatMicrosoftEvent(evt, timezone, 'Calendar', token.email);
            if (!seenIds.has(formatted.event_id)) {
              seenIds.add(formatted.event_id);
              allEvents.push(formatted);
            }
          }
        } else {
          for (const cal of calendars.slice(0, 15)) {
            try {
              const events = await fetchOutlookEventsLive(token.accessToken, cal.id, timeMin, timeMax, timezone, maxResults);
              for (const evt of events) {
                const formatted = formatMicrosoftEvent(evt, timezone, cal.name, token.email);
                if (!seenIds.has(formatted.event_id)) {
                  seenIds.add(formatted.event_id);
                  allEvents.push(formatted);
                }
              }
            } catch (e) {
              console.warn(`[calendar-helpers] Outlook cal ${cal.id} failed:`, (e as Error).message);
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[calendar-helpers] Account ${token.email} failed:`, (e as Error).message);
    }
  }

  if (query) {
    const q = query.toLowerCase();
    const filtered = allEvents.filter(evt =>
      evt.title.toLowerCase().includes(q) ||
      evt.calendar.toLowerCase().includes(q) ||
      evt.account.toLowerCase().includes(q) ||
      evt.attendees.some(a => a.toLowerCase().includes(q)) ||
      (evt.description ?? '').toLowerCase().includes(q) ||
      (evt.location ?? '').toLowerCase().includes(q)
    );
    filtered.sort((a, b) => new Date(a.start_iso).getTime() - new Date(b.start_iso).getTime());

    const uniqueDays = new Set(filtered.map(e => e.day).filter(Boolean));
    if (uniqueDays.size > 1) {
      return { events: filtered, _format: 'group_by_day', _hint: 'Group events by day with bold day headings. Blank line between days.' };
    }
    return { events: filtered };
  }

  allEvents.sort((a, b) => new Date(a.start_iso).getTime() - new Date(b.start_iso).getTime());
  const uniqueDays = new Set(allEvents.map(e => e.day).filter(Boolean));
  if (uniqueDays.size > 1) {
    return { events: allEvents, _format: 'group_by_day', _hint: 'Group events by day with bold day headings. Blank line between days.' };
  }
  return { events: allEvents };
}

async function listGoogleCalendarsLive(accessToken: string): Promise<Array<{ id: string; summary: string }>> {
  try {
    const resp = await retryFetch(`${CALENDAR_API}/users/me/calendarList?minAccessRole=reader&showHidden=false`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return [{ id: 'primary', summary: 'Primary' }];
    const data = await resp.json();
    return (data.items ?? []).filter((c: any) => !c.deleted).map((c: any) => ({ id: c.id, summary: c.summary ?? c.id }));
  } catch {
    return [{ id: 'primary', summary: 'Primary' }];
  }
}

async function fetchGoogleEventsLive(accessToken: string, calendarId: string, timeMin: string, timeMax: string, tz: string, maxResults: number): Promise<any[]> {
  const params = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', timeZone: tz, maxResults: String(maxResults) });
  const resp = await retryFetch(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.items ?? []).filter((e: any) => e.status !== 'cancelled');
}

async function listOutlookCalendarsLive(accessToken: string): Promise<Array<{ id: string; name: string }>> {
  try {
    const resp = await retryFetch(`${GRAPH_API}/calendars?$top=15`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.value ?? []).map((c: any) => ({ id: c.id, name: c.name ?? 'Calendar' }));
  } catch {
    return [];
  }
}

async function fetchOutlookEventsLive(accessToken: string, calendarId: string | null, timeMin: string, timeMax: string, tz: string, maxResults: number): Promise<any[]> {
  const params = new URLSearchParams({ startDateTime: timeMin, endDateTime: timeMax, $top: String(maxResults), $orderby: 'start/dateTime' });
  const url = calendarId
    ? `${GRAPH_API}/calendars/${encodeURIComponent(calendarId)}/calendarView?${params}`
    : `${GRAPH_API}/calendarView?${params}`;
  const resp = await retryFetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Prefer: `outlook.timezone="${tz}"` },
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.value ?? []).filter((e: any) => !e.isCancelled);
}

// ── Live calendar create ────────────────────────────────────────

export async function createGoogleEvent(
  accessToken: string,
  args: { title: string; start_time: string; end_time: string; attendees?: string[]; location?: string; description?: string; all_day?: boolean; recurrence?: string[]; send_updates?: string },
  tz: string,
): Promise<Record<string, unknown>> {
  const isAllDay = !!args.all_day;
  const event: Record<string, unknown> = {
    summary: args.title,
    start: isAllDay ? { date: args.start_time } : { dateTime: args.start_time, timeZone: tz },
    end: isAllDay ? { date: args.end_time } : { dateTime: args.end_time, timeZone: tz },
    conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
  };
  if (args.description) event.description = args.description;
  if (args.location) event.location = args.location;
  if (args.attendees) event.attendees = args.attendees.map(e => ({ email: e }));
  if (args.recurrence) event.recurrence = args.recurrence;

  const qp = new URLSearchParams({ conferenceDataVersion: '1' });
  if (args.send_updates) qp.set('sendUpdates', args.send_updates);

  const resp = await retryFetch(`${CALENDAR_API}/calendars/primary/events?${qp}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!resp.ok) { const t = await resp.text(); throw new Error(`Calendar create failed (${resp.status}): ${t.slice(0, 200)}`); }
  const created = await resp.json();
  const result: Record<string, unknown> = { event_id: created.id, status: 'created', title: created.summary, html_link: created.htmlLink };
  const meet = created.conferenceData?.entryPoints?.find((ep: any) => ep.entryPointType === 'video');
  if (meet) result.meet_link = meet.uri;
  return result;
}

export async function createOutlookEvent(
  accessToken: string,
  args: { title: string; start_time: string; end_time: string; attendees?: string[]; location?: string; description?: string; all_day?: boolean },
  tz: string,
): Promise<Record<string, unknown>> {
  const isAllDay = !!args.all_day;
  const event: Record<string, unknown> = {
    subject: args.title,
    start: isAllDay ? { dateTime: `${args.start_time}T00:00:00`, timeZone: tz } : { dateTime: args.start_time, timeZone: tz },
    end: isAllDay ? { dateTime: `${args.end_time}T00:00:00`, timeZone: tz } : { dateTime: args.end_time, timeZone: tz },
    isAllDay, isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness',
  };
  if (args.description) event.body = { contentType: 'text', content: args.description };
  if (args.location) event.location = { displayName: args.location };
  if (args.attendees) event.attendees = args.attendees.map(email => ({ emailAddress: { address: email }, type: 'required' }));

  const resp = await retryFetch(`${GRAPH_API}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!resp.ok) { const t = await resp.text(); throw new Error(`Outlook create failed (${resp.status}): ${t.slice(0, 200)}`); }
  const created = await resp.json();
  const result: Record<string, unknown> = { event_id: created.id, status: 'created', title: created.subject };
  const meetLink = created.onlineMeetingUrl || created.onlineMeeting?.joinUrl;
  if (meetLink) result.meet_link = meetLink;
  return result;
}

// ── Live calendar update ────────────────────────────────────────

export async function updateGoogleEvent(
  accessToken: string,
  eventId: string,
  calendarId: string,
  updates: Record<string, unknown>,
  tz: string,
  sendUpdates?: string,
): Promise<Record<string, unknown>> {
  const patch: Record<string, unknown> = {};
  if (updates.title) patch.summary = updates.title;
  if (updates.description) patch.description = updates.description;
  if (updates.location) patch.location = updates.location;
  if (updates.start_time) patch.start = { dateTime: updates.start_time, timeZone: tz };
  if (updates.end_time) patch.end = { dateTime: updates.end_time, timeZone: tz };
  if (updates.attendees) patch.attendees = (updates.attendees as string[]).map(e => ({ email: e }));
  if (updates.add_meet) patch.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };

  const qp = new URLSearchParams();
  if (sendUpdates) qp.set('sendUpdates', sendUpdates);
  if (updates.add_meet) qp.set('conferenceDataVersion', '1');
  const qs = qp.toString();

  const resp = await retryFetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}${qs ? `?${qs}` : ''}`,
    { method: 'PATCH', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(patch) },
  );
  if (!resp.ok) { const t = await resp.text(); throw new Error(`Calendar update failed (${resp.status}): ${t.slice(0, 200)}`); }
  const updated = await resp.json();
  return { event_id: updated.id, status: 'updated', title: updated.summary };
}

export async function updateOutlookEvent(
  accessToken: string,
  eventId: string,
  updates: Record<string, unknown>,
  tz: string,
): Promise<Record<string, unknown>> {
  const patch: Record<string, unknown> = {};
  if (updates.title) patch.subject = updates.title;
  if (updates.description) patch.body = { contentType: 'text', content: updates.description };
  if (updates.location) patch.location = { displayName: updates.location };
  if (updates.start_time) patch.start = { dateTime: updates.start_time, timeZone: tz };
  if (updates.end_time) patch.end = { dateTime: updates.end_time, timeZone: tz };
  if (updates.attendees) patch.attendees = (updates.attendees as string[]).map(email => ({ emailAddress: { address: email }, type: 'required' }));

  const resp = await retryFetch(`${GRAPH_API}/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  });
  if (!resp.ok) { const t = await resp.text(); throw new Error(`Outlook update failed (${resp.status}): ${t.slice(0, 200)}`); }
  const updated = await resp.json();
  return { event_id: updated.id, status: 'updated', title: updated.subject };
}

// ── Live calendar delete ────────────────────────────────────────

export async function deleteGoogleEvent(accessToken: string, eventId: string, calendarId = 'primary', sendUpdates = 'all'): Promise<Record<string, unknown>> {
  const qp = new URLSearchParams({ sendUpdates });
  const resp = await retryFetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?${qp}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok && resp.status !== 410) { const t = await resp.text(); throw new Error(`Calendar delete failed (${resp.status}): ${t.slice(0, 200)}`); }
  return { event_id: eventId, status: 'deleted' };
}

export async function deleteOutlookEvent(accessToken: string, eventId: string): Promise<Record<string, unknown>> {
  const resp = await retryFetch(`${GRAPH_API}/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok && resp.status !== 404) { const t = await resp.text(); throw new Error(`Outlook delete failed (${resp.status}): ${t.slice(0, 200)}`); }
  return { event_id: eventId, status: 'deleted' };
}

export interface CalendarEvent {
  eventId: string;
  calendarId: string;
  title: string;
  description: string;
  start: string;
  end: string;
  attendees: string;
  organiser: string;
  location: string;
  meetingLink: string;
  status: string;
  recurringEventId: string | null;
  provider: 'google' | 'microsoft';
}

// ── Google Calendar ─────────────────────────────────────────────

export async function fetchGoogleCalendarEvents(
  accessToken: string,
  daysBack = 730,
  daysForward = 365,
  primaryOnly = false,
): Promise<CalendarEvent[]> {
  const now = new Date();
  const timeMin = new Date(now.getTime() - daysBack * 86400000).toISOString();
  const timeMax = new Date(now.getTime() + daysForward * 86400000).toISOString();

  let calendars: Array<{ id: string; summary: string }>;

  if (primaryOnly) {
    calendars = [{ id: 'primary', summary: 'Primary' }];
  } else {
    calendars = await listGoogleCalendars(accessToken);
    calendars = calendars.slice(0, 5);
  }

  console.log(`[calendar-helpers] Fetching from ${calendars.length} Google calendars`);

  const allEvents: CalendarEvent[] = [];
  const seenIds = new Set<string>();

  for (const cal of calendars) {
    try {
      const events = await fetchGoogleEventsFromCalendar(accessToken, cal.id, timeMin, timeMax);
      for (const event of events) {
        if (!seenIds.has(event.eventId)) {
          seenIds.add(event.eventId);
          allEvents.push(event);
        }
      }
      console.log(`[calendar-helpers] Google "${cal.summary}": ${events.length} events`);
    } catch (e) {
      console.warn(`[calendar-helpers] Failed to fetch Google calendar ${cal.id}:`, (e as Error).message);
    }
  }

  allEvents.sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime());
  return allEvents;
}

async function listGoogleCalendars(
  accessToken: string,
): Promise<Array<{ id: string; summary: string }>> {
  const resp = await fetch(
    `${CALENDAR_API}/users/me/calendarList?minAccessRole=reader&showHidden=false`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Calendar list failed (${resp.status}): ${detail.slice(0, 200)}`);
  }

  const data = await resp.json();
  return (data.items ?? [])
    .filter((c: any) => !c.deleted)
    .map((c: any) => ({ id: c.id, summary: c.summary ?? c.id }));
}

async function fetchGoogleEventsFromCalendar(
  accessToken: string,
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '2500',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const resp = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`Calendar events failed (${resp.status}): ${detail.slice(0, 200)}`);
    }

    const data = await resp.json();

    for (const item of data.items ?? []) {
      if (item.status === 'cancelled') continue;

      const start = item.start?.dateTime ?? item.start?.date ?? '';
      const end = item.end?.dateTime ?? item.end?.date ?? '';
      if (!start) continue;

      const attendeeList = (item.attendees ?? [])
        .filter((a: any) => !a.self)
        .map((a: any) => a.displayName || a.email || '')
        .filter(Boolean);

      const meetingLink = item.hangoutLink
        ?? item.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === 'video')?.uri
        ?? '';

      events.push({
        eventId: item.id,
        calendarId,
        title: item.summary ?? '(No title)',
        description: (item.description ?? '').slice(0, 500),
        start,
        end,
        attendees: attendeeList.join(', '),
        organiser: item.organizer?.displayName ?? item.organizer?.email ?? '',
        location: item.location ?? '',
        meetingLink,
        status: item.status ?? 'confirmed',
        recurringEventId: item.recurringEventId ?? null,
        provider: 'google',
      });
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  return events;
}

// ── Outlook Calendar ────────────────────────────────────────────

export async function fetchOutlookCalendarEvents(
  accessToken: string,
  daysBack = 730,
  daysForward = 365,
): Promise<CalendarEvent[]> {
  const now = new Date();
  const startDateTime = new Date(now.getTime() - daysBack * 86400000).toISOString();
  const endDateTime = new Date(now.getTime() + daysForward * 86400000).toISOString();

  const events: CalendarEvent[] = [];
  let nextLink: string | null = null;
  let page = 0;
  const MAX_PAGES = 50;

  const initialUrl = `${GRAPH_API}/calendarView?` + new URLSearchParams({
    startDateTime,
    endDateTime,
    $top: '100',
    $orderby: 'start/dateTime',
    $select: 'id,subject,bodyPreview,start,end,attendees,organizer,location,onlineMeeting,seriesMasterId,isCancelled',
  }).toString();

  let url: string = initialUrl;

  do {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!resp.ok) {
      const detail = await resp.text();
      console.warn(`[calendar-helpers] Outlook calendar fetch failed (${resp.status}): ${detail.slice(0, 200)}`);
      break;
    }

    const data = await resp.json();

    for (const item of data.value ?? []) {
      if (item.isCancelled) continue;

      const start = item.start?.dateTime ? `${item.start.dateTime}Z` : '';
      const end = item.end?.dateTime ? `${item.end.dateTime}Z` : '';
      if (!start) continue;

      const attendeeList = (item.attendees ?? [])
        .map((a: any) => a.emailAddress?.name || a.emailAddress?.address || '')
        .filter(Boolean);

      const meetingLink = item.onlineMeeting?.joinUrl ?? '';

      events.push({
        eventId: item.id,
        calendarId: 'outlook-primary',
        title: item.subject ?? '(No title)',
        description: (item.bodyPreview ?? '').slice(0, 500),
        start,
        end,
        attendees: attendeeList.join(', '),
        organiser: item.organizer?.emailAddress?.name ?? item.organizer?.emailAddress?.address ?? '',
        location: typeof item.location === 'string' ? item.location : (item.location?.displayName ?? ''),
        meetingLink,
        status: 'confirmed',
        recurringEventId: item.seriesMasterId ?? null,
        provider: 'microsoft',
      });
    }

    nextLink = data['@odata.nextLink'] ?? null;
    if (nextLink) url = nextLink;
    page++;
  } while (nextLink && page < MAX_PAGES);

  events.sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime());
  console.log(`[calendar-helpers] Outlook: ${events.length} events (${daysBack}d back, ${daysForward}d forward)`);
  return events;
}
