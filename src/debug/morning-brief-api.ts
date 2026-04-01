import type { Request, Response } from 'express';
import { internalEdgeJsonHeaders } from '../lib/internal-edge-auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';

export async function handleMorningBriefRun(req: Request, res: Response) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!SUPABASE_URL) {
    res.status(500).json({ error: 'SUPABASE_URL is not configured' });
    return;
  }

  try {
    const body = req.body as { handle?: string; dry_run?: boolean };
    const handle = typeof body.handle === 'string' ? body.handle.trim() : '';
    if (!handle) {
      res.status(400).json({ error: 'handle is required' });
      return;
    }
    const dry_run = body.dry_run === true;

    const url = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/morning-brief-audio`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: internalEdgeJsonHeaders(),
      body: JSON.stringify({ handle, dry_run }),
    });

    const json = (await resp.json()) as Record<string, unknown>;
    res.status(resp.status).json(json);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[morning-brief-api]', msg);
    res.status(500).json({ error: msg });
  }
}
