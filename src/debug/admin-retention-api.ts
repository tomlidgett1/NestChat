import type { Request, Response } from 'express';
import { DateTime } from 'luxon';
import { getSupabase } from '../lib/supabase.js';

const PAGE = 1000;
const MAX_TURN_ROWS = 400_000;
const MAX_PROFILE_ROWS = 100_000;

/** All calendar weeks and days use this zone (handles AEDT / AEST). */
export const RETENTION_TIMEZONE = 'Australia/Melbourne';

function melbourneDayKeyFromIso(iso: string): string {
  const dt = DateTime.fromISO(iso, { setZone: true });
  if (!dt.isValid) return '';
  return dt.setZone(RETENTION_TIMEZONE).toFormat('yyyy-MM-dd');
}

function melbourneDayKeyFromUnixSec(sec: number): string {
  return DateTime.fromSeconds(sec, { zone: 'utc' }).setZone(RETENTION_TIMEZONE).toFormat('yyyy-MM-dd');
}

/** Monday 00:00 Melbourne for the week containing this instant (Luxon weekday 1 = Monday). */
function melbourneWeekMondayKeyFromIso(iso: string): string {
  const dt = DateTime.fromISO(iso, { setZone: true }).setZone(RETENTION_TIMEZONE).startOf('day');
  if (!dt.isValid) return '';
  const monday = dt.minus({ days: dt.weekday - 1 });
  return monday.toFormat('yyyy-MM-dd');
}

function melbourneWeekMondayKeyFromUnixSec(sec: number): string {
  const dt = DateTime.fromSeconds(sec, { zone: 'utc' }).setZone(RETENTION_TIMEZONE).startOf('day');
  const monday = dt.minus({ days: dt.weekday - 1 });
  return monday.toFormat('yyyy-MM-dd');
}

function addMelbourneWeeks(weekMondayYmd: string, delta: number): string {
  return DateTime.fromISO(weekMondayYmd, { zone: RETENTION_TIMEZONE })
    .startOf('day')
    .plus({ weeks: delta })
    .toFormat('yyyy-MM-dd');
}

function addMelbourneDays(dayYmd: string, delta: number): string {
  return DateTime.fromISO(dayYmd, { zone: RETENTION_TIMEZONE })
    .startOf('day')
    .plus({ days: delta })
    .toFormat('yyyy-MM-dd');
}

/** Calendar-day offsets after signup (Melbourne) for headline retention. */
const DAY_RETENTION_WINDOWS = [1, 3, 7, 14, 30] as const;

const DAY_RETENTION_MEANING: Record<(typeof DAY_RETENTION_WINDOWS)[number], string> = {
  1: 'Turn activity on the first Melbourne calendar day after signup (the day after first_seen day).',
  3: 'Turn activity on the Melbourne calendar day three days after the signup day.',
  7: 'Turn activity on the Melbourne calendar day seven days after the signup day.',
  14: 'Turn activity on the Melbourne calendar day fourteen days after the signup day.',
  30: 'Turn activity on the Melbourne calendar day thirty days after the signup day.',
};

function melbourneFetchSinceIso(windowDays: number): string {
  const start = DateTime.now()
    .setZone(RETENTION_TIMEZONE)
    .startOf('day')
    .minus({ days: windowDays });
  return start.toUTC().toISO()!;
}

async function fetchAllTurnsSince(supabase: ReturnType<typeof getSupabase>, sinceIso: string) {
  const rows: { sender_handle: string; created_at: string }[] = [];
  let from = 0;
  while (rows.length < MAX_TURN_ROWS) {
    const { data, error } = await supabase
      .from('turn_traces')
      .select('sender_handle, created_at')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) {
      console.warn('[retention-api] turn_traces page error:', error.message);
      break;
    }
    if (!data?.length) break;
    for (const r of data) {
      rows.push({ sender_handle: r.sender_handle as string, created_at: r.created_at as string });
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function fetchAllProfiles(supabase: ReturnType<typeof getSupabase>) {
  const rows: { handle: string; first_seen: number | null; last_seen: number | null; status: string | null }[] = [];
  let from = 0;
  while (rows.length < MAX_PROFILE_ROWS) {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('handle, first_seen, last_seen, status')
      .order('handle', { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) {
      console.warn('[retention-api] user_profiles page error:', error.message);
      break;
    }
    if (!data?.length) break;
    for (const r of data) {
      rows.push({
        handle: r.handle as string,
        first_seen: r.first_seen != null ? Number(r.first_seen) : null,
        last_seen: r.last_seen != null ? Number(r.last_seen) : null,
        status: (r.status as string) ?? null,
      });
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

/** GET /debug/api/retention-metrics */
export async function handleRetentionMetrics(_req: Request, res: Response) {
  try {
    const supabase = getSupabase();
    const windowDays = 180;
    const sinceIso = melbourneFetchSinceIso(windowDays);

    const [turns, profiles] = await Promise.all([fetchAllTurnsSince(supabase, sinceIso), fetchAllProfiles(supabase)]);

    const todayM = DateTime.now().setZone(RETENTION_TIMEZONE).startOf('day');
    const todayKey = todayM.toFormat('yyyy-MM-dd');
    const dataStartKey = todayM.minus({ days: windowDays }).toFormat('yyyy-MM-dd');
    const last7Keys = new Set<string>();
    for (let i = 0; i < 7; i++) last7Keys.add(todayM.minus({ days: i }).toFormat('yyyy-MM-dd'));
    const last30Keys = new Set<string>();
    for (let i = 0; i < 30; i++) last30Keys.add(todayM.minus({ days: i }).toFormat('yyyy-MM-dd'));

    const notes: string[] = [];
    if (turns.length >= MAX_TURN_ROWS) {
      notes.push(`Turn sample capped at ${MAX_TURN_ROWS} rows; older activity in the window may be missing.`);
    }
    if (profiles.length >= MAX_PROFILE_ROWS) {
      notes.push(`Profile sample capped at ${MAX_PROFILE_ROWS} rows.`);
    }

    const turnWeekUser = new Set<string>();
    const turnWeekCount = new Map<string, number>();
    const turnDayUser = new Map<string, Set<string>>();
    const userActiveDays = new Map<string, Set<string>>();

    const dauSet = new Set<string>();
    const wauSet = new Set<string>();
    const mauSet = new Set<string>();

    for (const t of turns) {
      const h = t.sender_handle;
      if (!h) continue;
      const wk = melbourneWeekMondayKeyFromIso(t.created_at);
      if (wk) {
        turnWeekUser.add(`${h}|${wk}`);
        turnWeekCount.set(wk, (turnWeekCount.get(wk) ?? 0) + 1);
      }
      const dk = melbourneDayKeyFromIso(t.created_at);
      if (dk) {
        if (!turnDayUser.has(dk)) turnDayUser.set(dk, new Set());
        turnDayUser.get(dk)!.add(h);
        if (!userActiveDays.has(h)) userActiveDays.set(h, new Set());
        userActiveDays.get(h)!.add(dk);
      }
      if (dk === todayKey) dauSet.add(h);
      if (last7Keys.has(dk)) wauSet.add(h);
      if (last30Keys.has(dk)) mauSet.add(h);
    }

    let lastSeenActive1 = 0;
    let lastSeenActive7 = 0;
    let lastSeenActive30 = 0;
    let newProfilesLast7d = 0;
    const signupWeekCount = new Map<string, number>();
    const cohortMembers = new Map<string, Set<string>>();

    for (const p of profiles) {
      if (p.last_seen != null) {
        const lk = melbourneDayKeyFromUnixSec(p.last_seen);
        if (lk === todayKey) lastSeenActive1++;
        if (last7Keys.has(lk)) lastSeenActive7++;
        if (last30Keys.has(lk)) lastSeenActive30++;
      }
      if (p.first_seen != null) {
        if (last7Keys.has(melbourneDayKeyFromUnixSec(p.first_seen))) newProfilesLast7d++;
        const sw = melbourneWeekMondayKeyFromUnixSec(p.first_seen);
        if (sw) signupWeekCount.set(sw, (signupWeekCount.get(sw) ?? 0) + 1);
        const cw = melbourneWeekMondayKeyFromUnixSec(p.first_seen);
        if (cw) {
          if (!cohortMembers.has(cw)) cohortMembers.set(cw, new Set());
          cohortMembers.get(cw)!.add(p.handle);
        }
      }
    }

    const weeklySignups: { week: string; count: number }[] = [...signupWeekCount.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([week, count]) => ({ week, count }));

    const uniqueByWeek = new Map<string, Set<string>>();
    for (const key of turnWeekUser) {
      const pipe = key.lastIndexOf('|');
      const h = key.slice(0, pipe);
      const wk = key.slice(pipe + 1);
      if (!uniqueByWeek.has(wk)) uniqueByWeek.set(wk, new Set());
      uniqueByWeek.get(wk)!.add(h);
    }

    const weeklyActiveFromTurns: { week: string; uniqueUsers: number; turns: number }[] = [];
    const allWeeks = new Set<string>([...turnWeekCount.keys(), ...uniqueByWeek.keys(), ...signupWeekCount.keys()]);
    for (const wk of [...allWeeks].sort((a, b) => a.localeCompare(b))) {
      weeklyActiveFromTurns.push({
        week: wk,
        uniqueUsers: uniqueByWeek.get(wk)?.size ?? 0,
        turns: turnWeekCount.get(wk) ?? 0,
      });
    }

    const dauLast30Days: { date: string; users: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const dk = todayM.minus({ days: i }).toFormat('yyyy-MM-dd');
      dauLast30Days.push({ date: dk, users: turnDayUser.get(dk)?.size ?? 0 });
    }

    const offsets = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const cohortWeekList = [...cohortMembers.keys()].sort((a, b) => b.localeCompare(a)).slice(0, 14);

    const retentionCohorts = cohortWeekList.map((cohortWeek) => {
      const members = cohortMembers.get(cohortWeek)!;
      const size = members.size;
      const activeByWeekOffset = offsets.map((off) => {
        const targetWeek = addMelbourneWeeks(cohortWeek, off);
        let n = 0;
        for (const h of members) {
          if (turnWeekUser.has(`${h}|${targetWeek}`)) n++;
        }
        return n;
      });
      const pctRow = activeByWeekOffset.map((n) => (size > 0 ? Math.round((n / size) * 1000) / 10 : 0));
      return { cohortWeek, size, activeByWeekOffset, pctByWeekOffset: pctRow };
    });

    const melbourne30Start = todayM.minus({ days: 29 }).startOf('day');
    const thirtyAgoIso = melbourne30Start.toUTC().toISO()!;

    const turnCountLast30 = new Map<string, number>();
    for (const t of turns) {
      if (t.created_at < thirtyAgoIso) continue;
      const h = t.sender_handle;
      if (!h) continue;
      turnCountLast30.set(h, (turnCountLast30.get(h) ?? 0) + 1);
    }

    const freqBuckets = { b0: 0, b1_2: 0, b3_5: 0, b6_10: 0, b11_20: 0, b21plus: 0 };
    for (const p of profiles) {
      const c = turnCountLast30.get(p.handle) ?? 0;
      if (c === 0) freqBuckets.b0++;
      else if (c <= 2) freqBuckets.b1_2++;
      else if (c <= 5) freqBuckets.b3_5++;
      else if (c <= 10) freqBuckets.b6_10++;
      else if (c <= 20) freqBuckets.b11_20++;
      else freqBuckets.b21plus++;
    }

    const daysActiveLast30 = { d0: 0, d1: 0, d2_3: 0, d4_7: 0, d8plus: 0 };
    for (const p of profiles) {
      const set = userActiveDays.get(p.handle);
      let n = 0;
      if (set) {
        for (const dk of set) {
          if (last30Keys.has(dk)) n++;
        }
      }
      if (n === 0) daysActiveLast30.d0++;
      else if (n === 1) daysActiveLast30.d1++;
      else if (n <= 3) daysActiveLast30.d2_3++;
      else if (n <= 7) daysActiveLast30.d4_7++;
      else daysActiveLast30.d8plus++;
    }

    const verifiedCount = profiles.filter((p) => p.status === 'active').length;

    const stickiness = mauSet.size > 0 ? Math.round((wauSet.size / mauSet.size) * 1000) / 10 : null;

    const dayRetentionTallies: Record<number, { eligible: number; retained: number }> = Object.fromEntries(
      DAY_RETENTION_WINDOWS.map((d) => [d, { eligible: 0, retained: 0 }]),
    ) as Record<number, { eligible: number; retained: number }>;

    for (const p of profiles) {
      if (p.first_seen == null) continue;
      const signupDay = melbourneDayKeyFromUnixSec(p.first_seen);
      if (!signupDay) continue;
      const activeDays = userActiveDays.get(p.handle);
      for (const n of DAY_RETENTION_WINDOWS) {
        const targetDay = addMelbourneDays(signupDay, n);
        if (targetDay > todayKey) continue;
        if (targetDay < dataStartKey) continue;
        dayRetentionTallies[n].eligible++;
        if (activeDays?.has(targetDay)) dayRetentionTallies[n].retained++;
      }
    }

    const dayRetentionWindows = DAY_RETENTION_WINDOWS.map((n) => {
      const { eligible, retained } = dayRetentionTallies[n];
      const pct = eligible > 0 ? Math.round((retained / eligible) * 1000) / 10 : null;
      return { days: n, eligible, retained, pct, meaning: DAY_RETENTION_MEANING[n] };
    });

    res.json({
      generatedAt: new Date().toISOString(),
      timezone: RETENTION_TIMEZONE,
      windowDays,
      turnRowsLoaded: turns.length,
      profileRowsLoaded: profiles.length,
      notes,
      headlines: {
        totalProfiles: profiles.length,
        verifiedActiveStatus: verifiedCount,
        newProfilesLast7d,
        dauTurns: dauSet.size,
        wauTurns: wauSet.size,
        mauTurns: mauSet.size,
        lastSeenActive1d: lastSeenActive1,
        lastSeenActive7d: lastSeenActive7,
        lastSeenActive30d: lastSeenActive30,
        wauMauStickinessPct: stickiness,
      },
      weeklySignups,
      weeklyEngagement: weeklyActiveFromTurns,
      dauLast30Days,
      frequencyTurnsLast30d: {
        labels: ['0 turns', '1–2', '3–5', '6–10', '11–20', '21+'],
        users: [
          freqBuckets.b0,
          freqBuckets.b1_2,
          freqBuckets.b3_5,
          freqBuckets.b6_10,
          freqBuckets.b11_20,
          freqBuckets.b21plus,
        ],
      },
      distinctDaysActiveLast30: {
        labels: ['0 days', '1 day', '2–3 days', '4–7 days', '8+ days'],
        users: [
          daysActiveLast30.d0,
          daysActiveLast30.d1,
          daysActiveLast30.d2_3,
          daysActiveLast30.d4_7,
          daysActiveLast30.d8plus,
        ],
      },
      retention: {
        weekOffsets: offsets,
        cohorts: retentionCohorts,
        definition:
          'Cohort = users whose first_seen falls in that Monday (Australia/Melbourne) week. Cell = users with ≥1 turn in week offset N from cohort week. % = of cohort size.',
      },
      dayRetention: {
        dataStartDay: dataStartKey,
        todayDay: todayKey,
        definition:
          'Signup day = Melbourne calendar day of user_profiles.first_seen. N-day retention = share of those users who had ≥1 turn_traces row on the Melbourne calendar day exactly N days after signup (not a rolling 24h window). A user is only counted if that target day is not in the future and falls inside the loaded turns window so activity could be observed.',
        windows: dayRetentionWindows,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
}
