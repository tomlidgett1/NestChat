import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getAdminClient } from '../_shared/supabase.ts';
import { findSubscriptionByEmail } from '../_shared/email-webhook-helpers.ts';
import { processGmailNotificationInline } from '../_shared/process-notification-event.ts';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Gmail Webhook — receives Google Cloud Pub/Sub push notifications.
 *
 * Pub/Sub sends:
 * {
 *   "message": {
 *     "data": "<base64 of {emailAddress, historyId}>",
 *     "messageId": "...",
 *     "publishTime": "..."
 *   },
 *   "subscription": "projects/.../subscriptions/..."
 * }
 *
 * Returns 200 immediately. Processing happens inline via waitUntil().
 */
Deno.serve(async (req) => {
  // Pub/Sub requires fast 200 ack — always return 200 even on errors
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

    let payload: { message?: { data?: string; messageId?: string } };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ received: true }, 200);
    }

    const messageData = payload.message?.data;
    if (!messageData) {
      console.warn('[gmail-webhook] No message.data in payload');
      return jsonResponse({ received: true }, 200);
    }

    // Decode the base64 notification data
    let notification: { emailAddress?: string; historyId?: string };
    try {
      const decoded = atob(messageData);
      notification = JSON.parse(decoded);
    } catch {
      console.warn('[gmail-webhook] Failed to decode message.data');
      return jsonResponse({ received: true }, 200);
    }

    const emailAddress = notification.emailAddress;
    const historyId = notification.historyId;

    if (!emailAddress || !historyId) {
      console.warn('[gmail-webhook] Missing emailAddress or historyId in notification');
      return jsonResponse({ received: true }, 200);
    }

    console.log(`[gmail-webhook] Notification for ${emailAddress}, historyId=${historyId}`);

    // Background processing — return 200 immediately, process inline
    EdgeRuntime.waitUntil(
      handleGmailNotification(emailAddress, historyId).catch((err) =>
        console.error(`[gmail-webhook] Background processing failed:`, err),
      ),
    );

    return jsonResponse({ received: true }, 200);
  } catch (err) {
    console.error(`[gmail-webhook] Error:`, err);
    return jsonResponse({ received: true }, 200);
  }
});

async function handleGmailNotification(
  emailAddress: string,
  historyId: string,
): Promise<void> {
  // Look up the active subscription for this email
  const subscription = await findSubscriptionByEmail('google', emailAddress, 'email');

  if (!subscription) {
    console.warn(`[gmail-webhook] No active subscription for ${emailAddress}, ignoring`);
    return;
  }

  // Skip if we've already processed this or a later historyId
  if (subscription.history_id && BigInt(historyId) <= BigInt(subscription.history_id)) {
    console.log(`[gmail-webhook] Stale historyId ${historyId} <= ${subscription.history_id}, skipping`);
    return;
  }

  // Record event for audit trail + cron fallback
  const supabase = getAdminClient();
  const { data: eventId, error } = await supabase.rpc('record_webhook_event', {
    p_provider: 'google',
    p_account_email: emailAddress,
    p_subscription_id: subscription.id,
    p_history_id: historyId,
    p_source_type: 'email',
  });

  if (error) {
    console.error(`[gmail-webhook] Failed to record event: ${error.message}`);
  }

  // Process inline — fetch emails, evaluate triggers, deliver alerts
  console.log(`[gmail-webhook] Processing inline for ${emailAddress}, historyId=${historyId}`);
  try {
    await processGmailNotificationInline(
      emailAddress,
      historyId,
      subscription.id,
      subscription.history_id,
    );

    // Mark event as completed so cron doesn't re-process it
    if (eventId) {
      await supabase.rpc('complete_webhook_event', { p_id: eventId, p_status: 'completed' });
    }
  } catch (err) {
    console.error(`[gmail-webhook] Inline processing failed: ${(err as Error).message}`);
    // Event stays in pending/processing — cron will retry it
  }
}
