// Shared inline processor for notification webhook events.
// Called directly from gmail-webhook, outlook-webhook, and calendar-webhook
// for instant processing. Also used by email-webhook-cron as a fallback.

import { getAdminClient } from './supabase.ts';
import { getGoogleAccessToken, getMicrosoftAccessToken } from './token-broker.ts';
import { getGmailMessage, getOutlookEmail } from './gmail-helpers.ts';
import { sendMessage, createChat } from './linq.ts';
import { addMessage } from './state.ts';

// ── Unicode bold for iMessage (same as pipeline.ts) ──────────
const _BOLD_UPPER: Record<string, string> = {};
const _BOLD_LOWER: Record<string, string> = {};
const _BOLD_DIGIT: Record<string, string> = {};
for (let c = 65; c <= 90; c++) _BOLD_UPPER[String.fromCharCode(c)] = String.fromCodePoint(0x1D5D4 + (c - 65));
for (let c = 97; c <= 122; c++) _BOLD_LOWER[String.fromCharCode(c)] = String.fromCodePoint(0x1D5EE + (c - 97));
for (let c = 48; c <= 57; c++) _BOLD_DIGIT[String.fromCharCode(c)] = String.fromCodePoint(0x1D7EC + (c - 48));
const _BOLD_MAP: Record<string, string> = { ..._BOLD_UPPER, ..._BOLD_LOWER, ..._BOLD_DIGIT };

function toUnicodeBold(text: string): string {
  return [...text].map(c => _BOLD_MAP[c] ?? c).join('');
}

function formatAlertText(text: string): string {
  return text
    .replace(/\*\*([\s\S]+?)\*\*/g, (_m, p1) => toUnicodeBold(p1.trim()))
    .replace(/\u2014/g, '-')
    .replace(/\u2013/g, '-')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
import {
  getGmailHistory,
  updateSubscriptionHistoryId,
  resolveChatId,
  resolveBotNumber,
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
} from './email-webhook-helpers.ts';
import {
  fetchRecentGoogleCalendarEvents,
  filterGoogleCalendarEventsForAlerts,
  fingerprintForCalendarEvent,
  upsertCalendarEventSnapshot,
} from './calendar-notification-snapshot.ts';

const TAG = '[process-notification]';

// ══════════════════════════════════════════════════════════════
// Main entry: process a Gmail notification inline
// ══════════════════════════════════════════════════════════════

export async function processGmailNotificationInline(
  accountEmail: string,
  historyId: string,
  subscriptionId: string,
  subscriptionHistoryId: string | null,
): Promise<void> {
  const supabase = getAdminClient();

  // Look up the subscription to get the handle
  const { data: subscription } = await supabase
    .from('notification_webhook_subscriptions')
    .select('id, handle, history_id')
    .eq('id', subscriptionId)
    .maybeSingle();

  if (!subscription) {
    console.warn(`${TAG} No subscription ${subscriptionId}`);
    return;
  }

  const handle = subscription.handle;
  const { userId, userName, userTz } = await resolveUserContext(handle);
  if (!userId) return;

  // Fetch emails using Gmail History API
  const startHistoryId = subscriptionHistoryId ?? subscription.history_id ?? historyId;
  const token = await getGoogleAccessToken(userId, { email: accountEmail });
  const historyResult = await getGmailHistory(token.accessToken, startHistoryId);

  // Update stored historyId
  if (historyResult.latestHistoryId !== startHistoryId) {
    await updateSubscriptionHistoryId(subscription.id, historyResult.latestHistoryId);
  }

  if (historyResult.messageIds.length === 0) {
    console.log(`${TAG} No new messages for ${accountEmail}`);
    return;
  }

  // Fetch message details (limit to 5)
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
      console.warn(`${TAG} Failed to fetch Gmail message ${msgId}: ${(err as Error).message}`);
    }
  }

  if (emails.length === 0) return;

  // Load and evaluate triggers
  const triggers = await loadTriggers(handle);
  if (!triggers.length) return;

  const emailTriggers = triggers.filter(t => t.source_type === 'email' || t.source_type === 'any');
  if (!emailTriggers.length) return;

  for (const email of emails) {
    await evaluateAndDeliverEmail(email, emailTriggers, handle, userName, userTz);
  }
}

// ══════════════════════════════════════════════════════════════
// Main entry: process an Outlook notification inline
// ══════════════════════════════════════════════════════════════

export async function processOutlookNotificationInline(
  accountEmail: string,
  subscriptionId: string,
  resource: string,
  changeType: string,
  sourceType: 'email' | 'calendar',
): Promise<void> {
  const supabase = getAdminClient();

  const { data: subscription } = await supabase
    .from('notification_webhook_subscriptions')
    .select('id, handle')
    .eq('id', subscriptionId)
    .maybeSingle();

  if (!subscription) {
    console.warn(`${TAG} No subscription ${subscriptionId}`);
    return;
  }

  const handle = subscription.handle;
  const { userId, userName, userTz } = await resolveUserContext(handle);
  if (!userId) return;

  if (sourceType === 'calendar') {
    // TODO: fetch Outlook calendar event details and evaluate calendar triggers
    console.log(`${TAG} Outlook calendar notification for ${accountEmail} — not yet implemented`);
    return;
  }

  // Email: fetch the message
  const parts = resource.split('/');
  const messageId = parts[parts.length - 1];
  if (!messageId) return;

  const token = await getMicrosoftAccessToken(userId, { email: accountEmail });

  try {
    const msg = await getOutlookEmail(token.accessToken, messageId, userTz) as Record<string, unknown>;
    const email: EmailData = {
      from: (msg.from as string) ?? '',
      to: (msg.to as string) ?? '',
      subject: (msg.subject as string) ?? '',
      snippet: ((msg.body as string) ?? '').slice(0, 200),
      bodyPreview: ((msg.body as string) ?? '').slice(0, 2000),
      provider: 'microsoft',
    };

    const triggers = await loadTriggers(handle);
    if (!triggers.length) return;

    const emailTriggers = triggers.filter(t => t.source_type === 'email' || t.source_type === 'any');
    if (!emailTriggers.length) return;

    await evaluateAndDeliverEmail(email, emailTriggers, handle, userName, userTz);
  } catch (err) {
    console.warn(`${TAG} Failed to fetch Outlook email ${messageId}: ${(err as Error).message}`);
  }
}

// ══════════════════════════════════════════════════════════════
// Main entry: process a Google Calendar notification inline
// ══════════════════════════════════════════════════════════════

export async function processCalendarNotificationInline(
  accountEmail: string,
  subscriptionId: string,
): Promise<void> {
  const supabase = getAdminClient();

  const { data: subscription } = await supabase
    .from('notification_webhook_subscriptions')
    .select('id, handle')
    .eq('id', subscriptionId)
    .maybeSingle();

  if (!subscription) {
    console.warn(`${TAG} No subscription ${subscriptionId}`);
    return;
  }

  const handle = subscription.handle;
  const { userId, userName, userTz } = await resolveUserContext(handle);
  if (!userId) return;

  const triggers = await loadTriggers(handle);
  if (!triggers.length) return;

  const calTriggers = triggers.filter(t => t.source_type === 'calendar' || t.source_type === 'any');
  if (!calTriggers.length) return;

  // Fetch recent calendar changes
  try {
    const token = await getGoogleAccessToken(userId, { email: accountEmail });
    const raw = await fetchRecentGoogleCalendarEvents(token.accessToken);
    const events = await filterGoogleCalendarEventsForAlerts(supabase, subscription.id, raw);

    if (events.length === 0) {
      console.log(`${TAG} No meaningful calendar changes for ${accountEmail}`);
      return;
    }

    for (const event of events) {
      try {
        await evaluateAndDeliverCalendar(event, calTriggers, handle, userName, userTz);
        await upsertCalendarEventSnapshot(
          supabase,
          subscription.id,
          event.eventId,
          fingerprintForCalendarEvent(event),
        );
      } catch (err) {
        console.warn(`${TAG} Calendar deliver/snapshot failed for ${event.eventId}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.warn(`${TAG} Failed to fetch calendar changes: ${(err as Error).message}`);
  }
}

// ══════════════════════════════════════════════════════════════
// Shared helpers
// ══════════════════════════════════════════════════════════════

async function resolveUserContext(handle: string): Promise<{
  userId: string | null;
  userName: string;
  userTz: string;
}> {
  const supabase = getAdminClient();
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('auth_user_id, name, timezone')
    .eq('handle', handle)
    .maybeSingle();

  const userId = (profile as { auth_user_id: string | null } | null)?.auth_user_id;
  if (!userId) {
    console.warn(`${TAG} No auth_user_id for handle ${handle}`);
    return { userId: null, userName: '', userTz: 'Australia/Melbourne' };
  }

  const userName = await resolveNameForAlerts(
    supabase,
    userId,
    (profile as { name: string | null } | null)?.name,
  );
  const tzRaw = (profile as { timezone: string | null } | null)?.timezone;
  const userTz = (tzRaw && tzRaw.trim()) || 'Australia/Melbourne';

  return { userId, userName, userTz };
}

async function loadTriggers(handle: string): Promise<TriggerDef[]> {
  const supabase = getAdminClient();
  const { data: triggers } = await supabase.rpc('get_active_triggers_for_handle', {
    p_handle: handle,
  });

  if (!triggers || triggers.length === 0) {
    console.log(`${TAG} No active triggers for ${handle}`);
    return [];
  }

  return triggers as TriggerDef[];
}

async function evaluateAndDeliverEmail(
  email: EmailData,
  triggers: TriggerDef[],
  handle: string,
  userName: string,
  userTz: string,
): Promise<void> {
  const activeTriggers = triggers.filter(t => checkTimeConstraint(t.time_constraint, userTz));
  if (activeTriggers.length === 0) return;

  const { fastMatches, needsAiEval } = evaluateTriggersForEmail(email, activeTriggers);
  const aiMatches = await aiEvaluateTriggers(email, needsAiEval);
  const allMatches = [...fastMatches, ...aiMatches];

  if (allMatches.length === 0) return;

  console.log(`${TAG} ${allMatches.length} trigger(s) matched for email from ${email.from}: ${allMatches.map(m => m.triggerName).join(', ')}`);

  await deliverAlerts(allMatches, handle, async (match) => {
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
  const activeTriggers = triggers.filter(t => checkTimeConstraint(t.time_constraint, userTz));
  if (activeTriggers.length === 0) return;

  const { fastMatches, needsAiEval } = evaluateTriggersForCalendarEvent(event, activeTriggers);
  const aiMatches = await aiEvaluateCalendarTriggers(event, needsAiEval);
  const allMatches = [...fastMatches, ...aiMatches];

  if (allMatches.length === 0) return;

  console.log(`${TAG} ${allMatches.length} calendar trigger(s) matched for "${event.title}": ${allMatches.map(m => m.triggerName).join(', ')}`);

  await deliverAlerts(allMatches, handle, async (match) => {
    return await generateCalendarAlertMessage(event, match.triggerName, match.matchReason, userName, userTz);
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function deliverAlerts(
  matches: TriggerMatch[],
  handle: string,
  generateMsg: (match: TriggerMatch) => Promise<string>,
): Promise<void> {
  const supabase = getAdminClient();

  let chatId = await resolveChatId(handle);
  if (chatId && !UUID_RE.test(chatId)) {
    console.warn(`${TAG} resolveChatId returned non-UUID "${chatId}" for ${handle}, ignoring`);
    chatId = null;
  }

  const botNumber = !chatId ? await resolveBotNumber(handle) : null;
  if (!chatId && !botNumber) {
    console.warn(`${TAG} No chatId or botNumber found for ${handle}, cannot deliver alerts`);
    return;
  }

  for (const match of matches) {
    if (match.deliveryMethod === 'silent_log') {
      console.log(`${TAG} Silent log: trigger "${match.triggerName}" fired for ${handle}`);
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
        console.log(`${TAG} Created new chat ${deliveredChatId} for ${handle}`);
      }

      try {
        await addMessage(deliveredChatId, 'assistant', alertMsg);
      } catch (err) {
        console.warn(`${TAG} Failed to store alert in history:`, err);
      }

      await supabase.rpc('mark_trigger_fired', { p_id: match.triggerId });

      try {
        await supabase.rpc('touch_bill_reminder_automation_after_send', {
          p_trigger_id: match.triggerId,
        });
      } catch (e) {
        console.warn(`${TAG} touch_bill_reminder_automation_after_send: ${(e as Error).message}`);
      }

      console.log(`${TAG} Alert delivered to ${handle}: "${match.triggerName}"`);
    } catch (err) {
      console.error(`${TAG} Failed to deliver alert for trigger ${match.triggerId}: ${(err as Error).message}`);
    }
  }
}

