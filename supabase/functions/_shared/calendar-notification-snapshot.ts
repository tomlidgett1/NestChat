/**
 * Google Calendar push fires on any event mutation (including RSVP/attendee updates).
 * We persist a fingerprint of start, end, location, and status per subscription + event
 * and only surface events when those fields meaningfully change.
 */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import type { CalendarEventData } from './email-webhook-helpers.ts';

export interface GoogleCalendarEventItem {
  id: string;
  summary?: string;
  organizer?: { email?: string; displayName?: string };
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  status?: string;
  attendees?: Array<{ email?: string }>;
  location?: string;
  updated?: string;
  created?: string;
}

const TAG = '[calendar-snapshot]';

/** Events touched in the last few minutes (Google push does not include a diff). */
export async function fetchRecentGoogleCalendarEvents(accessToken: string): Promise<CalendarEventData[]> {
  const now = new Date();
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const updatedMin = fiveMinAgo.toISOString();

  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?updatedMin=${encodeURIComponent(updatedMin)}&maxResults=10&singleEvents=true&orderBy=updated`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    console.warn(`${TAG} Google Calendar events API ${resp.status}: ${await resp.text()}`);
    return [];
  }

  const data = await resp.json() as { items?: GoogleCalendarEventItem[] };

  if (!data.items?.length) return [];

  return data.items.map(item => mapGoogleItemToCalendarEventData(item));
}

export function mapGoogleItemToCalendarEventData(item: GoogleCalendarEventItem): CalendarEventData {
  const created = item.created ? new Date(item.created).getTime() : 0;
  const updated = item.updated ? new Date(item.updated).getTime() : 0;
  const isNewEvent = Math.abs(updated - created) < 2000;
  const isCancelled = item.status === 'cancelled';

  return {
    eventId: item.id,
    title: item.summary ?? 'Untitled',
    organizer: item.organizer?.displayName ?? item.organizer?.email ?? '',
    start: item.start?.dateTime ?? item.start?.date ?? '',
    end: item.end?.dateTime ?? item.end?.date ?? '',
    status: (item.status ?? 'confirmed') as 'confirmed' | 'cancelled' | 'tentative',
    changeType: isCancelled ? 'deleted' : isNewEvent ? 'created' : 'updated',
    isNewEvent,
    attendees: item.attendees?.map(a => a.email ?? '').filter(Boolean),
    location: item.location ?? undefined,
    provider: 'google',
  };
}

export type MeaningfulFingerprint = {
  start: string;
  end: string;
  location: string;
  status: string;
};

export function fingerprintForCalendarEvent(event: CalendarEventData): string {
  const fp: MeaningfulFingerprint = {
    start: event.start,
    end: event.end,
    location: (event.location ?? '').trim(),
    status: event.status,
  };
  return JSON.stringify(fp);
}

function applyTransitionFromPrevious(
  event: CalendarEventData,
  previous: MeaningfulFingerprint,
): CalendarEventData {
  const next = { ...event };
  if (next.status === 'cancelled' && previous.status !== 'cancelled') {
    next.changeType = 'deleted';
  } else if (next.status !== 'cancelled') {
    next.changeType = 'updated';
  }
  return next;
}

/**
 * Returns events that should go through trigger evaluation. Baseline-only rows (first time
 * we see an existing event with no prior snapshot) are written immediately so RSVP churn
 * does not notify. Caller must upsert snapshots after successfully processing each returned event.
 */
export async function filterGoogleCalendarEventsForAlerts(
  supabase: SupabaseClient,
  subscriptionId: string,
  events: CalendarEventData[],
): Promise<CalendarEventData[]> {
  if (events.length === 0) return [];

  const ids = events.map(e => e.eventId);
  const { data: rows } = await supabase
    .from('calendar_event_notification_snapshots')
    .select('google_event_id, fingerprint')
    .eq('subscription_id', subscriptionId)
    .in('google_event_id', ids);

  const rowMap = new Map((rows ?? []).map(r => [r.google_event_id as string, r.fingerprint as string]));

  const out: CalendarEventData[] = [];
  const baselineUpserts: Array<{
    subscription_id: string;
    google_event_id: string;
    fingerprint: string;
    updated_at: string;
  }> = [];

  const now = new Date().toISOString();

  for (const event of events) {
    const fp = fingerprintForCalendarEvent(event);
    const prev = rowMap.get(event.eventId);

    if (!prev) {
      if (event.isNewEvent) {
        const created: CalendarEventData = {
          ...event,
          changeType: event.status === 'cancelled' ? 'deleted' : 'created',
          delta: null,
        };
        out.push(created);
      } else {
        baselineUpserts.push({
          subscription_id: subscriptionId,
          google_event_id: event.eventId,
          fingerprint: fp,
          updated_at: now,
        });
      }
      continue;
    }

    if (prev === fp) continue;

    let previous: MeaningfulFingerprint;
    try {
      previous = JSON.parse(prev) as MeaningfulFingerprint;
    } catch {
      previous = { start: '', end: '', location: '', status: '' };
    }

    const delta = {
      previousStart: previous.start || undefined,
      previousEnd: previous.end || undefined,
      previousLocation: previous.location || undefined,
      previousStatus: previous.status || undefined,
    };

    let enriched = applyTransitionFromPrevious(event, previous);
    enriched = { ...enriched, delta };
    out.push(enriched);
  }

  if (baselineUpserts.length > 0) {
    const { error } = await supabase.from('calendar_event_notification_snapshots').upsert(baselineUpserts, {
      onConflict: 'subscription_id,google_event_id',
    });
    if (error) {
      console.warn('[calendar-snapshot] Baseline upsert failed:', error.message);
    }
  }

  return out;
}

export async function upsertCalendarEventSnapshot(
  supabase: SupabaseClient,
  subscriptionId: string,
  eventId: string,
  fingerprint: string,
): Promise<void> {
  const { error } = await supabase.from('calendar_event_notification_snapshots').upsert(
    {
      subscription_id: subscriptionId,
      google_event_id: eventId,
      fingerprint,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'subscription_id,google_event_id' },
  );
  if (error) {
    console.warn('[calendar-snapshot] Upsert failed:', error.message);
  }
}
