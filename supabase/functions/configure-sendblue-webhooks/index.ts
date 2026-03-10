import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getListEnv, getOptionalEnv, requireAnyEnv, requireEnv } from '../_shared/env.ts';

const BASE_URL = getOptionalEnv('SENDBLUE_API_BASE_URL') || 'https://api.sendblue.co';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getAuthHeaders(): Record<string, string> {
  return {
    'sb-api-key-id': requireEnv('SENDBLUE_API_KEY'),
    'sb-api-secret-key': requireEnv('SENDBLUE_API_SECRET'),
    'Content-Type': 'application/json',
  };
}

async function sendblueRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...getAuthHeaders(),
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sendblue API error ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

type WebhookEntry = string | { url: string; secret?: string };
type WebhookResponse = {
  status: string;
  webhooks: Record<string, unknown>;
};
type LinesResponse = {
  status: string;
  data?: unknown;
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405);
  }

  const adminSecret = requireEnv('SENDBLUE_WEBHOOK_ADMIN_SECRET');
  if (req.headers.get('x-admin-secret') !== adminSecret) {
    return jsonResponse({ error: 'unauthorised' }, 401);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  if (body.action === 'poll-messages') {
    const botNumber = (body.botNumber as string) || getListEnv('SENDBLUE_BOT_NUMBERS')[0] || '';
    const messagesUrl = `/api/v2/messages?is_outbound=false&sendblue_number=${encodeURIComponent(botNumber)}&order_by=createdAt&order_direction=desc&limit=10`;
    try {
      const messages = await sendblueRequest<unknown>(messagesUrl, { method: 'GET' });
      return jsonResponse({ ok: true, messages });
    } catch (error) {
      return jsonResponse({ ok: false, error: String(error) }, 500);
    }
  }

  if (body.action === 'get-account') {
    try {
      const account = await sendblueRequest<unknown>('/api/account', { method: 'GET' });
      return jsonResponse({ ok: true, account });
    } catch (error) {
      return jsonResponse({ ok: false, error: String(error) }, 500);
    }
  }

  if (body.action === 'reset-webhooks') {
    const projectUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
    const globalSecret = requireEnv('SENDBLUE_WEBHOOK_SECRET');
    const receiveUrl = `${projectUrl}/functions/v1/sendblue-webhook`;
    const outboundUrl = `${projectUrl}/functions/v1/sendblue-outbound-webhook`;

    // First delete all webhooks
    try {
      await sendblueRequest<unknown>('/api/account/webhooks', {
        method: 'PUT',
        body: JSON.stringify({ webhooks: {} }),
      });
    } catch { /* ignore */ }

    // Then re-add receive webhook via POST
    const receiveResult = await sendblueRequest<unknown>('/api/account/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        webhooks: [receiveUrl],
        type: 'receive',
        globalSecret,
      }),
    });

    // Then add outbound webhook via POST
    const outboundResult = await sendblueRequest<unknown>('/api/account/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        webhooks: [outboundUrl],
        type: 'outbound',
        globalSecret,
      }),
    });

    // Verify
    const verify = await sendblueRequest<WebhookResponse>('/api/account/webhooks', { method: 'GET' });

    return jsonResponse({
      ok: true,
      receiveResult,
      outboundResult,
      currentConfig: verify.webhooks,
    });
  }

  const projectUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const globalSecret = requireEnv('SENDBLUE_WEBHOOK_SECRET');
  const receiveUrl = `${projectUrl}/functions/v1/sendblue-webhook`;
  const outboundUrl = `${projectUrl}/functions/v1/sendblue-outbound-webhook`;

  const current = await sendblueRequest<WebhookResponse>('/api/account/webhooks', {
    method: 'GET',
  });

  const currentWebhooks = (current.webhooks || {}) as Record<string, unknown>;
  const nextWebhooks: Record<string, unknown> = {
    ...currentWebhooks,
    receive: [receiveUrl] as WebhookEntry[],
    outbound: [outboundUrl] as WebhookEntry[],
    globalSecret,
  };

  const result = await sendblueRequest<WebhookResponse>('/api/account/webhooks', {
    method: 'PUT',
    body: JSON.stringify({
      webhooks: nextWebhooks,
    }),
  });
  const lines = await sendblueRequest<LinesResponse>('/api/lines', {
    method: 'GET',
  });

  return jsonResponse({
    ok: true,
    receive: receiveUrl,
    outbound: outboundUrl,
    currentWebhooksBefore: currentWebhooks,
    configured: result.webhooks,
    lines: lines.data ?? lines,
    botNumbers: getListEnv('SENDBLUE_BOT_NUMBERS'),
    serviceRoleKeySource: requireAnyEnv('SUPABASE_SERVICE_ROLE_KEY', 'SERVICE_ROLE_KEY') ? 'available' : 'missing',
  });
});
