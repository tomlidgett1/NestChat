// Email Webhook Helpers — Gmail Pub/Sub + Outlook Graph Change Notifications
// Shared by gmail-webhook, outlook-webhook, manage-email-webhooks, email-webhook-cron

import { getAdminClient } from './supabase.ts';
import { getGoogleAccessToken, getMicrosoftAccessToken, type TokenOptions } from './token-broker.ts';
import { getOptionalEnv } from './env.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GRAPH_API = 'https://graph.microsoft.com/v1.0';

// ══════════════════════════════════════════════════════════════
// ALERT DISPLAY NAMES (calendar / email notifications)
// ══════════════════════════════════════════════════════════════

/** First given name for alerts, title-cased. Empty if missing. */
export function displayNameForAlerts(name: string | null | undefined): string {
  const t = (name ?? '').trim();
  if (!t) return '';
  const first = t.split(/\s+/)[0] ?? '';
  if (!first) return '';
  const lower = first.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Prefer `user_profiles.name`, then Supabase Auth `user_metadata` (full_name / name / given_name).
 */
export async function resolveNameForAlerts(
  supabase: SupabaseClient,
  authUserId: string,
  profileName: string | null | undefined,
): Promise<string> {
  const fromProfile = displayNameForAlerts(profileName);
  if (fromProfile) return fromProfile;
  try {
    const { data, error } = await supabase.auth.admin.getUserById(authUserId);
    if (error || !data.user) return '';
    const meta = data.user.user_metadata as Record<string, unknown> | undefined;
    const raw =
      (typeof meta?.full_name === 'string' && meta.full_name.trim()) ||
      (typeof meta?.name === 'string' && meta.name.trim()) ||
      (typeof meta?.given_name === 'string' && meta.given_name.trim()) ||
      '';
    return displayNameForAlerts(raw);
  } catch {
    return '';
  }
}

// ══════════════════════════════════════════════════════════════
// GMAIL — Watch Management
// ══════════════════════════════════════════════════════════════

export interface GmailWatchResult {
  historyId: string;
  expiration: string; // unix ms timestamp as string
}

export async function setupGmailWatch(
  accessToken: string,
  topicName: string,
): Promise<GmailWatchResult> {
  const resp = await fetch(`${GMAIL_API}/watch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      topicName,
      labelIds: ['INBOX'],
      labelFilterBehavior: 'INCLUDE',
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Gmail watch failed (${resp.status}): ${detail.slice(0, 300)}`);
  }

  const data = await resp.json();
  return {
    historyId: String(data.historyId),
    expiration: String(data.expiration),
  };
}

export async function stopGmailWatch(accessToken: string): Promise<void> {
  const resp = await fetch(`${GMAIL_API}/stop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok && resp.status !== 404) {
    const detail = await resp.text().catch(() => '');
    console.warn(`[email-webhook] Gmail stop watch failed (${resp.status}): ${detail.slice(0, 200)}`);
  }
}

// ══════════════════════════════════════════════════════════════
// GMAIL — History
// ══════════════════════════════════════════════════════════════

export interface GmailHistoryResult {
  messageIds: string[];
  latestHistoryId: string;
}

export async function getGmailHistory(
  accessToken: string,
  startHistoryId: string,
): Promise<GmailHistoryResult> {
  const messageIds: string[] = [];
  let pageToken: string | undefined;
  let latestHistoryId = startHistoryId;

  do {
    const params = new URLSearchParams({
      startHistoryId,
      historyTypes: 'messageAdded',
      maxResults: '50',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const resp = await fetch(`${GMAIL_API}/history?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!resp.ok) {
      if (resp.status === 404) {
        // historyId too old — return empty, caller should re-watch
        console.warn('[email-webhook] Gmail history 404 — historyId expired');
        return { messageIds: [], latestHistoryId: startHistoryId };
      }
      const detail = await resp.text().catch(() => '');
      throw new Error(`Gmail history.list failed (${resp.status}): ${detail.slice(0, 200)}`);
    }

    const data = await resp.json();

    if (data.historyId) {
      latestHistoryId = String(data.historyId);
    }

    for (const record of data.history ?? []) {
      for (const added of record.messagesAdded ?? []) {
        if (added.message?.id) {
          messageIds.push(added.message.id);
        }
      }
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  // Deduplicate
  const unique = [...new Set(messageIds)];
  return { messageIds: unique, latestHistoryId };
}

// ══════════════════════════════════════════════════════════════
// OUTLOOK — Subscription Management
// ══════════════════════════════════════════════════════════════

export interface OutlookSubscriptionResult {
  subscriptionId: string;
  expirationDateTime: string;
}

export async function createOutlookSubscription(
  accessToken: string,
  notificationUrl: string,
  resource: string,
  clientState: string,
  lifecycleNotificationUrl?: string,
): Promise<OutlookSubscriptionResult> {
  // Max 7 days for basic notifications (10080 minutes)
  const expiration = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000); // 6 days for safety margin

  const body: Record<string, unknown> = {
    changeType: 'created,updated',
    notificationUrl,
    resource,
    expirationDateTime: expiration.toISOString(),
    clientState,
    latestSupportedTlsVersion: 'v1_2',
  };

  if (lifecycleNotificationUrl) {
    body.lifecycleNotificationUrl = lifecycleNotificationUrl;
  }

  const resp = await fetch(`${GRAPH_API}/subscriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Outlook subscription create failed (${resp.status}): ${detail.slice(0, 300)}`);
  }

  const data = await resp.json();
  return {
    subscriptionId: data.id,
    expirationDateTime: data.expirationDateTime,
  };
}

export async function renewOutlookSubscription(
  accessToken: string,
  subscriptionId: string,
): Promise<string> {
  const expiration = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);

  const resp = await fetch(`${GRAPH_API}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expirationDateTime: expiration.toISOString(),
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Outlook subscription renew failed (${resp.status}): ${detail.slice(0, 300)}`);
  }

  const data = await resp.json();
  return data.expirationDateTime;
}

export async function deleteOutlookSubscription(
  accessToken: string,
  subscriptionId: string,
): Promise<void> {
  const resp = await fetch(`${GRAPH_API}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok && resp.status !== 404) {
    const detail = await resp.text().catch(() => '');
    console.warn(`[email-webhook] Outlook subscription delete failed (${resp.status}): ${detail.slice(0, 200)}`);
  }
}

// ══════════════════════════════════════════════════════════════
// TRIGGER EVALUATION
// ══════════════════════════════════════════════════════════════

export interface EmailData {
  from: string;
  to: string;
  subject: string;
  snippet: string;
  bodyPreview: string;
  labelIds?: string[];
  isImportant?: boolean;
  provider: 'google' | 'microsoft';
}

export interface TimeConstraint {
  after_hour?: number;
  before_hour?: number;
  days_of_week?: number[];
}

export interface TriggerDef {
  id: number;
  name: string;
  description: string;
  trigger_type: string;
  source_type: string;
  match_sender: string | null;
  match_subject_pattern: string | null;
  match_labels: string[] | null;
  use_ai_matching: boolean;
  ai_prompt: string | null;
  delivery_method: string;
  account_email: string | null;
  provider: string | null;
  time_constraint: TimeConstraint | null;
}

// Check if the current time satisfies a trigger's time constraint
export function checkTimeConstraint(
  constraint: TimeConstraint | null,
  timezone: string,
): boolean {
  if (!constraint) return true;

  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    weekday: 'short',
    hour12: false,
  }).formatToParts(now);

  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10) % 24;
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[parts.find(p => p.type === 'weekday')?.value ?? 'Mon'] ?? 1;

  if (constraint.days_of_week?.length && !constraint.days_of_week.includes(dow)) {
    return false;
  }

  if (constraint.after_hour !== undefined && constraint.before_hour !== undefined) {
    // Range like "after 22, before 6" means overnight window
    if (constraint.after_hour > constraint.before_hour) {
      return hour >= constraint.after_hour || hour < constraint.before_hour;
    }
    return hour >= constraint.after_hour && hour < constraint.before_hour;
  }

  if (constraint.after_hour !== undefined && hour < constraint.after_hour) return false;
  if (constraint.before_hour !== undefined && hour >= constraint.before_hour) return false;

  return true;
}

export interface TriggerMatch {
  triggerId: number;
  triggerName: string;
  matchReason: string;
  deliveryMethod: string;
}

/** Heuristic match for utility bills, invoices, and payment-due notices (no API call). */
function emailLooksLikeBillReminder(haystack: string): boolean {
  const t = haystack.toLowerCase();
  const patterns: RegExp[] = [
    /\boverdue\b/,
    /\bpast\s+due\b/,
    /\bupcoming\s+bill\b/,
    /\bupcoming\s+payment\b/,
    /\bpayment\s+reminder\b/,
    /\bupcoming\s+due\s+date\b/,
    /\bdue\s+soon\b/,
    /\bdue\s+tomorrow\b/,
    /\bdue\s+this\s+week\b/,
    /\bauto-?pay\b.*\bupcoming\b/,
    /\bupcoming\s+charge\b/,
    /\bpayment\s+scheduled\b/,
    /\brenewal\s+due\b/,
    /\bpayment\s+due\b/,
    /\bdue\s+date\b/,
    /\bdue\s+on\b/,
    /\bdue\s+by\b/,
    /\bpay\s+by\b/,
    /\bto\s+avoid\s+late\s+fees\b/,
    /\bbefore\s+it'?s\s+due\b/,
    /\bamount\s+due\b/,
    /\bbill\s+is\s+due\b/,
    /\bbill\s+due\b/,
    /\byour\s+bill\b.*\bdue\b/,
    /\binvoice\b.*\bdue\b/,
    /\bstatement\b.*\bdue\b/,
    /\bplease\s+pay\b/,
    /\breminder[:\s].*\bdue\b/,
    /\butility\b.*\bdue\b/,
    /\brate\s+notice\b.*\bdue\b/i,
  ];
  return patterns.some((re) => re.test(t));
}

export function evaluateTriggersForEmail(
  email: EmailData,
  triggers: TriggerDef[],
): { fastMatches: TriggerMatch[]; needsAiEval: TriggerDef[] } {
  const fastMatches: TriggerMatch[] = [];
  const needsAiEval: TriggerDef[] = [];

  for (const trigger of triggers) {
    // Skip if trigger is scoped to a different provider
    if (trigger.provider && trigger.provider !== email.provider) continue;

    let matched = false;
    let matchReason = '';

    // Bill / payment-due notices (dashboard "Bill reminders" moment + optional tool triggers)
    if (trigger.trigger_type === 'bill_reminder') {
      const haystack = [email.subject, email.snippet, email.bodyPreview].filter(Boolean).join('\n');
      if (emailLooksLikeBillReminder(haystack)) {
        matched = true;
        matchReason = 'bill or payment due signal in email';
      }
    }

    // Fast pre-filter: sender match
    if (trigger.match_sender) {
      const senderLower = email.from.toLowerCase();
      const matchLower = trigger.match_sender.toLowerCase();
      if (senderLower.includes(matchLower)) {
        matched = true;
        matchReason = `sender matches "${trigger.match_sender}"`;
      }
    }

    // Fast pre-filter: subject pattern match
    if (!matched && trigger.match_subject_pattern) {
      try {
        const regex = new RegExp(trigger.match_subject_pattern, 'i');
        if (regex.test(email.subject)) {
          matched = true;
          matchReason = `subject matches pattern "${trigger.match_subject_pattern}"`;
        }
      } catch {
        // Invalid regex — try simple includes
        if (email.subject.toLowerCase().includes(trigger.match_subject_pattern.toLowerCase())) {
          matched = true;
          matchReason = `subject contains "${trigger.match_subject_pattern}"`;
        }
      }
    }

    // Fast pre-filter: label match (Gmail only)
    if (!matched && trigger.match_labels?.length && email.labelIds?.length) {
      const overlap = trigger.match_labels.filter(l => email.labelIds!.includes(l));
      if (overlap.length > 0) {
        matched = true;
        matchReason = `labels match: ${overlap.join(', ')}`;
      }
    }

    if (matched) {
      fastMatches.push({
        triggerId: trigger.id,
        triggerName: trigger.name,
        matchReason,
        deliveryMethod: trigger.delivery_method,
      });
    } else if (trigger.use_ai_matching) {
      needsAiEval.push(trigger);
    }
  }

  return { fastMatches, needsAiEval };
}

// AI-based trigger evaluation using gpt-4.1-mini
export async function aiEvaluateTriggers(
  email: EmailData,
  triggers: TriggerDef[],
): Promise<TriggerMatch[]> {
  if (triggers.length === 0) return [];

  const apiKey = getOptionalEnv('OPENAI_API_KEY');
  if (!apiKey) {
    console.warn('[email-webhook] No OPENAI_API_KEY, skipping AI trigger evaluation');
    return [];
  }

  const triggerDescriptions = triggers
    .map((t, i) => `[${i}] ID=${t.id} "${t.name}": ${t.ai_prompt ?? t.description}`)
    .join('\n');

  const emailSummary = [
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    `Preview: ${(email.bodyPreview || email.snippet).slice(0, 500)}`,
  ].join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        max_output_tokens: 200,
        instructions: `You evaluate whether an email matches user-defined alert triggers.
Reply with ONLY a JSON array of matching trigger indices (0-based) and a brief reason.
Format: [{"index": 0, "reason": "refund confirmation from PayPal"}]
If no triggers match, reply with: []
Be reasonably generous — if the email is plausibly related to what the user asked about, include it.`,
        input: [
          {
            role: 'user',
            content: `TRIGGERS:\n${triggerDescriptions}\n\nEMAIL:\n${emailSummary}`,
          },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      console.warn(`[email-webhook] AI eval failed (${resp.status})`);
      return [];
    }

    const data = await resp.json();
    const textItem = data.output?.find((o: Record<string, unknown>) => o.type === 'message');
    const text = textItem?.content?.find(
      (c: Record<string, unknown>) => c.type === 'output_text',
    )?.text?.trim();

    if (!text) return [];

    // Parse JSON from response (may have markdown code fence)
    const jsonStr = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(jsonStr);

    if (!Array.isArray(parsed)) return [];

    const matches: TriggerMatch[] = [];
    for (const item of parsed) {
      const idx = item.index;
      if (typeof idx === 'number' && idx >= 0 && idx < triggers.length) {
        matches.push({
          triggerId: triggers[idx].id,
          triggerName: triggers[idx].name,
          matchReason: item.reason ?? 'AI match',
          deliveryMethod: triggers[idx].delivery_method,
        });
      }
    }
    return matches;
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === 'AbortError') {
      console.warn('[email-webhook] AI eval timed out');
    } else {
      console.warn('[email-webhook] AI eval error:', err);
    }
    return [];
  }
}

// ══════════════════════════════════════════════════════════════
// ALERT MESSAGE GENERATION
// ══════════════════════════════════════════════════════════════

const ALERT_SYSTEM_PROMPT = `You are Nest, sending a short iMessage on behalf of a sharp executive assistant. The user asked to be alerted when certain emails land.

ABSOLUTELY FORBIDDEN: the em dash character. Never output it anywhere. Use commas, hyphens (-), or colons instead.
ABSOLUTELY FORBIDDEN: the word "mate". Never use it.

Voice: calm, efficient, discreet. Like a trusted EA texting between meetings - not a chatbot, not a marketing email, not overly casual ("hey mate") and not stiff corporate ("please be advised"). You filter noise and surface what matters.

RULES:
- 2-4 short lines total. Tight. Scannable on a phone.
- Use actual line breaks between lines (not literal \\n)
- Use **bold** for who it is from (brand or person) and **bold** for the subject line
- Use their first name occasionally, not every message
- Lead with the point (what landed, why it matters in one breath)
- If something needs action or a deadline, say it plainly
- Australian spelling (e.g. cancelled, not canceled)
- Vary openings: "Quick flag -", "FYI -", "Heads up -", or straight into the point

EXAMPLES (EA tone):
Trigger: refund notice, From: PayPal, Subject: Your refund has been processed ->
Quick flag - **PayPal**, **Your refund has been processed**

Looks processed on their side. Shout if you want the full thread.

Trigger: contact email, From: sarah@company.com, Subject: Q2 Report Draft ->
**Sarah** - **Q2 Report Draft** in your inbox.

Ping me if you want a summary before you reply.`;

export async function generateAlertMessage(
  email: EmailData,
  triggerName: string,
  matchReason: string,
  userName: string,
): Promise<string> {
  const apiKey = getOptionalEnv('OPENAI_API_KEY');
  if (!apiKey) {
    const who = email.from.split('<')[0].trim() || email.from;
    return `${who} - ${email.subject}. Flagging because of your "${triggerName}" alert.`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        max_output_tokens: 140,
        instructions: ALERT_SYSTEM_PROMPT,
        input: [
          {
            role: 'user',
            content: `User's name: ${userName || 'unknown'}\nTrigger: "${triggerName}"\nMatch reason: ${matchReason}\nFrom: ${email.from}\nSubject: ${email.subject}\nPreview: ${(email.snippet || email.bodyPreview).slice(0, 200)}${triggerName.toLowerCase().includes('bill') ? '\n\nBill / payment context: write like an EA flagging a bill - amount and due date if visible in preview, whether it is upcoming, due soon, scheduled, due now, or overdue, and what it is (e.g. utilities, card, insurance). One clear line of substance. Offer to open or summarise the full email only if it fits naturally.' : ''}`,
          },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (resp.ok) {
      const data = await resp.json();
      const textItem = data.output?.find((o: Record<string, unknown>) => o.type === 'message');
      const text = textItem?.content?.find(
        (c: Record<string, unknown>) => c.type === 'output_text',
      )?.text?.trim();
      if (text && text.length > 0 && text.length < 400) {
        return text;
      }
    }
  } catch (err) {
    clearTimeout(timeout);
    console.warn('[email-webhook] Alert message generation failed:', err);
  }

  return `Email alert (${triggerName}): ${email.subject} from ${email.from}`;
}

// ══════════════════════════════════════════════════════════════
// CALENDAR EVENT TYPES & EVALUATION
// ══════════════════════════════════════════════════════════════

export interface CalendarEventDelta {
  previousStart?: string;
  previousEnd?: string;
  previousLocation?: string;
  previousStatus?: string;
}

export interface CalendarEventData {
  eventId: string;
  title: string;
  organizer: string;
  start: string;
  end: string;
  status: 'confirmed' | 'cancelled' | 'tentative';
  changeType: 'created' | 'updated' | 'deleted';
  /** Google Calendar: created and updated timestamps within ~2s (true brand-new event). */
  isNewEvent?: boolean;
  /** When present, describes meaningful field transitions (time, location, status). */
  delta?: CalendarEventDelta | null;
  attendees?: string[];
  location?: string;
  provider: 'google' | 'microsoft';
}

const CALENDAR_TRIGGER_MAP: Record<string, (event: CalendarEventData) => boolean> = {
  new_invite: (e) => e.changeType === 'created' && e.status !== 'cancelled',
  cancellation: (e) => e.status === 'cancelled' || e.changeType === 'deleted',
  reschedule: (e) => e.changeType === 'updated' && e.status !== 'cancelled',
};

export function evaluateTriggersForCalendarEvent(
  event: CalendarEventData,
  triggers: TriggerDef[],
): { fastMatches: TriggerMatch[]; needsAiEval: TriggerDef[] } {
  const fastMatches: TriggerMatch[] = [];
  const needsAiEval: TriggerDef[] = [];

  for (const trigger of triggers) {
    // Skip email-only triggers
    if (trigger.source_type === 'email') continue;

    // Provider filter
    if (trigger.provider && trigger.provider !== event.provider) continue;

    // Fast match for calendar trigger types
    const typeChecker = CALENDAR_TRIGGER_MAP[trigger.trigger_type];
    if (typeChecker && typeChecker(event)) {
      // Additional sender filter (organizer)
      if (trigger.match_sender) {
        const org = event.organizer.toLowerCase();
        if (!org.includes(trigger.match_sender.toLowerCase())) {
          if (trigger.use_ai_matching) needsAiEval.push(trigger);
          continue;
        }
      }

      // Subject pattern match on event title
      if (trigger.match_subject_pattern) {
        try {
          if (!new RegExp(trigger.match_subject_pattern, 'i').test(event.title)) {
            if (trigger.use_ai_matching) needsAiEval.push(trigger);
            continue;
          }
        } catch {
          if (!event.title.toLowerCase().includes(trigger.match_subject_pattern.toLowerCase())) {
            if (trigger.use_ai_matching) needsAiEval.push(trigger);
            continue;
          }
        }
      }

      fastMatches.push({
        triggerId: trigger.id,
        triggerName: trigger.name,
        matchReason: `Calendar event ${event.changeType}: ${event.title}`,
        deliveryMethod: trigger.delivery_method,
      });
      continue;
    }

    // For custom/calendar_custom types, or types that didn't fast-match
    if (trigger.use_ai_matching && (trigger.trigger_type === 'custom' || trigger.trigger_type === 'calendar_custom')) {
      needsAiEval.push(trigger);
    }
  }

  return { fastMatches, needsAiEval };
}

export async function aiEvaluateCalendarTriggers(
  event: CalendarEventData,
  triggers: TriggerDef[],
): Promise<TriggerMatch[]> {
  if (triggers.length === 0) return [];

  const apiKey = getOptionalEnv('OPENAI_API_KEY');
  if (!apiKey) return [];

  const triggerDescs = triggers
    .map((t, i) => `${i}. "${t.name}": ${t.ai_prompt || t.description}`)
    .join('\n');

  const deltaLines =
    event.delta != null
      ? [
          event.delta.previousStart ? `Previous start: ${event.delta.previousStart}` : null,
          event.delta.previousEnd ? `Previous end: ${event.delta.previousEnd}` : null,
          event.delta.previousLocation !== undefined
            ? `Previous location: ${event.delta.previousLocation || '(none)'}`
            : null,
          event.delta.previousStatus ? `Previous status: ${event.delta.previousStatus}` : null,
        ].filter(Boolean)
      : [];

  const eventSummary = [
    `Title: ${event.title}`,
    `Organizer: ${event.organizer}`,
    `Status: ${event.status}`,
    `Change: ${event.changeType}`,
    `Start: ${event.start}`,
    `End: ${event.end}`,
    event.attendees?.length ? `Attendees: ${event.attendees.join(', ')}` : null,
    event.location ? `Location: ${event.location}` : null,
    ...deltaLines,
  ].filter(Boolean).join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        instructions: `You evaluate calendar events against notification triggers. Return a JSON array of matched trigger indices with reasons. Be generous - if the event is plausibly related, include it. Return [] if no triggers match.`,
        input: `CALENDAR EVENT:\n${eventSummary}\n\nTRIGGERS:\n${triggerDescs}\n\nReturn JSON: [{"index": 0, "reason": "brief reason"}]`,
        max_output_tokens: 200,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) return [];

    const data = await resp.json();
    const text = data?.output?.[0]?.content?.[0]?.text ?? '';
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(jsonStr) as Array<{ index: number; reason?: string }>;

    const matches: TriggerMatch[] = [];
    for (const item of parsed) {
      const idx = item.index;
      if (idx >= 0 && idx < triggers.length) {
        matches.push({
          triggerId: triggers[idx].id,
          triggerName: triggers[idx].name,
          matchReason: item.reason ?? 'AI match',
          deliveryMethod: triggers[idx].delivery_method,
        });
      }
    }
    return matches;
  } catch {
    return [];
  }
}

const CALENDAR_ALERT_SYSTEM_PROMPT = `You are Nest, sending a short iMessage like a capable executive assistant would. A calendar watch they set up has fired.

ABSOLUTELY FORBIDDEN: the em dash character. Never output it anywhere. Use commas, hyphens (-), or colons instead.
ABSOLUTELY FORBIDDEN: the word "mate". Never use it.

Voice: efficient, calm, discreet. You are briefing someone between meetings - not writing a diary entry.

RULES:
- 2-4 short lines. Lead with what changed or what they need to know.
- Use actual line breaks between lines (not literal \\n)
- Use **bold** for event title, organiser, and key times or places
- If the user message includes a first name, use it sparingly. If it says no name on file, open with the update - never "there", "friend", or "mate" as a fake name
- When BEFORE and AFTER values are given, state the delta clearly (time from X to Y, location, cancelled, etc.)
- Australian spelling (e.g. cancelled, organised)
- Vary structure: sometimes "Calendar -", "FYI -", or straight into the update

EXAMPLES:
Trigger: new invite, Organiser: Sarah Chen, Event: Q2 Planning Review, Start: March 20 at 2pm ->
New invite - **Sarah Chen**

**Q2 Planning Review** · **March 20, 2pm**

Trigger: cancellation, Organiser: James, Event: 1:1 Sync ->
**James** cancelled **1:1 Sync** - that time is free again.

Trigger: reschedule, time 3pm to 5pm ->
**Interview - Senior Dev** shifted **3pm** to **5pm** Tuesday

Still with **recruiter@company.com**`;

export function formatCalendarInstantForUser(iso: string, timeZone: string): string {
  if (!iso?.trim()) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-AU', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export async function generateCalendarAlertMessage(
  event: CalendarEventData,
  triggerName: string,
  matchReason: string,
  userName: string,
  userTz: string,
): Promise<string> {
  const apiKey = getOptionalEnv('OPENAI_API_KEY');
  if (!apiKey) {
    return `Calendar - **${event.title}** (${event.changeType}). **${event.organizer}**.`;
  }

  const tz = userTz || 'Australia/Melbourne';
  const startFmt = formatCalendarInstantForUser(event.start, tz);
  const endFmt = formatCalendarInstantForUser(event.end, tz);

  let deltaBlock = '';
  if (event.delta != null && event.changeType !== 'created') {
    const ps = formatCalendarInstantForUser(event.delta.previousStart ?? '', tz);
    const pe = event.delta.previousEnd
      ? formatCalendarInstantForUser(event.delta.previousEnd, tz)
      : '';
    const pl =
      event.delta.previousLocation !== undefined
        ? (event.delta.previousLocation?.trim() || '(none)')
        : '';
    const ploc =
      event.delta.previousLocation !== undefined ? `\nPrevious location: ${pl}\n` : '';
    deltaBlock = [
      `\nBEFORE (contrast with what changed):`,
      event.delta.previousStart ? `Previous start: ${ps}` : '',
      pe ? `Previous end: ${pe}` : '',
      ploc,
      `NOW:`,
      `Start: ${startFmt}`,
      `End: ${endFmt}`,
      event.location ? `Location: ${event.location}` : 'Location: (none)',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const nameLine = userName.trim()
    ? `User first name (use naturally): ${userName.trim()}`
    : 'No first name on file — do not use a placeholder name; never say "there", "friend", or "mate" as if it were their name';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        instructions: CALENDAR_ALERT_SYSTEM_PROMPT,
        input: `${nameLine}\nTrigger: "${triggerName}" (reason: ${matchReason})\nEvent title: ${event.title}\nOrganiser: ${event.organizer}\nChange: ${event.changeType}\nStatus: ${event.status}\nStart (local): ${startFmt}\nEnd (local): ${endFmt}${event.location ? `\nLocation: ${event.location}` : ''}${deltaBlock}`,
        max_output_tokens: 180,
        temperature: 0.85,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) return `Calendar - **${event.title}** (${event.changeType}).`;

    const data = await resp.json();
    const textItem = data.output?.find((o: Record<string, unknown>) => o.type === 'message');
    const text = textItem?.content?.find(
      (c: Record<string, unknown>) => c.type === 'output_text',
    )?.text?.trim();
    if (text && text.length > 0 && text.length < 400) {
      return text;
    }
    return `Calendar - **${event.title}** (${event.changeType}).`;
  } catch {
    clearTimeout(timeout);
    return `Calendar - **${event.title}** (${event.changeType}).`;
  }
}

// ══════════════════════════════════════════════════════════════
// GOOGLE CALENDAR WATCH HELPERS
// ══════════════════════════════════════════════════════════════

export interface CalendarWatchResult {
  channelId: string;
  resourceId: string;
  expiration: string;
}

export async function setupGoogleCalendarWatch(
  accessToken: string,
  calendarId: string,
  webhookUrl: string,
): Promise<CalendarWatchResult> {
  const channelId = crypto.randomUUID();
  const expiration = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/watch`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: channelId,
        type: 'web_hook',
        address: webhookUrl,
        expiration: expiration.toString(),
      }),
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google Calendar watch failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return {
    channelId: data.id ?? channelId,
    resourceId: data.resourceId,
    expiration: data.expiration ?? expiration.toString(),
  };
}

export async function stopGoogleCalendarWatch(
  accessToken: string,
  channelId: string,
  resourceId: string,
): Promise<void> {
  const resp = await fetch('https://www.googleapis.com/calendar/v3/channels/stop', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ id: channelId, resourceId }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.warn(`[calendar-webhook] Failed to stop watch: ${resp.status} ${text}`);
  }
}

// Find subscription by Google Calendar channel ID
export async function findSubscriptionByChannelId(channelId: string) {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('notification_webhook_subscriptions')
    .select('*')
    .eq('channel_id', channelId)
    .eq('resource_type', 'calendar')
    .eq('active', true)
    .maybeSingle();

  if (error) {
    console.error(`[calendar-webhook] findSubscriptionByChannelId error: ${error.message}`);
    return null;
  }
  return data;
}

// ══════════════════════════════════════════════════════════════
// SUBSCRIPTION LOOKUP HELPERS
// ══════════════════════════════════════════════════════════════

export async function findSubscriptionByEmail(
  provider: 'google' | 'microsoft',
  accountEmail: string,
  resourceType: 'email' | 'calendar' = 'email',
) {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('notification_webhook_subscriptions')
    .select('*')
    .eq('provider', provider)
    .eq('account_email', accountEmail)
    .eq('resource_type', resourceType)
    .eq('active', true)
    .maybeSingle();

  if (error) {
    console.error(`[email-webhook] findSubscriptionByEmail error: ${error.message}`);
    return null;
  }
  return data;
}

export async function findSubscriptionByMsId(subscriptionId: string) {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('notification_webhook_subscriptions')
    .select('*')
    .eq('subscription_id', subscriptionId)
    .eq('active', true)
    .maybeSingle();

  if (error) {
    console.error(`[email-webhook] findSubscriptionByMsId error: ${error.message}`);
    return null;
  }
  return data;
}

export async function updateSubscriptionHistoryId(
  subscriptionDbId: string,
  historyId: string,
): Promise<void> {
  const supabase = getAdminClient();
  await supabase
    .from('notification_webhook_subscriptions')
    .update({ history_id: historyId, updated_at: new Date().toISOString() })
    .eq('id', subscriptionDbId);
}

export async function updateSubscriptionExpiration(
  subscriptionDbId: string,
  expiration: Date,
): Promise<void> {
  const supabase = getAdminClient();
  await supabase
    .from('notification_webhook_subscriptions')
    .update({
      expiration: expiration.toISOString(),
      last_renewed_at: new Date().toISOString(),
      error_count: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', subscriptionDbId);
}

export async function markSubscriptionError(
  subscriptionDbId: string,
  errorMsg: string,
  currentErrorCount: number,
): Promise<void> {
  const supabase = getAdminClient();
  const newCount = currentErrorCount + 1;

  await supabase
    .from('notification_webhook_subscriptions')
    .update({
      error_count: newCount,
      last_error: errorMsg,
      active: newCount >= 5 ? false : true,
      updated_at: new Date().toISOString(),
    })
    .eq('id', subscriptionDbId);

  if (newCount >= 5) {
    console.warn(`[email-webhook] Subscription ${subscriptionDbId} deactivated after ${newCount} consecutive errors`);
  }
}

// Generate a random client state for Outlook subscription verification
export function generateClientState(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Resolve user handle to bot number for message delivery
export async function resolveBotNumber(handle: string): Promise<string | null> {
  try {
    const supabase = getAdminClient();
    const { data } = await supabase
      .from('user_profiles')
      .select('bot_number')
      .eq('handle', handle)
      .maybeSingle();

    const profileBot = (data as { bot_number: string | null } | null)?.bot_number ?? null;

    const allowedRaw = getOptionalEnv('LINQ_AGENT_BOT_NUMBERS');
    if (allowedRaw) {
      const allowed = allowedRaw.split(',').map(n => n.trim()).filter(Boolean);
      if (profileBot && allowed.includes(profileBot)) return profileBot;
      return allowed[0] ?? profileBot;
    }
    return profileBot;
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve the Linq 1:1 bot chat UUID for a user handle.
// IMPORTANT: Only returns non-group chats to prevent alerts leaking into group conversations.
// Returns null if no valid UUID chat_id is found.
export async function resolveChatId(handle: string): Promise<string | null> {
  try {
    const supabase = getAdminClient();

    // Get all group chat_ids so we can exclude them
    const { data: groups } = await supabase
      .from('group_chats')
      .select('chat_id');
    const groupChatIds = new Set((groups ?? []).map((g: { chat_id: string }) => g.chat_id));

    // Find the most recent message from this handle
    const { data: messages } = await supabase
      .from('conversation_messages')
      .select('chat_id')
      .eq('handle', handle)
      .order('created_at', { ascending: false })
      .limit(20);

    const match = (messages ?? []).find(
      (m: { chat_id: string }) =>
        !groupChatIds.has(m.chat_id) && UUID_RE.test(m.chat_id),
    );

    return match?.chat_id ?? null;
  } catch {
    return null;
  }
}
