import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getAdminClient } from '../_shared/supabase.ts';
import { findSubscriptionByMsId } from '../_shared/email-webhook-helpers.ts';
import { processOutlookNotificationInline } from '../_shared/process-notification-event.ts';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

/**
 * Outlook Webhook — receives Microsoft Graph change notifications.
 *
 * Handles two flows:
 * 1. Validation: GET/POST with ?validationToken=... → return token as text/plain
 * 2. Notifications: POST with { value: [...] } → process inline and return 202
 */
Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const validationToken = url.searchParams.get('validationToken');

    // ── Validation handshake ──
    // Microsoft sends this when creating/renewing a subscription.
    // Must return the token as plain text within 10 seconds.
    if (validationToken) {
      console.log('[outlook-webhook] Validation request received');
      return new Response(validationToken, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Notification payload ──
    let rawBody: string;
    try {
      rawBody = await req.text();
    } catch {
      return new Response(null, { status: 202 });
    }

    let payload: { value?: Array<Record<string, unknown>> };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response(null, { status: 202 });
    }

    const notifications = payload.value;
    if (!Array.isArray(notifications) || notifications.length === 0) {
      return new Response(null, { status: 202 });
    }

    console.log(`[outlook-webhook] Received ${notifications.length} notification(s)`);

    // Return 202 immediately, process in background
    EdgeRuntime.waitUntil(
      processOutlookNotifications(notifications).catch((err) =>
        console.error(`[outlook-webhook] Background processing failed:`, err),
      ),
    );

    return new Response(null, { status: 202 });
  } catch (err) {
    console.error(`[outlook-webhook] Error:`, err);
    return new Response(null, { status: 202 });
  }
});

async function processOutlookNotifications(
  notifications: Array<Record<string, unknown>>,
): Promise<void> {
  const supabase = getAdminClient();

  for (const notification of notifications) {
    try {
      // Handle lifecycle notifications
      const lifecycleEvent = notification.lifecycleEvent as string | undefined;
      if (lifecycleEvent) {
        console.log(`[outlook-webhook] Lifecycle event: ${lifecycleEvent} for subscription ${notification.subscriptionId}`);
        if (lifecycleEvent === 'reauthorizationRequired') {
          console.warn(`[outlook-webhook] Reauthorization required for subscription ${notification.subscriptionId}`);
        }
        continue;
      }

      const msSubscriptionId = notification.subscriptionId as string;
      const clientState = notification.clientState as string;
      const changeType = notification.changeType as string;
      const resource = notification.resource as string;

      if (!msSubscriptionId) {
        console.warn('[outlook-webhook] Notification missing subscriptionId');
        continue;
      }

      // Verify client state against stored value
      const subscription = await findSubscriptionByMsId(msSubscriptionId);
      if (!subscription) {
        console.warn(`[outlook-webhook] No active subscription for MS ID ${msSubscriptionId}`);
        continue;
      }

      if (subscription.client_state && clientState !== subscription.client_state) {
        console.warn(`[outlook-webhook] clientState mismatch for ${msSubscriptionId}, ignoring`);
        continue;
      }

      // Determine source type from resource path
      const sourceType: 'email' | 'calendar' = resource?.includes('/events') ? 'calendar' : 'email';

      // Record event for audit trail + cron fallback
      const { data: eventId, error } = await supabase.rpc('record_webhook_event', {
        p_provider: 'microsoft',
        p_account_email: subscription.account_email,
        p_subscription_id: subscription.id,
        p_resource_data: { resource, changeType, subscriptionId: msSubscriptionId },
        p_change_type: changeType,
        p_source_type: sourceType,
      });

      if (error) {
        console.error(`[outlook-webhook] Failed to record event: ${error.message}`);
      }

      // Process inline — fetch content, evaluate triggers, deliver alerts
      console.log(`[outlook-webhook] Processing inline: ${changeType} for ${subscription.account_email} (${sourceType})`);
      try {
        await processOutlookNotificationInline(
          subscription.account_email,
          subscription.id,
          resource,
          changeType,
          sourceType,
        );

        // Mark completed so cron doesn't re-process
        if (eventId) {
          await supabase.rpc('complete_webhook_event', { p_id: eventId, p_status: 'completed' });
        }
      } catch (err) {
        console.error(`[outlook-webhook] Inline processing failed: ${(err as Error).message}`);
        // Event stays pending — cron will retry
      }

      console.log(`[outlook-webhook] Processed: ${changeType} for ${subscription.account_email}`);
    } catch (err) {
      console.error(`[outlook-webhook] Error processing notification:`, err);
    }
  }
}
