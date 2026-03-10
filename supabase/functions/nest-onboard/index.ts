import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { activateUser, getUserByToken } from '../_shared/state.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) {
    return json({ error: 'missing_token' }, 400);
  }

  const user = await getUserByToken(token);
  if (!user) {
    return json({ error: 'invalid_token' }, 404);
  }

  if (user.status === 'active') {
    return json({ success: true, already_active: true });
  }

  const handle = await activateUser(token);
  if (!handle) {
    return json({ error: 'activation_failed' }, 500);
  }

  console.log(`[nest-onboard] Activated user ${handle.slice(0, 6)}***`);
  return json({ success: true });
});
