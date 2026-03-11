import type { ToolContract } from './types.ts';

export const calendarReadTool: ToolContract = {
  name: 'calendar_read',
  description:
    "Look up or search the user's calendar events across all connected accounts (Google Calendar and Outlook). Use action 'lookup' with a time range to see what's on the schedule (e.g. 'today', 'this week', 'next 3 days', 'next monday'). Use action 'search' with a query to find specific events by title, attendee, location, or calendar name. Results include account, calendar, provider, and meeting links. This is the ONLY source of truth for calendar data — never fabricate events or times.",
  namespace: 'calendar.read',
  sideEffect: 'read',
  idempotent: true,
  timeoutMs: 15000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['lookup', 'search'],
        description: "'lookup' lists events for a time range. 'search' finds events matching a query.",
      },
      range: {
        type: 'string',
        description: "Time range for lookup. Examples: 'today', 'tomorrow', 'this week', 'next week', 'next 3 days', 'next monday', 'past 7 days'. Required for 'lookup', optional for 'search' (defaults to 'next 30 days').",
      },
      query: {
        type: 'string',
        description: "Search filter: matches against event title, attendees, location, calendar name, or account email. Required for 'search', optional for 'lookup'.",
      },
      account: {
        type: 'string',
        description: 'Specific account email to query. If omitted, queries ALL connected accounts.',
      },
      max_results: {
        type: 'number',
        description: 'Maximum events to return per calendar (default 25).',
      },
    },
    required: ['action'],
  },
  inputExamples: [
    { action: 'lookup', range: 'today' },
    { action: 'lookup', range: 'next week' },
    { action: 'lookup', range: 'next 3 days' },
    { action: 'search', query: 'team standup' },
    { action: 'search', query: 'sarah', range: 'this week' },
  ],
  handler: async (input, ctx) => {
    if (!ctx.authUserId) {
      return { content: 'Calendar not connected. The user needs to verify their account first to access their calendar.' };
    }

    const action = input.action as string;

    try {
      const {
        liveCalendarLookup,
        fetchCalendarTimezone,
        fetchOutlookTimezone,
        getAllCalendarTokens,
        isGoogleAuthError,
        isMicrosoftAuthError,
      } = await import('../calendar-helpers.ts');

      let tz = 'UTC';
      try {
        const tokens = await getAllCalendarTokens(ctx.authUserId!);
        for (const token of tokens) {
          try {
            const fetched = token.provider === 'google'
              ? await fetchCalendarTimezone(token.accessToken)
              : await fetchOutlookTimezone(token.accessToken);
            if (fetched && fetched !== 'UTC') {
              tz = fetched;
              break;
            }
          } catch { continue; }
        }
        if (tz && tz !== 'UTC') {
          const { updateUserTimezone } = await import('../state.ts');
          updateUserTimezone(ctx.senderHandle, tz).catch(() => {});
        }
      } catch {
        // Fall through with UTC
      }

      if (action === 'lookup') {
        const range = (input.range as string) || 'today';
        const { resolveTimeRange } = await import('../calendar-helpers.ts');
        const resolved = resolveTimeRange(range, tz);
        console.log(`[calendar_read] lookup: range="${range}", tz="${tz}", resolved timeMin=${resolved.timeMin}, timeMax=${resolved.timeMax}`);
        const result = await liveCalendarLookup(
          ctx.authUserId, range, tz, input.query as string | undefined,
          input.account as string | undefined, (input.max_results as number) || 25,
        );
        console.log(`[calendar_read] lookup result: ${result.events.length} events`);
        for (const evt of result.events.slice(0, 5)) {
          console.log(`[calendar_read]   event: "${evt.title}" start=${evt.start_iso} end=${evt.end_iso} account=${evt.account}`);
        }
        if (result.events.length === 0) {
          return { content: JSON.stringify({ events: [], message: `No events found for "${range}".` }) };
        }
        return { content: JSON.stringify(result) };
      }

      if (action === 'search') {
        if (!input.query) return { content: "Missing 'query' parameter. Provide a search term like a person's name, event title, or location." };
        const range = (input.range as string) || 'next 30 days';
        const result = await liveCalendarLookup(
          ctx.authUserId, range, tz, input.query as string,
          input.account as string | undefined, (input.max_results as number) || 25,
        );
        if (result.events.length === 0) {
          return { content: JSON.stringify({ events: [], message: `No events matching "${input.query}" found.` }) };
        }
        return { content: JSON.stringify(result) };
      }

      return { content: "Invalid action. Use 'lookup' to see your schedule or 'search' to find specific events." };
    } catch (err) {
      const msg = (err as Error).message;
      const { isGoogleAuthError, isMicrosoftAuthError } = await import('../calendar-helpers.ts');
      if (isGoogleAuthError(msg)) {
        return { content: 'Google account access expired. The user needs to reconnect their Google account in Settings.' };
      }
      if (isMicrosoftAuthError(msg)) {
        return { content: 'Microsoft account access expired. The user needs to reconnect their Microsoft account in Settings.' };
      }
      return { content: `Calendar lookup failed: ${msg}. Try again or use a simpler range like "today" or "this week".` };
    }
  },
};
