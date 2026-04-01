import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getAdminClient } from '../_shared/supabase.ts';
import {
  findSubscriptionByChannelId,
  findSubscriptionByMsId,
} from '../_shared/email-webhook-helpers.ts';
import { processCalendarNotificationInline } from '../_shared/process-notification-event.ts';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Calendar Webhook — handles both Google Calendar push and Outlook Calendar
 * graph change notifications. Processes inline for instant alerts.
 *
 * Google Calendar:
 *   POST with empty body + X-Goog-* headers
 *   X-Goog-Channel-ID, X-Goog-Resource-ID, X-Goog-Resource-State
 *
 * Outlook Calendar:
 *   GET ?validationToken=... → return plain text (subscription validation)
 *   POST with change notification JSON body
 */
Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);

    // ── Outlook validation handshake ──────────────────────────
    if (req.method === 'GET') {
      const validationToken = url.searchParams.get('validationToken');
      if (validationToken) {
        return new Response(validationToken, {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      return jsonResponse({ error: 'missing validationToken' }, 400);
    }

    if (req.method !== 'POST') {
      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    // ── Detect source by headers ─────────────────────────────
    const channelId = req.headers.get('x-goog-channel-id');

    if (channelId) {
      // Google Calendar push notification
      EdgeRuntime.waitUntil(
        processGoogleCalendarNotification(
          channelId,
          req.headers.get('x-goog-resource-id') ?? '',
          req.headers.get('x-goog-resource-state') ?? '',
        ).catch((err) =>
          console.error('[calendar-webhook] Google Calendar processing failed:', err),
        ),
      );
      return jsonResponse({ received: true }, 200);
    }

    // Outlook Calendar change notification
    let body: string;
    try {
      body = await req.text();
    } catch {
      return jsonResponse({ received: true }, 202);
    }

    let payload: { value?: Array<{
      subscriptionId?: string;
      clientState?: string;
      changeType?: string;
      resource?: string;
      resourceData?: Record<string, unknown>;
      lifecycleEvent?: string;
    }> };
    try {
      payload = JSON.parse(body);
    } catch {
      return jsonResponse({ received: true }, 202);
    }

    if (!payload.value?.length) {
      return jsonResponse({ received: true }, 202);
    }

    EdgeRuntime.waitUntil(
      processOutlookCalendarNotifications(payload.value).catch((err) =>
        console.error('[calendar-webhook] Outlook Calendar processing failed:', err),
      ),
    );

    return jsonResponse({ received: true }, 202);
  } catch (err) {
    console.error('[calendar-webhook] Error:', err);
    return jsonResponse({ received: true }, 200);
  }
});

// ══════════════════════════════════════════════════════════════
// Google Calendar
// ══════════════════════════════════════════════════════════════

async function processGoogleCalendarNotification(
  channelId: string,
  resourceId: string,
  resourceState: string,
): Promise<void> {
  // 'sync' is the initial notification — ignore it
  if (resourceState === 'sync') {
    console.log(`[calendar-webhook] Sync notification for channel ${channelId}, ignoring`);
    return;
  }

  const subscription = await findSubscriptionByChannelId(channelId);
  if (!subscription) {
    console.warn(`[calendar-webhook] No subscription for channel ${channelId}`);
    return;
  }

  const supabase = getAdminClient();

  // Record event first, then debounce: if another event for this subscription
  // was already recorded in the last 30s, skip processing (Google sends multiple pushes)
  const { data: eventId, error } = await supabase.rpc('record_webhook_event', {
    p_provider: 'google',
    p_account_email: subscription.account_email,
    p_subscription_id: subscription.id,
    p_resource_data: { channelId, resourceId, resourceState },
    p_change_type: resourceState,
    p_source_type: 'calendar',
  });

  if (error) {
    console.error(`[calendar-webhook] Failed to record event: ${error.message}`);
  }

  // Debounce: check if there are OTHER events for this subscription recorded
  // in the last 30 seconds (excluding the one we just created)
  const thirtySecsAgo = new Date(Date.now() - 30_000).toISOString();
  const { data: recentEvents } = await supabase
    .from('notification_webhook_events')
    .select('id')
    .eq('subscription_id', subscription.id)
    .eq('source_type', 'calendar')
    .gte('created_at', thirtySecsAgo)
    .neq('id', eventId ?? -1)
    .limit(1);

  if (recentEvents && recentEvents.length > 0) {
    console.log(`[calendar-webhook] Debounce: duplicate push for ${subscription.account_email} within 30s, skipping`);
    // Mark as completed so cron doesn't re-process
    if (eventId) await supabase.rpc('complete_webhook_event', { p_id: eventId, p_status: 'skipped' });
    return;
  }

  // Process inline — fetch calendar changes, evaluate triggers, deliver alerts
  console.log(`[calendar-webhook] Processing inline for ${subscription.account_email}, state=${resourceState}`);
  try {
    await processCalendarNotificationInline(
      subscription.account_email,
      subscription.id,
    );

    if (eventId) {
      await supabase.rpc('complete_webhook_event', { p_id: eventId, p_status: 'completed' });
    }
  } catch (err) {
    console.error(`[calendar-webhook] Inline processing failed: ${(err as Error).message}`);
  }
}

// ══════════════════════════════════════════════════════════════
// Outlook Calendar
// ══════════════════════════════════════════════════════════════

async function processOutlookCalendarNotifications(
  notifications: Array<{
    subscriptionId?: string;
    clientState?: string;
    changeType?: string;
    resource?: string;
    resourceData?: Record<string, unknown>;
    lifecycleEvent?: string;
  }>,
): Promise<void> {
  const supabase = getAdminClient();

  for (const notification of notifications) {
    // Skip lifecycle events
    if (notification.lifecycleEvent) {
      console.log(`[calendar-webhook] Lifecycle event: ${notification.lifecycleEvent}`);
      continue;
    }

    const msSubId = notification.subscriptionId;
    if (!msSubId) continue;

    const subscription = await findSubscriptionByMsId(msSubId);
    if (!subscription) {
      console.warn(`[calendar-webhook] No subscription for MS ID ${msSubId}`);
      continue;
    }

    // Verify client state
    if (subscription.client_state && notification.clientState !== subscription.client_state) {
      console.warn(`[calendar-webhook] Client state mismatch for ${msSubId}`);
      continue;
    }

    const { data: eventId, error } = await supabase.rpc('record_webhook_event', {
      p_provider: 'microsoft',
      p_account_email: subscription.account_email,
      p_subscription_id: subscription.id,
      p_resource_data: notification.resourceData ?? { resource: notification.resource },
      p_change_type: notification.changeType,
      p_source_type: 'calendar',
    });

    if (error) {
      console.error(`[calendar-webhook] Failed to record event: ${error.message}`);
      continue;
    }

    // TODO: inline processing for Outlook calendar events
    console.log(`[calendar-webhook] Event recorded for ${subscription.account_email}, change=${notification.changeType}`);

    if (eventId) {
      await supabase.rpc('complete_webhook_event', { p_id: eventId, p_status: 'completed' });
    }
  }
}
