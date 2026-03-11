// Server-side data ingestion pipeline — persistent task-queue architecture.
// Adapted from TapMeeting's ingest-pipeline.
//
// Guarantees 100% completion:
//   1. Initial POST creates a job + seeds tasks into ingestion_tasks
//   2. Each invocation claims ONE task, processes it, then chains
//   3. If killed (CPU limit, timeout), the task stays "running" in DB
//   4. Stale detection resets crashed tasks to "pending" for retry
//   5. ingest-cron resumes any stalled jobs every 5 min
//
// Task granularity:
//   - emails:   30 threads per task per account
//   - calendar: 80 events per task per account
//   - transcript: placeholder (no-op)

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { getAdminClient } from '../_shared/supabase.ts';
import { getGoogleAccessToken, getAllGoogleTokens, getMicrosoftAccessToken } from '../_shared/token-broker.ts';
import { listGmailThreadIds, fetchGmailThreadsByIds } from '../_shared/gmail-fetcher.ts';
import { fetchOutlookMessages } from '../_shared/gmail-fetcher.ts';
import { fetchGoogleCalendarEvents, fetchOutlookCalendarEvents, type CalendarEvent } from '../_shared/calendar-helpers.ts';
import {
  sentenceAwareChunks,
  buildEmailSummary,
  buildCalendarSummary,
  contentHash,
  emailContextHeader,
  calendarContextHeader,
} from '../_shared/chunker.ts';
import { embedChunks, type ChunkToEmbed, truncateForEmbedding } from '../_shared/embedder.ts';
import { softDeleteSource, bulkDeleteSources, bulkCheckNeedsUpdate, insertEmbeddedChunks, sourceNeedsUpdate } from '../_shared/ingestion-helpers.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const EMAIL_PAGE_SIZE = 30;
const CALENDAR_PAGE_SIZE = 80;
const STALE_THRESHOLD_MS = 180_000;
const MAX_TASK_ATTEMPTS = 3;
const PARALLEL_WORKERS = 3;

interface TaskRow {
  id: string;
  job_id: string;
  handle: string;
  auth_user_id: string;
  task_type: string;
  params: Record<string, any>;
  status: string;
  attempts: number;
}

interface TaskResult {
  documents: number;
  chunks: number;
  embeddings: number;
  skipped: number;
  has_more?: boolean;
  next_offset?: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
    });
  }

  if (req.method !== 'POST') {
    return jsonResp({ error: 'method_not_allowed' }, 405);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token || !isServiceRoleToken(token)) {
    return jsonResp({ error: 'unauthorized' }, 401);
  }

  try {
    const body = await req.json();
    const supabase = getAdminClient();

    let jobId: string;
    let isNewJob = false;

    if (body.job_id && !body.handle && !body.auth_user_id) {
      jobId = body.job_id;
    } else {
      const created = await createJobAndSeedTasks(supabase, body);
      jobId = created.jobId;
      isNewJob = true;
    }

    await recoverStaleTasks(supabase, jobId);

    const task = await claimNextTask(supabase, jobId);

    if (!task) {
      await finaliseJob(supabase, jobId);
      return jsonResp({ job_id: jobId, status: 'completed' }, 200);
    }

    const taskStart = Date.now();
    console.log(
      `[ingest-pipeline] Task ${task.id} (${task.task_type}) started` +
      ` [attempt ${task.attempts}/${MAX_TASK_ATTEMPTS}]`,
    );

    if (isNewJob) {
      for (let i = 0; i < PARALLEL_WORKERS - 1; i++) {
        chainNext(jobId, authHeader);
      }
    }

    try {
      const result = await executeTask(supabase, task);

      await supabase.from('ingestion_tasks').update({
        status: 'completed',
        result,
        completed_at: new Date().toISOString(),
      }).eq('id', task.id);

      if (result.has_more && result.next_offset != null) {
        await supabase.from('ingestion_tasks').insert({
          job_id: task.job_id,
          handle: task.handle,
          auth_user_id: task.auth_user_id,
          task_type: task.task_type,
          params: { ...task.params, offset: result.next_offset },
        });
        console.log(`[ingest-pipeline] Continuation: ${task.task_type} offset=${result.next_offset}`);
      }

      await updateCumulativeProgress(supabase, jobId);

      const elapsed = ((Date.now() - taskStart) / 1000).toFixed(1);
      console.log(
        `[ingest-pipeline] Task ${task.id} done in ${elapsed}s — ` +
        `${result.documents} docs, ${result.embeddings} embeddings`,
      );
    } catch (e) {
      const errMsg = (e as Error).message;
      console.error(`[ingest-pipeline] Task ${task.id} failed:`, errMsg);

      if (task.attempts >= MAX_TASK_ATTEMPTS) {
        await supabase.from('ingestion_tasks').update({
          status: 'failed',
          error_message: errMsg,
          completed_at: new Date().toISOString(),
        }).eq('id', task.id);
      } else {
        await supabase.from('ingestion_tasks').update({
          status: 'pending',
          started_at: null,
          error_message: errMsg,
        }).eq('id', task.id);
      }
    }

    chainNext(jobId, authHeader);

    return jsonResp({ job_id: jobId, task_id: task.id, status: 'processing' }, 200);
  } catch (e) {
    console.error('[ingest-pipeline] Request error:', (e as Error).message);
    return jsonResp({ error: 'internal', detail: (e as Error).message }, 500);
  }
});

// ── Job + Task Seeding ────────────────────────────────────────

async function createJobAndSeedTasks(
  supabase: SupabaseClient,
  body: Record<string, any>,
): Promise<{ jobId: string }> {
  let handle: string = body.handle ?? '';
  const mode: string = body.mode ?? 'full';
  const sources: string[] = body.sources ?? ['emails', 'calendar'];
  let authUserId: string | null = body.auth_user_id ?? null;

  if (!handle && !authUserId) throw new Error('missing handle or auth_user_id');

  if (authUserId && !handle) {
    handle = await resolveHandleFromAuthUserId(supabase, authUserId) ?? '';
    if (!handle) throw new Error(`No handle found for auth_user_id ${authUserId}`);
  }

  if (!authUserId) {
    authUserId = await resolveAuthUserId(supabase, handle);
    if (!authUserId) throw new Error(`No auth_user_id found for handle ${handle}`);
  }

  const googleAccounts = await getAllGoogleTokens(authUserId).catch(() => []);
  const msAccounts = await getMicrosoftAccounts(supabase, authUserId);

  const accountEmails = [
    ...googleAccounts.map((a) => a.email),
    ...msAccounts.map((a) => a.email),
  ].join(', ');

  const { data: job, error: jobErr } = await supabase
    .from('ingestion_jobs')
    .insert({
      handle,
      auth_user_id: authUserId,
      mode,
      sources_requested: sources,
      status: 'running',
      started_at: new Date().toISOString(),
      account_emails: accountEmails || null,
    })
    .select('id')
    .single();

  if (jobErr || !job) throw new Error(`Job creation failed: ${jobErr?.message}`);
  const jobId = job.id;

  const tasks: Array<Record<string, any>> = [];

  for (const acct of googleAccounts) {
    if (sources.includes('emails')) {
      tasks.push({
        job_id: jobId, handle, auth_user_id: authUserId,
        task_type: 'emails',
        params: { mode, account_email: acct.email, provider: 'google', offset: 0 },
      });
    }
    if (sources.includes('calendar')) {
      tasks.push({
        job_id: jobId, handle, auth_user_id: authUserId,
        task_type: 'calendar',
        params: { mode, account_email: acct.email, provider: 'google', offset: 0 },
      });
    }
  }

  for (const acct of msAccounts) {
    if (sources.includes('emails')) {
      tasks.push({
        job_id: jobId, handle, auth_user_id: authUserId,
        task_type: 'emails',
        params: { mode, account_email: acct.email, provider: 'microsoft', offset: 0 },
      });
    }
    if (sources.includes('calendar')) {
      tasks.push({
        job_id: jobId, handle, auth_user_id: authUserId,
        task_type: 'calendar',
        params: { mode, account_email: acct.email, provider: 'microsoft', offset: 0 },
      });
    }
  }

  if (sources.includes('transcript')) {
    tasks.push({
      job_id: jobId, handle, auth_user_id: authUserId,
      task_type: 'transcript',
      params: { mode },
    });
  }

  if (tasks.length > 0) {
    await supabase.from('ingestion_tasks').insert(tasks);
  }

  console.log(`[ingest-pipeline] Job ${jobId}: seeded ${tasks.length} tasks (${sources.join(', ')})`);
  return { jobId };
}

// ── Task Queue Operations ─────────────────────────────────────

async function recoverStaleTasks(supabase: SupabaseClient, jobId: string): Promise<void> {
  const threshold = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

  const { data: recovered } = await supabase
    .from('ingestion_tasks')
    .update({ status: 'pending', started_at: null })
    .eq('job_id', jobId)
    .eq('status', 'running')
    .lt('started_at', threshold)
    .lt('attempts', MAX_TASK_ATTEMPTS)
    .select('id');

  await supabase
    .from('ingestion_tasks')
    .update({ status: 'failed', error_message: 'Max attempts exceeded', completed_at: new Date().toISOString() })
    .eq('job_id', jobId)
    .eq('status', 'running')
    .lt('started_at', threshold)
    .gte('attempts', MAX_TASK_ATTEMPTS);

  if (recovered && recovered.length > 0) {
    console.log(`[ingest-pipeline] Recovered ${recovered.length} stale task(s)`);
  }
}

async function claimNextTask(supabase: SupabaseClient, jobId: string): Promise<TaskRow | null> {
  const { data: task } = await supabase
    .from('ingestion_tasks')
    .select('id, job_id, handle, auth_user_id, task_type, params, status, attempts')
    .eq('job_id', jobId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!task) return null;

  const newAttempts = (task.attempts ?? 0) + 1;
  await supabase.from('ingestion_tasks').update({
    status: 'running',
    started_at: new Date().toISOString(),
    attempts: newAttempts,
  }).eq('id', task.id);

  return { ...task, attempts: newAttempts };
}

// ── Task Execution Router ─────────────────────────────────────

async function executeTask(supabase: SupabaseClient, task: TaskRow): Promise<TaskResult> {
  switch (task.task_type) {
    case 'emails':
      return executeEmailsTask(supabase, task);
    case 'calendar':
      return executeCalendarTask(supabase, task);
    case 'transcript':
      console.log('[ingest-pipeline] Transcript task: placeholder (no-op)');
      return { documents: 0, chunks: 0, embeddings: 0, skipped: 0 };
    default:
      throw new Error(`Unknown task type: ${task.task_type}`);
  }
}

// ── Emails Task ───────────────────────────────────────────────

async function executeEmailsTask(
  supabase: SupabaseClient,
  task: TaskRow,
): Promise<TaskResult> {
  const { mode = 'full', account_email, provider, offset = 0 } = task.params;
  const handle = task.handle;
  const authUserId = task.auth_user_id;

  if (provider === 'microsoft') {
    return executeOutlookEmailsTask(supabase, handle, authUserId, account_email, mode, offset);
  }

  const tokenResult = await getGoogleAccessToken(authUserId, { email: account_email });
  const accessToken = tokenResult.accessToken;

  const daysBack = mode === 'incremental' ? 3 : 730;
  const maxThreads = mode === 'incremental' ? 50 : Infinity;

  const allIds = await listGmailThreadIds(accessToken, daysBack, maxThreads);
  const sliceIds = allIds.slice(offset, offset + EMAIL_PAGE_SIZE);

  console.log(`[ingest-pipeline] Gmail: ${account_email}, offset=${offset}, total=${allIds.length}, page=${sliceIds.length}`);

  const slice = await fetchGmailThreadsByIds(accessToken, sliceIds);

  const validThreads = slice.filter((t) => t.messages.length > 0);
  const emptyCount = slice.length - validThreads.length;

  const threadHashes = validThreads.map((t) => ({
    sourceId: t.threadId,
    contentHash: contentHash('email_summary', t.threadId, 'summary'),
  }));

  let threadsToProcess = validThreads;
  let skipped = emptyCount;

  if (mode === 'incremental') {
    const needsUpdate = await bulkCheckNeedsUpdate(supabase, handle, 'email_summary', threadHashes);
    threadsToProcess = validThreads.filter((t) => needsUpdate.has(t.threadId));
    skipped += validThreads.length - threadsToProcess.length;
  }

  const idsToDelete = threadsToProcess.map((t) => t.threadId);
  await Promise.all([
    bulkDeleteSources(supabase, handle, 'email_summary', idsToDelete),
    bulkDeleteSources(supabase, handle, 'email_chunk', idsToDelete),
  ]);

  const allChunks: ChunkToEmbed[] = [];
  let docCount = 0;

  for (const thread of threadsToProcess) {
    const hash = threadHashes.find((h) => h.sourceId === thread.threadId)!.contentHash;

    const contextHdr = emailContextHeader(thread.subject, thread.participants, thread.lastMessageDate);

    const summaryMessages = thread.messages.slice(-6).map((m) => ({
      from: m.from,
      body: m.bodyPlain,
      date: m.date,
    }));
    const summary = buildEmailSummary(summaryMessages);

    allChunks.push({
      text: truncateForEmbedding(`${contextHdr}\n---\n${summary}`),
      sourceType: 'email_summary',
      sourceId: thread.threadId,
      title: thread.subject,
      chunkIndex: 0,
      contentHash: hash,
      metadata: {
        participants: thread.participants.slice(0, 10),
        message_count: thread.messages.length,
        last_date: thread.lastMessageDate,
        account: account_email,
      },
    });

    const fullBody = thread.messages
      .map((m) => `From: ${m.from} (${m.date})\n${m.bodyPlain}`)
      .join('\n\n---\n\n');

    const chunks = sentenceAwareChunks(fullBody, contextHdr);
    for (let i = 0; i < chunks.length; i++) {
      allChunks.push({
        text: truncateForEmbedding(chunks[i]),
        sourceType: 'email_chunk',
        sourceId: thread.threadId,
        title: thread.subject,
        chunkIndex: i,
        contentHash: contentHash('email_chunk', thread.threadId, 'chunk', i),
        parentSourceId: thread.threadId,
        metadata: { participants: thread.participants.slice(0, 10), account: account_email },
      });
    }

    docCount++;
  }

  console.log(`[ingest-pipeline] Gmail page: ${allChunks.length} chunks from ${docCount} threads (${skipped} skipped)`);

  const embedded = await embedChunks(allChunks);
  const { inserted } = await insertEmbeddedChunks(supabase, handle, embedded);

  const nextOffset = offset + sliceIds.length;
  const hasMore = nextOffset < allIds.length;

  return {
    documents: docCount,
    chunks: allChunks.length,
    embeddings: inserted,
    skipped,
    has_more: hasMore,
    next_offset: hasMore ? nextOffset : undefined,
  };
}

async function executeOutlookEmailsTask(
  supabase: SupabaseClient,
  handle: string,
  authUserId: string,
  accountEmail: string,
  mode: string,
  offset: number,
): Promise<TaskResult> {
  const tokenResult = await getMicrosoftAccessToken(authUserId, { email: accountEmail });
  const accessToken = tokenResult.accessToken;

  const daysBack = mode === 'incremental' ? 3 : 730;
  const maxMessages = mode === 'incremental' ? 50 : 500;

  const threads = await fetchOutlookMessages(accessToken, daysBack, maxMessages);
  const slice = threads.slice(offset, offset + EMAIL_PAGE_SIZE);

  const validThreads = slice.filter((t) => t.messages.length > 0);
  const emptyCount = slice.length - validThreads.length;

  const threadHashes = validThreads.map((t) => ({
    sourceId: `ms:${t.threadId}`,
    contentHash: contentHash('email_summary', `ms:${t.threadId}`, 'summary'),
  }));

  let threadsToProcess = validThreads;
  let skipped = emptyCount;

  if (mode === 'incremental') {
    const needsUpdate = await bulkCheckNeedsUpdate(supabase, handle, 'email_summary', threadHashes);
    threadsToProcess = validThreads.filter((t) => needsUpdate.has(`ms:${t.threadId}`));
    skipped += validThreads.length - threadsToProcess.length;
  }

  const idsToDelete = threadsToProcess.map((t) => `ms:${t.threadId}`);
  await Promise.all([
    bulkDeleteSources(supabase, handle, 'email_summary', idsToDelete),
    bulkDeleteSources(supabase, handle, 'email_chunk', idsToDelete),
  ]);

  const allChunks: ChunkToEmbed[] = [];
  let docCount = 0;

  for (const thread of threadsToProcess) {
    const msId = `ms:${thread.threadId}`;
    const hash = threadHashes.find((h) => h.sourceId === msId)!.contentHash;

    const contextHdr = emailContextHeader(thread.subject, thread.participants, thread.lastMessageDate);
    const summary = buildEmailSummary(thread.messages.slice(-6));

    allChunks.push({
      text: truncateForEmbedding(`${contextHdr}\n---\n${summary}`),
      sourceType: 'email_summary',
      sourceId: msId,
      title: thread.subject,
      chunkIndex: 0,
      contentHash: hash,
      metadata: {
        participants: thread.participants.slice(0, 10),
        message_count: thread.messages.length,
        last_date: thread.lastMessageDate,
        account: accountEmail,
        provider: 'microsoft',
      },
    });

    const fullBody = thread.messages
      .map((m) => `From: ${m.from} (${m.date})\n${m.body}`)
      .join('\n\n---\n\n');

    const chunks = sentenceAwareChunks(fullBody, contextHdr);
    for (let i = 0; i < chunks.length; i++) {
      allChunks.push({
        text: truncateForEmbedding(chunks[i]),
        sourceType: 'email_chunk',
        sourceId: msId,
        title: thread.subject,
        chunkIndex: i,
        contentHash: contentHash('email_chunk', msId, 'chunk', i),
        parentSourceId: msId,
        metadata: { participants: thread.participants.slice(0, 10), account: accountEmail, provider: 'microsoft' },
      });
    }

    docCount++;
  }

  console.log(`[ingest-pipeline] Outlook page: ${allChunks.length} chunks from ${docCount} threads (${skipped} skipped)`);

  const embedded = await embedChunks(allChunks);
  const { inserted } = await insertEmbeddedChunks(supabase, handle, embedded);

  const nextOffset = offset + slice.length;
  const hasMore = nextOffset < threads.length;

  return {
    documents: docCount,
    chunks: allChunks.length,
    embeddings: inserted,
    skipped,
    has_more: hasMore,
    next_offset: hasMore ? nextOffset : undefined,
  };
}

// ── Calendar Task ─────────────────────────────────────────────

async function executeCalendarTask(
  supabase: SupabaseClient,
  task: TaskRow,
): Promise<TaskResult> {
  const { mode = 'full', account_email, provider, offset = 0 } = task.params;
  const handle = task.handle;
  const authUserId = task.auth_user_id;

  const daysBack = mode === 'incremental' ? 7 : 730;
  const daysForward = mode === 'incremental' ? 60 : 365;

  let events: CalendarEvent[];

  if (provider === 'microsoft') {
    const tokenResult = await getMicrosoftAccessToken(authUserId, { email: account_email });
    events = await fetchOutlookCalendarEvents(tokenResult.accessToken, daysBack, daysForward);
  } else {
    const tokenResult = await getGoogleAccessToken(authUserId, { email: account_email });
    const primaryOnly = mode === 'full';
    events = await fetchGoogleCalendarEvents(tokenResult.accessToken, daysBack, daysForward, primaryOnly);
  }

  const slice = events.slice(offset, offset + CALENDAR_PAGE_SIZE);

  console.log(`[ingest-pipeline] Calendar: ${account_email} (${provider}), offset=${offset}, total=${events.length}, page=${slice.length}`);

  const eventHashes = slice.map((e) => ({
    sourceId: e.eventId,
    contentHash: contentHash('calendar_summary', e.eventId, 'summary'),
  }));

  const needsUpdate = await bulkCheckNeedsUpdate(supabase, handle, 'calendar_summary', eventHashes);
  const eventsToProcess = slice.filter((e) => needsUpdate.has(e.eventId));
  const skipped = slice.length - eventsToProcess.length;

  const idsToDelete = eventsToProcess.map((e) => e.eventId);
  await Promise.all([
    bulkDeleteSources(supabase, handle, 'calendar_summary', idsToDelete),
    bulkDeleteSources(supabase, handle, 'calendar_chunk', idsToDelete),
  ]);

  const allChunks: ChunkToEmbed[] = [];
  let totalDocs = 0;

  for (const event of eventsToProcess) {
    const hash = eventHashes.find((h) => h.sourceId === event.eventId)!.contentHash;
    const summary = buildCalendarSummary(event);

    allChunks.push({
      text: truncateForEmbedding(summary),
      sourceType: 'calendar_summary',
      sourceId: event.eventId,
      title: event.title,
      chunkIndex: 0,
      contentHash: hash,
      metadata: {
        start: event.start,
        end: event.end,
        attendees: event.attendees,
        organiser: event.organiser,
        location: event.location,
        meeting_link: event.meetingLink,
        calendar_id: event.calendarId,
        account: account_email,
        provider,
      },
    });

    if (event.description && event.description.trim().length > 20) {
      allChunks.push({
        text: truncateForEmbedding(
          `Calendar Event: ${event.title}\nWhen: ${event.start} to ${event.end}\n` +
          `Attendees: ${event.attendees}\nDescription: ${event.description}`,
        ),
        sourceType: 'calendar_chunk',
        sourceId: event.eventId,
        title: event.title,
        chunkIndex: 1,
        contentHash: contentHash('calendar_chunk', event.eventId, 'chunk', 0),
        parentSourceId: event.eventId,
        metadata: { start: event.start, end: event.end, account: account_email, provider },
      });
    }

    totalDocs++;
  }

  const SUB_BATCH = 25;
  let totalChunks = 0;
  let totalEmbeddings = 0;

  for (let i = 0; i < allChunks.length; i += SUB_BATCH) {
    const batch = allChunks.slice(i, i + SUB_BATCH);
    const embedded = await embedChunks(batch);
    const { inserted } = await insertEmbeddedChunks(supabase, handle, embedded);
    totalChunks += batch.length;
    totalEmbeddings += inserted;
  }

  const nextOffset = offset + slice.length;
  const hasMore = nextOffset < events.length;

  console.log(
    `[ingest-pipeline] Calendar page: ${totalChunks} chunks from ${totalDocs} events ` +
    `(${offset}->${nextOffset}/${events.length}${hasMore ? ', more pages' : ''})`,
  );

  return {
    documents: totalDocs,
    chunks: totalChunks,
    embeddings: totalEmbeddings,
    skipped,
    has_more: hasMore,
    next_offset: hasMore ? nextOffset : undefined,
  };
}

// ── Handle -> auth_user_id resolution ─────────────────────────

async function resolveAuthUserId(supabase: SupabaseClient, handle: string): Promise<string | null> {
  const { data } = await supabase
    .from('user_profiles')
    .select('auth_user_id')
    .eq('handle', handle)
    .not('auth_user_id', 'is', null)
    .maybeSingle();

  return data?.auth_user_id ?? null;
}

async function resolveHandleFromAuthUserId(supabase: SupabaseClient, authUserId: string): Promise<string | null> {
  const { data } = await supabase
    .from('user_profiles')
    .select('handle')
    .eq('auth_user_id', authUserId)
    .maybeSingle();

  return data?.handle ?? null;
}

async function getMicrosoftAccounts(
  supabase: SupabaseClient,
  authUserId: string,
): Promise<Array<{ id: string; email: string }>> {
  const { data } = await supabase
    .from('user_microsoft_accounts')
    .select('id, microsoft_email')
    .eq('user_id', authUserId);

  return (data ?? []).map((a: any) => ({ id: a.id, email: a.microsoft_email }));
}

// ── Progress + Finalisation ───────────────────────────────────

async function updateCumulativeProgress(supabase: SupabaseClient, jobId: string): Promise<void> {
  const { data: tasks } = await supabase
    .from('ingestion_tasks')
    .select('task_type, status, result')
    .eq('job_id', jobId);

  let docs = 0, chunks = 0, emb = 0;
  const progress: Record<string, { documents: number; chunks: number; embeddings: number }> = {};

  for (const t of tasks ?? []) {
    if (t.status !== 'completed' || !t.result) continue;
    docs += t.result.documents ?? 0;
    chunks += t.result.chunks ?? 0;
    emb += t.result.embeddings ?? 0;
    if (!progress[t.task_type]) progress[t.task_type] = { documents: 0, chunks: 0, embeddings: 0 };
    progress[t.task_type].documents += t.result.documents ?? 0;
    progress[t.task_type].chunks += t.result.chunks ?? 0;
    progress[t.task_type].embeddings += t.result.embeddings ?? 0;
  }

  await supabase.from('ingestion_jobs').update({
    progress,
    total_documents: docs,
    total_chunks: chunks,
    total_embeddings: emb,
  }).eq('id', jobId);
}

async function finaliseJob(supabase: SupabaseClient, jobId: string): Promise<void> {
  await updateCumulativeProgress(supabase, jobId);

  const { data: failed } = await supabase
    .from('ingestion_tasks')
    .select('id')
    .eq('job_id', jobId)
    .eq('status', 'failed');

  const failCount = failed?.length ?? 0;

  await supabase.from('ingestion_jobs').update({
    status: 'completed',
    error_message: failCount > 0 ? `${failCount} task(s) failed` : null,
    completed_at: new Date().toISOString(),
  }).eq('id', jobId);

  console.log(`[ingest-pipeline] Job ${jobId} finalised${failCount > 0 ? ` (${failCount} failed)` : ''}`);
}

// ── Chaining ──────────────────────────────────────────────────

function chainNext(jobId: string, authHeader: string): void {
  const doChain = () =>
    fetch(`${supabaseUrl}/functions/v1/ingest-pipeline`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId }),
    });

  doChain().catch(() => {
    setTimeout(() => {
      doChain().catch((e) => console.warn('[ingest-pipeline] Chain retry failed:', (e as Error).message));
    }, 2000);
  });
}

// ── Utilities ─────────────────────────────────────────────────

function isServiceRoleToken(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(atob(parts[1]));
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

function jsonResp(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
