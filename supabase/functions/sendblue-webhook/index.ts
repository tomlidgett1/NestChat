import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getOptionalEnv } from '../_shared/env.ts';
import { normaliseIncomingMessage, isAllowedSender, isIgnoredSender, isInboundReceiveWebhook, type SendblueWebhookEvent, shouldProcessBotNumber } from '../_shared/sendblue.ts';
import { processMessage } from '../_shared/pipeline.ts';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405);
  }

  let payload: SendblueWebhookEvent;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ ok: true }, 200);
  }

  if (!isInboundReceiveWebhook(payload)) {
    return jsonResponse({ received: true }, 200);
  }

  const webhookSecret = getOptionalEnv('SENDBLUE_WEBHOOK_SECRET');
  if (webhookSecret) {
    const provided = req.headers.get('sb-signing-secret')
      || req.headers.get('x-webhook-secret');
    if (provided !== webhookSecret) {
      console.warn('[sendblue-webhook] Invalid webhook secret');
      return jsonResponse({ error: 'invalid webhook secret' }, 401);
    }
  }

  const message = normaliseIncomingMessage(payload);
  if (!message) {
    return jsonResponse({ received: true }, 200);
  }

  if (!shouldProcessBotNumber(message.conversation.fromNumber)) {
    return jsonResponse({ received: true }, 200);
  }

  if (!isAllowedSender(message.from) || isIgnoredSender(message.from)) {
    return jsonResponse({ received: true }, 200);
  }

  if (!message.text.trim() && message.images.length === 0 && message.audio.length === 0) {
    return jsonResponse({ received: true }, 200);
  }

  console.log('[sendblue-webhook] processing inbound message', {
    messageId: message.messageId,
    chatId: message.chatId,
    bot: message.conversation.fromNumber,
  });

  try {
    await processMessage(message);
  } catch (err) {
    console.error('[sendblue-webhook] processing failed:', err);
  }

  return jsonResponse({ received: true }, 200);
});
