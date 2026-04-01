/**
 * Brand admin API — same contract as website/api/admin-brands.ts (Vercel).
 * Serves Nest admin iframe at /admin/brands and local tooling on one origin.
 */
import type { Request, Response } from 'express';
import { internalEdgeJsonHeaders } from '../lib/internal-edge-auth.js';
import { normaliseInternalAdminPhoneList } from '../lib/phone-e164.js';
import { getSupabase } from '../lib/supabase.js';
import type { SupabaseClient } from '@supabase/supabase-js';

function pickEnv(names: string[]): string | undefined {
  for (const name of names) {
    const v = process.env[name];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

function getSupabaseAdmin(): SupabaseClient {
  return getSupabase();
}

const PATCHABLE = new Set([
  'activation_aliases',
  'core_system_prompt',
  'business_display_name',
  'opening_line',
  'hours_text',
  'prices_text',
  'services_products_text',
  'policies_text',
  'contact_text',
  'booking_info_text',
  'extra_knowledge',
  'style_template',
  'style_notes',
  'topics_to_avoid',
  'escalation_text',
  'internal_admin_phone_e164s',
]);

function normaliseBrandKey(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (s.length < 2 || s.length > 32) return null;
  return s;
}

function normaliseAliases(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    const t = String(x ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    if (t.length < 2 || t.length > 24) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.slice(0, 12);
}

/** GET/POST/PATCH /api/admin-brands */
export async function handleAdminBrands(req: Request, res: Response): Promise<void> {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.status(204).end();
    return;
  }

  let supabase: SupabaseClient;
  try {
    supabase = getSupabaseAdmin();
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Server missing Supabase configuration' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const brandKey = typeof req.query.brandKey === 'string' ? req.query.brandKey.trim().toLowerCase() : '';
      const list = req.query.list === '1' || req.query.list === 'true';

      if (list) {
        const { data: configs, error } = await supabase
          .from('nest_brand_chat_config')
          .select('brand_key, business_display_name, activation_aliases, updated_at, core_system_prompt')
          .order('business_display_name', { ascending: true });

        if (error) {
          res.status(500).json({ error: error.message });
          return;
        }

        const rows = (configs ?? []).map((c) => ({
          brand_key: c.brand_key,
          business_display_name: c.business_display_name,
          activation_aliases: c.activation_aliases ?? [],
          updated_at: c.updated_at,
          prompt_chars: String(c.core_system_prompt ?? '').length,
          has_prompt: String(c.core_system_prompt ?? '').trim().length > 0,
        }));

        const { data: jobs } = await supabase
          .from('nest_brand_onboard_jobs')
          .select('brand_key, status, pages_scraped, error, updated_at')
          .order('updated_at', { ascending: false });

        const latestJobByBrand = new Map<string, { status: string; pages_scraped: number; error: string | null }>();
        for (const j of jobs ?? []) {
          if (!latestJobByBrand.has(j.brand_key)) {
            latestJobByBrand.set(j.brand_key, {
              status: j.status,
              pages_scraped: j.pages_scraped,
              error: j.error,
            });
          }
        }

        res.status(200).json({
          brands: rows.map((r) => ({
            ...r,
            last_job: latestJobByBrand.get(r.brand_key) ?? null,
          })),
        });
        return;
      }

      if (!brandKey) {
        res.status(400).json({ error: 'brandKey query param required (or list=1)' });
        return;
      }

      const { data: config, error } = await supabase.from('nest_brand_chat_config').select('*').eq('brand_key', brandKey).maybeSingle();

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      if (!config) {
        res.status(404).json({ error: 'Brand not found' });
        return;
      }

      const { data: secretRow } = await supabase
        .from('nest_brand_portal_secrets')
        .select('brand_key')
        .eq('brand_key', brandKey)
        .maybeSingle();

      const { data: recentJobs } = await supabase
        .from('nest_brand_onboard_jobs')
        .select('id, status, website_url, pages_scraped, pages_found, error, created_at, updated_at')
        .eq('brand_key', brandKey)
        .order('created_at', { ascending: false })
        .limit(5);

      res.status(200).json({
        brand: config,
        has_portal_secret: Boolean(secretRow),
        recent_jobs: recentJobs ?? [],
      });
      return;
    }

    if (req.method === 'PATCH') {
      const body = req.body as Record<string, unknown>;
      if (!body || typeof body !== 'object') {
        res.status(400).json({ error: 'Invalid JSON' });
        return;
      }

      const bk = typeof body.brandKey === 'string' ? body.brandKey.trim().toLowerCase() : '';
      if (!bk) {
        res.status(400).json({ error: 'brandKey is required' });
        return;
      }

      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) {
        if (k === 'brandKey') continue;
        if (!PATCHABLE.has(k)) continue;
        if (k === 'activation_aliases') {
          patch[k] = normaliseAliases(v).filter((a) => a !== bk);
        } else if (k === 'internal_admin_phone_e164s') {
          patch[k] = normaliseInternalAdminPhoneList(v);
        } else {
          patch[k] = v;
        }
      }

      if (Object.keys(patch).length <= 1) {
        res.status(400).json({ error: 'No valid fields to update' });
        return;
      }

      const { error } = await supabase.from('nest_brand_chat_config').update(patch).eq('brand_key', bk);

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body as Record<string, unknown>;
      if (!body || typeof body !== 'object') {
        res.status(400).json({ error: 'Invalid JSON' });
        return;
      }

      const action = String(body.action ?? 'create');
      const brandKey = normaliseBrandKey(String(body.brandKey ?? ''));
      const businessDisplayName = String(body.businessDisplayName ?? '').trim();
      let websiteUrlRaw = String(body.websiteUrl ?? '').trim();
      const portalPassword = String(body.portalPassword ?? '').trim() || brandKey || '';
      const activationAliases = normaliseAliases(body.activationAliases).filter((a) => a !== brandKey);

      if (!brandKey || !businessDisplayName) {
        res.status(400).json({ error: 'brandKey and businessDisplayName are required' });
        return;
      }

      let url = websiteUrlRaw;
      if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
        url = `https://${url}`;
      }

      const { error: cfgErr } = await supabase.from('nest_brand_chat_config').upsert(
        {
          brand_key: brandKey,
          business_display_name: businessDisplayName,
          activation_aliases: activationAliases,
        },
        { onConflict: 'brand_key' },
      );

      if (cfgErr) {
        res.status(500).json({ error: cfgErr.message });
        return;
      }

      const { error: secErr } = await supabase.from('nest_brand_portal_secrets').upsert(
        { brand_key: brandKey, portal_password: portalPassword },
        { onConflict: 'brand_key' },
      );

      if (secErr) {
        res.status(500).json({ error: secErr.message });
        return;
      }

      if (action === 'create') {
        res.status(200).json({ ok: true, brandKey, message: 'Brand created. Add a system prompt or run website onboarding.' });
        return;
      }

      if (action === 'trigger_generate') {
        const jobId = String(body.jobId ?? '').trim();
        if (!jobId) {
          res.status(400).json({ error: 'jobId is required' });
          return;
        }

        const supabaseUrl = pickEnv(['SUPABASE_URL', 'VITE_SUPABASE_URL']);
        if (!supabaseUrl) {
          res.status(500).json({ error: 'Missing service configuration' });
          return;
        }

        const generateUrl = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/brand-generate`;
        const genRes = await fetch(generateUrl, {
          method: 'POST',
          headers: internalEdgeJsonHeaders(),
          body: JSON.stringify({ jobId }),
        });
        const genJson = (await genRes.json().catch(() => ({}))) as Record<string, unknown>;
        if (!genRes.ok) {
          res.status(502).json({ error: 'brand-generate call failed', detail: genJson });
          return;
        }

        res.status(200).json({ ok: true, ...genJson });
        return;
      }

      if (action === 'create_and_scrape') {
        if (!url) {
          res.status(400).json({ error: 'websiteUrl is required for create_and_scrape' });
          return;
        }

        const supabaseUrl = pickEnv(['SUPABASE_URL', 'VITE_SUPABASE_URL']);
        if (!supabaseUrl) {
          res.status(500).json({ error: 'Cannot invoke scrape: missing service configuration' });
          return;
        }

        const { data: job, error: jobErr } = await supabase
          .from('nest_brand_onboard_jobs')
          .insert({
            brand_key: brandKey,
            business_name: businessDisplayName,
            website_url: url,
            status: 'pending',
          })
          .select('id')
          .single();

        if (jobErr || !job?.id) {
          res.status(500).json({ error: jobErr?.message ?? 'Job insert failed' });
          return;
        }

        const onboardUrl = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/brand-onboard`;
        fetch(onboardUrl, {
          method: 'POST',
          headers: internalEdgeJsonHeaders(),
          body: JSON.stringify({ action: '_scrape', jobId: job.id }),
        }).catch(() => {});

        res.status(200).json({
          ok: true,
          brandKey,
          jobId: job.id,
          message: 'Scrape started. Poll job status in Supabase or re-open this brand after a few minutes.',
        });
        return;
      }

      res.status(400).json({ error: `Unknown action: ${action}` });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Server error' });
  }
}
