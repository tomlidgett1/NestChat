import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getAdminClient } from '../_shared/supabase.ts';
import { getGoogleAccessToken, getMicrosoftAccessToken } from '../_shared/token-broker.ts';
import { getOptionalEnv, requireAnyEnv } from '../_shared/env.ts';
import { authorizeInternalRequest } from '../_shared/internal-auth.ts';
import {
  setupGmailWatch,
  stopGmailWatch,
  createOutlookSubscription,
  renewOutlookSubscription,
  deleteOutlookSubscription,
  findSubscriptionByEmail,
  updateSubscriptionExpiration,
  generateClientState,
  setupGoogleCalendarWatch,
  stopGoogleCalendarWatch,
} from '../_shared/email-webhook-helpers.ts';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface ManageRequest {
  action: 'create' | 'renew' | 'delete' | 'ensure';
  provider: 'google' | 'microsoft';
  handle: string;
  account_email: string;
  user_id?: string;
  resource_type?: 'email' | 'calendar';
}

/**
 * Manage Email/Calendar Webhooks — CRUD for Gmail watch, Google Calendar watch,
 * and Outlook subscriptions.
 *
 * Actions:
 * - create: Set up a new webhook subscription
 * - renew: Extend an existing subscription
 * - delete: Remove a subscription
 * - ensure: Idempotent — create if none exists, renew if expiring within 24h
 */
Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') {
      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    if (!authorizeInternalRequest(req)) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }

    const body: ManageRequest = await req.json();
    const { action, provider, handle, account_email } = body;
    const resourceType = body.resource_type ?? 'email';

    if (!action || !provider || !handle || !account_email) {
      return jsonResponse({ error: 'Missing required fields: action, provider, handle, account_email' }, 400);
    }

    // Resolve user_id from handle
    const supabase = getAdminClient();
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('auth_user_id')
      .eq('handle', handle)
      .maybeSingle();

    const userId = body.user_id ?? (profile as { auth_user_id: string | null } | null)?.auth_user_id;
    if (!userId) {
      return jsonResponse({ error: `No user found for handle ${handle}` }, 404);
    }

    switch (action) {
      case 'create':
        return await handleCreate(provider, handle, account_email, userId, resourceType);

      case 'renew':
        return await handleRenew(provider, account_email, userId, resourceType);

      case 'delete':
        return await handleDelete(provider, account_email, userId, resourceType);

      case 'ensure':
        return await handleEnsure(provider, handle, account_email, userId, resourceType);

      default:
        return jsonResponse({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[manage-email-webhooks] Error:', msg);
    return jsonResponse({ error: msg }, 500);
  }
});

// ── Create ──

async function handleCreate(
  provider: 'google' | 'microsoft',
  handle: string,
  accountEmail: string,
  userId: string,
  resourceType: 'email' | 'calendar',
): Promise<Response> {
  const supabase = getAdminClient();
  const supabaseUrl = requireAnyEnv('SUPABASE_URL');

  if (provider === 'google') {
    const token = await getGoogleAccessToken(userId, { email: accountEmail });

    if (resourceType === 'calendar') {
      // Google Calendar push notification via channel watch
      const calendarWebhookUrl = `${supabaseUrl}/functions/v1/calendar-webhook`;
      const result = await setupGoogleCalendarWatch(token.accessToken, 'primary', calendarWebhookUrl);

      const expiration = new Date(parseInt(result.expiration, 10));

      const { error } = await supabase
        .from('notification_webhook_subscriptions')
        .upsert({
          handle,
          provider: 'google',
          account_email: accountEmail,
          resource_type: 'calendar',
          channel_id: result.channelId,
          resource_id: result.resourceId,
          expiration: expiration.toISOString(),
          resource: 'primary/events',
          active: true,
          error_count: 0,
          last_error: null,
          last_renewed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'provider,account_email,resource_type',
        });

      if (error) throw new Error(`DB upsert failed: ${error.message}`);

      console.log(`[manage-email-webhooks] Google Calendar watch created for ${accountEmail}, channel=${result.channelId}, expires=${expiration.toISOString()}`);

      return jsonResponse({
        status: 'created',
        provider: 'google',
        resource_type: 'calendar',
        account_email: accountEmail,
        channel_id: result.channelId,
        expiration: expiration.toISOString(),
      });
    }

    // Gmail Pub/Sub watch
    const topicName = getOptionalEnv('GOOGLE_PUBSUB_TOPIC');
    if (!topicName) {
      return jsonResponse({ error: 'GOOGLE_PUBSUB_TOPIC not configured' }, 500);
    }

    const result = await setupGmailWatch(token.accessToken, topicName);
    const expiration = new Date(parseInt(result.expiration, 10));

    const { error } = await supabase
      .from('notification_webhook_subscriptions')
      .upsert({
        handle,
        provider: 'google',
        account_email: accountEmail,
        resource_type: 'email',
        history_id: result.historyId,
        expiration: expiration.toISOString(),
        resource: 'INBOX',
        active: true,
        error_count: 0,
        last_error: null,
        last_renewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'provider,account_email,resource_type',
      });

    if (error) throw new Error(`DB upsert failed: ${error.message}`);

    console.log(`[manage-email-webhooks] Gmail watch created for ${accountEmail}, historyId=${result.historyId}, expires=${expiration.toISOString()}`);

    return jsonResponse({
      status: 'created',
      provider: 'google',
      resource_type: 'email',
      account_email: accountEmail,
      history_id: result.historyId,
      expiration: expiration.toISOString(),
    });
  }

  // Microsoft
  const token = await getMicrosoftAccessToken(userId, { email: accountEmail });
  const notificationUrl = resourceType === 'calendar'
    ? `${supabaseUrl}/functions/v1/calendar-webhook`
    : `${supabaseUrl}/functions/v1/outlook-webhook`;
  const clientState = generateClientState();

  const msResource = resourceType === 'calendar'
    ? 'me/events'
    : 'me/mailFolders/inbox/messages';

  const result = await createOutlookSubscription(
    token.accessToken,
    notificationUrl,
    msResource,
    clientState,
    notificationUrl, // lifecycle notifications go to same URL
  );

  const expiration = new Date(result.expirationDateTime);

  const { error } = await supabase
    .from('notification_webhook_subscriptions')
    .upsert({
      handle,
      provider: 'microsoft',
      account_email: accountEmail,
      resource_type: resourceType,
      subscription_id: result.subscriptionId,
      client_state: clientState,
      expiration: expiration.toISOString(),
      resource: msResource,
      active: true,
      error_count: 0,
      last_error: null,
      last_renewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'provider,account_email,resource_type',
    });

  if (error) throw new Error(`DB upsert failed: ${error.message}`);

  console.log(`[manage-email-webhooks] Outlook ${resourceType} subscription created for ${accountEmail}, id=${result.subscriptionId}, expires=${expiration.toISOString()}`);

  return jsonResponse({
    status: 'created',
    provider: 'microsoft',
    resource_type: resourceType,
    account_email: accountEmail,
    subscription_id: result.subscriptionId,
    expiration: expiration.toISOString(),
  });
}

// ── Renew ──

async function handleRenew(
  provider: 'google' | 'microsoft',
  accountEmail: string,
  userId: string,
  resourceType: 'email' | 'calendar',
): Promise<Response> {
  const existing = await findSubscriptionByEmail(provider, accountEmail, resourceType);
  if (!existing) {
    return jsonResponse({ error: `No active ${resourceType} subscription for ${provider}/${accountEmail}` }, 404);
  }

  if (provider === 'google') {
    const token = await getGoogleAccessToken(userId, { email: accountEmail });

    if (resourceType === 'calendar') {
      // Stop old channel + create new one
      if (existing.channel_id && existing.resource_id) {
        await stopGoogleCalendarWatch(token.accessToken, existing.channel_id, existing.resource_id);
      }

      const supabaseUrl = requireAnyEnv('SUPABASE_URL');
      const calendarWebhookUrl = `${supabaseUrl}/functions/v1/calendar-webhook`;
      const result = await setupGoogleCalendarWatch(token.accessToken, 'primary', calendarWebhookUrl);
      const expiration = new Date(parseInt(result.expiration, 10));

      const supabase = getAdminClient();
      await supabase
        .from('notification_webhook_subscriptions')
        .update({
          channel_id: result.channelId,
          resource_id: result.resourceId,
          expiration: expiration.toISOString(),
          last_renewed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          error_count: 0,
          last_error: null,
        })
        .eq('id', existing.id);

      console.log(`[manage-email-webhooks] Google Calendar watch renewed for ${accountEmail}, channel=${result.channelId}, expires=${expiration.toISOString()}`);

      return jsonResponse({
        status: 'renewed',
        provider: 'google',
        resource_type: 'calendar',
        account_email: accountEmail,
        expiration: expiration.toISOString(),
      });
    }

    // Gmail — re-watch
    const topicName = getOptionalEnv('GOOGLE_PUBSUB_TOPIC');
    if (!topicName) {
      return jsonResponse({ error: 'GOOGLE_PUBSUB_TOPIC not configured' }, 500);
    }

    const result = await setupGmailWatch(token.accessToken, topicName);
    const expiration = new Date(parseInt(result.expiration, 10));
    await updateSubscriptionExpiration(existing.id, expiration);

    console.log(`[manage-email-webhooks] Gmail watch renewed for ${accountEmail}, expires=${expiration.toISOString()}`);

    return jsonResponse({
      status: 'renewed',
      provider: 'google',
      resource_type: 'email',
      account_email: accountEmail,
      expiration: expiration.toISOString(),
    });
  }

  // Microsoft
  const token = await getMicrosoftAccessToken(userId, { email: accountEmail });
  const newExpiration = await renewOutlookSubscription(token.accessToken, existing.subscription_id);
  const expiration = new Date(newExpiration);
  await updateSubscriptionExpiration(existing.id, expiration);

  console.log(`[manage-email-webhooks] Outlook ${resourceType} subscription renewed for ${accountEmail}, expires=${expiration.toISOString()}`);

  return jsonResponse({
    status: 'renewed',
    provider,
    resource_type: resourceType,
    account_email: accountEmail,
    expiration: expiration.toISOString(),
  });
}

// ── Delete ──

async function handleDelete(
  provider: 'google' | 'microsoft',
  accountEmail: string,
  userId: string,
  resourceType: 'email' | 'calendar',
): Promise<Response> {
  const existing = await findSubscriptionByEmail(provider, accountEmail, resourceType);
  if (!existing) {
    return jsonResponse({ status: 'not_found', message: 'No active subscription found' });
  }

  const token = provider === 'google'
    ? await getGoogleAccessToken(userId, { email: accountEmail })
    : await getMicrosoftAccessToken(userId, { email: accountEmail });

  if (provider === 'google') {
    if (resourceType === 'calendar' && existing.channel_id && existing.resource_id) {
      await stopGoogleCalendarWatch(token.accessToken, existing.channel_id, existing.resource_id);
    } else if (resourceType === 'email') {
      await stopGmailWatch(token.accessToken);
    }
  } else {
    await deleteOutlookSubscription(token.accessToken, existing.subscription_id);
  }

  // Deactivate in DB
  const supabase = getAdminClient();
  await supabase
    .from('notification_webhook_subscriptions')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('id', existing.id);

  console.log(`[manage-email-webhooks] ${resourceType} subscription deleted for ${provider}/${accountEmail}`);

  return jsonResponse({
    status: 'deleted',
    provider,
    resource_type: resourceType,
    account_email: accountEmail,
  });
}

// ── Ensure (idempotent) ──

async function handleEnsure(
  provider: 'google' | 'microsoft',
  handle: string,
  accountEmail: string,
  userId: string,
  resourceType: 'email' | 'calendar',
): Promise<Response> {
  const existing = await findSubscriptionByEmail(provider, accountEmail, resourceType);

  if (!existing) {
    // No subscription — create one
    return handleCreate(provider, handle, accountEmail, userId, resourceType);
  }

  // Check if expiring within 24 hours
  const expiresIn = new Date(existing.expiration).getTime() - Date.now();
  const twentyFourHours = 24 * 60 * 60 * 1000;

  if (expiresIn < twentyFourHours) {
    // Expiring soon — renew
    return handleRenew(provider, accountEmail, userId, resourceType);
  }

  // Still valid — no-op
  return jsonResponse({
    status: 'exists',
    provider,
    resource_type: resourceType,
    account_email: accountEmail,
    expiration: existing.expiration,
  });
}
