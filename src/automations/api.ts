import type { Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';
import {
  extractInterestsFromDeepProfile,
  inferCountryFromTimezone,
  resolveLocationFromProfile,
  runNewsSearchForBriefing,
} from '../lib/news-briefing-standalone.js';
import OpenAI from 'openai';
import { cleanResponse } from '../lib/imessage-text-format.js';
import { displayNameForAlerts, resolveNameForAlerts } from '../lib/resolve-user-display-name.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ============================================================================
// GET /automations/api/users — all users with automation status
// ============================================================================

export async function handleAutomationUsers(_req: Request, res: Response) {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.rpc('get_all_users_with_automation_status');

    if (error) {
      console.error('[automations-api] Error fetching users:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json(data || []);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
}

// ============================================================================
// GET /automations/api/history?handle=... — automation history for a user
// ============================================================================

export async function handleAutomationHistory(req: Request, res: Response) {
  try {
    const handle = req.query.handle as string;
    if (!handle) {
      return res.status(400).json({ error: 'handle is required' });
    }

    const supabase = getSupabase();
    const { data, error } = await supabase.rpc('get_user_automation_history', {
      p_handle: handle,
      p_limit: 100,
    });

    if (error) {
      console.error('[automations-api] Error fetching history:', error.message);
      return res.status(500).json({ error: error.message });
    }

    // Also fetch legacy proactive_messages for historical context
    const { data: legacyData } = await supabase
      .from('proactive_messages')
      .select('*')
      .eq('handle', handle)
      .order('sent_at', { ascending: false })
      .limit(50);

    const legacyFormatted = (legacyData || []).map((p: Record<string, unknown>) => ({
      id: p.id,
      handle: p.handle,
      chat_id: p.chat_id,
      automation_type: p.message_type,
      content: p.content,
      sent_at: p.sent_at,
      delivered_at: null,
      replied_at: p.replied_at,
      ignored: p.ignored,
      metadata: p.metadata || {},
      manual_trigger: false,
      triggered_by: 'legacy_system',
    }));

    const combined = [...(data || []), ...legacyFormatted];
    combined.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
      return new Date(b.sent_at as string).getTime() - new Date(a.sent_at as string).getTime();
    });

    const deduped: Record<string, unknown>[] = [];
    for (const item of combined) {
      const isDupe = deduped.some(d => {
        return d.content === item.content &&
          Math.abs(new Date(d.sent_at as string).getTime() - new Date(item.sent_at as string).getTime()) < 60000;
      });
      if (!isDupe) deduped.push(item);
    }

    res.json(deduped);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
}

// ============================================================================
// GET /automations/api/user-detail?handle=... — detailed user profile
// ============================================================================

export async function handleAutomationUserDetail(req: Request, res: Response) {
  try {
    const handle = req.query.handle as string;
    if (!handle) {
      return res.status(400).json({ error: 'handle is required' });
    }

    const supabase = getSupabase();

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('handle', handle)
      .maybeSingle();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'User not found' });
    }

    let connectedAccounts = 0;
    if (profile.auth_user_id) {
      const [google, microsoft] = await Promise.all([
        supabase.from('user_google_accounts').select('id').eq('user_id', profile.auth_user_id),
        supabase.from('user_microsoft_accounts').select('id').eq('user_id', profile.auth_user_id),
      ]);
      connectedAccounts = (google.data?.length || 0) + (microsoft.data?.length || 0);
    }

    let memoryCount = 0;
    try {
      const { data: memories } = await supabase.rpc('get_active_memory_items', {
        p_handle: handle,
        p_limit: 1000,
      });
      memoryCount = memories?.length || 0;
    } catch {
      // Non-fatal
    }

    res.json({
      handle: profile.handle,
      name: profile.name,
      status: profile.status,
      timezone: profile.timezone,
      first_seen: profile.first_seen,
      last_seen: profile.last_seen,
      onboard_state: profile.onboard_state || 'new_user_unclassified',
      onboard_count: profile.onboard_count || 0,
      activation_score: profile.activation_score || 0,
      proactive_ignore_count: profile.proactive_ignore_count || 0,
      bot_number: profile.bot_number,
      auth_user_id: profile.auth_user_id,
      connected_accounts: connectedAccounts,
      memory_count: memoryCount,
      capabilities_used: profile.capability_categories_used || [],
      first_value_delivered_at: profile.first_value_delivered_at,
      follow_through_delivered_at: profile.follow_through_delivered_at,
      second_engagement_at: profile.second_engagement_at,
      memory_moment_delivered_at: profile.memory_moment_delivered_at,
      activated_at: profile.activated_at,
      at_risk_at: profile.at_risk_at,
      entry_state: profile.entry_state,
      first_value_wedge: profile.first_value_wedge,
      last_proactive_sent_at: profile.last_proactive_sent_at,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
}

// ============================================================================
// Live data fetchers — Google Calendar & Gmail via OAuth refresh tokens
// ============================================================================

async function getGoogleAccessToken(userId: string): Promise<{ accessToken: string; email: string } | null> {
  const supabase = getSupabase();
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) return null;

  const { data: account } = await supabase
    .from('user_google_accounts')
    .select('google_email, refresh_token')
    .eq('user_id', userId)
    .eq('is_primary', true)
    .maybeSingle();

  if (!account?.refresh_token) return null;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: account.refresh_token,
    }),
  });

  if (!resp.ok) return null;
  const tokens = await resp.json() as { access_token: string };
  return { accessToken: tokens.access_token, email: account.google_email };
}

interface CalendarEvent {
  title: string;
  start: string;
  end: string;
  location?: string;
  attendees: string[];
  allDay: boolean;
}

async function fetchCalendarEvents(accessToken: string, tz: string): Promise<CalendarEvent[]> {
  const now = new Date();
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '10',
    timeZone: tz,
  });

  const resp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) return [];
  const data = await resp.json() as { items?: Array<Record<string, unknown>> };

  return (data.items || []).map(e => ({
    title: (e.summary as string) || 'Untitled',
    start: ((e.start as Record<string, string>)?.dateTime || (e.start as Record<string, string>)?.date) ?? '',
    end: ((e.end as Record<string, string>)?.dateTime || (e.end as Record<string, string>)?.date) ?? '',
    location: (e.location as string) || undefined,
    attendees: ((e.attendees as Array<{ email: string; displayName?: string }>) || [])
      .map(a => a.displayName || a.email)
      .slice(0, 5),
    allDay: !!(e.start as Record<string, string>)?.date,
  }));
}

async function fetchUpcomingEvents(accessToken: string, tz: string, hoursAhead: number): Promise<CalendarEvent[]> {
  const now = new Date();
  const future = new Date(now.getTime() + hoursAhead * 3600000);

  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '5',
    timeZone: tz,
  });

  const resp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) return [];
  const data = await resp.json() as { items?: Array<Record<string, unknown>> };

  return (data.items || []).map(e => ({
    title: (e.summary as string) || 'Untitled',
    start: ((e.start as Record<string, string>)?.dateTime || (e.start as Record<string, string>)?.date) ?? '',
    end: ((e.end as Record<string, string>)?.dateTime || (e.end as Record<string, string>)?.date) ?? '',
    location: (e.location as string) || undefined,
    attendees: ((e.attendees as Array<{ email: string; displayName?: string }>) || [])
      .map(a => a.displayName || a.email)
      .slice(0, 5),
    allDay: !!(e.start as Record<string, string>)?.date,
  }));
}

interface EmailSummary {
  from: string;
  subject: string;
  snippet: string;
  date: string;
}

async function fetchRecentEmails(accessToken: string): Promise<EmailSummary[]> {
  const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=is:unread newer_than:1d`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) return [];
  const data = await resp.json() as { messages?: Array<{ id: string }> };
  if (!data.messages?.length) return [];

  const emails: EmailSummary[] = [];
  for (const msg of data.messages.slice(0, 5)) {
    try {
      const detailResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!detailResp.ok) continue;
      const detail = await detailResp.json() as { snippet?: string; payload?: { headers?: Array<{ name: string; value: string }> } };
      const headers = detail.payload?.headers || [];
      const fromHeader = headers.find(h => h.name === 'From')?.value || 'Unknown';
      const subject = headers.find(h => h.name === 'Subject')?.value || 'No subject';
      // Extract just the name from "Name <email>" format
      const fromName = fromHeader.replace(/<[^>]+>/, '').trim().replace(/"/g, '');
      emails.push({ from: fromName, subject, snippet: detail.snippet || '', date: headers.find(h => h.name === 'Date')?.value || '' });
    } catch {
      continue;
    }
  }
  return emails;
}

async function fetchConversationSummaries(handle: string, botNumber: string): Promise<string[]> {
  const supabase = getSupabase();
  const chatId = `DM#${botNumber}#${handle}`;
  const { data } = await supabase
    .from('conversation_summaries')
    .select('summary, open_loops, topics')
    .eq('chat_id', chatId)
    .order('last_message_at', { ascending: false })
    .limit(5);

  if (!data?.length) return [];
  const loops: string[] = [];
  for (const s of data as Array<{ summary: string; open_loops: string[]; topics: string[] }>) {
    if (s.open_loops?.length) loops.push(...s.open_loops);
  }
  return loops;
}

async function fetchMemories(handle: string): Promise<string[]> {
  const supabase = getSupabase();
  try {
    const { data } = await supabase.rpc('get_active_memory_items', {
      p_handle: handle,
      p_limit: 20,
    });
    if (!data?.length) return [];
    return (data as Array<{ value_text: string; memory_type: string; category: string }>)
      .map(m => `[${m.memory_type}/${m.category}] ${m.value_text}`);
  } catch {
    return [];
  }
}

// ============================================================================
// Contextual message generation via OpenAI
// ============================================================================

const NEST_STYLE = `You are Nest, a warm and thoughtful personal assistant that people text via iMessage. You write like a kind, emotionally intelligent friend — not a corporate bot, not overly casual slang. Use proper capitalisation and punctuation (but not formal). No markdown, no em dashes, no bullet points, no asterisks. Australian spelling. Never mention AI, bots, or technology. Use --- to split into multiple text bubbles if needed (max 2 bubbles). Keep it SHORT — this is a text message, not an email.

Tone guide:
- Warm, genuine, caring — like a trusted friend who actually pays attention
- Use greetings that feel human and varied: "Good morning Tom", "Morning!", "Hey Tom, hope you're having a good one", "Hope your Wednesday is off to a good start" etc
- Show you care about them as a person, not just their schedule
- Never robotic, never overly peppy, never salesy
- Vary your openings every time — never repeat the same greeting pattern
- It's okay to be brief, but always be kind`;

async function generateContextualMessage(
  automationType: string,
  profile: Record<string, unknown>,
): Promise<{ message: string; metadata: Record<string, unknown> } | null> {
  const handle = profile.handle as string;
  const authUserId = profile.auth_user_id as string | null;
  const supabase = getSupabase();
  const greetingRaw = String(
    (profile.display_name as string | undefined) ?? (profile.name as string | undefined) ?? '',
  ).trim();
  let name = greetingRaw
    ? displayNameForAlerts(greetingRaw.split(/\s+/)[0] || greetingRaw)
    : '';
  if (!name && authUserId) {
    name = await resolveNameForAlerts(supabase, authUserId, greetingRaw || null);
  }
  const tz = (profile.timezone as string) || 'Australia/Sydney';
  const botNumber = profile.bot_number as string;
  const capabilities = (profile.capability_categories_used as string[]) || [];

  // Gather context in parallel
  const googleAuth = authUserId ? await getGoogleAccessToken(authUserId) : null;

  switch (automationType) {
    case 'onboarding_morning': {
      // Day 2 morning — either briefing (verified) or greeting (unverified)
      if (googleAuth) {
        // Verified: generate a morning briefing
        let calendarBlock = 'No events today';
        let emailBlock = 'No unread emails';
        const calEvents: CalendarEvent[] = [];
        const emails: EmailSummary[] = [];

        const [cal, em] = await Promise.all([
          fetchCalendarEvents(googleAuth.accessToken, tz),
          fetchRecentEmails(googleAuth.accessToken),
        ]);
        calEvents.push(...cal);
        emails.push(...em);

        if (cal.length > 0) {
          calendarBlock = cal.map(e => {
            const time = e.allDay ? 'all day' : new Date(e.start).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz });
            const loc = e.location ? ` @ ${e.location}` : '';
            return `- ${e.title} at ${time}${loc}`;
          }).join('\n');
        }

        if (em.length > 0) {
          emailBlock = em.map(e => `- From: ${e.from} | Subject: ${e.subject}`).join('\n');
        }

        const message = await callOpenAI(`${NEST_STYLE}

Generate a morning briefing for ${name || 'this person'}. This is their FIRST morning message from you (Day 2 after signing up), so make it extra warm and welcoming.

Today's calendar:
${calendarBlock}

Unread emails:
${emailBlock}

Rules:
- Start with a warm, welcoming morning greeting using their name
- Summarise the day naturally — mention specific events and times
- Keep it warm and friendly — this is their first morning message, make it feel special
- 2-4 lines max, split into max 2 bubbles with ---`);

        return {
          message: message || `Good morning${name ? ` ${name}` : ''}! I hope you slept well. Your calendar is looking clear today. I'm here whenever you need a hand with anything!`,
          metadata: { trigger: 'manual', verified: true, calendar_events: calEvents.length, emails: emails.length },
        };
      }

      // Not verified: warm greeting + ask about daily check-in
      const greetings = [
        `Good morning${name ? ` ${name}` : ''}, I hope you had a lovely sleep. I'm here whenever you need a hand with anything today.\n---\nWould you like me to send you a little morning check-in like this every day? Just let me know!`,
        `Good morning${name ? ` ${name}` : ''}, hope you're feeling good this morning. Just wanted to let you know I'm here if you need anything at all today.\n---\nBy the way, I can send you a quick morning hello like this every day if you'd like. Just say the word!`,
      ];
      return {
        message: greetings[Math.floor(Math.random() * greetings.length)],
        metadata: { trigger: 'manual', verified: false },
      };
    }

    case 'onboarding_feature': {
      // Day 3: contextual reminders feature discovery
      const memories = await fetchMemories(handle);
      const openLoops = await fetchConversationSummaries(handle, botNumber);

      const message = await callOpenAI(`${NEST_STYLE}

Generate a warm feature discovery message about REMINDERS for ${name || 'this person'}. This is Day 3 after they signed up.

What you know about them:
${memories.length > 0 ? memories.slice(0, 10).map(m => `- ${m}`).join('\n') : 'Not much yet'}

Open topics from conversations:
${openLoops.length > 0 ? openLoops.map(l => `- ${l}`).join('\n') : 'None'}

Rules:
- Start with a warm greeting using their name
- Frame it like a friend sharing a genuinely useful tip
- Personalise: if they mentioned footy, suggest reminding about a match. If they mentioned a doctor, suggest a reminder for that. Use whatever you know.
- Give ONE specific example they could text right now, phrased naturally
- 2-3 lines max
- End with something encouraging but not a question
- Australian spelling`);

      return {
        message: message || `Hey${name ? ` ${name}` : ''}, by the way - you can ask me to set reminders for anything. Just text something like "Remind me to call the doctor tomorrow at 10am" and I'll make sure you don't forget!`,
        metadata: { trigger: 'manual', feature: 'reminders' },
      };
    }

    case 'morning_briefing': {
      let calendarBlock = 'No calendar connected';
      let emailBlock = 'No email connected';
      const calEvents: CalendarEvent[] = [];
      const emails: EmailSummary[] = [];

      if (googleAuth) {
        const [cal, em] = await Promise.all([
          fetchCalendarEvents(googleAuth.accessToken, tz),
          fetchRecentEmails(googleAuth.accessToken),
        ]);
        calEvents.push(...cal);
        emails.push(...em);

        if (cal.length > 0) {
          calendarBlock = cal.map(e => {
            const time = e.allDay ? 'all day' : new Date(e.start).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz });
            const loc = e.location ? ` @ ${e.location}` : '';
            const people = e.attendees.length > 0 ? ` (with: ${e.attendees.slice(0, 3).join(', ')})` : '';
            return `- ${e.title} at ${time}${loc}${people}`;
          }).join('\n');
        } else {
          calendarBlock = 'No events today';
        }

        if (em.length > 0) {
          emailBlock = em.map(e => `- From: ${e.from} | Subject: ${e.subject}`).join('\n');
        } else {
          emailBlock = 'No unread emails';
        }
      }

      const message = await callOpenAI(`${NEST_STYLE}

Generate a morning briefing text message for ${name || 'this person'}.

Today's calendar:
${calendarBlock}

Unread emails:
${emailBlock}

Rules:
- Start with a warm, varied morning greeting using their name. Examples: "Good morning ${name || 'there'}! Hope you slept well.", "Morning ${name || 'there'}, hope you're feeling good today.", "Happy ${new Date().toLocaleDateString('en-AU', { weekday: 'long' })} ${name || 'there'}!" — but don't copy these exactly, create your own.
- Then naturally summarise what their day looks like — mention specific events, times, and key people by first name where possible
- Only mention emails if they seem genuinely interesting (from family, something personal, clearly urgent)
- If no events: warmly note it's a quiet day, maybe encourage them to enjoy it
- If it's a busy day, acknowledge that with empathy ("Looks like a full one today")
- 2-4 lines max, split into max 2 bubbles with ---
- Be specific but conversational, like you're a thoughtful friend giving them a heads-up over coffee`);

      return {
        message: message || `Good morning${name ? ` ${name}` : ''}! Nothing on the calendar today and your inbox is nice and quiet. Enjoy the clear day!`,
        metadata: {
          trigger: 'manual',
          calendar_events: calEvents.map(e => ({ title: e.title, start: e.start, location: e.location })),
          emails: emails.map(e => ({ from: e.from, subject: e.subject })),
        },
      };
    }

    case 'calendar_heads_up': {
      if (!googleAuth) {
        return { message: `Hey${name ? ` ${name}` : ''}, I don't have access to your calendar yet. Would you like to connect it so I can give you a heads-up before your events?`, metadata: { trigger: 'manual', no_accounts: true } };
      }

      const events = await fetchUpcomingEvents(googleAuth.accessToken, tz, 3);
      if (events.length === 0) {
        return { message: `Hey${name ? ` ${name}` : ''}, nothing coming up on your calendar for the next few hours. You're all clear!`, metadata: { trigger: 'manual', no_events: true } };
      }

      const nextEvent = events[0];
      const startTime = new Date(nextEvent.start);
      const minutesUntil = Math.round((startTime.getTime() - Date.now()) / 60000);

      const message = await callOpenAI(`${NEST_STYLE}

Generate a friendly calendar heads-up text for ${name || 'this person'}.

Next event: ${nextEvent.title}
Starts in: ${minutesUntil} minutes
Time: ${startTime.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz })}
Location: ${nextEvent.location || 'not specified'}
Attendees: ${nextEvent.attendees.join(', ') || 'none listed'}

${events.length > 1 ? `After that: ${events.slice(1).map(e => e.title).join(', ')}` : ''}

Rules:
- 1-2 lines max
- Start with a gentle, kind heads-up — "Just a heads up", "Quick reminder", "Don't forget" — varied each time
- Mention the event name, roughly how long until it starts, and location if known
- If there's a location, warmly offer to check travel time or directions
- If there are attendees, mention who they're meeting with (first names if possible)
- Tone: like a thoughtful friend making sure you don't lose track of time`);

      return {
        message: message || `Just a heads up${name ? ` ${name}` : ''} — ${nextEvent.title} starts in about ${minutesUntil} minutes${nextEvent.location ? ` at ${nextEvent.location}` : ''}. Hope it goes well!`,
        metadata: {
          trigger: 'manual',
          event_title: nextEvent.title,
          event_start: nextEvent.start,
          event_location: nextEvent.location,
          minutes_until: minutesUntil,
        },
      };
    }

    case 'follow_up_loop': {
      const [openLoops, memories] = await Promise.all([
        fetchConversationSummaries(handle, botNumber),
        fetchMemories(handle),
      ]);

      if (openLoops.length === 0 && memories.length === 0) {
        return { message: `Hey${name ? ` ${name}` : ''}, is there anything on your mind I can help with? I'm always just a text away.`, metadata: { trigger: 'manual', no_loops: true } };
      }

      const message = await callOpenAI(`${NEST_STYLE}

Generate a thoughtful follow-up text for ${name || 'this person'} based on things they mentioned previously.

Open loops from recent conversations:
${openLoops.length > 0 ? openLoops.map(l => `- ${l}`).join('\n') : 'None found'}

What you know about them:
${memories.length > 0 ? memories.slice(0, 10).map(m => `- ${m}`).join('\n') : 'Nothing stored yet'}

Rules:
- Pick the MOST actionable or timely open loop or memory
- 1-2 lines max
- Show that you genuinely remembered and care — not that you're running a checklist
- Reference the specific thing naturally, like a friend who was thinking of them
- Gently offer to help with the next step if appropriate
- Examples of good tone: "Hey ${name || 'there'}, I was thinking about that thing with the mechanic — did you end up hearing back?", "Just popped into my head — did the appointment go well yesterday?"
- Never be nosy or pushy, just warm and helpful`);

      return {
        message: message || `Hey${name ? ` ${name}` : ''}, just thinking about our last chat. Is there anything you'd like me to follow up on?`,
        metadata: { trigger: 'manual', open_loops: openLoops.slice(0, 5), memory_count: memories.length },
      };
    }

    case 'inactivity_reengagement': {
      const lastSeen = profile.last_seen as number;
      const daysSilent = lastSeen ? (Date.now() / 1000 - lastSeen) / 86400 : 0;
      const tier = daysSilent >= 7 ? 'direct' : daysSilent >= 5 ? 'value' : 'soft';

      // For value tier, try to include calendar context
      let calendarContext = '';
      if (tier === 'value' && googleAuth) {
        try {
          // Fetch this week's events
          const now = new Date();
          const endOfWeek = new Date(now);
          endOfWeek.setDate(endOfWeek.getDate() + (7 - endOfWeek.getDay()));
          const params = new URLSearchParams({
            timeMin: now.toISOString(),
            timeMax: endOfWeek.toISOString(),
            singleEvents: 'true',
            orderBy: 'startTime',
            maxResults: '10',
            timeZone: tz,
          });
          const resp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
            headers: { Authorization: `Bearer ${googleAuth.accessToken}` },
          });
          if (resp.ok) {
            const data = await resp.json() as { items?: Array<Record<string, unknown>> };
            if (data.items?.length) {
              calendarContext = `Their calendar this week has ${data.items.length} event(s): ${data.items.slice(0, 3).map(e => (e.summary as string) || 'Untitled').join(', ')}`;
            }
          }
        } catch { /* non-fatal */ }
      }

      const memories = await fetchMemories(handle);

      const message = await callOpenAI(`${NEST_STYLE}

Generate a warm re-engagement text for ${name || 'this person'} who hasn't messaged in ${Math.round(daysSilent)} days.

Tier: ${tier}
- soft (3 days): A genuinely caring check-in. Show you noticed they've been quiet and you hope they're doing well.
- value (5 days): Lead with something specifically useful — reference their calendar, a memory, something concrete that shows you're thinking of them.
- direct (7+ days): Simple, warm, no pressure. Let them know you're there whenever they need you.

${calendarContext ? `Calendar context: ${calendarContext}` : ''}
${memories.length > 0 ? `What you know about them:\n${memories.slice(0, 5).map(m => `- ${m}`).join('\n')}` : ''}

Rules:
- 1-2 lines max
- Sound like a kind friend who genuinely cares, not a notification system
- For "value" tier: reference specific things from their life to show real thoughtfulness
- Never sound desperate, clingy, or like marketing
- Vary your approach — don't always open the same way
- Good examples: "Hey ${name || 'there'}, hope you're having a good week. I noticed you've got a few things coming up on Thursday — want me to give you a rundown?", "Hi ${name || 'there'}, just wanted you to know I'm here whenever you need a hand with anything."
- Bad examples: "Just checking in!" (lazy), "We miss you!" (desperate), "Don't forget about me!" (needy)`);

      return {
        message: message || `Hey${name ? ` ${name}` : ''}, just wanted you to know I'm here whenever you need a hand with anything. No rush at all.`,
        metadata: { tier, days_silent: Math.round(daysSilent * 10) / 10, manual: true },
      };
    }

    case 'news_briefing': {
      const tz = (profile.timezone as string) || 'Australia/Sydney';
      const deepProfile = profile.deep_profile_snapshot as Record<string, unknown> | null;
      const contextProfile = profile.context_profile;
      const location = resolveLocationFromProfile(contextProfile, tz);
      const country = inferCountryFromTimezone(tz);
      const interests = extractInterestsFromDeepProfile(deepProfile);
      const topicsStr = interests.length > 0 ? interests.slice(0, 4).join(', ') : undefined;

      let newsBlock = '';
      try {
        newsBlock = await runNewsSearchForBriefing({
          location,
          country,
          topics: topicsStr,
          timezone: tz,
        });
      } catch (e) {
        console.error('[automations-api] news_briefing grounded search failed:', (e as Error).message);
      }

      const displayName = name || '';

      if (!newsBlock || newsBlock.length < 40) {
        return {
          message: displayName
            ? `Hey ${displayName}, I couldn't pull a fresh news snapshot just then - want me to try again in a bit?`
            : `Hey, I couldn't pull a fresh news snapshot just then - want me to try again in a bit?`,
          metadata: { trigger: 'manual', type: 'news_briefing', fallback: true },
        };
      }

      const dayContext = new Date().toLocaleString('en-AU', {
        timeZone: tz,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      });

      const instructions = `You are Nest, sending a scheduled news briefing via iMessage.

The user turned on "News Briefing" on the website. Your job is to feel like a smart friend texting them — not a newsreader or a wire service.

RAW NEWS MATERIAL (from live search — may include section headers):
${newsBlock}

USER CONTEXT:
- Name for greeting (from their Nest profile): ${displayName || '(none on file — open warmly without a fake name or the word "there")'}.
- Their rough area for context: ${location ?? 'not specified'} (${country}).
- Day for them: ${dayContext}

OPENING LINE (CRITICAL):
- Start with ONE short, warm line that varies in tone — never the same template every time.
- When you have a name: use their name naturally, e.g. "Hey Tom, here's a quick look…" or "Morning Sarah -". Never say "Hey there".
- When you do not have a name: warm opener with no placeholder name, e.g. "Hey, quick news catch-up for you -".
- Do NOT sound robotic or like a push notification. Light personality is good.

BODY:
- 2-4 short paragraphs OR use --- between 2 bubbles max (iMessage style).
- Lead with what matters most for someone in ${country}${location ? ` (${location})` : ''}.
- Cover several distinct stories from the material — mix local angle when relevant with national/world.
- For each story: bold the headline idea with **like this**, then 1-2 sentences. No bullet lists with asterisk lines — prose or bold labels only.
- If the raw material is thin on one area, say less rather than padding.

FORBIDDEN: em dashes (use hyphen), the word "mate", markdown tables, numbered lists.

Australian spelling. Max ~350 words — stay scannable on a phone.`;

      const message = await callOpenAINewsBriefing(instructions);
      if (!message || message.length < 30) {
        return {
          message: displayName
            ? `Hey ${displayName}, here's a quick look at what's making headlines - the full digest didn't come through cleanly, but I can try again if you like.`
            : `Hey, here's a quick look at what's making headlines - the full digest didn't come through cleanly, but I can try again if you like.`,
          metadata: { trigger: 'manual', type: 'news_briefing', fallback: true, partial: true },
        };
      }

      return {
        message,
        metadata: {
          trigger: 'manual',
          type: 'news_briefing',
          had_location: !!location,
          country,
          had_topic_interests: !!topicsStr,
        },
      };
    }

    case 'feature_discovery': {
      const allFeatures = ['reminders', 'email', 'calendar', 'drafting', 'web_search', 'image_generation', 'travel_time', 'places'];
      const unused = allFeatures.filter(f => !capabilities.includes(f));
      const feature = unused[0] || allFeatures[0];

      const memories = await fetchMemories(handle);

      const message = await callOpenAI(`${NEST_STYLE}

Generate a warm, personalised feature discovery message for ${name || 'this person'} about: ${feature}

What you know about them:
${memories.length > 0 ? memories.slice(0, 5).map(m => `- ${m}`).join('\n') : 'Not much yet'}

Feature descriptions:
- reminders: setting one-off or recurring reminders
- email: checking/searching emails, summarising, drafting replies
- calendar: checking schedule, finding free time
- drafting: help writing messages, emails, anything
- web_search: looking things up — recipes, opening hours, how-tos
- image_generation: creating images from descriptions
- travel_time: checking how long to get somewhere with live traffic
- places: finding restaurants, shops, services nearby

Rules:
- Start with a warm greeting that feels natural and varied
- Frame it like a friend sharing a helpful tip, not a product tutorial
- Personalise using what you know about them — if they have kids, suggest school-related examples. If they travel for work, suggest travel_time. Etc.
- If you don't know much about them, use relatable everyday examples that a 40-70 year old would find genuinely useful
- Give ONE specific example they could text you right now, phrased naturally
- 2-3 lines max
- Tone: "Oh by the way, did you know you can..." not "Feature update: you can now..."`);

      return {
        message: message || `Hey${name ? ` ${name}` : ''}, by the way — you can ask me to set reminders for anything. Just text something like "Remind me to call the doctor tomorrow at 10am" and I'll make sure you don't forget!`,
        metadata: { feature, manual: true },
      };
    }

    default:
      return null;
  }
}

async function callOpenAI(prompt: string): Promise<string | null> {
  try {
    const response = await openai.responses.create({
      model: 'gpt-4.1-mini',
      instructions: prompt,
      input: 'Generate the message.',
      max_output_tokens: 300,
      store: false,
    } as Parameters<typeof openai.responses.create>[0]);

    const text = (response as unknown as { output_text?: string }).output_text?.trim();
    if (!text || text.length < 5) return null;
    return text;
  } catch (err) {
    console.error('[automations-api] OpenAI call failed:', (err as Error).message);
    return null;
  }
}

async function callOpenAINewsBriefing(instructions: string): Promise<string | null> {
  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_NEWS_BRIEFING_MODEL || 'gpt-4.1',
      instructions,
      input: 'Write the news briefing message.',
      max_output_tokens: 900,
      store: false,
    } as Parameters<typeof openai.responses.create>[0]);

    const text = (response as unknown as { output_text?: string }).output_text?.trim();
    if (!text || text.length < 5) return null;
    return text;
  } catch (err) {
    console.error('[automations-api] OpenAI news briefing failed:', (err as Error).message);
    return null;
  }
}

// ============================================================================
// GET /automations/api/eligibility?handle=... — next automation eligibility
// ============================================================================

interface EligibilityStatus {
  type: string;
  name: string;
  icon: string;
  schedule: string; // e.g. "Daily 7-9am · max 1/day · 20h gap"
  status: 'ready' | 'blocked' | 'waiting' | 'not_applicable';
  statusLabel: string;
  countdown: string | null; // e.g. "in 4h 23m" or null if ready/blocked
  nextEligible: string | null; // human-readable datetime
  conditions: { label: string; met: boolean; detail: string }[];
}

/** Compute calendar days since epoch, in user's timezone */
function getCalendarDaysSince(epochSeconds: number, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    const firstLocal = fmt.format(new Date(epochSeconds * 1000));
    const nowLocal = fmt.format(new Date());
    const d1 = new Date(firstLocal + 'T00:00:00');
    const d2 = new Date(nowLocal + 'T00:00:00');
    return Math.round((d2.getTime() - d1.getTime()) / 86400000);
  } catch {
    return Math.floor((Date.now() / 1000 - epochSeconds) / 86400);
  }
}

const RULE_DEFS = [
  // Onboarding rules
  {
    type: 'onboarding_morning',
    name: 'Day 2 Morning',
    icon: '🌅',
    schedule: 'Day 2 only · 8:15am local · greeting (unverified) or briefing (verified)',
    maxPerDay: 1,
    minIntervalHours: 20,
    requiresConnectedAccounts: false,
    hourWindow: [8, 9],
    minMessages: 0,
    onboardingDay: 1, // calendar days since join
  },
  {
    type: 'onboarding_feature',
    name: 'Day 3 Reminders Tip',
    icon: '🔔',
    schedule: 'Day 3 only · 8:15am local · contextual reminders tip · only if user responded on Day 2',
    maxPerDay: 1,
    minIntervalHours: 20,
    requiresConnectedAccounts: false,
    hourWindow: [8, 9],
    minMessages: 0,
    onboardingDay: 2,
  },
  // Regular rules (Day 4+)
  {
    type: 'morning_briefing',
    name: 'Morning Briefing',
    icon: '☀️',
    schedule: 'Daily 7-9am · max 1/day · 20h gap · needs accounts · Day 4+',
    maxPerDay: 1,
    minIntervalHours: 20,
    requiresConnectedAccounts: true,
    hourWindow: [7, 9],
    minMessages: 2,
  },
  {
    type: 'calendar_heads_up',
    name: 'Calendar Heads-Up',
    icon: '📅',
    schedule: '7am-9pm when event in 30-75min · max 1/day · needs accounts · Day 4+',
    maxPerDay: 1,
    minIntervalHours: 1,
    requiresConnectedAccounts: true,
    hourWindow: [7, 21],
    minMessages: 3,
  },
  {
    type: 'follow_up_loop',
    name: 'Follow-Up Loop',
    icon: '🔄',
    schedule: '10am-6pm · when silent 24-72h · max 1/day · 24h gap · Day 4+',
    maxPerDay: 1,
    minIntervalHours: 24,
    requiresConnectedAccounts: false,
    hourWindow: [10, 18],
    minMessages: 5,
    requiresSilence: [24, 72],
  },
  {
    type: 'inactivity_reengagement',
    name: 'Inactivity Re-engage',
    icon: '👋',
    schedule: '9am-7pm · Day 3 (soft) / Day 5 (value) / Day 7 (direct) · 36h gap · Day 4+',
    maxPerDay: 1,
    minIntervalHours: 36,
    requiresConnectedAccounts: false,
    hourWindow: [9, 19],
    minMessages: 2,
    requiresSilence: [72, 192],
  },
  {
    type: 'feature_discovery',
    name: 'Feature Discovery',
    icon: '💡',
    schedule: '9am-7pm · Day 7, 14 after join · max 1/day · 48h gap · Day 4+',
    maxPerDay: 1,
    minIntervalHours: 48,
    requiresConnectedAccounts: false,
    hourWindow: [9, 19],
    minMessages: 0,
    tipDays: [7, 14],
  },
];

export async function handleAutomationEligibility(req: Request, res: Response) {
  try {
    const handle = req.query.handle as string;
    if (!handle) return res.status(400).json({ error: 'handle is required' });

    const supabase = getSupabase();

    // Load user profile
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('handle', handle)
      .maybeSingle();

    if (!profile) return res.status(404).json({ error: 'User not found' });

    const nowEpoch = Math.floor(Date.now() / 1000);
    const tz = profile.timezone || 'Australia/Sydney';
    const lastSeen = profile.last_seen as number || 0;
    const firstSeen = profile.first_seen as number || 0;
    const hoursSinceLastSeen = (nowEpoch - lastSeen) / 3600;
    const daysSinceFirstSeen = (nowEpoch - firstSeen) / 86400;
    const onboardCount = profile.onboard_count || 0;
    const ignoreCount = profile.proactive_ignore_count || 0;
    const lastProactiveIgnored = profile.last_proactive_ignored || false;
    const lastProactiveSentAt = profile.last_proactive_sent_at;

    // Get user's local time (hour + minute)
    let userLocalHour: number;
    let userLocalMinute: number;
    let userLocalTimeStr: string;
    try {
      const now = new Date();
      const hourFmt = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', hour12: false });
      userLocalHour = parseInt(hourFmt.format(now));
      const minFmt = new Intl.DateTimeFormat('en-AU', { timeZone: tz, minute: '2-digit' });
      userLocalMinute = parseInt(minFmt.format(now));
      const timeFmt = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
      userLocalTimeStr = timeFmt.format(now);
    } catch {
      userLocalHour = new Date().getUTCHours() + 10;
      userLocalMinute = new Date().getMinutes();
      userLocalTimeStr = `${userLocalHour}:${String(userLocalMinute).padStart(2, '0')}`;
    }

    // Check connected accounts
    let hasConnectedAccounts = false;
    if (profile.auth_user_id) {
      const [google, microsoft] = await Promise.all([
        supabase.from('user_google_accounts').select('id').eq('user_id', profile.auth_user_id),
        supabase.from('user_microsoft_accounts').select('id').eq('user_id', profile.auth_user_id),
      ]);
      hasConnectedAccounts = (google.data?.length || 0) + (microsoft.data?.length || 0) > 0;
    }

    // Compute calendar days since join (more accurate than epoch division)
    const calendarDaysSinceJoin = getCalendarDaysSince(firstSeen, tz);
    const isOnboardingPeriod = calendarDaysSinceJoin >= 1 && calendarDaysSinceJoin <= 2;

    // Global checks
    const tooNew = calendarDaysSinceJoin < 1; // Day 0 = sign-up day, no automations

    const { data: todayCountData } = await supabase.rpc('automations_sent_today', { p_handle: handle });
    const automationsToday = (todayCountData as number) ?? 0;
    const dailyCapReached = automationsToday >= 1;

    // Spam hold check
    let spamHold = false;
    let spamHoldUntil: string | null = null;
    if (lastProactiveIgnored && lastProactiveSentAt) {
      const hoursSince = (Date.now() - new Date(lastProactiveSentAt).getTime()) / 3600000;
      if (hoursSince < 72) {
        spamHold = true;
        const resumeAt = new Date(new Date(lastProactiveSentAt).getTime() + 72 * 3600000);
        spamHoldUntil = resumeAt.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz });
      }
    }

    const isQuietHours = userLocalHour >= 21 || userLocalHour < 7;

    // Check user preferences
    const { data: prefsData } = await supabase.rpc('get_automation_preferences', { p_handle: handle });
    const prefsMap = new Map<string, boolean>();
    if (prefsData && Array.isArray(prefsData)) {
      for (const p of prefsData as Array<{ automation_type: string; enabled: boolean }>) {
        prefsMap.set(p.automation_type, p.enabled);
      }
    }

    // Evaluate each rule
    const results: EligibilityStatus[] = [];

    // Also fetch Day 2 automation for onboarding checks
    const { data: day2RunData } = await supabase
      .from('automation_runs')
      .select('sent_at, replied_at')
      .eq('handle', handle)
      .eq('automation_type', 'onboarding_morning')
      .order('sent_at', { ascending: false })
      .limit(1);

    for (const rule of RULE_DEFS) {
      const conditions: { label: string; met: boolean; detail: string }[] = [];
      const prefEnabled = prefsMap.get(rule.type) ?? true;

      const isOnboardingRule = rule.type.startsWith('onboarding_');
      const ruleOnboardingDay = (rule as Record<string, unknown>).onboardingDay as number | undefined;

      // Onboarding rules: check calendar day match
      if (isOnboardingRule && ruleOnboardingDay !== undefined) {
        const isCorrectDay = calendarDaysSinceJoin === ruleOnboardingDay;
        conditions.push({
          label: 'Onboarding day',
          met: isCorrectDay,
          detail: isCorrectDay
            ? `Calendar day ${calendarDaysSinceJoin} since join — correct day`
            : `Calendar day ${calendarDaysSinceJoin} since join — needs day ${ruleOnboardingDay}`,
        });

        // Day 3 feature: check if user responded on Day 2
        if (rule.type === 'onboarding_feature') {
          const day2Sent = day2RunData && day2RunData.length > 0;
          const day2SentEpoch = day2Sent ? new Date((day2RunData[0] as Record<string, unknown>).sent_at as string).getTime() / 1000 : 0;
          const respondedToDay2 = day2Sent && lastSeen > day2SentEpoch;
          conditions.push({
            label: 'Responded on Day 2',
            met: !!respondedToDay2,
            detail: respondedToDay2
              ? 'User responded after Day 2 morning message'
              : day2Sent ? 'No response to Day 2 morning message yet' : 'Day 2 morning not sent yet',
          });
        }
      }

      // Regular rules: must be past onboarding period
      if (!isOnboardingRule) {
        const pastOnboarding = calendarDaysSinceJoin >= 3;
        conditions.push({
          label: 'Onboarding complete',
          met: pastOnboarding,
          detail: pastOnboarding
            ? `Day ${calendarDaysSinceJoin + 1} — past onboarding (Day 4+)`
            : `Day ${calendarDaysSinceJoin + 1} — still in onboarding (Days 1-3)`,
        });
      }

      // Sign-up day check
      conditions.push({
        label: 'Sign-up cooldown',
        met: !tooNew,
        detail: tooNew
          ? `Day 0 (sign-up day) — no automations until Day 2`
          : `Day ${calendarDaysSinceJoin} since sign-up`,
      });

      // Check if user disabled this type
      conditions.push({
        label: 'User preference',
        met: prefEnabled,
        detail: prefEnabled ? 'Enabled' : 'Disabled by user',
      });

      // Check connected accounts
      if (rule.requiresConnectedAccounts) {
        conditions.push({
          label: 'Connected accounts',
          met: hasConnectedAccounts,
          detail: hasConnectedAccounts ? 'Has connected accounts' : 'Requires calendar/email connection',
        });
      }

      // Check minimum messages
      if (rule.minMessages > 0) {
        conditions.push({
          label: 'Minimum engagement',
          met: onboardCount >= rule.minMessages,
          detail: onboardCount >= rule.minMessages
            ? `${onboardCount} messages sent (need ${rule.minMessages})`
            : `Only ${onboardCount} messages (need ${rule.minMessages})`,
        });
      }

      // Check quiet hours
      conditions.push({
        label: 'Quiet hours',
        met: !isQuietHours,
        detail: isQuietHours
          ? `Currently ${userLocalHour}:00 local — quiet hours (9pm-7am)`
          : `Currently ${userLocalHour}:00 local — within allowed hours`,
      });

      // Check time window
      const [windowStart, windowEnd] = rule.hourWindow;
      const inWindow = userLocalHour >= windowStart && userLocalHour < windowEnd;
      conditions.push({
        label: 'Time window',
        met: inWindow,
        detail: inWindow
          ? `In window (${windowStart}:00-${windowEnd}:00 local)`
          : `Outside window (${windowStart}:00-${windowEnd}:00 local, currently ${userLocalHour}:00)`,
      });

      // Check daily cap (1 per day)
      conditions.push({
        label: 'Daily limit',
        met: !dailyCapReached,
        detail: dailyCapReached
          ? `${automationsToday} sent today — limit reached (max 1/day)`
          : `${automationsToday} sent today (max 1/day)`,
      });

      // Check spam hold
      conditions.push({
        label: 'Spam guard',
        met: !spamHold,
        detail: spamHold
          ? `Last message ignored — held until ${spamHoldUntil}`
          : ignoreCount > 0 ? `${ignoreCount}/3 consecutive ignores` : 'No ignores',
      });

      // Check per-type rate limit
      const { data: lastOfType } = await supabase.rpc('last_automation_of_type', {
        p_handle: handle,
        p_automation_type: rule.type,
      });
      let intervalMet = true;
      let intervalDetail = 'Never sent';
      let nextEligibleTime: Date | null = null;

      if (lastOfType) {
        const lastSentDate = new Date(lastOfType as string);
        const hoursSinceLast = (Date.now() - lastSentDate.getTime()) / 3600000;
        intervalMet = hoursSinceLast >= rule.minIntervalHours;

        if (intervalMet) {
          intervalDetail = `Last sent ${Math.round(hoursSinceLast)}h ago (min ${rule.minIntervalHours}h)`;
        } else {
          nextEligibleTime = new Date(lastSentDate.getTime() + rule.minIntervalHours * 3600000);
          intervalDetail = `Last sent ${Math.round(hoursSinceLast)}h ago — need ${rule.minIntervalHours}h gap`;
        }
      }

      conditions.push({
        label: 'Rate limit',
        met: intervalMet,
        detail: intervalDetail,
      });

      // Check per-type daily cap
      const { data: typeCountData } = await supabase.rpc('automation_count_in_window', {
        p_handle: handle,
        p_automation_type: rule.type,
        p_hours: 24,
      });
      const typeToday = (typeCountData as number) ?? 0;
      const typeCapMet = typeToday < rule.maxPerDay;
      conditions.push({
        label: 'Type daily cap',
        met: typeCapMet,
        detail: `${typeToday}/${rule.maxPerDay} sent in last 24h`,
      });

      // Type-specific conditions
      if (rule.type === 'inactivity_reengagement') {
        const daysSilent = hoursSinceLastSeen / 24;
        const inSilenceWindow = daysSilent >= 3 && daysSilent < 8;
        let tier = 'none';
        if (daysSilent >= 7) tier = 'direct (7+ days)';
        else if (daysSilent >= 5) tier = 'value (5 days)';
        else if (daysSilent >= 3) tier = 'soft (3 days)';

        conditions.push({
          label: 'Inactivity period',
          met: inSilenceWindow,
          detail: inSilenceWindow
            ? `Silent ${Math.round(daysSilent * 10) / 10} days — tier: ${tier}`
            : `Silent ${Math.round(daysSilent * 10) / 10} days — need 3-8 days`,
        });
      }

      if (rule.type === 'follow_up_loop') {
        const silenceMet = hoursSinceLastSeen >= 24 && hoursSinceLastSeen <= 72;
        conditions.push({
          label: 'Silence window',
          met: silenceMet,
          detail: silenceMet
            ? `${Math.round(hoursSinceLastSeen)}h since last seen (need 24-72h)`
            : `${Math.round(hoursSinceLastSeen)}h since last seen (need 24-72h)`,
        });
      }

      if (rule.type === 'feature_discovery' && rule.tipDays) {
        const onTipDay = rule.tipDays.some(d => daysSinceFirstSeen >= d && daysSinceFirstSeen < d + 2);
        conditions.push({
          label: 'Tip day schedule',
          met: onTipDay,
          detail: onTipDay
            ? `Day ${Math.round(daysSinceFirstSeen)} — on schedule (Day ${rule.tipDays.join('/')})`
            : `Day ${Math.round(daysSinceFirstSeen)} — not a tip day (Day ${rule.tipDays.join('/')})`,
        });
      }

      // Determine overall status + countdown
      const allMet = conditions.every(c => c.met);
      const hardBlockers = ['Connected accounts', 'User preference', 'Spam guard', 'Minimum engagement', 'Sign-up cooldown', 'Onboarding complete', 'Onboarding day', 'Responded on Day 2'];
      const hasBlockers = conditions.some(c => !c.met && hardBlockers.includes(c.label));
      const timingLabels = ['Time window', 'Quiet hours', 'Rate limit', 'Type daily cap', 'Daily limit', 'Inactivity period', 'Silence window', 'Tip day schedule'];
      const isTimingOnly = !allMet && !hasBlockers && conditions.filter(c => !c.met).every(c => timingLabels.includes(c.label));

      let status: 'ready' | 'blocked' | 'waiting' | 'not_applicable';
      let statusLabel: string;
      let nextEligible: string | null = null;
      let countdown: string | null = null;

      // Helper: compute countdown string from a future Date
      const formatCountdown = (futureDate: Date): string => {
        const diffMs = futureDate.getTime() - Date.now();
        if (diffMs <= 0) return 'now';
        const totalMins = Math.floor(diffMs / 60000);
        const hours = Math.floor(totalMins / 60);
        const mins = totalMins % 60;
        if (hours === 0) return `in ${mins}m`;
        if (mins === 0) return `in ${hours}h`;
        return `in ${hours}h ${mins}m`;
      };

      // Helper: compute next window opening
      const computeNextWindowOpen = (): Date | null => {
        try {
          const nowDate = new Date();
          // If we're before the window today, it opens at windowStart today
          // If we're after/in the window, it opens at windowStart tomorrow
          // We need to compute this in the user's timezone
          const parts = new Intl.DateTimeFormat('en-AU', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
          }).formatToParts(nowDate);
          const p: Record<string, string> = {};
          for (const part of parts) { if (part.type !== 'literal') p[part.type] = part.value; }
          const localHourNow = parseInt(p.hour || '0');

          // Create target date string in user's timezone
          // If current hour < windowStart, target is today at windowStart
          // Otherwise, target is tomorrow at windowStart
          const daysToAdd = localHourNow < windowStart ? 0 : 1;
          const target = new Date(nowDate);
          target.setDate(target.getDate() + daysToAdd);
          // Approximate: set to windowStart in UTC adjusted for timezone offset
          // This is rough but sufficient for a countdown display
          const offset = (nowDate.getTime() - new Date(nowDate.toLocaleString('en-US', { timeZone: tz })).getTime());
          const targetLocal = new Date(target.getFullYear(), target.getMonth(), target.getDate() + daysToAdd, windowStart, 0, 0);
          return new Date(targetLocal.getTime() + offset);
        } catch {
          return null;
        }
      };

      if (!prefEnabled) {
        status = 'not_applicable';
        statusLabel = 'Disabled by user';
      } else if (rule.requiresConnectedAccounts && !hasConnectedAccounts) {
        status = 'not_applicable';
        statusLabel = 'Needs connected accounts to activate';
      } else if (spamHold) {
        status = 'blocked';
        const holdEnd = lastProactiveSentAt ? new Date(new Date(lastProactiveSentAt).getTime() + 72 * 3600000) : null;
        countdown = holdEnd ? formatCountdown(holdEnd) : null;
        statusLabel = `Spam hold — resumes ${countdown || 'soon'}`;
        nextEligible = spamHoldUntil;
      } else if (allMet) {
        status = 'ready';
        statusLabel = 'Ready — will fire on next cron (every 5 min)';
        countdown = 'in ~5m';
      } else if (isTimingOnly) {
        status = 'waiting';

        // Figure out the soonest timing constraint
        const soonestTimes: Date[] = [];

        // Rate limit countdown
        if (nextEligibleTime) {
          soonestTimes.push(nextEligibleTime);
        }

        // Window opening countdown
        if (!inWindow) {
          const windowOpen = computeNextWindowOpen();
          if (windowOpen) soonestTimes.push(windowOpen);
        }

        if (soonestTimes.length > 0) {
          // The soonest constraint is the one that matters
          const soonest = soonestTimes.reduce((a, b) => a > b ? a : b); // latest of constraints (all must be met)
          countdown = formatCountdown(soonest);
          nextEligible = soonest.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz });
          statusLabel = `Next eligible ${countdown} (${nextEligible})`;
        } else {
          const failedConditions = conditions.filter(c => !c.met).map(c => c.label);
          statusLabel = `Waiting: ${failedConditions.join(', ')}`;
        }
      } else {
        status = 'blocked';
        const blockerNames = conditions.filter(c => !c.met && hardBlockers.includes(c.label)).map(c => c.label);
        statusLabel = `Blocked — ${blockerNames.join(', ')}`;
      }

      results.push({
        type: rule.type,
        name: rule.name,
        icon: rule.icon,
        schedule: rule.schedule,
        status,
        statusLabel,
        countdown,
        nextEligible,
        conditions,
      });
    }

    // Add global info
    res.json({
      handle,
      localTime: userLocalTimeStr,
      timezone: tz,
      quietHours: isQuietHours,
      tooNew,
      isOnboarding: isOnboardingPeriod,
      calendarDay: calendarDaysSinceJoin,
      daysSinceJoin: Math.round(daysSinceFirstSeen * 10) / 10,
      dailyCap: { used: automationsToday, max: 1, reached: dailyCapReached },
      spamHold: { active: spamHold, until: spamHoldUntil, ignoreCount: ignoreCount, ignoreMax: 3 },
      automations: results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
}

// ============================================================================
// POST /automations/api/trigger — manually trigger an automation
// ============================================================================

export async function handleAutomationTrigger(req: Request, res: Response) {
  try {
    const { handle, automation_type } = req.body;

    if (!handle || !automation_type) {
      return res.status(400).json({ error: 'handle and automation_type are required' });
    }

    const supabase = getSupabase();

    // 1. Load user profile
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('handle', handle)
      .maybeSingle();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'User not found' });
    }

    const botNumber = profile.bot_number;
    if (!botNumber) {
      return res.status(400).json({ error: 'User has no bot number' });
    }

    // 2. Generate contextual message
    console.log(`[automations-api] Generating ${automation_type} for ${handle}...`);
    const result = await generateContextualMessage(automation_type, profile);
    if (!result) {
      return res.status(400).json({ error: `Unknown automation type: ${automation_type}` });
    }

    const bubbleParts = result.message.split(/\n---\n|^---$/m).map((b) => b.trim()).filter(Boolean);
    const outboundParts = bubbleParts.length
      ? bubbleParts.map((b) => cleanResponse(b))
      : [cleanResponse(result.message)];
    const recordedText = outboundParts.join('\n---\n');

    const chatId = `DM#${botNumber}#${handle}`;

    // 3. Record in automation_runs table
    const { error: recordError } = await supabase.rpc('record_automation_run', {
      p_handle: handle,
      p_chat_id: chatId,
      p_automation_type: automation_type,
      p_content: recordedText,
      p_metadata: JSON.stringify(result.metadata),
      p_manual_trigger: true,
      p_triggered_by: 'dashboard',
    });

    if (recordError) {
      console.error('[automations-api] Failed to record run:', recordError.message);
      return res.status(500).json({ error: 'Failed to record: ' + recordError.message });
    }

    // 4. Send via LINQ — use createChat (from, to, message) since we have phone numbers
    const linqToken = process.env.LINQ_API_TOKEN;
    const linqBase = process.env.LINQ_API_BASE_URL || 'https://api.linqapp.com/api/partner/v3';

    if (!linqToken) {
      console.warn('[automations-api] No LINQ_API_TOKEN — recorded but not sent');
      return res.json({
        success: true,
        automation_type,
        message: recordedText,
        handle,
        warning: 'Recorded but not sent (no LINQ_API_TOKEN)',
      });
    }

    try {
      for (const part of outboundParts) {
        const sendResp = await fetch(`${linqBase}/chats`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${linqToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: botNumber,
            to: [handle],
            message: {
              parts: [{ type: 'text', value: part }],
            },
          }),
        });

        if (!sendResp.ok) {
          const errBody = await sendResp.text();
          console.error('[automations-api] LINQ send failed:', sendResp.status, errBody);
          return res.json({
            success: true,
            automation_type,
            message: recordedText,
            handle,
            warning: `Recorded but LINQ failed (${sendResp.status}): ${errBody.slice(0, 200)}`,
          });
        }
      }

      console.log(`[automations-api] Sent ${automation_type} to ${handle}: "${recordedText.slice(0, 60)}..."`);
    } catch (sendErr) {
      console.error('[automations-api] LINQ error:', sendErr);
      return res.json({
        success: true,
        automation_type,
        message: recordedText,
        handle,
        warning: 'Recorded but LINQ threw an error',
      });
    }

    // 5. Store in conversation history
    try {
      await supabase.rpc('append_conversation_message', {
        p_chat_id: chatId,
        p_role: 'assistant',
        p_content: recordedText,
      });
    } catch {
      // Non-fatal
    }

    res.json({
      success: true,
      automation_type,
      message: recordedText,
      handle,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[automations-api] Trigger error:', msg);
    res.status(500).json({ error: msg });
  }
}
