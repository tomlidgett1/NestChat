// Incremental ingestion cron + stale job recovery.
// Adapted from TapMeeting's ingest-cron.
//
// 1. Resumes stalled jobs (running > 5 min)
// 2. Triggers incremental ingestion for all users with connected accounts

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getAdminClient } from '../_shared/supabase.ts';
import { authorizeInternalRequest, internalJsonHeaders } from '../_shared/internal-auth.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const STALE_JOB_THRESHOLD_MS = 5 * 60 * 1000;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
    });
  }

  if (!authorizeInternalRequest(req)) {
    return jsonResp({ error: 'unauthorized' }, 401);
  }

  const supabase = getAdminClient();

  try {
    // ── Phase 1: Resume stalled jobs ────────────────────────────
    const staleThreshold = new Date(Date.now() - STALE_JOB_THRESHOLD_MS).toISOString();

    const { data: stalledJobs } = await supabase
      .from('ingestion_jobs')
      .select('id')
      .eq('status', 'running')
      .lt('started_at', staleThreshold);

    let resumed = 0;
    for (const job of stalledJobs ?? []) {
      try {
        const resp = await fetch(`${supabaseUrl}/functions/v1/ingest-pipeline`, {
          method: 'POST',
          headers: internalJsonHeaders(),
          body: JSON.stringify({ job_id: job.id }),
        });
        if (resp.ok) resumed++;
        console.log(`[ingest-cron] Resumed stalled job ${job.id} (status=${resp.status})`);
      } catch (e) {
        console.warn(`[ingest-cron] Failed to resume job ${job.id}:`, (e as Error).message);
      }
    }

    if (resumed > 0) {
      console.log(`[ingest-cron] Resumed ${resumed}/${stalledJobs?.length ?? 0} stalled job(s)`);
    }

    // ── Phase 2: Incremental ingestion for users with accounts ──
    const { data: googleUsers } = await supabase
      .from('user_google_accounts')
      .select('user_id')
      .not('refresh_token', 'is', null);

    const { data: msUsers } = await supabase
      .from('user_microsoft_accounts')
      .select('user_id')
      .not('refresh_token', 'is', null);

    const allAuthUserIds = new Set<string>();
    for (const u of googleUsers ?? []) { if (u.user_id) allAuthUserIds.add(u.user_id); }
    for (const u of msUsers ?? []) { if (u.user_id) allAuthUserIds.add(u.user_id); }

    const handleMap = new Map<string, string>();
    if (allAuthUserIds.size > 0) {
      const { data: profiles } = await supabase
        .from('user_profiles')
        .select('handle, auth_user_id')
        .in('auth_user_id', [...allAuthUserIds]);

      for (const p of profiles ?? []) {
        if (p.handle && p.auth_user_id) {
          handleMap.set(p.auth_user_id, p.handle);
        }
      }
    }

    console.log(`[ingest-cron] Starting incremental ingestion for ${handleMap.size} users`);

    const results: Array<{ handle: string; status: string; job_id?: string; error?: string }> = [];
    const concurrency = 3;
    const entries = [...handleMap.entries()];

    for (let i = 0; i < entries.length; i += concurrency) {
      const batch = entries.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async ([_authUserId, handle]) => {
          try {
            const resp = await fetch(`${supabaseUrl}/functions/v1/ingest-pipeline`, {
              method: 'POST',
              headers: internalJsonHeaders(),
              body: JSON.stringify({
                handle,
                mode: 'incremental',
                sources: ['emails', 'calendar'],
              }),
            });

            const data = await resp.json();
            return {
              handle,
              status: resp.ok ? 'triggered' : 'failed',
              job_id: data.job_id,
              error: data.error,
            };
          } catch (e) {
            return {
              handle,
              status: 'failed',
              error: (e as Error).message,
            };
          }
        }),
      );

      results.push(...batchResults);
    }

    const succeeded = results.filter((r) => r.status === 'triggered').length;
    const failed = results.filter((r) => r.status === 'failed').length;

    console.log(`[ingest-cron] Completed: ${succeeded} succeeded, ${failed} failed, ${resumed} resumed`);

    return jsonResp({
      total_users: handleMap.size,
      succeeded,
      failed,
      stalled_resumed: resumed,
      results,
    }, 200);
  } catch (e) {
    console.error('[ingest-cron] Error:', (e as Error).message);
    return jsonResp({ error: (e as Error).message }, 500);
  }
});

function jsonResp(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
