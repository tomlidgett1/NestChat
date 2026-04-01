import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getAdminClient } from '../_shared/supabase.ts';
import { generateBrandPrompt } from '../_shared/brand-prompt-generator.ts';

const JOB_TABLE = 'nest_brand_onboard_jobs';
const CONFIG_TABLE = 'nest_brand_chat_config';

const MAX_CONTENT_CHARS = 60_000;

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

function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;

  const cut = content.slice(0, maxChars);
  const lastPageBreak = cut.lastIndexOf('\n---\n#');
  const breakPoint = lastPageBreak > maxChars * 0.5 ? lastPageBreak : maxChars;

  console.log(`[brand-generate] Truncated scraped content: ${content.length} → ${breakPoint} chars (${((1 - breakPoint / content.length) * 100).toFixed(0)}% removed)`);
  return content.slice(0, breakPoint);
}

async function runGeneration(jobId: string): Promise<void> {
  const supabase = getAdminClient();
  const phaseStart = Date.now();

  console.log(`[brand-generate] ╔══════════════════════════════════════════╗`);
  console.log(`[brand-generate] ║  PROMPT GENERATION (background)          ║`);
  console.log(`[brand-generate] ╚══════════════════════════════════════════╝`);
  console.log(`[brand-generate]   Job: ${jobId}`);

  const { data: job, error: fetchErr } = await supabase
    .from(JOB_TABLE)
    .select('brand_key, business_name, scraped_content, status')
    .eq('id', jobId)
    .single();

  if (fetchErr || !job) {
    console.error(`[brand-generate]   Job fetch failed: ${fetchErr?.message ?? 'not found'}`);
    return;
  }

  console.log(`[brand-generate]   Brand:    ${job.brand_key}`);
  console.log(`[brand-generate]   Business: ${job.business_name}`);
  console.log(`[brand-generate]   Status:   ${job.status}`);
  console.log(`[brand-generate]   Scraped:  ${job.scraped_content ? `${(job.scraped_content.length / 1024).toFixed(1)}KB` : 'EMPTY'}`);

  if (job.status === 'complete') {
    console.log(`[brand-generate]   Already complete — skipping`);
    return;
  }

  if (!job.scraped_content || job.scraped_content.length < 100) {
    const msg = `No scraped content available (${job.scraped_content?.length ?? 0} chars)`;
    console.error(`[brand-generate]   ✗ ${msg}`);
    await supabase
      .from(JOB_TABLE)
      .update({ status: 'failed', error: msg, updated_at: new Date().toISOString() })
      .eq('id', jobId);
    return;
  }

  try {
    await supabase
      .from(JOB_TABLE)
      .update({ status: 'generating_prompt', updated_at: new Date().toISOString() })
      .eq('id', jobId);

    const trimmedContent = truncateContent(job.scraped_content, MAX_CONTENT_CHARS);
    console.log(`[brand-generate]   Content for GPT: ${(trimmedContent.length / 1024).toFixed(1)}KB`);
    console.log(`[brand-generate]   Calling GPT-5.2 reasoning medium + web search...`);

    const result = await generateBrandPrompt(trimmedContent, job.business_name);

    console.log(`[brand-generate]   Prompt: ${result.prompt.length} chars, ${result.prompt.split('\n').length} lines`);
    console.log(`[brand-generate]   AI cost: $${result.cost.total_cost_usd.toFixed(4)}`);
    console.log(`[brand-generate]   Saving to nest_brand_chat_config...`);

    const { error: updateErr } = await supabase
      .from(CONFIG_TABLE)
      .update({
        core_system_prompt: result.prompt,
        updated_at: new Date().toISOString(),
      })
      .eq('brand_key', job.brand_key);

    if (updateErr) {
      throw new Error(`DB save failed: ${updateErr.message}`);
    }
    console.log(`[brand-generate]   ✓ Prompt saved`);

    await supabase
      .from(JOB_TABLE)
      .update({
        status: 'complete',
        ai_cost: result.cost,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    const phaseMs = ((Date.now() - phaseStart) / 1000).toFixed(1);
    console.log(`[brand-generate] ════════════════════════════════════════════`);
    console.log(`[brand-generate] ✓ ${job.business_name} is LIVE!`);
    console.log(`[brand-generate]   Trigger: "Hey ${job.brand_key.charAt(0).toUpperCase() + job.brand_key.slice(1)}"`);
    console.log(`[brand-generate]   Duration: ${phaseMs}s`);
    console.log(`[brand-generate] ════════════════════════════════════════════`);
  } catch (err) {
    const message = (err as Error).message || 'Unknown error';
    const phaseMs = ((Date.now() - phaseStart) / 1000).toFixed(1);
    console.error(`[brand-generate] ✗ FAILED after ${phaseMs}s: ${message}`);
    console.error(`[brand-generate]   Stack: ${(err as Error).stack || 'no stack'}`);

    await supabase
      .from(JOB_TABLE)
      .update({ status: 'failed', error: `Prompt generation failed: ${message}`, updated_at: new Date().toISOString() })
      .eq('id', jobId);
  }
}

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

  const jobId = String(body.jobId ?? '');
  if (!jobId) return jsonResponse({ error: 'jobId is required' }, 400);

  const supabase = getAdminClient();

  const { data: job } = await supabase
    .from(JOB_TABLE)
    .select('status')
    .eq('id', jobId)
    .single();

  if (!job) return jsonResponse({ error: 'Job not found' }, 404);
  if (job.status === 'complete') return jsonResponse({ ok: true, status: 'complete' });

  console.log(`[brand-generate] Accepted job ${jobId} — running generation in background`);

  // Respond immediately, run the heavy OpenAI work in the background (up to 400s wall time)
  EdgeRuntime.waitUntil(runGeneration(jobId));

  return jsonResponse({ ok: true, status: 'generating_prompt', message: 'Generation started in background' });
});
