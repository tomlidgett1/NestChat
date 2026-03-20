import type { Request, Response } from 'express';
import type { PostgrestError } from '@supabase/supabase-js';
import { getSupabase } from '../lib/supabase.js';

/** Columns admins may change (handle is immutable). */
const PATCHABLE_USER_PROFILE_KEYS = new Set([
  'name',
  'facts',
  'first_seen',
  'last_seen',
  'status',
  'onboard_messages',
  'onboard_count',
  'bot_number',
  'pdl_profile',
  'auth_user_id',
  'onboard_state',
  'entry_state',
  'first_value_wedge',
  'first_value_delivered_at',
  'follow_through_delivered_at',
  'second_engagement_at',
  'checkin_opt_in',
  'checkin_decline_at',
  'checkin_last_permission_at',
  'memory_moment_delivered_at',
  'activated_at',
  'at_risk_at',
  'last_proactive_sent_at',
  'last_proactive_ignored',
  'proactive_ignore_count',
  'recovery_nudge_sent_at',
  'timezone',
  'activation_score',
  'capability_categories_used',
  'deep_profile_snapshot',
  'deep_profile_built_at',
  'use_linq',
]);

async function deleteByEq(
  table: string,
  column: string,
  value: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = getSupabase();
  const { error } = await supabase.from(table).delete().eq(column, value);
  if (error) return { ok: false, error: `${table}: ${error.message}` };
  return { ok: true };
}

async function deleteByIn(
  table: string,
  column: string,
  values: string[],
): Promise<{ ok: boolean; error?: string }> {
  if (values.length === 0) return { ok: true };
  const supabase = getSupabase();
  const { error } = await supabase.from(table).delete().in(column, values);
  if (error) return { ok: false, error: `${table}: ${error.message}` };
  return { ok: true };
}

async function collectChatIdsForHandle(handle: string): Promise<string[]> {
  const supabase = getSupabase();
  const ids = new Set<string>([handle]);
  const [byParticipant, byChatId] = await Promise.all([
    supabase.from('conversation_messages').select('chat_id').eq('handle', handle),
    supabase.from('conversation_messages').select('chat_id').eq('chat_id', handle),
  ]);
  for (const row of byParticipant.data || []) {
    if (row.chat_id) ids.add(row.chat_id as string);
  }
  for (const row of byChatId.data || []) {
    if (row.chat_id) ids.add(row.chat_id as string);
  }
  return [...ids];
}

/**
 * Removes Nest rows keyed by this messaging handle (and related chat_ids).
 * Optionally deletes auth.users afterwards (cascades OAuth + uploads).
 */
export async function purgeUserDataByHandle(
  handle: string,
  options: { deleteAuthUser: boolean },
): Promise<{ cleaned: string[]; errors: string[]; authUserDeleted: boolean | null }> {
  const supabase = getSupabase();
  const cleaned: string[] = [];
  const errors: string[] = [];

  const { data: profile } = await supabase.from('user_profiles').select('auth_user_id').eq('handle', handle).maybeSingle();
  const authUserId = (profile?.auth_user_id as string | null | undefined) ?? null;

  const chatIds = await collectChatIdsForHandle(handle);

  const chatTables = ['pending_actions', 'tool_traces', 'conversation_messages', 'outbound_messages', 'conversations'] as const;
  for (const table of chatTables) {
    const r = await deleteByIn(table, 'chat_id', chatIds);
    if (r.ok) cleaned.push(table);
    else if (r.error) errors.push(r.error);
  }

  const handleTables: { table: string; column: string }[] = [
    { table: 'search_documents', column: 'handle' },
    { table: 'memory_items', column: 'handle' },
    { table: 'conversation_summaries', column: 'sender_handle' },
    { table: 'proactive_messages', column: 'handle' },
    { table: 'onboarding_events', column: 'handle' },
    { table: 'experiment_assignments', column: 'handle' },
    { table: 'turn_traces', column: 'sender_handle' },
    { table: 'webhook_events', column: 'sender_handle' },
    { table: 'ingestion_jobs', column: 'handle' },
    { table: 'automation_runs', column: 'handle' },
    { table: 'automation_preferences', column: 'handle' },
    { table: 'reminders', column: 'handle' },
    { table: 'notification_watch_triggers', column: 'handle' },
    { table: 'notification_webhook_subscriptions', column: 'handle' },
    { table: 'group_chat_members', column: 'handle' },
    { table: 'reported_bugs', column: 'sender_handle' },
  ];

  for (const { table, column } of handleTables) {
    const r = await deleteByEq(table, column, handle);
    if (r.ok) cleaned.push(`${table}(${column})`);
    else if (r.error && !isMissingRelationError(r.error)) errors.push(r.error);
  }

  const profileDel = await deleteByEq('user_profiles', 'handle', handle);
  if (profileDel.ok) cleaned.push('user_profiles');
  else if (profileDel.error) errors.push(profileDel.error);

  let authUserDeleted: boolean | null = null;
  if (options.deleteAuthUser && authUserId) {
    const { error } = await supabase.auth.admin.deleteUser(authUserId);
    if (error) {
      errors.push(`auth.admin.deleteUser: ${error.message}`);
      authUserDeleted = false;
    } else {
      cleaned.push('auth.users (cascade: oauth, uploads, chunks)');
      authUserDeleted = true;
    }
  } else if (options.deleteAuthUser && !authUserId) {
    authUserDeleted = null;
  }

  return { cleaned, errors, authUserDeleted };
}

function isMissingRelationError(msg: string): boolean {
  return /relation|does not exist|schema cache/i.test(msg);
}

function pickPatch(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (PATCHABLE_USER_PROFILE_KEYS.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

/** PATCH /debug/api/admin-user?handle= — JSON body: partial user_profiles fields (allowlisted). */
export async function handleAdminUserPatch(req: Request, res: Response) {
  try {
    const handle = typeof req.query.handle === 'string' ? req.query.handle.trim() : '';
    if (!handle) {
      return res.status(400).json({ error: 'handle query parameter is required' });
    }

    const patch = pickPatch(req.body);
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No allowlisted fields in body' });
    }

    const supabase = getSupabase();
    const { data, error } = await supabase.from('user_profiles').update(patch).eq('handle', handle).select().maybeSingle();

    if (error) {
      return res.status(500).json({ error: (error as PostgrestError).message });
    }
    if (!data) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ ok: true, profile: data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
}

/** DELETE /debug/api/admin-user?handle= — body: { confirmHandle, deleteAuthUser? } */
export async function handleAdminUserDelete(req: Request, res: Response) {
  try {
    const handle = typeof req.query.handle === 'string' ? req.query.handle.trim() : '';
    if (!handle) {
      return res.status(400).json({ error: 'handle query parameter is required' });
    }

    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const confirm = typeof body.confirmHandle === 'string' ? body.confirmHandle.trim() : '';
    if (confirm !== handle) {
      return res.status(400).json({
        error: 'confirmHandle in JSON body must exactly match the handle query parameter',
      });
    }

    const deleteAuthUser = body.deleteAuthUser === true;

    const result = await purgeUserDataByHandle(handle, { deleteAuthUser });

    const payload = {
      ok: result.errors.length === 0,
      handle,
      deleteAuthUser,
      cleaned: result.cleaned,
      errors: result.errors.length ? result.errors : undefined,
      authUserDeleted: result.authUserDeleted,
    };

    if (result.errors.length > 0) {
      return res.status(500).json({
        ...payload,
        error: result.errors.join('; '),
      });
    }

    res.json(payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
}
