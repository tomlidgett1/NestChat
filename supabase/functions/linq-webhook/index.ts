import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { isAllowedSender, isIgnoredSender, isMessageReceivedEvent, normaliseLinqMessage, shouldProcessLinqBotNumber, markAsRead, startTyping } from '../_shared/linq.ts';
import { processMessage } from '../_shared/pipeline.ts';
import type { WebhookEvent } from '../_shared/linq.ts';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') {
      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    let rawBody: string;
    try {
      rawBody = await req.text();
    } catch {
      return jsonResponse({ received: true }, 200);
    }

    let payload: WebhookEvent;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ received: true }, 200);
    }

    if (!isMessageReceivedEvent(payload)) {
      return jsonResponse({ received: true }, 200);
    }

    const event = payload;

    if (event.data.sender_handle?.is_me || event.data.direction === 'outbound') {
      return jsonResponse({ received: true }, 200);
    }

    const botNumber = event.data.chat?.owner_handle?.handle;
    if (botNumber && !shouldProcessLinqBotNumber(botNumber)) {
      return jsonResponse({ received: true }, 200);
    }

    const senderHandle = event.data.sender_handle?.handle;
    if (senderHandle && (!isAllowedSender(senderHandle) || isIgnoredSender(senderHandle))) {
      return jsonResponse({ received: true }, 200);
    }

    const message = await normaliseLinqMessage(event);
    if (!message) {
      return jsonResponse({ received: true }, 200);
    }

    if (!message.text.trim() && message.images.length === 0 && message.audio.length === 0) {
      return jsonResponse({ received: true }, 200);
    }

    console.log('[linq-webhook] processing inbound message', {
      messageId: message.messageId,
      chatId: message.chatId,
      from: message.from,
      bot: botNumber,
      isGroup: message.isGroupChat,
    });

    const bgTasks: Promise<unknown>[] = [
      markAsRead(message.chatId),
      processMessage(message),
    ];
    if (!message.isGroupChat) {
      bgTasks.push(startTyping(message.chatId));
    }

    EdgeRuntime.waitUntil(
      Promise.all(bgTasks).catch((err) => console.error('[linq-webhook] processing failed:', err)),
    );

    return jsonResponse({ received: true }, 200);
  } catch (err) {
    console.error(`[linq-webhook] error: ${err}`);
    return jsonResponse({ received: true }, 200);
  }
});
