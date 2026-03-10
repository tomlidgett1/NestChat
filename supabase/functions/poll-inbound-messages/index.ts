import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getListEnv, requireEnv } from '../_shared/env.ts';
import {
  normaliseIncomingMessage,
  isAllowedSender,
  isIgnoredSender,
  shouldProcessBotNumber,
  type SendblueWebhookEvent,
} from '../_shared/sendblue.ts';
import { enqueueWebhookEvent } from '../_shared/state.ts';
import { getAdminClient } from '../_shared/supabase.ts';

const CURSOR_ID = 'sendblue_inbound_poll';
const POLL_LIMIT = 20;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try { return JSON.stringify(error); } catch { return String(error); }
}

async function fetchRecentMessages(botNumber: string): Promise<SendblueWebhookEvent[]> {
  const baseUrl = Deno.env.get('SENDBLUE_API_BASE_URL') || 'https://api.sendblue.co';
  const apiKey = requireEnv('SENDBLUE_API_KEY');
  const apiSecret = requireEnv('SENDBLUE_API_SECRET');

  const params = new URLSearchParams({
    is_outbound: 'false',
    sendblue_number: botNumber,
    order_by: 'createdAt',
    order_direction: 'desc',
    limit: String(POLL_LIMIT),
  });

  const response = await fetch(`${baseUrl}/api/v2/messages?${params}`, {
    headers: {
      'sb-api-key-id': apiKey,
      'sb-api-secret-key': apiSecret,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sendblue API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const result = await response.json();
  return (result.data || []) as SendblueWebhookEvent[];
}

async function getCursor(): Promise<string | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('polling_cursors')
    .select('last_value')
    .eq('id', CURSOR_ID)
    .maybeSingle<{ last_value: string }>();

  if (error) throw error;
  return data?.last_value ?? null;
}

async function setCursor(value: string): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase
    .from('polling_cursors')
    .upsert({ id: CURSOR_ID, last_value: value, updated_at: new Date().toISOString() });

  if (error) throw error;
}

async function triggerWorker(): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase.functions.invoke('process-inbound-queue', {
    body: { batchSize: 5 },
  });
  if (error) {
    console.error('[poll-inbound] Failed to kick worker:', error);
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405);
  }

  try {
    const botNumbers = getListEnv('SENDBLUE_BOT_NUMBERS');
    if (botNumbers.length === 0) {
      return jsonResponse({ error: 'SENDBLUE_BOT_NUMBERS not configured' }, 500);
    }

    const lastCursor = await getCursor();
    let totalEnqueued = 0;
    let newCursor = lastCursor;

    for (const botNumber of botNumbers) {
      const messages = await fetchRecentMessages(botNumber);
      if (messages.length === 0) continue;

      const newMessages = lastCursor
        ? messages.filter((m) => {
            const msgDate = m.date_updated || m.date_sent || '';
            return msgDate > lastCursor;
          })
        : messages.slice(0, 1);

      const sorted = newMessages.sort((a, b) => {
        const da = a.date_updated || a.date_sent || '';
        const db = b.date_updated || b.date_sent || '';
        return da < db ? -1 : da > db ? 1 : 0;
      });

      for (const rawEvent of sorted) {
        const message = normaliseIncomingMessage(rawEvent);
        if (!message) continue;

        if (!shouldProcessBotNumber(message.conversation.fromNumber)) continue;
        if (!isAllowedSender(message.from) || isIgnoredSender(message.from)) continue;
        if (!message.text.trim() && message.images.length === 0 && message.audio.length === 0) continue;

        try {
          const rawPayload = rawEvent as unknown as Record<string, unknown>;
          const result = await enqueueWebhookEvent(rawPayload, message);
          if (result.created) {
            totalEnqueued++;
            console.log('[poll-inbound] Enqueued message', {
              messageId: message.messageId,
              chatId: message.chatId,
            });
          }
        } catch (error) {
          console.error('[poll-inbound] Failed to enqueue:', formatError(error));
        }

        const eventDate = rawEvent.date_updated || rawEvent.date_sent || '';
        if (!newCursor || eventDate > newCursor) {
          newCursor = eventDate;
        }
      }
    }

    if (newCursor && newCursor !== lastCursor) {
      await setCursor(newCursor);
    }

    if (totalEnqueued > 0) {
      EdgeRuntime.waitUntil(triggerWorker());
    }

    return jsonResponse({
      ok: true,
      enqueued: totalEnqueued,
      cursor: newCursor,
    });
  } catch (error) {
    console.error('[poll-inbound] Error:', formatError(error));
    return jsonResponse({ error: formatError(error) }, 500);
  }
});
