import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
// v2: weather tool integration
import { getOptionalEnv, QUEUE_NAME } from '../_shared/env.ts';
import { processWebhookEvent } from '../_shared/pipeline.ts';
import { getWebhookEvent, markWebhookEventStatus, recordJobFailure } from '../_shared/state.ts';
import { getAdminClient } from '../_shared/supabase.ts';

interface QueueMessage {
  msg_id: number;
  read_ct: number;
  vt: string;
  enqueued_at: string;
  message: {
    event_id: number;
    provider: string;
    provider_message_id: string;
  };
}

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

async function readQueueMessages(batchSize: number): Promise<QueueMessage[]> {
  const supabase = getAdminClient();
  const visibilityTimeout = Number(getOptionalEnv('QUEUE_VISIBILITY_TIMEOUT_SECONDS') || '120');
  const { data, error } = await supabase.rpc('read_queue_messages', {
    p_queue_name: QUEUE_NAME,
    p_sleep_seconds: visibilityTimeout,
    p_n: batchSize,
  });

  if (error) {
    throw error;
  }

  return (data as QueueMessage[] | null) || [];
}

async function deleteQueueMessage(messageId: number): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase.rpc('delete_queue_message', {
    p_queue_name: QUEUE_NAME,
    p_message_id: messageId,
  });

  if (error) {
    throw error;
  }
}

async function archiveQueueMessage(messageId: number): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase.rpc('archive_queue_message', {
    p_queue_name: QUEUE_NAME,
    p_message_id: messageId,
  });

  if (error) {
    throw error;
  }
}

async function processQueueMessage(queueMessage: QueueMessage): Promise<void> {
  const maxAttempts = Number(getOptionalEnv('QUEUE_MAX_ATTEMPTS') || '5');
  const event = await getWebhookEvent(queueMessage.message.event_id);

  if (!event) {
    await archiveQueueMessage(queueMessage.msg_id);
    return;
  }

  try {
    if (event.status === 'completed') {
      await deleteQueueMessage(queueMessage.msg_id);
      return;
    }

    await processWebhookEvent(event);
    await deleteQueueMessage(queueMessage.msg_id);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await recordJobFailure(
      QUEUE_NAME,
      queueMessage.msg_id,
      event.id,
      queueMessage.read_ct,
      errorMessage,
      queueMessage.message as unknown as Record<string, unknown>,
    );

    if (queueMessage.read_ct >= maxAttempts) {
      await markWebhookEventStatus(event.id, 'failed', errorMessage);
      await archiveQueueMessage(queueMessage.msg_id);
      return;
    }

    await markWebhookEventStatus(event.id, 'queued', errorMessage);
    throw error;
  }
}

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') {
      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    let body: { batchSize?: number } = {};
    try {
      body = await req.json();
    } catch {
      // ignore empty body
    }

    const batchSize = Math.max(1, Math.min(body.batchSize ?? Number(getOptionalEnv('QUEUE_BATCH_SIZE') || '3'), 10));
    const messages = await readQueueMessages(batchSize);

    if (messages.length === 0) {
      return jsonResponse({ message: 'No messages in queue', count: 0 });
    }

    let processed = 0;
    const failures: Array<{ msg_id: number; error: string }> = [];

    for (const queueMessage of messages) {
      try {
        await processQueueMessage(queueMessage);
        processed += 1;
      } catch (error) {
        const errorMessage = formatError(error);
        console.error('[process-inbound-queue] Failed queue message:', queueMessage.msg_id, errorMessage);
        failures.push({ msg_id: queueMessage.msg_id, error: errorMessage });
      }
    }

    return jsonResponse({
      message: `Processed ${processed} queue message(s)`,
      count: processed,
      failures,
    });
  } catch (error) {
    const errorMessage = formatError(error);
    console.error('[process-inbound-queue] Fatal error:', error);
    return jsonResponse({ error: errorMessage }, 500);
  }
});
