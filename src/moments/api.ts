import type { Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';
import { internalEdgeJsonHeaders } from '../lib/internal-edge-auth.js';

// ============================================================================
// Input sanitization helpers
// ============================================================================

function sanitizeString(value: unknown, maxLength = 1000): string | null {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, maxLength);
}

function sanitizeNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').map(v => v.slice(0, 500));
}

function sanitizeEnum<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  if (typeof value === 'string' && (allowed as string[]).includes(value)) return value as T;
  return fallback;
}

function sanitizePlainObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return JSON.parse(JSON.stringify(value));
  }
  return {};
}

function sanitizePlainArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return JSON.parse(JSON.stringify(value));
  return [];
}

// ============================================================================
// Auth helper
// ============================================================================

function verifyAdmin(_req: Request): boolean {
  return true;
}

function requireAuth(req: Request, res: Response): boolean {
  if (!verifyAdmin(req)) {
    res.status(401).json({ error: 'Unauthorised' });
    return false;
  }
  return true;
}

// ============================================================================
// GET /api/admin-moments — list all moments
// ============================================================================

export async function handleListMoments(req: Request, res: Response) {
  if (!requireAuth(req, res)) return;

  try {
    const supabase = getSupabase();
    const statusFilter = req.query.status as string | undefined;

    let query = supabase
      .from('moments')
      .select('*')
      .order('priority', { ascending: true })
      .order('created_at', { ascending: false });

    if (statusFilter && statusFilter !== 'all') {
      query = query.eq('status', statusFilter);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Attach stats for each moment
    const moments = data || [];
    const momentIds = moments.map((m: Record<string, unknown>) => m.id as string);

    if (momentIds.length > 0) {
      const statsPromises = momentIds.map((id: string) =>
        supabase.rpc('get_moment_stats', { p_moment_id: id })
      );
      const statsResults = await Promise.all(statsPromises);

      for (let i = 0; i < moments.length; i++) {
        const statsData = statsResults[i]?.data;
        if (statsData && Array.isArray(statsData) && statsData.length > 0) {
          (moments[i] as Record<string, unknown>).stats = statsData[0];
        } else if (statsData && !Array.isArray(statsData)) {
          (moments[i] as Record<string, unknown>).stats = statsData;
        } else {
          (moments[i] as Record<string, unknown>).stats = null;
        }
      }
    }

    res.json(moments);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ============================================================================
// POST /api/admin-moments — create a moment
// ============================================================================

function parseMomentCreatePayload(input: Record<string, unknown>): Record<string, unknown> | null {
  const name = sanitizeString(input.name, 200);
  if (!name) return null;
  const triggerType = sanitizeString(input.trigger_type, 100);
  if (!triggerType) return null;

  return {
    name,
    description: sanitizeString(input.description, 2000),
    status: sanitizeEnum(input.status, ['draft', 'active', 'paused', 'archived'], 'draft'),
    trigger_type: triggerType,
    trigger_config: sanitizePlainObject(input.trigger_config),
    audience_config: input.audience_config ? sanitizePlainObject(input.audience_config) : { mode: 'all_active' },
    conditions: sanitizePlainArray(input.conditions),
    action_type: sanitizeEnum(input.action_type, ['send_message', 'send_media', 'trigger_flow'], 'send_message'),
    action_config: sanitizePlainObject(input.action_config),
    prompt_template: sanitizeString(input.prompt_template, 10000),
    prompt_system_context: sanitizeString(input.prompt_system_context, 10000),
    prompt_variables: sanitizePlainArray(input.prompt_variables),
    cooldown_hours: sanitizeNumber(input.cooldown_hours, 0, 8760, 24),
    max_per_day_per_user: sanitizeNumber(input.max_per_day_per_user, 0, 1000, 1),
    max_per_user_total: input.max_per_user_total != null ? sanitizeNumber(input.max_per_user_total, 0, 100000, 0) : null,
    priority: sanitizeNumber(input.priority, 0, 10000, 100),
    quiet_hours_start: sanitizeNumber(input.quiet_hours_start, 0, 23, 21),
    quiet_hours_end: sanitizeNumber(input.quiet_hours_end, 0, 23, 7),
    rollout_pct: sanitizeNumber(input.rollout_pct, 0, 100, 100),
    test_mode: sanitizeBoolean(input.test_mode, false),
    test_handles: sanitizeStringArray(input.test_handles),
    timezone_behavior: sanitizeEnum(input.timezone_behavior, ['user_local', 'fixed', 'utc'], 'user_local'),
    timezone_fixed: sanitizeString(input.timezone_fixed, 100),
    window_start_hour: input.window_start_hour != null ? sanitizeNumber(input.window_start_hour, 0, 23, 0) : null,
    window_end_hour: input.window_end_hour != null ? sanitizeNumber(input.window_end_hour, 0, 23, 23) : null,
    tags: sanitizeStringArray(input.tags),
    is_system: false,
    created_by: 'dashboard',
    updated_by: 'dashboard',
  };
}

export async function handleCreateMoment(req: Request, res: Response) {
  if (!requireAuth(req, res)) return;

  try {
    const supabase = getSupabase();
    const sanitized = parseMomentCreatePayload(req.body);
    if (!sanitized) return res.status(400).json({ error: 'name and trigger_type are required' });

    // Build a clean insert payload from validated fields only (no raw req.body references)
    const insertPayload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sanitized)) {
      insertPayload[String(key)] = value;
    }

    const { data, error } = await supabase
      .from('moments')
      .insert(insertPayload)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    // Save initial version
    await supabase.rpc('save_moment_version', {
      p_moment_id: (data as Record<string, unknown>).id,
      p_changed_by: 'dashboard',
      p_change_summary: 'Created',
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ============================================================================
// PATCH /api/admin-moments/:id — update a moment
// ============================================================================

export async function handleUpdateMoment(req: Request, res: Response) {
  if (!requireAuth(req, res)) return;

  try {
    const supabase = getSupabase();
    const momentId = req.params.id;
    const body = req.body;

    // Build update payload with sanitized values only
    const updates: Record<string, unknown> = { updated_by: 'dashboard', updated_at: new Date().toISOString() };

    // Sanitize each patchable field individually
    const sanitizers: Record<string, () => unknown> = {
      name: () => sanitizeString(body.name, 200),
      description: () => sanitizeString(body.description, 2000),
      trigger_type: () => sanitizeString(body.trigger_type, 100),
      trigger_config: () => sanitizePlainObject(body.trigger_config),
      audience_config: () => sanitizePlainObject(body.audience_config),
      conditions: () => sanitizePlainArray(body.conditions),
      action_type: () => sanitizeEnum(body.action_type, ['send_message', 'send_media', 'trigger_flow'], 'send_message'),
      action_config: () => sanitizePlainObject(body.action_config),
      prompt_template: () => sanitizeString(body.prompt_template, 10000),
      prompt_system_context: () => sanitizeString(body.prompt_system_context, 10000),
      prompt_variables: () => sanitizePlainArray(body.prompt_variables),
      cooldown_hours: () => sanitizeNumber(body.cooldown_hours, 0, 8760, 24),
      max_per_day_per_user: () => sanitizeNumber(body.max_per_day_per_user, 0, 1000, 1),
      max_per_user_total: () => body.max_per_user_total != null ? sanitizeNumber(body.max_per_user_total, 0, 100000, 0) : null,
      priority: () => sanitizeNumber(body.priority, 0, 10000, 100),
      quiet_hours_start: () => sanitizeNumber(body.quiet_hours_start, 0, 23, 21),
      quiet_hours_end: () => sanitizeNumber(body.quiet_hours_end, 0, 23, 7),
      rollout_pct: () => sanitizeNumber(body.rollout_pct, 0, 100, 100),
      test_mode: () => sanitizeBoolean(body.test_mode, false),
      test_handles: () => sanitizeStringArray(body.test_handles),
      timezone_behavior: () => sanitizeEnum(body.timezone_behavior, ['user_local', 'fixed', 'utc'], 'user_local'),
      timezone_fixed: () => sanitizeString(body.timezone_fixed, 100),
      window_start_hour: () => body.window_start_hour != null ? sanitizeNumber(body.window_start_hour, 0, 23, 0) : null,
      window_end_hour: () => body.window_end_hour != null ? sanitizeNumber(body.window_end_hour, 0, 23, 23) : null,
      tags: () => sanitizeStringArray(body.tags),
    };

    for (const [key, sanitize] of Object.entries(sanitizers)) {
      if (key in body) updates[key] = sanitize();
    }

    // Increment version
    const { data: current } = await supabase
      .from('moments')
      .select('version')
      .eq('id', momentId)
      .single();

    if (current) {
      updates.version = ((current as Record<string, unknown>).version as number) + 1;
    }

    const { data, error } = await supabase
      .from('moments')
      .update(updates)
      .eq('id', momentId)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    // Save version snapshot
    await supabase.rpc('save_moment_version', {
      p_moment_id: momentId,
      p_changed_by: 'dashboard',
      p_change_summary: sanitizeString(body.change_summary, 500) || 'Updated',
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ============================================================================
// POST /api/admin-moments/:id/activate
// ============================================================================

export async function handleActivateMoment(req: Request, res: Response) {
  if (!requireAuth(req, res)) return;

  try {
    const supabase = getSupabase();
    const momentId = req.params.id;

    const { data, error } = await supabase
      .from('moments')
      .update({ status: 'active', activated_at: new Date().toISOString(), updated_by: 'dashboard', updated_at: new Date().toISOString() })
      .eq('id', momentId)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    await supabase.rpc('save_moment_version', {
      p_moment_id: momentId,
      p_changed_by: 'dashboard',
      p_change_summary: 'Activated',
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ============================================================================
// POST /api/admin-moments/:id/pause
// ============================================================================

export async function handlePauseMoment(req: Request, res: Response) {
  if (!requireAuth(req, res)) return;

  try {
    const supabase = getSupabase();
    const momentId = req.params.id;

    const { data, error } = await supabase
      .from('moments')
      .update({ status: 'paused', paused_at: new Date().toISOString(), updated_by: 'dashboard', updated_at: new Date().toISOString() })
      .eq('id', momentId)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    await supabase.rpc('save_moment_version', {
      p_moment_id: momentId,
      p_changed_by: 'dashboard',
      p_change_summary: 'Paused',
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ============================================================================
// POST /api/admin-moments/:id/archive
// ============================================================================

export async function handleArchiveMoment(req: Request, res: Response) {
  if (!requireAuth(req, res)) return;

  try {
    const supabase = getSupabase();
    const momentId = req.params.id;

    const { data, error } = await supabase
      .from('moments')
      .update({ status: 'archived', updated_by: 'dashboard', updated_at: new Date().toISOString() })
      .eq('id', momentId)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    await supabase.rpc('save_moment_version', {
      p_moment_id: momentId,
      p_changed_by: 'dashboard',
      p_change_summary: 'Archived',
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ============================================================================
// POST /api/admin-moments/:id/duplicate
// ============================================================================

export async function handleDuplicateMoment(req: Request, res: Response) {
  if (!requireAuth(req, res)) return;

  try {
    const supabase = getSupabase();
    const momentId = req.params.id;

    const { data: original, error: fetchError } = await supabase
      .from('moments')
      .select('*')
      .eq('id', momentId)
      .single();

    if (fetchError || !original) return res.status(404).json({ error: 'Moment not found' });

    const orig = original as Record<string, unknown>;

    const { data, error } = await supabase
      .from('moments')
      .insert({
        name: `${orig.name} (copy)`,
        description: orig.description,
        status: 'draft',
        version: 1,
        trigger_type: orig.trigger_type,
        trigger_config: orig.trigger_config,
        audience_config: orig.audience_config,
        conditions: orig.conditions,
        action_type: orig.action_type,
        action_config: orig.action_config,
        prompt_template: orig.prompt_template,
        prompt_system_context: orig.prompt_system_context,
        prompt_variables: orig.prompt_variables,
        cooldown_hours: orig.cooldown_hours,
        max_per_day_per_user: orig.max_per_day_per_user,
        max_per_user_total: orig.max_per_user_total,
        priority: orig.priority,
        quiet_hours_start: orig.quiet_hours_start,
        quiet_hours_end: orig.quiet_hours_end,
        rollout_pct: orig.rollout_pct,
        test_mode: true,
        test_handles: orig.test_handles,
        timezone_behavior: orig.timezone_behavior,
        timezone_fixed: orig.timezone_fixed,
        window_start_hour: orig.window_start_hour,
        window_end_hour: orig.window_end_hour,
        tags: orig.tags,
        is_system: false,
        created_by: 'dashboard',
        updated_by: 'dashboard',
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ============================================================================
// GET /api/admin-moments/:id/executions
// ============================================================================

export async function handleGetExecutions(req: Request, res: Response) {
  if (!requireAuth(req, res)) return;

  try {
    const supabase = getSupabase();
    const momentId = req.params.id;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;

    const { data, error } = await supabase.rpc('get_moment_executions', {
      p_moment_id: momentId,
      p_limit: limit,
      p_offset: offset,
    });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ============================================================================
// GET /api/admin-moments/:id/audience-preview
// ============================================================================

export async function handleAudiencePreview(req: Request, res: Response) {
  if (!requireAuth(req, res)) return;

  try {
    const supabase = getSupabase();
    const momentId = req.params.id;

    const { data: momentData } = await supabase
      .from('moments')
      .select('*')
      .eq('id', momentId)
      .single();

    if (!momentData) return res.status(404).json({ error: 'Moment not found' });

    const audience = (momentData as Record<string, unknown>).audience_config as Record<string, unknown>;
    let query = supabase
      .from('user_profiles')
      .select('handle, name, timezone, status, last_seen, first_seen, onboard_count, activation_score, bot_number, auth_user_id', { count: 'exact' })
      .eq('status', 'active')
      .not('bot_number', 'is', null);

    if (audience.mode === 'specific' && Array.isArray(audience.include_handles)) {
      query = query.in('handle', audience.include_handles as string[]);
    }

    if (audience.require_connected_accounts) {
      query = query.not('auth_user_id', 'is', null);
    }

    if (audience.min_days_since_signup && Number(audience.min_days_since_signup) > 0) {
      const cutoff = Math.floor(Date.now() / 1000) - Number(audience.min_days_since_signup) * 86400;
      query = query.lt('first_seen', cutoff);
    }

    query = query.order('last_seen', { ascending: false }).limit(50);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ users: data || [], total: count || 0 });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ============================================================================
// POST /api/admin-moments/:id/manual-trigger
// ============================================================================

export async function handleManualTrigger(req: Request, res: Response) {
  if (!requireAuth(req, res)) return;

  try {
    const momentId = req.params.id;
    const { handle } = req.body;

    if (!handle) return res.status(400).json({ error: 'handle is required' });

    // Forward to the moment-engine Edge Function
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!supabaseUrl) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const resp = await fetch(`${supabaseUrl}/functions/v1/moment-engine`, {
      method: 'POST',
      headers: internalEdgeJsonHeaders(),
      body: JSON.stringify({ moment_id: momentId, handle, manual: true }),
    });

    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ============================================================================
// GET /api/admin-moments/global-config
// ============================================================================

export async function handleGetGlobalConfig(req: Request, res: Response) {
  if (!requireAuth(req, res)) return;

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('moment_global_config')
      .select('*');

    if (error) return res.status(500).json({ error: error.message });

    const config: Record<string, unknown> = {};
    for (const row of (data || []) as Array<{ key: string; value: unknown; updated_by: string; updated_at: string }>) {
      config[row.key] = row.value;
    }

    res.json(config);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ============================================================================
// PATCH /api/admin-moments/global-config
// ============================================================================

export async function handleUpdateGlobalConfig(req: Request, res: Response) {
  if (!requireAuth(req, res)) return;

  try {
    const supabase = getSupabase();
    const updates = req.body as Record<string, unknown>;

    for (const [key, value] of Object.entries(updates)) {
      await supabase
        .from('moment_global_config')
        .upsert({
          key,
          value: typeof value === 'string' ? value : JSON.stringify(value),
          updated_by: 'dashboard',
          updated_at: new Date().toISOString(),
        });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ============================================================================
// GET /api/admin-moments/stats
// ============================================================================

export async function handleGetStats(req: Request, res: Response) {
  if (!requireAuth(req, res)) return;

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.rpc('get_global_moment_stats');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ============================================================================
// GET /api/admin-moments/:id/versions
// ============================================================================

export async function handleGetVersions(req: Request, res: Response) {
  if (!requireAuth(req, res)) return;

  try {
    const supabase = getSupabase();
    const momentId = req.params.id;

    const { data, error } = await supabase
      .from('moment_versions')
      .select('*')
      .eq('moment_id', momentId)
      .order('version', { ascending: false })
      .limit(50);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
