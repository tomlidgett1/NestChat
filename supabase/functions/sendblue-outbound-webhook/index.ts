import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getOptionalEnv } from '../_shared/env.ts';
import { isOutboundMessageWebhook, type SendblueWebhookEvent } from '../_shared/sendblue.ts';
import { recordOutboundStatusWebhook } from '../_shared/state.ts';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405);
  }

  const webhookSecret = getOptionalEnv('SENDBLUE_WEBHOOK_SECRET');
  if (webhookSecret) {
    const provided = req.headers.get('sb-signing-secret')
      || req.headers.get('x-webhook-secret');
    if (provided !== webhookSecret) {
      console.warn('[sendblue-outbound-webhook] Invalid webhook secret');
      return jsonResponse({ error: 'invalid webhook secret' }, 401);
    }
  }

  let payload: SendblueWebhookEvent;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid json payload' }, 400);
  }

  const ack = jsonResponse({ received: true }, 200);
  if (!isOutboundMessageWebhook(payload)) {
    return ack;
  }

  try {
    await recordOutboundStatusWebhook(payload);
  } catch (error) {
    console.error('[sendblue-outbound-webhook] Failed to record outbound webhook:', formatError(error));
  }

  return ack;
});
