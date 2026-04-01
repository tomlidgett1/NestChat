import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getAdminClient } from '../_shared/supabase.ts';
import { internalJsonHeaders } from '../_shared/internal-auth.ts';
import { scrapeWebsite, type CrawlState, type ScrapedImage, type CheckpointCallback } from '../_shared/brand-scraper.ts';

const JOB_TABLE = 'nest_brand_onboard_jobs';
const CONFIG_TABLE = 'nest_brand_chat_config';
const SECRETS_TABLE = 'nest_brand_portal_secrets';
const SESSIONS_TABLE = 'nest_brand_portal_sessions';
const SESSION_DAYS = 7;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)[0]
    .substring(0, 20);
}

async function ensureUniqueBrandKey(baseKey: string): Promise<string> {
  const supabase = getAdminClient();
  let candidate = baseKey;
  let attempt = 0;

  while (attempt < 50) {
    const { data } = await supabase
      .from(CONFIG_TABLE)
      .select('brand_key')
      .eq('brand_key', candidate)
      .maybeSingle();

    if (!data) return candidate;
    attempt++;
    candidate = `${baseKey}${attempt}`;
  }

  throw new Error('Could not generate unique brand key');
}

// ═══════════════════════════════════════════════════════════════
// No server-side chaining — the frontend drives each phase.
// Each phase is an independent browser request.

// ═══════════════════════════════════════════════════════════════
// start — create records, return immediately, frontend fires _scrape
// ═══════════════════════════════════════════════════════════════

async function handleStart(payload: { businessName: string; websiteUrl: string }): Promise<Response> {
  const { businessName, websiteUrl } = payload;

  if (!businessName?.trim()) {
    return jsonResponse({ error: 'Business name is required' }, 400);
  }
  if (!websiteUrl?.trim()) {
    return jsonResponse({ error: 'Website URL is required' }, 400);
  }

  let url = websiteUrl.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`;
  }

  const baseKey = slugify(businessName);
  if (!baseKey) {
    return jsonResponse({ error: 'Could not generate a brand key from the business name' }, 400);
  }

  const brandKey = await ensureUniqueBrandKey(baseKey);
  const supabase = getAdminClient();

  console.log(`[brand-onboard] START`);
  console.log(`[brand-onboard]   Business: ${businessName.trim()}`);
  console.log(`[brand-onboard]   URL:      ${url}`);
  console.log(`[brand-onboard]   Brand:    ${brandKey}`);

  const { data: job, error: jobErr } = await supabase
    .from(JOB_TABLE)
    .insert({
      brand_key: brandKey,
      business_name: businessName.trim(),
      website_url: url,
      status: 'pending',
    })
    .select('id')
    .single();

  if (jobErr || !job?.id) {
    console.error('[brand-onboard] job insert failed:', jobErr?.message);
    return jsonResponse({ error: 'Could not create onboarding job' }, 500);
  }

  await supabase
    .from(CONFIG_TABLE)
    .upsert({
      brand_key: brandKey,
      business_display_name: businessName.trim(),
    }, { onConflict: 'brand_key' });

  await supabase
    .from(SECRETS_TABLE)
    .upsert({
      brand_key: brandKey,
      portal_password: brandKey,
    }, { onConflict: 'brand_key' });

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_DAYS);

  const { data: session } = await supabase
    .from(SESSIONS_TABLE)
    .insert({ brand_key: brandKey, expires_at: expiresAt.toISOString() })
    .select('id')
    .single();

  console.log(`[brand-onboard]   Job:     ${job.id}`);
  console.log(`[brand-onboard]   Session: ${session?.id ?? 'none'}`);
  console.log(`[brand-onboard]   ✓ Records created — returning to client`);

  return jsonResponse({
    ok: true,
    jobId: job.id,
    brandKey,
    sessionToken: session?.id ?? null,
  });
}

// ═══════════════════════════════════════════════════════════════
// _scrape — chunked scraper with automatic self-chaining.
// Each invocation scrapes for ~3 minutes. If pages remain,
// it saves crawl state and fires another invocation of itself.
// The frontend just polls status and sees progress climbing.
// ═══════════════════════════════════════════════════════════════

const IMAGES_TABLE = 'nest_brand_images';
const IMG_BATCH_SIZE = 500;

async function insertImageBatch(
  supabase: ReturnType<typeof getAdminClient>,
  brandKey: string,
  images: Array<{ url: string; alt: string; pageUrl: string; pageTitle: string }>,
): Promise<number> {
  if (images.length === 0) return 0;
  const rows = images.map(img => ({
    brand_key: brandKey,
    url: img.url,
    alt: img.alt,
    page_title: img.pageTitle,
    page_url: img.pageUrl,
  }));

  let inserted = 0;
  for (let i = 0; i < rows.length; i += IMG_BATCH_SIZE) {
    const batch = rows.slice(i, i + IMG_BATCH_SIZE);
    const { error } = await supabase.from(IMAGES_TABLE).insert(batch);
    if (error) {
      console.error(`[brand-onboard]   Image batch ${i}-${i + batch.length} failed: ${error.message}`);
    } else {
      inserted += batch.length;
    }
  }
  return inserted;
}

function selfInvokeScrape(jobId: string): void {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const url = `${supabaseUrl}/functions/v1/brand-onboard`;

  console.log(`[brand-onboard]   Self-invoking _scrape for next chunk...`);
  fetch(url, {
    method: 'POST',
    headers: internalJsonHeaders(),
    body: JSON.stringify({ action: '_scrape', jobId }),
  }).catch(err => {
    console.error(`[brand-onboard]   Self-invoke failed: ${(err as Error).message}`);
  });
}

async function handleScrape(payload: { jobId: string }): Promise<Response> {
  const { jobId } = payload;
  if (!jobId) return jsonResponse({ error: 'jobId is required' }, 400);

  const supabase = getAdminClient();
  const phaseStart = Date.now();

  console.log(`[brand-onboard] ╔══════════════════════════════════════════╗`);
  console.log(`[brand-onboard] ║  PHASE 1: WEBSITE SCRAPING               ║`);
  console.log(`[brand-onboard] ╚══════════════════════════════════════════╝`);
  console.log(`[brand-onboard]   Job: ${jobId}`);

  const { data: job } = await supabase
    .from(JOB_TABLE)
    .select('*')
    .eq('id', jobId)
    .single();

  if (!job) {
    console.error(`[brand-onboard]   Job not found`);
    return jsonResponse({ error: 'Job not found' }, 404);
  }

  if (job.status === 'complete') {
    console.log(`[brand-onboard]   Already complete — skipping`);
    return jsonResponse({ ok: true, status: 'complete' });
  }

  const existingCrawlState = job.crawl_state as CrawlState | null;
  const isFirstChunk = !existingCrawlState;

  console.log(`[brand-onboard]   Brand:    ${job.brand_key}`);
  console.log(`[brand-onboard]   Business: ${job.business_name}`);
  console.log(`[brand-onboard]   URL:      ${job.website_url}`);
  console.log(`[brand-onboard]   Status:   ${job.status}`);
  console.log(`[brand-onboard]   Chunk:    ${isFirstChunk ? 'first' : `resume #${existingCrawlState!.chunkIndex}`}`);

  try {
    await supabase
      .from(JOB_TABLE)
      .update({ status: 'scraping', updated_at: new Date().toISOString() })
      .eq('id', jobId);

    if (isFirstChunk) {
      await supabase.from(IMAGES_TABLE).delete().eq('brand_key', job.brand_key);
      console.log(`[brand-onboard]   Cleared existing images for fresh scrape`);
    }

    let accumulatedContent = job.scraped_content || '';

    const onCheckpoint: CheckpointCallback = async (
      cpState: CrawlState,
      chunkMarkdown: string,
      chunkImages: ScrapedImage[],
    ) => {
      accumulatedContent = isFirstChunk && !accumulatedContent
        ? chunkMarkdown
        : accumulatedContent + chunkMarkdown;

      if (chunkImages.length > 0) {
        const count = await insertImageBatch(supabase, job.brand_key, chunkImages);
        console.log(`[brand-onboard]   Checkpoint: saved ${count} images`);
      }

      await supabase
        .from(JOB_TABLE)
        .update({
          scraped_content: accumulatedContent,
          crawl_state: cpState,
          pages_scraped: cpState.totalPagesScraped,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);
      console.log(`[brand-onboard]   Checkpoint: saved crawl state (${cpState.totalPagesScraped} pages)`);
    };

    const result = await scrapeWebsite(
      job.website_url,
      job.business_name,
      jobId,
      existingCrawlState ?? undefined,
      onCheckpoint,
    );

    console.log(`[brand-onboard]   Chunk result:`);
    console.log(`[brand-onboard]     This chunk:    ${result.pagesScrapedThisChunk} pages, ${result.images.length} images`);
    console.log(`[brand-onboard]     Total visited: ${result.totalPagesVisited}`);
    console.log(`[brand-onboard]     Total scraped: ${result.totalPagesScraped}`);
    console.log(`[brand-onboard]     Total failed:  ${result.totalPagesFailed}`);
    console.log(`[brand-onboard]     Needs resume:  ${result.needsResume}`);

    if (result.images.length > 0) {
      const count = await insertImageBatch(supabase, job.brand_key, result.images);
      console.log(`[brand-onboard]   Saved ${count} images this chunk`);
    }

    const updatedContent = accumulatedContent + result.markdown;

    if (result.needsResume) {
      await supabase
        .from(JOB_TABLE)
        .update({
          scraped_content: updatedContent,
          crawl_state: result.resumeState,
          pages_scraped: result.totalPagesScraped,
          pages_found: result.totalPagesVisited,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);

      const phaseMs = ((Date.now() - phaseStart) / 1000).toFixed(1);
      console.log(`[brand-onboard]   Chunk done in ${phaseMs}s — chaining next chunk`);

      selfInvokeScrape(jobId);

      return jsonResponse({
        ok: true,
        status: 'scraping',
        pagesScraped: result.totalPagesScraped,
        pagesVisited: result.totalPagesVisited,
      });
    }

    const finalMarkdown = `# ${job.business_name}\n\nPages: ${result.totalPagesScraped} scraped / ${result.totalPagesVisited} visited / ${result.totalPagesFailed} failed\n${updatedContent}`;

    await supabase
      .from(JOB_TABLE)
      .update({
        status: 'generating_prompt',
        scraped_content: finalMarkdown,
        crawl_state: null,
        pages_scraped: result.totalPagesScraped,
        pages_found: result.totalPagesVisited,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    const phaseMs = ((Date.now() - phaseStart) / 1000).toFixed(1);
    console.log(`[brand-onboard]   Phase 1 complete in ${phaseMs}s — frontend will trigger Phase 2`);

    return jsonResponse({
      ok: true,
      status: 'generating_prompt',
      pagesScraped: result.totalPagesScraped,
    });
  } catch (err) {
    const message = (err as Error).message || 'Unknown error';
    const phaseMs = ((Date.now() - phaseStart) / 1000).toFixed(1);
    console.error(`[brand-onboard] ✗ Phase 1 FAILED after ${phaseMs}s: ${message}`);
    console.error(`[brand-onboard]   Stack: ${(err as Error).stack || 'no stack'}`);

    await supabase
      .from(JOB_TABLE)
      .update({
        status: 'failed',
        error: `Scraping failed: ${message}`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    return jsonResponse({ error: message }, 500);
  }
}

// ═══════════════════════════════════════════════════════════════
// status — lightweight DB read, returns current job state
// ═══════════════════════════════════════════════════════════════

async function handleStatus(payload: { jobId: string }): Promise<Response> {
  const { jobId } = payload;
  if (!jobId) return jsonResponse({ error: 'jobId is required' }, 400);

  const supabase = getAdminClient();
  const { data: job, error } = await supabase
    .from(JOB_TABLE)
    .select('id, brand_key, business_name, website_url, status, pages_found, pages_scraped, error, ai_cost, created_at, updated_at')
    .eq('id', jobId)
    .single();

  if (error || !job) return jsonResponse({ error: 'Job not found' }, 404);

  return jsonResponse({
    ok: true,
    job: {
      id: job.id,
      brandKey: job.brand_key,
      businessName: job.business_name,
      websiteUrl: job.website_url,
      status: job.status,
      pagesFound: job.pages_found,
      pagesScraped: job.pages_scraped,
      error: job.error,
      aiCost: job.ai_cost,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    },
  });
}

// ═══════════════════════════════════════════════════════════════
// retry — restart from the appropriate phase
// ═══════════════════════════════════════════════════════════════

async function handleRetry(payload: { jobId: string }): Promise<Response> {
  const { jobId } = payload;
  if (!jobId) return jsonResponse({ error: 'jobId is required' }, 400);

  const supabase = getAdminClient();
  const { data: job } = await supabase
    .from(JOB_TABLE)
    .select('*')
    .eq('id', jobId)
    .single();

  if (!job) return jsonResponse({ error: 'Job not found' }, 404);
  if (job.status === 'complete') return jsonResponse({ ok: true, status: 'complete' });
  if (job.status === 'scraping' || job.status === 'generating_prompt') {
    return jsonResponse({ ok: true, status: job.status, message: 'Already in progress' });
  }

  const hasContent = (job.scraped_content?.length ?? 0) > 100;
  const retryPhase = hasContent ? 'generating_prompt' : 'scraping';
  console.log(`[brand-onboard] Retry for job ${jobId}, has content: ${hasContent}, retry phase: ${retryPhase}`);

  await supabase
    .from(JOB_TABLE)
    .update({
      status: retryPhase,
      error: null,
      crawl_state: retryPhase === 'scraping' ? null : job.crawl_state,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  return jsonResponse({ ok: true, status: retryPhase, message: 'Retrying — frontend should fire the appropriate phase' });
}

// ═══════════════════════════════════════════════════════════════
// brand_info — public endpoint for the PLG demo page
// ═══════════════════════════════════════════════════════════════

async function handleBrandInfo(payload: { brandKey: string }): Promise<Response> {
  const { brandKey } = payload;
  if (!brandKey) return jsonResponse({ error: 'brandKey is required' }, 400);

  const supabase = getAdminClient();
  const { data: config } = await supabase
    .from(CONFIG_TABLE)
    .select('brand_key, business_display_name')
    .eq('brand_key', brandKey.toLowerCase())
    .single();

  if (!config) {
    const { data: job } = await supabase
      .from(JOB_TABLE)
      .select('brand_key, business_name')
      .eq('brand_key', brandKey.toLowerCase())
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!job) return jsonResponse({ error: 'Brand not found' }, 404);

    return jsonResponse({
      ok: true,
      brand: {
        brandKey: job.brand_key,
        businessName: job.business_name,
      },
    });
  }

  return jsonResponse({
    ok: true,
    brand: {
      brandKey: config.brand_key,
      businessName: config.business_display_name || brandKey,
    },
  });
}

// ═══════════════════════════════════════════════════════════════
// HTTP router
// ═══════════════════════════════════════════════════════════════

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const action = String(body.action ?? '');
  console.log(`[brand-onboard] → ${action}`);

  switch (action) {
    case 'start':
      return handleStart(body as { businessName: string; websiteUrl: string });
    case 'status':
      return handleStatus(body as { jobId: string });
    case 'retry':
      return handleRetry(body as { jobId: string });
    case '_scrape':
      return handleScrape(body as { jobId: string });
    case 'brand_info':
      return handleBrandInfo(body as { brandKey: string });
    default:
      return jsonResponse({ error: `Unknown action: ${action}` }, 400);
  }
});
