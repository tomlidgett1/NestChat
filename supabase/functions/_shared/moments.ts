import { getAdminClient } from './supabase.ts';
import { USER_PROFILES_TABLE } from './env.ts';

// ============================================================================
// Types
// ============================================================================

export interface Moment {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'paused' | 'archived';
  version: number;
  trigger_type: 'relative_time' | 'inactivity' | 'event' | 'scheduled' | 'table_condition' | 'opt_in';
  trigger_config: Record<string, unknown>;
  audience_config: AudienceConfig;
  conditions: ConditionFilter[];
  action_type: 'send_message' | 'run_agentic_task' | 'create_reminder' | 'trigger_morning_brief';
  action_config: Record<string, unknown>;
  prompt_template: string | null;
  prompt_system_context: string | null;
  prompt_variables: string[];
  cooldown_hours: number;
  max_per_day_per_user: number;
  max_per_user_total: number | null;
  priority: number;
  quiet_hours_start: number;
  quiet_hours_end: number;
  rollout_pct: number;
  test_mode: boolean;
  test_handles: string[];
  timezone_behavior: string;
  timezone_fixed: string | null;
  window_start_hour: number | null;
  window_end_hour: number | null;
  tags: string[];
  is_system: boolean;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  paused_at: string | null;
}

export interface AudienceConfig {
  mode: 'all_active' | 'filter' | 'specific' | 'exclude';
  filters?: ConditionFilter[];
  require_connected_accounts?: boolean;
  min_days_since_signup?: number;
  exclude_handles?: string[];
  include_handles?: string[];
  internal_only?: boolean;
}

export interface ConditionFilter {
  table?: string;
  column: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'is_null' | 'is_not_null' | 'in' | 'contains';
  value?: unknown;
}

export interface MomentCandidate {
  handle: string;
  name: string | null;
  timezone: string | null;
  first_seen: number;
  last_seen: number;
  onboard_count: number;
  bot_number: string | null;
  auth_user_id: string | null;
  activation_score: number;
  last_proactive_sent_at: string | null;
  last_proactive_ignored: boolean;
  proactive_ignore_count: number;
  status: string;
}

export interface GlobalConfig {
  global_daily_cap: number;
  global_cooldown_hours: number;
  quiet_hours: { start: number; end: number };
  max_consecutive_ignores: number;
  ignore_hold_hours: number;
  kill_switch: boolean;
}

export type EvalResult =
  | { outcome: 'send'; content: string; metadata: Record<string, unknown>; prompt_used?: string }
  | { outcome: 'skip'; reason: string }
  | { outcome: 'error'; reason: string };

// ============================================================================
// Load active moments
// ============================================================================

export async function loadActiveMoments(): Promise<Moment[]> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('moments')
    .select('*')
    .eq('status', 'active')
    .order('priority', { ascending: true });

  if (error) {
    console.error('[moments] Failed to load active moments:', error.message);
    return [];
  }

  return (data || []) as unknown as Moment[];
}

// ============================================================================
// Load global config
// ============================================================================

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  const supabase = getAdminClient();
  const { data } = await supabase
    .from('moment_global_config')
    .select('key, value');

  const config: Record<string, unknown> = {};
  for (const row of (data || []) as Array<{ key: string; value: unknown }>) {
    config[row.key] = row.value;
  }

  return {
    global_daily_cap: Number(config.global_daily_cap ?? 2),
    global_cooldown_hours: Number(config.global_cooldown_hours ?? 2),
    quiet_hours: (config.quiet_hours as { start: number; end: number }) ?? { start: 21, end: 7 },
    max_consecutive_ignores: Number(config.max_consecutive_ignores ?? 3),
    ignore_hold_hours: Number(config.ignore_hold_hours ?? 72),
    kill_switch: config.kill_switch === true || config.kill_switch === 'true',
  };
}

// ============================================================================
// Phase 1: Candidate selection — build SQL per trigger type
// ============================================================================

/** Rolling relative_time: wait = delay_hours + delay_minutes after reference. */
function relativeTimeDelaySeconds(tc: Record<string, unknown>): number {
  const h = tc.delay_hours === undefined || tc.delay_hours === null ? 0 : Number(tc.delay_hours);
  const m = Number(tc.delay_minutes ?? 0);
  return Math.max(0, h * 3600 + m * 60);
}

/** Eligibility window after the wait (defaults to 24h if unset). */
function relativeTimeWindowSeconds(tc: Record<string, unknown>): number {
  const h = tc.window_hours === undefined || tc.window_hours === null ? 24 : Number(tc.window_hours);
  const m = Number(tc.window_minutes ?? 0);
  return Math.max(0, h * 3600 + m * 60);
}

export async function getCandidates(
  moment: Moment,
  limit: number,
): Promise<MomentCandidate[]> {
  const supabase = getAdminClient();
  const tc = moment.trigger_config;
  const audience = moment.audience_config;

  let query = supabase
    .from(USER_PROFILES_TABLE)
    .select('handle, name, timezone, first_seen, last_seen, onboard_count, bot_number, auth_user_id, activation_score, last_proactive_sent_at, last_proactive_ignored, proactive_ignore_count, status')
    .eq('status', 'active')
    .not('bot_number', 'is', null);

  // Audience: specific handles
  if (audience.mode === 'specific' && audience.include_handles?.length) {
    query = query.in('handle', audience.include_handles);
  }

  // Audience: internal only (test handles from moment)
  if (audience.internal_only && moment.test_handles.length > 0) {
    query = query.in('handle', moment.test_handles);
  }

  // Audience: exclude handles
  if (audience.exclude_handles?.length) {
    for (const h of audience.exclude_handles) {
      query = query.neq('handle', h);
    }
  }

  // Audience: min days since signup
  if (audience.min_days_since_signup && audience.min_days_since_signup > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - audience.min_days_since_signup * 86400;
    query = query.lt('first_seen', cutoff);
  }

  // Audience: connected accounts filter
  if (audience.require_connected_accounts) {
    query = query.not('auth_user_id', 'is', null);
  }

  // Audience: custom filters on user_profiles
  if (audience.filters?.length) {
    for (const f of audience.filters) {
      if (f.table && f.table !== 'user_profiles') continue;
      query = applyFilter(query, f);
    }
  }

  // Trigger-type-specific filtering
  const nowEpoch = Math.floor(Date.now() / 1000);

  switch (moment.trigger_type) {
    case 'relative_time': {
      // Calendar mode: N full calendar days after sign-up (in the user's timezone), at a fixed local time.
      // Phase 1 only narrows the pool; exact matching happens in evaluateCandidate.
      if (tc.calendar_day_offset != null && Number(tc.calendar_day_offset) >= 0) {
        const minAge = 3600; // at least 1 hour ago (avoid same-minute churn)
        const maxAge = 400 * 86400; // ~13 months — onboarding / lifecycle only
        query = query.lt('first_seen', nowEpoch - minAge).gt('first_seen', nowEpoch - maxAge);
        break;
      }

      const delaySec = relativeTimeDelaySeconds(tc);
      let windowSec = relativeTimeWindowSeconds(tc);
      if (windowSec < 60) windowSec = 60; // minimum 1 minute eligibility window
      const isEpoch = tc.reference_is_epoch === true;
      const ref = String(tc.reference ?? 'first_seen').replace('user_profiles.', '');

      if (isEpoch) {
        const earliest = nowEpoch - delaySec - windowSec;
        const latest = nowEpoch - delaySec;
        query = query.gt(ref, earliest).lt(ref, latest);
      } else {
        const earliest = new Date(Date.now() - (delaySec + windowSec) * 1000).toISOString();
        const latest = new Date(Date.now() - delaySec * 1000).toISOString();
        query = query.gt(ref, earliest).lt(ref, latest);
      }
      break;
    }

    case 'inactivity': {
      const thresholdHours = Number(tc.threshold_hours ?? 72);
      const isEpoch = tc.reference_is_epoch === true;
      const ref = String(tc.reference ?? 'last_seen').replace('user_profiles.', '');

      if (isEpoch) {
        const cutoff = nowEpoch - thresholdHours * 3600;
        query = query.lt(ref, cutoff);
      } else {
        const cutoff = new Date(Date.now() - thresholdHours * 3600000).toISOString();
        query = query.lt(ref, cutoff);
      }
      break;
    }

    case 'scheduled': {
      // Scheduled moments fire based on time window checks (Phase 2)
      // Phase 1 just loads all eligible users
      break;
    }

    case 'event': {
      // Event moments fire based on event checks (Phase 2)
      // Phase 1 loads all eligible users for now
      break;
    }

    case 'table_condition': {
      // Column conditions are partially handled by audience filters
      if (tc.conditions && Array.isArray(tc.conditions)) {
        for (const cond of tc.conditions as ConditionFilter[]) {
          const col = String(cond.column).replace('user_profiles.', '');
          query = applyFilter(query, { ...cond, column: col });
        }
      }
      break;
    }

    case 'opt_in': {
      // Opt-in moments need preference records — handled in Phase 2
      break;
    }
  }

  // Recent sign-ups first when using calendar-day relative triggers (better hit rate within per-run limit)
  if (moment.trigger_type === 'relative_time' && moment.trigger_config.calendar_day_offset != null) {
    query = query.order('first_seen', { ascending: false });
  } else {
    query = query.order('last_seen', { ascending: true });
  }
  query = query.limit(limit);

  const { data, error } = await query;

  if (error) {
    console.error(`[moments] Candidate query failed for ${moment.name}:`, error.message);
    return [];
  }

  return (data || []) as unknown as MomentCandidate[];
}

// deno-lint-ignore no-explicit-any
function applyFilter(query: any, f: ConditionFilter): any {
  switch (f.op) {
    case 'eq': return query.eq(f.column, f.value);
    case 'neq': return query.neq(f.column, f.value);
    case 'gt': return query.gt(f.column, f.value);
    case 'gte': return query.gte(f.column, f.value);
    case 'lt': return query.lt(f.column, f.value);
    case 'lte': return query.lte(f.column, f.value);
    case 'is_null': return query.is(f.column, null);
    case 'is_not_null': return query.not(f.column, 'is', null);
    case 'in': return query.in(f.column, f.value as unknown[]);
    default: return query;
  }
}

// ============================================================================
// Phase 2: Fine-grained evaluation per candidate
// ============================================================================

export async function evaluateCandidate(
  moment: Moment,
  candidate: MomentCandidate,
  globalConfig: GlobalConfig,
  sentThisCycle: Set<string>,
): Promise<{ status: string; skipReason?: string }> {
  const supabase = getAdminClient();
  const handle = candidate.handle;

  // 1. Rollout percentage check (deterministic hash)
  if (moment.rollout_pct < 100) {
    const hash = simpleHash(moment.id + ':' + handle) % 100;
    if (hash >= moment.rollout_pct) {
      return { status: 'skipped', skipReason: 'rollout_excluded' };
    }
  }

  // 2. Idempotency check
  const idempKey = buildIdempotencyKey(moment, candidate);
  const { data: exists } = await supabase.rpc('moment_execution_exists', {
    p_idempotency_key: idempKey,
  });
  if (exists) {
    return { status: 'deduplicated', skipReason: 'already_processed' };
  }

  // 3. Already sent to this user this cycle (priority conflict)
  if (sentThisCycle.has(handle)) {
    return { status: 'skipped', skipReason: 'lower_priority_this_cycle' };
  }

  // 4. Global daily cap (skippable per-moment via action_config.ignore_global_cap)
  const ignoreGlobalCap = moment.action_config.ignore_global_cap === true;
  if (!ignoreGlobalCap) {
    const { data: sendsToday } = await supabase.rpc('moment_sends_today', {
      p_handle: handle,
    });
    if ((sendsToday as number) >= globalConfig.global_daily_cap) {
      return { status: 'frequency_capped', skipReason: 'global_daily_cap' };
    }
  }

  // 5. Global cooldown (also skipped when ignore_global_cap is set)
  if (!ignoreGlobalCap) {
    const { data: lastSentAny } = await supabase.rpc('moment_last_sent_any', {
      p_handle: handle,
    });
    if (lastSentAny) {
      const hoursSince = (Date.now() - new Date(lastSentAny as string).getTime()) / 3600000;
      if (hoursSince < globalConfig.global_cooldown_hours) {
        return { status: 'cooldown_blocked', skipReason: 'global_cooldown' };
      }
    }
  }

  // 6. Per-moment cooldown
  const { data: lastSentThis } = await supabase.rpc('moment_last_sent', {
    p_moment_id: moment.id,
    p_handle: handle,
  });
  if (lastSentThis) {
    const hoursSince = (Date.now() - new Date(lastSentThis as string).getTime()) / 3600000;
    if (hoursSince < moment.cooldown_hours) {
      return { status: 'cooldown_blocked', skipReason: 'moment_cooldown' };
    }
  }

  // 7. Lifetime cap
  if (moment.max_per_user_total !== null) {
    const { data: totalSends } = await supabase.rpc('moment_total_sends', {
      p_moment_id: moment.id,
      p_handle: handle,
    });
    if ((totalSends as number) >= moment.max_per_user_total) {
      return { status: 'frequency_capped', skipReason: 'lifetime_cap' };
    }
  }

  // 8. User suppression
  const { data: suppressed } = await supabase.rpc('is_moment_suppressed', {
    p_handle: handle,
    p_moment_id: moment.id,
  });
  if (suppressed) {
    return { status: 'suppressed', skipReason: 'user_suppressed' };
  }

  // 9. Resolve timezone and local time
  const tz = resolveTimezone(moment, candidate);
  const { localHour, localMinute } = getUserLocalTime(tz);

  let calendarRelativeMode = false;
  if (moment.trigger_type === 'relative_time') {
    const tc = moment.trigger_config;
    const offsetRaw = tc.calendar_day_offset;
    if (offsetRaw != null && Number(offsetRaw) >= 0) {
      calendarRelativeMode = true;
      const ref = String(tc.reference ?? 'first_seen').replace('user_profiles.', '');
      const refEpoch = getCandidateRefEpoch(candidate, ref);
      if (refEpoch == null) {
        return { status: 'skipped', skipReason: 'no_reference_time' };
      }
      const sendAtHour = Number(tc.send_at_local_hour ?? 9);
      const sendAtMin = Number(tc.send_at_local_minute ?? 0);
      const offsetDays = Math.floor(Number(offsetRaw));
      const signupYmd = formatLocalYmd(refEpoch * 1000, tz);
      const targetYmd = addDaysToGregorianYmd(signupYmd, offsetDays);
      const todayYmd = formatLocalYmd(Date.now(), tz);
      if (todayYmd !== targetYmd) {
        return { status: 'skipped', skipReason: 'calendar_day_mismatch' };
      }
      if (!localClockMatchesSendAt(localHour, localMinute, sendAtHour, sendAtMin)) {
        return { status: 'skipped', skipReason: 'calendar_time_mismatch' };
      }
    }
  }

  // 10. Quiet hours check
  const qStart = moment.quiet_hours_start;
  const qEnd = moment.quiet_hours_end;
  if (isInQuietHours(localHour, qStart, qEnd)) {
    return { status: 'skipped', skipReason: 'quiet_hours' };
  }

  // 11. Time window check (calendar-day relative triggers pin the send time in trigger_config instead)
  if (
    !calendarRelativeMode &&
    moment.window_start_hour !== null &&
    moment.window_end_hour !== null
  ) {
    if (localHour < moment.window_start_hour || localHour >= moment.window_end_hour) {
      return { status: 'skipped', skipReason: 'outside_window' };
    }
  }

  // 12. Spam guard
  if (candidate.proactive_ignore_count >= globalConfig.max_consecutive_ignores) {
    return { status: 'skipped', skipReason: 'max_ignores_reached' };
  }

  if (candidate.last_proactive_ignored && candidate.last_proactive_sent_at) {
    const hoursSinceProactive = (Date.now() - new Date(candidate.last_proactive_sent_at).getTime()) / 3600000;
    if (hoursSinceProactive < globalConfig.ignore_hold_hours) {
      return { status: 'skipped', skipReason: 'ignore_hold' };
    }
  }

  // 13. Scheduled trigger — cron check
  if (moment.trigger_type === 'scheduled') {
    const cron = moment.trigger_config.cron as string | undefined;
    if (cron && !cronMatchesNow(cron, localHour, localMinute, new Date())) {
      return { status: 'skipped', skipReason: 'cron_not_matching' };
    }
  }

  // 14. Per-moment daily cap
  if (moment.max_per_day_per_user > 0) {
    const { count } = await supabase
      .from('moment_executions')
      .select('id', { count: 'exact', head: true })
      .eq('moment_id', moment.id)
      .eq('handle', handle)
      .eq('status', 'sent')
      .gt('sent_at', new Date(Date.now() - 86400000).toISOString());

    if ((count ?? 0) >= moment.max_per_day_per_user) {
      return { status: 'frequency_capped', skipReason: 'moment_daily_cap' };
    }
  }

  // 15. Test mode
  if (moment.test_mode) {
    return { status: 'dry_run', skipReason: 'test_mode' };
  }

  // All checks passed
  return { status: 'pass' };
}

// ============================================================================
// Record execution
// ============================================================================

export async function recordExecution(
  moment: Moment,
  handle: string,
  chatId: string | null,
  status: string,
  opts: {
    skipReason?: string;
    renderedContent?: string;
    promptUsed?: string;
    metadata?: Record<string, unknown>;
    errorMessage?: string;
    executionMs?: number;
    idempotencyKey?: string;
  } = {},
): Promise<number | null> {
  const supabase = getAdminClient();
  const idempKey = opts.idempotencyKey ?? buildIdempotencyKey(moment, { handle } as MomentCandidate);

  const { data, error } = await supabase.rpc('record_moment_execution', {
    p_moment_id: moment.id,
    p_moment_version: moment.version,
    p_handle: handle,
    p_chat_id: chatId,
    p_status: status,
    p_skip_reason: opts.skipReason ?? null,
    p_rendered_content: opts.renderedContent ?? null,
    p_prompt_used: opts.promptUsed ?? null,
    p_metadata: JSON.stringify(opts.metadata ?? {}),
    p_error_message: opts.errorMessage ?? null,
    p_execution_ms: opts.executionMs ?? null,
    p_idempotency_key: idempKey,
  });

  if (error) {
    console.error(`[moments] Failed to record execution for ${handle}:`, error.message);
    return null;
  }

  return data as number;
}

// ============================================================================
// Dual-write to legacy automation_runs for backwards compatibility
// ============================================================================

export async function dualWriteAutomationRun(
  handle: string,
  chatId: string,
  momentName: string,
  content: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const supabase = getAdminClient();
  try {
    await supabase.rpc('record_automation_run', {
      p_handle: handle,
      p_chat_id: chatId,
      p_automation_type: momentName,
      p_content: content,
      p_metadata: JSON.stringify(metadata),
      p_manual_trigger: false,
      p_triggered_by: 'moment-engine',
    });
  } catch (err) {
    console.warn('[moments] Dual-write to automation_runs failed:', (err as Error).message);
  }
}

// ============================================================================
// Helpers
// ============================================================================

export function buildIdempotencyKey(moment: Moment, candidate: MomentCandidate): string {
  const tc = moment.trigger_config;
  if (
    moment.trigger_type === 'relative_time' &&
    tc.calendar_day_offset != null &&
    Number(tc.calendar_day_offset) >= 0
  ) {
    const tz = resolveTimezone(moment, candidate);
    const ymd = formatLocalYmd(Date.now(), tz);
    return `${moment.id}:${candidate.handle}:${ymd}`;
  }
  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  return `${moment.id}:${candidate.handle}:${dateStr}`;
}

function getCandidateRefEpoch(candidate: MomentCandidate, ref: string): number | null {
  if (ref === 'first_seen' || ref === 'last_seen') {
    const v = candidate[ref];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/** YYYY-MM-DD in the given IANA timezone (civil date). */
function formatLocalYmd(epochMs: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toISOString().slice(0, 10);
  }
}

/** Add N calendar days to a YYYY-MM-DD string (Gregorian). */
function addDaysToGregorianYmd(ymd: string, days: number): string {
  const parts = ymd.split('-').map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (!y || !m || !d) return ymd;
  const t = Date.UTC(y, m - 1, d + days);
  const dt = new Date(t);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function localClockMatchesSendAt(
  localHour: number,
  localMinute: number,
  sendAtHour: number,
  sendAtMin: number,
): boolean {
  if (localHour !== sendAtHour) return false;
  const diff = localMinute - sendAtMin;
  return diff === 0 || diff === -1 || (sendAtMin === 0 && localMinute === 59);
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return Math.abs(hash);
}

function resolveTimezone(moment: Moment, candidate: MomentCandidate): string {
  if (moment.timezone_behavior === 'fixed' && moment.timezone_fixed) {
    return moment.timezone_fixed;
  }
  if (moment.timezone_behavior === 'utc') {
    return 'UTC';
  }
  return candidate.timezone || 'Australia/Sydney';
}

export function getUserLocalTime(tz: string): { localHour: number; localMinute: number; localDay: number } {
  try {
    const now = new Date();
    const hourFmt = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', hour12: false });
    const localHour = parseInt(hourFmt.format(now));
    const minFmt = new Intl.DateTimeFormat('en-AU', { timeZone: tz, minute: 'numeric' });
    const localMinute = parseInt(minFmt.format(now));
    const dayFmt = new Intl.DateTimeFormat('en-AU', { timeZone: tz, weekday: 'short' });
    const dayStr = dayFmt.format(now);
    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const localDay = dayMap[dayStr] ?? now.getDay();
    return { localHour, localMinute, localDay };
  } catch {
    return { localHour: new Date().getUTCHours() + 10, localMinute: new Date().getUTCMinutes(), localDay: new Date().getDay() };
  }
}

function isInQuietHours(localHour: number, start: number, end: number): boolean {
  if (start > end) {
    return localHour >= start || localHour < end;
  }
  return localHour >= start && localHour < end;
}

function cronMatchesNow(cron: string, localHour: number, localMinute: number, now: Date): boolean {
  const parts = cron.split(/\s+/);
  if (parts.length < 5) return false;

  const [minPart, hourPart, _dom, _month, dowPart] = parts;

  // Check minute (exact match or 1 min before to account for cron firing a few seconds early)
  if (minPart !== '*') {
    const minutes = expandCronField(minPart, 0, 59);
    if (!minutes.some(m => {
      const diff = m - localMinute;
      return diff === 0 || diff === 1 || (m === 0 && localMinute === 59);
    })) return false;
  }

  // Check hour
  if (hourPart !== '*') {
    const hours = expandCronField(hourPart, 0, 23);
    if (!hours.includes(localHour)) return false;
  }

  // Check day of week
  if (dowPart !== '*') {
    const daysOfWeek = expandCronField(dowPart, 0, 6);
    const currentDow = now.getDay();
    if (!daysOfWeek.includes(currentDow)) return false;
  }

  return true;
}

function expandCronField(field: string, min: number, max: number): number[] {
  const values: number[] = [];

  for (const part of field.split(',')) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      for (let i = start; i <= end && i <= max; i++) {
        values.push(i);
      }
    } else if (part.includes('/')) {
      const [_base, step] = part.split('/');
      const stepNum = Number(step);
      for (let i = min; i <= max; i += stepNum) {
        values.push(i);
      }
    } else {
      const num = Number(part);
      if (!isNaN(num)) values.push(num);
    }
  }

  return values;
}
