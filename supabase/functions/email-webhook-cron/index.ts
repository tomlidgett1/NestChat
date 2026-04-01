import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getAdminClient } from '../_shared/supabase.ts';
import { getGoogleAccessToken, getMicrosoftAccessToken } from '../_shared/token-broker.ts';
import { getGmailMessage, getOutlookEmail, type GmailMessageData } from '../_shared/gmail-helpers.ts';
import { getUserProfile, addMessage } from '../_shared/state.ts';
import { sendMessage, createChat } from '../_shared/linq.ts';
import { getOptionalEnv } from '../_shared/env.ts';
import {
  getGmailHistory,
  setupGmailWatch,
  setupGoogleCalendarWatch,
  stopGoogleCalendarWatch,
  renewOutlookSubscription,
  updateSubscriptionHistoryId,
  updateSubscriptionExpiration,
  markSubscriptionError,
  resolveBotNumber,
  resolveChatId,
  checkTimeConstraint,
  evaluateTriggersForEmail,
  aiEvaluateTriggers,
  generateAlertMessage,
  evaluateTriggersForCalendarEvent,
  aiEvaluateCalendarTriggers,
  generateCalendarAlertMessage,
  resolveNameForAlerts,
  type EmailData,
  type CalendarEventData,
  type TriggerDef,
  type TriggerMatch,
} from '../_shared/email-webhook-helpers.ts';
import {
  fetchRecentGoogleCalendarEvents,
  filterGoogleCalendarEventsForAlerts,
  fingerprintForCalendarEvent,
  upsertCalendarEventSnapshot,
} from '../_shared/calendar-notification-snapshot.ts';

// ── Unicode bold for iMessage ──────────────────────────────────
const _BU: Record<string, string> = {};
const _BL: Record<string, string> = {};
const _BD: Record<string, string> = {};
for (let c = 65; c <= 90; c++) _BU[String.fromCharCode(c)] = String.fromCodePoint(0x1D5D4 + (c - 65));
for (let c = 97; c <= 122; c++) _BL[String.fromCharCode(c)] = String.fromCodePoint(0x1D5EE + (c - 97));
for (let c = 48; c <= 57; c++) _BD[String.fromCharCode(c)] = String.fromCodePoint(0x1D7EC + (c - 48));
const _BM: Record<string, string> = { ..._BU, ..._BL, ..._BD };
function toUnicodeBold(t: string): string { return [...t].map(c => _BM[c] ?? c).join(''); }
function formatAlertText(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, (_m, p1) => toUnicodeBold(p1)).replace(/\u2014/g, '-').replace(/\u2013/g, '-').replace(/\n{3,}/g, '\n\n').trim();
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Email Webhook Cron — dual-mode edge function called by pg_cron.
 *
 * mode: 'process' — Claim pending webhook events, fetch emails, evaluate triggers, deliver alerts.
 * mode: 'renew'   — Renew expiring Gmail watches and Outlook subscriptions.
 */
Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') {
      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    const body = await req.json().catch(() => ({}));
    const mode = (body as { mode?: string }).mode ?? 'process';

    if (mode === 'renew') {
      return await handleRenew();
    }

    return await handleProcess();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[email-webhook-cron] Fatal error:', msg);
    return jsonResponse({ error: msg }, 500);
  }
});

// ══════════════════════════════════════════════════════════════
// MODE: PROCESS — Fetch emails from webhook events, evaluate triggers
// ══════════════════════════════════════════════════════════════

async function handleProcess(): Promise<Response> {
  const supabase = getAdminClient();

  // Claim a batch of pending events
  const { data: events, error: claimError } = await supabase.rpc('claim_pending_webhook_events', {
    p_limit: 10,
  });

  if (claimError) {
    console.error(`[email-webhook-cron] claim_pending_webhook_events failed: ${claimError.message}`);
    return jsonResponse({ error: claimError.message }, 500);
  }

  if (!events || events.length === 0) {
    return jsonResponse({ message: 'No pending events', processed: 0 });
  }

  console.log(`[email-webhook-cron] Processing ${events.length} event(s)`);

  let processed = 0;
  const errors: string[] = [];

  for (const event of events) {
    try {
      await processEvent(event);
      await supabase.rpc('complete_webhook_event', { p_id: event.id, p_status: 'completed' });
      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[email-webhook-cron] Event ${event.id} failed: ${msg}`);
      await supabase.rpc('complete_webhook_event', {
        p_id: event.id,
        p_status: 'failed',
        p_error: msg.slice(0, 500),
      });
      errors.push(`${event.id}: ${msg.slice(0, 100)}`);
    }
  }

  return jsonResponse({
    message: `Processed ${events.length} event(s)`,
    processed,
    total: events.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}

async function processEvent(event: {
  id: number;
  provider: string;
  account_email: string;
  subscription_id: string;
  history_id: string | null;
  resource_data: Record<string, unknown> | null;
  change_type: string | null;
  source_type: string | null;
}): Promise<void> {
  const supabase = getAdminClient();

  // Look up the subscription to get the handle
  const { data: subscription } = await supabase
    .from('notification_webhook_subscriptions')
    .select('id, handle, history_id, resource_type')
    .eq('id', event.subscription_id)
    .maybeSingle();

  if (!subscription) {
    console.warn(`[email-webhook-cron] No subscription for event ${event.id}, skipping`);
    return;
  }

  const handle = subscription.handle;
  const sourceType = event.source_type ?? subscription.resource_type ?? 'email';

  // Resolve user_id from handle for token acquisition
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('auth_user_id, name, timezone')
    .eq('handle', handle)
    .maybeSingle();

  const userId = (profile as { auth_user_id: string | null } | null)?.auth_user_id;
  if (!userId) {
    console.warn(`[email-webhook-cron] No auth_user_id for handle ${handle}, skipping`);
    return;
  }

  const userName = await resolveNameForAlerts(
    supabase,
    userId,
    (profile as { name: string | null } | null)?.name,
  );
  const tzRaw = (profile as { timezone: string | null } | null)?.timezone;
  const userTz = (tzRaw && tzRaw.trim()) || 'Australia/Melbourne';

  // Load active triggers for this user
  const { data: triggers } = await supabase.rpc('get_active_triggers_for_handle', {
    p_handle: handle,
  });

  if (!triggers || triggers.length === 0) {
    console.log(`[email-webhook-cron] No active triggers for ${handle}`);
    return;
  }

  // Route based on source type
  if (sourceType === 'calendar') {
    await processCalendarEvent(
      event,
      userId,
      handle,
      userName,
      userTz,
      triggers as TriggerDef[],
    );
  } else {
    await processEmailEvent(event, userId, subscription, handle, userName, userTz, triggers as TriggerDef[]);
  }
}

async function processEmailEvent(
  event: {
    id: number;
    provider: string;
    account_email: string;
    history_id: string | null;
    resource_data: Record<string, unknown> | null;
  },
  userId: string,
  subscription: { id: string; history_id: string | null },
  handle: string,
  userName: string,
  userTz: string,
  triggers: TriggerDef[],
): Promise<void> {
  // Fetch the actual email(s) that triggered this event
  let emails: EmailData[] = [];

  if (event.provider === 'google') {
    emails = await fetchGmailEmails(userId, event.account_email, subscription, event.history_id);
  } else {
    emails = await fetchOutlookEmail(userId, event.account_email, event.resource_data, userTz);
  }

  if (emails.length === 0) {
    console.log(`[email-webhook-cron] No new emails for event ${event.id}`);
    return;
  }

  // Filter triggers to email-relevant ones
  const emailTriggers = triggers.filter(t => t.source_type === 'email' || t.source_type === 'any');

  if (emailTriggers.length === 0) {
    console.log(`[email-webhook-cron] No email triggers for ${handle}`);
    return;
  }

  // Evaluate each email against triggers
  for (const email of emails) {
    await evaluateAndDeliver(email, emailTriggers, handle, userName, userTz);
  }
}

async function processCalendarEvent(
  event: {
    id: number;
    provider: string;
    account_email: string;
    subscription_id: string;
    resource_data: Record<string, unknown> | null;
    change_type: string | null;
  },
  userId: string,
  handle: string,
  userName: string,
  userTz: string,
  triggers: TriggerDef[],
): Promise<void> {
  const supabase = getAdminClient();

  // Build CalendarEventData from webhook resource_data
  const rd = event.resource_data ?? {};
  const calendarEvent: CalendarEventData = {
    eventId: (rd.eventId as string) ?? (rd.resourceId as string) ?? `${event.id}`,
    title: (rd.title as string) ?? (rd.summary as string) ?? (rd.subject as string) ?? 'Unknown event',
    organizer: (rd.organizer as string) ?? (rd.organizerEmail as string) ?? event.account_email,
    start: (rd.start as string) ?? '',
    end: (rd.end as string) ?? '',
    status: ((rd.status as string) ?? 'confirmed') as 'confirmed' | 'cancelled' | 'tentative',
    changeType: mapChangeType(event.change_type),
    attendees: (rd.attendees as string[]) ?? undefined,
    location: (rd.location as string) ?? undefined,
    provider: event.provider as 'google' | 'microsoft',
  };

  const calTriggers = triggers.filter(t => t.source_type === 'calendar' || t.source_type === 'any');
  if (calTriggers.length === 0) {
    console.log(`[email-webhook-cron] No calendar triggers for ${handle}`);
    return;
  }

  // Google Calendar: webhook payload has no reliable diff — fetch recent events and only
  // alert when start/end/location/status meaningfully change (not RSVP-only updates).
  if (event.provider === 'google') {
    try {
      const token = await getGoogleAccessToken(userId, { email: event.account_email });
      const raw = await fetchRecentGoogleCalendarEvents(token.accessToken);
      const enriched = await filterGoogleCalendarEventsForAlerts(supabase, event.subscription_id, raw);
      if (enriched.length === 0) {
        console.log(`[email-webhook-cron] No meaningful Google Calendar changes for ${handle}`);
        return;
      }
      for (const ce of enriched) {
        try {
          await evaluateAndDeliverCalendar(ce, calTriggers, handle, userName, userTz);
          await upsertCalendarEventSnapshot(
            supabase,
            event.subscription_id,
            ce.eventId,
            fingerprintForCalendarEvent(ce),
          );
        } catch (err) {
          console.warn(
            `[email-webhook-cron] Calendar deliver/snapshot failed for ${ce.eventId}: ${(err as Error).message}`,
          );
        }
      }
      return;
    } catch (err) {
      console.warn(`[email-webhook-cron] Failed to fetch Google Calendar changes: ${(err as Error).message}`);
      return;
    }
  }

  await evaluateAndDeliverCalendar(calendarEvent, calTriggers, handle, userName, userTz);
}

function mapChangeType(changeType: string | null): 'created' | 'updated' | 'deleted' {
  if (!changeType) return 'updated';
  const ct = changeType.toLowerCase();
  if (ct === 'created' || ct === 'exists') return 'created';
  if (ct === 'deleted') return 'deleted';
  return 'updated';
}

async function fetchGmailEmails(
  userId: string,
  accountEmail: string,
  subscription: { id: string; history_id: string | null },
  eventHistoryId: string | null,
): Promise<EmailData[]> {
  const startHistoryId = subscription.history_id ?? eventHistoryId;
  if (!startHistoryId) return [];

  const token = await getGoogleAccessToken(userId, { email: accountEmail });
  const historyResult = await getGmailHistory(token.accessToken, startHistoryId);

  // Update stored historyId
  if (historyResult.latestHistoryId !== startHistoryId) {
    await updateSubscriptionHistoryId(subscription.id, historyResult.latestHistoryId);
  }

  if (historyResult.messageIds.length === 0) return [];

  // Fetch message details (limit to 5 to avoid overload)
  const messageIds = historyResult.messageIds.slice(0, 5);
  const emails: EmailData[] = [];

  for (const msgId of messageIds) {
    try {
      const msg = await getGmailMessage(token.accessToken, msgId);
      emails.push({
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        snippet: msg.snippet,
        bodyPreview: msg.bodyPreview,
        labelIds: msg.labelIds,
        isImportant: msg.isImportant,
        provider: 'google',
      });
    } catch (err) {
      console.warn(`[email-webhook-cron] Failed to fetch Gmail message ${msgId}: ${(err as Error).message}`);
    }
  }

  return emails;
}

async function fetchOutlookEmail(
  userId: string,
  accountEmail: string,
  resourceData: Record<string, unknown> | null,
  tz: string,
): Promise<EmailData[]> {
  if (!resourceData?.resource) return [];

  const token = await getMicrosoftAccessToken(userId, { email: accountEmail });
  const resource = resourceData.resource as string;

  // Extract message ID from resource path (e.g., "me/messages/{id}")
  const parts = resource.split('/');
  const messageId = parts[parts.length - 1];

  if (!messageId) return [];

  try {
    const msg = await getOutlookEmail(token.accessToken, messageId, tz) as Record<string, unknown>;
    return [{
      from: (msg.from as string) ?? '',
      to: (msg.to as string) ?? '',
      subject: (msg.subject as string) ?? '',
      snippet: ((msg.body as string) ?? '').slice(0, 200),
      bodyPreview: ((msg.body as string) ?? '').slice(0, 2000),
      provider: 'microsoft',
    }];
  } catch (err) {
    console.warn(`[email-webhook-cron] Failed to fetch Outlook email ${messageId}: ${(err as Error).message}`);
    return [];
  }
}

async function evaluateAndDeliver(
  email: EmailData,
  triggers: TriggerDef[],
  handle: string,
  userName: string,
  userTz: string,
): Promise<void> {
  // Filter by time constraints before evaluation
  const activeTriggers = triggers.filter(t => checkTimeConstraint(t.time_constraint, userTz));

  if (activeTriggers.length === 0) {
    console.log(`[email-webhook-cron] All triggers filtered out by time constraints for ${handle}`);
    return;
  }

  const { fastMatches, needsAiEval } = evaluateTriggersForEmail(email, activeTriggers);

  // AI evaluation for remaining triggers
  const aiMatches = await aiEvaluateTriggers(email, needsAiEval);

  const allMatches = [...fastMatches, ...aiMatches];

  if (allMatches.length === 0) return;

  console.log(`[email-webhook-cron] ${allMatches.length} trigger(s) matched for email from ${email.from}: ${allMatches.map(m => m.triggerName).join(', ')}`);

  await deliverAlerts(allMatches, handle, userName, async (match) => {
    return await generateAlertMessage(email, match.triggerName, match.matchReason, userName);
  });
}

async function evaluateAndDeliverCalendar(
  event: CalendarEventData,
  triggers: TriggerDef[],
  handle: string,
  userName: string,
  userTz: string,
): Promise<void> {
  // Filter by time constraints before evaluation
  const activeTriggers = triggers.filter(t => checkTimeConstraint(t.time_constraint, userTz));

  if (activeTriggers.length === 0) {
    console.log(`[email-webhook-cron] All calendar triggers filtered out by time constraints for ${handle}`);
    return;
  }

  const { fastMatches, needsAiEval } = evaluateTriggersForCalendarEvent(event, activeTriggers);

  // AI evaluation for remaining triggers
  const aiMatches = await aiEvaluateCalendarTriggers(event, needsAiEval);

  const allMatches = [...fastMatches, ...aiMatches];

  if (allMatches.length === 0) return;

  console.log(`[email-webhook-cron] ${allMatches.length} calendar trigger(s) matched for "${event.title}": ${allMatches.map(m => m.triggerName).join(', ')}`);

  await deliverAlerts(allMatches, handle, userName, async (match) => {
    return await generateCalendarAlertMessage(event, match.triggerName, match.matchReason, userName, userTz);
  });
}

async function deliverAlerts(
  matches: TriggerMatch[],
  handle: string,
  _userName: string,
  generateMsg: (match: TriggerMatch) => Promise<string>,
): Promise<void> {
  const supabase = getAdminClient();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  let chatId = await resolveChatId(handle);
  if (chatId && !UUID_RE.test(chatId)) {
    console.warn(`[email-webhook-cron] resolveChatId returned non-UUID "${chatId}" for ${handle}, ignoring`);
    chatId = null;
  }

  const botNumber = !chatId ? await resolveBotNumber(handle) : null;
  if (!chatId && !botNumber) {
    console.warn(`[email-webhook-cron] No chatId or botNumber found for ${handle}, cannot deliver alerts`);
    return;
  }

  if (chatId) {
    console.log(`[email-webhook-cron] Resolved chatId for ${handle}: ${chatId}`);
  } else {
    console.log(`[email-webhook-cron] No chatId for ${handle}, will use createChat with bot ${botNumber}`);
  }

  for (const match of matches) {
    if (match.deliveryMethod === 'silent_log') {
      console.log(`[email-webhook-cron] Silent log: trigger "${match.triggerName}" fired for ${handle}`);
      await supabase.rpc('mark_trigger_fired', { p_id: match.triggerId });
      continue;
    }

    try {
      const rawMsg = await generateMsg(match);
      const alertMsg = formatAlertText(rawMsg);

      let deliveredChatId: string;
      if (chatId) {
        await sendMessage(chatId, alertMsg);
        deliveredChatId = chatId;
      } else {
        const result = await createChat(botNumber!, [handle], alertMsg);
        deliveredChatId = result.chat.id;
      }

      // Store in conversation history so the bot has context if user replies
      try {
        await addMessage(deliveredChatId, 'assistant', alertMsg);
      } catch (err) {
        console.warn(`[email-webhook-cron] Failed to store alert in history:`, err);
      }

      await supabase.rpc('mark_trigger_fired', { p_id: match.triggerId });

      try {
        await supabase.rpc('touch_bill_reminder_automation_after_send', {
          p_trigger_id: match.triggerId,
        });
      } catch (e) {
        console.warn(
          `[email-webhook-cron] touch_bill_reminder_automation_after_send: ${(e as Error).message}`,
        );
      }

      console.log(`[email-webhook-cron] Alert delivered to ${handle}: "${match.triggerName}"`);
    } catch (err) {
      console.error(`[email-webhook-cron] Failed to deliver alert for trigger ${match.triggerId}: ${(err as Error).message}`);
    }
  }
}

// ══════════════════════════════════════════════════════════════
// MODE: RENEW — Renew expiring subscriptions
// ══════════════════════════════════════════════════════════════

async function handleRenew(): Promise<Response> {
  const supabase = getAdminClient();

  const { data: subscriptions, error } = await supabase.rpc('get_expiring_subscriptions', {
    p_within_hours: 48,
  });

  if (error) {
    console.error(`[email-webhook-cron] get_expiring_subscriptions failed: ${error.message}`);
    return jsonResponse({ error: error.message }, 500);
  }

  if (!subscriptions || subscriptions.length === 0) {
    return jsonResponse({ message: 'No subscriptions need renewal', renewed: 0 });
  }

  console.log(`[email-webhook-cron] Renewing ${subscriptions.length} subscription(s)`);

  let renewed = 0;
  const errors: string[] = [];

  for (const sub of subscriptions) {
    try {
      // Resolve user_id from handle
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('auth_user_id')
        .eq('handle', sub.handle)
        .maybeSingle();

      const userId = (profile as { auth_user_id: string | null } | null)?.auth_user_id;
      if (!userId) {
        console.warn(`[email-webhook-cron] No auth_user_id for handle ${sub.handle}, skipping renewal`);
        continue;
      }

      const resourceType = sub.resource_type ?? 'email';

      if (sub.provider === 'google') {
        const token = await getGoogleAccessToken(userId, { email: sub.account_email });

        if (resourceType === 'calendar') {
          // Google Calendar watch renewal — stop old channel + create new one
          const supabaseUrl = getOptionalEnv('SUPABASE_URL') ?? '';
          const webhookUrl = `${supabaseUrl}/functions/v1/calendar-webhook`;

          // Stop the old channel if we have its IDs
          if (sub.channel_id && sub.resource_id) {
            try {
              await stopGoogleCalendarWatch(token.accessToken, sub.channel_id, sub.resource_id);
            } catch {
              console.warn(`[email-webhook-cron] Failed to stop old calendar channel ${sub.channel_id}`);
            }
          }

          const result = await setupGoogleCalendarWatch(token.accessToken, 'primary', webhookUrl);
          const expiration = new Date(parseInt(result.expiration, 10));
          await updateSubscriptionExpiration(sub.id, expiration);

          // Update channel_id and resource_id
          await supabase
            .from('notification_webhook_subscriptions')
            .update({ channel_id: result.channelId, resource_id: result.resourceId })
            .eq('id', sub.id);

          console.log(`[email-webhook-cron] Calendar watch renewed for ${sub.account_email}, expires=${expiration.toISOString()}`);
        } else {
          // Gmail Pub/Sub watch renewal
          const topicName = getOptionalEnv('GOOGLE_PUBSUB_TOPIC');
          if (!topicName) {
            console.warn('[email-webhook-cron] GOOGLE_PUBSUB_TOPIC not configured, skipping Gmail renewal');
            continue;
          }

          const result = await setupGmailWatch(token.accessToken, topicName);
          const expiration = new Date(parseInt(result.expiration, 10));
          await updateSubscriptionExpiration(sub.id, expiration);

          console.log(`[email-webhook-cron] Gmail watch renewed for ${sub.account_email}, expires=${expiration.toISOString()}`);
        }
      } else {
        // Microsoft — renewal works the same for both email and calendar
        const token = await getMicrosoftAccessToken(userId, { email: sub.account_email });
        const newExpiration = await renewOutlookSubscription(token.accessToken, sub.subscription_id);

        const expiration = new Date(newExpiration);
        await updateSubscriptionExpiration(sub.id, expiration);

        console.log(`[email-webhook-cron] ${resourceType} subscription renewed for ${sub.account_email}, expires=${expiration.toISOString()}`);
      }

      renewed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[email-webhook-cron] Renewal failed for ${sub.provider}/${sub.account_email}: ${msg}`);
      await markSubscriptionError(sub.id, msg, sub.error_count);
      errors.push(`${sub.account_email}: ${msg.slice(0, 100)}`);
    }
  }

  return jsonResponse({
    message: `Renewed ${renewed}/${subscriptions.length} subscription(s)`,
    renewed,
    total: subscriptions.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}
