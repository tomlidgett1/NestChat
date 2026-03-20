import type { Request, Response } from 'express';
import type { PostgrestError } from '@supabase/supabase-js';
import { getSupabase } from '../lib/supabase.js';

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

async function countOrZero(
  promise: PromiseLike<{ count: number | null; error: PostgrestError | null }>,
): Promise<number> {
  try {
    const { count, error } = await promise;
    if (error) {
      console.warn('[admin-insights]', error.message);
      return 0;
    }
    return count ?? 0;
  } catch (e) {
    console.warn('[admin-insights]', e);
    return 0;
  }
}

/** Nest uses user_profiles.status: active = finished onboarding (verified), pending = not yet. */
export function buildUserVerificationFromCounts(total: number, active: number, pending: number) {
  const other = Math.max(0, total - active - pending);
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);
  return {
    totalUserProfiles: total,
    verifiedActive: active,
    pendingVerification: pending,
    otherStatus: other,
    verifiedPercentOfTotal: pct(active),
    pendingPercentOfTotal: pct(pending),
    otherPercentOfTotal: pct(other),
    note:
      "Verified = user_profiles.status is 'active' (completed Nest onboarding). Pending verification = status is 'pending'. Any other status values appear under Other.",
  };
}

/** GET /debug/api/activity-summary — high-level app activity (last 24h / 7d). */
export async function handleActivitySummary(_req: Request, res: Response) {
  try {
    const supabase = getSupabase();
    const t24 = hoursAgoIso(24);
    const t7d = hoursAgoIso(24 * 7);
    const nowIso = new Date().toISOString();

    const [
      turns24,
      turns7d,
      msgs24,
      profilesCount,
      profilesActive,
      profilesPending,
      webhooksQueued,
      outboundPending,
      errors24,
      webhooksProcessed24,
      automation24,
      onboardEvents24,
      ingestionPending,
    ] = await Promise.all([
      countOrZero(
        supabase.from('turn_traces').select('*', { count: 'exact', head: true }).gte('created_at', t24),
      ),
      countOrZero(
        supabase.from('turn_traces').select('*', { count: 'exact', head: true }).gte('created_at', t7d),
      ),
      countOrZero(
        supabase
          .from('conversation_messages')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', t24)
          .gt('expires_at', nowIso),
      ),
      countOrZero(supabase.from('user_profiles').select('*', { count: 'exact', head: true })),
      countOrZero(
        supabase.from('user_profiles').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      ),
      countOrZero(
        supabase.from('user_profiles').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      ),
      countOrZero(
        supabase.from('webhook_events').select('*', { count: 'exact', head: true }).eq('status', 'queued'),
      ),
      countOrZero(
        supabase.from('outbound_messages').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      ),
      countOrZero(
        supabase
          .from('turn_traces')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', t24)
          .not('error_message', 'is', null),
      ),
      countOrZero(
        supabase
          .from('webhook_events')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', t24)
          .not('processed_at', 'is', null),
      ),
      countOrZero(
        supabase.from('automation_runs').select('*', { count: 'exact', head: true }).gte('sent_at', t24),
      ),
      countOrZero(
        supabase.from('onboarding_events').select('*', { count: 'exact', head: true }).gte('created_at', t24),
      ),
      countOrZero(
        supabase.from('ingestion_jobs').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      ),
    ]);

    const { data: recentTurns, error: sampleError } = await supabase
      .from('turn_traces')
      .select('sender_handle, agent_name')
      .gte('created_at', t7d)
      .order('created_at', { ascending: false })
      .limit(2500);

    if (sampleError) {
      console.warn('[admin-insights] turn sample:', sampleError.message);
    }

    const handleCounts = new Map<string, number>();
    const agentCounts = new Map<string, number>();
    for (const row of recentTurns || []) {
      const h = row.sender_handle as string;
      if (h) handleCounts.set(h, (handleCounts.get(h) || 0) + 1);
      const a = row.agent_name as string;
      if (a) agentCounts.set(a, (agentCounts.get(a) || 0) + 1);
    }

    const topHandles = [...handleCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([handle, count]) => ({ handle, count }));

    const agentBreakdown = [...agentCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([agent, count]) => ({ agent, count }));

    const userVerification = buildUserVerificationFromCounts(profilesCount, profilesActive, profilesPending);

    res.json({
      generatedAt: nowIso,
      window: { last24hFrom: t24, last7dFrom: t7d },
      turns: { last24h: turns24, last7d: turns7d },
      conversationMessages: { nonExpiredLast24h: msgs24 },
      userProfiles: profilesCount,
      userVerification,
      webhooks: { queued: webhooksQueued, processedLast24h: webhooksProcessed24 },
      outboundMessages: { pending: outboundPending },
      turnErrors: { last24h: errors24 },
      automationRuns: { last24h: automation24 },
      onboardingEvents: { last24h: onboardEvents24 },
      ingestionJobs: { pending: ingestionPending },
      sampledTurnsLast7d: recentTurns?.length ?? 0,
      topHandlesBySampledTurns: topHandles,
      agentBreakdownSampled: agentBreakdown,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
}

/** GET /debug/api/user-verification-stats — lightweight counts for the Users admin page. */
export async function handleUserVerificationStats(_req: Request, res: Response) {
  try {
    const supabase = getSupabase();
    const [total, active, pending] = await Promise.all([
      countOrZero(supabase.from('user_profiles').select('*', { count: 'exact', head: true })),
      countOrZero(
        supabase.from('user_profiles').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      ),
      countOrZero(
        supabase.from('user_profiles').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      ),
    ]);
    res.json(buildUserVerificationFromCounts(total, active, pending));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
}

function escapeIlike(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** GET /debug/api/admin-users?q=&limit=&offset= */
export async function handleAdminUsersList(req: Request, res: Response) {
  try {
    const supabase = getSupabase();
    const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset), 10) || 0, 0);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    let query = supabase
      .from('user_profiles')
      .select(
        'handle, name, status, bot_number, first_seen, last_seen, onboard_state, auth_user_id, use_linq, timezone, onboard_count, activation_score',
        { count: 'exact' },
      )
      .order('last_seen', { ascending: false })
      .range(offset, offset + limit - 1);

    if (q) {
      const esc = escapeIlike(q);
      query = query.or(`handle.ilike.%${esc}%,name.ilike.%${esc}%`);
    }

    const { data, error, count } = await query;
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ users: data ?? [], total: count ?? 0, limit, offset });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
}

/** GET /debug/api/admin-user-detail?handle= */
export async function handleAdminUserDetail(req: Request, res: Response) {
  try {
    const handle = typeof req.query.handle === 'string' ? req.query.handle.trim() : '';
    if (!handle) {
      return res.status(400).json({ error: 'handle is required' });
    }

    const supabase = getSupabase();

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('handle', handle)
      .maybeSingle();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'User not found' });
    }

    const authUserId = profile.auth_user_id as string | null;

    const [
      googleAccounts,
      msAccounts,
      granolaAccounts,
      recentTurns,
      onboardEvents,
      convMsgs,
      automationRuns,
      turnCount7d,
      memCount,
      summaries,
    ] = await Promise.all([
      authUserId
        ? supabase
            .from('user_google_accounts')
            .select('id, google_email, google_name, google_avatar_url, is_primary, timezone, scopes, created_at')
            .eq('user_id', authUserId)
        : Promise.resolve({ data: [] as unknown[] }),
      authUserId
        ? supabase
            .from('user_microsoft_accounts')
            .select('id, microsoft_email, microsoft_name, microsoft_avatar_url, is_primary, created_at')
            .eq('user_id', authUserId)
        : Promise.resolve({ data: [] as unknown[] }),
      authUserId
        ? supabase
            .from('user_granola_accounts')
            .select('id, granola_email, granola_name, is_primary, token_expires_at, created_at')
            .eq('user_id', authUserId)
        : Promise.resolve({ data: [] as unknown[] }),
      supabase
        .from('turn_traces')
        .select(
          'id, created_at, chat_id, route_agent, agent_name, model_used, total_latency_ms, error_message, user_message',
        )
        .eq('sender_handle', handle)
        .order('created_at', { ascending: false })
        .limit(30),
      supabase
        .from('onboarding_events')
        .select('id, event_type, chat_id, created_at, payload, current_state')
        .eq('handle', handle)
        .order('created_at', { ascending: false })
        .limit(40),
      supabase
        .from('conversation_messages')
        .select('id, role, content, handle, metadata, created_at, chat_id')
        .eq('chat_id', handle)
        .order('created_at', { ascending: false })
        .limit(25),
      supabase
        .from('automation_runs')
        .select('id, automation_type, content, sent_at, replied_at, ignored, manual_trigger, triggered_by')
        .eq('handle', handle)
        .order('sent_at', { ascending: false })
        .limit(25),
      countOrZero(
        supabase
          .from('turn_traces')
          .select('*', { count: 'exact', head: true })
          .eq('sender_handle', handle)
          .gte('created_at', hoursAgoIso(24 * 7)),
      ),
      countOrZero(
        supabase
          .from('memory_items')
          .select('*', { count: 'exact', head: true })
          .eq('handle', handle)
          .eq('status', 'active'),
      ),
      supabase
        .from('conversation_summaries')
        .select('id, summary_kind, message_count, first_message_at, last_message_at, topics')
        .eq('sender_handle', handle)
        .order('last_message_at', { ascending: false })
        .limit(8),
    ]);

    let memorySample: unknown[] = [];
    const memRpc = await supabase.rpc('get_active_memory_items', { p_handle: handle, p_limit: 50 });
    if (!memRpc.error && memRpc.data) {
      memorySample = memRpc.data;
    }

    const { deep_profile_snapshot: _dp, ...profileRest } = profile as Record<string, unknown>;
    const deepProfileSnapshot = profile.deep_profile_snapshot;
    const deepProfilePreview =
      deepProfileSnapshot == null
        ? null
        : typeof deepProfileSnapshot === 'string'
          ? (deepProfileSnapshot as string).slice(0, 4000)
          : JSON.stringify(deepProfileSnapshot).slice(0, 4000);

    res.json({
      profile: profileRest,
      deep_profile_built_at: profile.deep_profile_built_at ?? null,
      deep_profile_preview: deepProfilePreview,
      deep_profile_truncated:
        deepProfileSnapshot != null &&
        (typeof deepProfileSnapshot === 'string'
          ? (deepProfileSnapshot as string).length > 4000
          : JSON.stringify(deepProfileSnapshot).length > 4000),
      linkedAccounts: {
        google: googleAccounts.data ?? [],
        microsoft: msAccounts.data ?? [],
        granola: granolaAccounts.data ?? [],
      },
      counts: {
        active_memory_items: memCount,
        turns_last_7d: turnCount7d,
      },
      recentTurns: recentTurns.data ?? [],
      recentOnboardingEvents: onboardEvents.data ?? [],
      recentConversationMessages: convMsgs.data ?? [],
      recentAutomationRuns: automationRuns.data ?? [],
      conversationSummaries: summaries.data ?? [],
      memoryItemsSample: memorySample,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
}
