import type { ToolContract } from './types.ts';

export const calendarWriteTool: ToolContract = {
  name: 'calendar_write',
  description:
    "Create, update, or delete calendar events on the user's connected Google Calendar or Outlook. Use action 'create' to add a new event (auto-adds Google Meet or Teams link). Use action 'update' to modify an existing event by its event_id. Use action 'delete' to cancel/remove an event by its event_id. Always use calendar_read first to check for conflicts before creating, and to find the event_id before updating or deleting. Always confirm with the user before executing any write action.",
  namespace: 'calendar.write',
  sideEffect: 'commit',
  idempotent: false,
  timeoutMs: 15000,
  requiresConfirmation: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'update', 'delete'],
        description: "'create' adds a new event. 'update' modifies an existing event. 'delete' removes/cancels an event.",
      },
      title: {
        type: 'string',
        description: 'Event title (required for create, optional for update).',
      },
      start_time: {
        type: 'string',
        description: 'ISO 8601 datetime for event start (required for create, optional for update). e.g. 2026-03-15T09:00:00+11:00',
      },
      end_time: {
        type: 'string',
        description: 'ISO 8601 datetime for event end (required for create, optional for update). Default to 30 minutes after start if not specified.',
      },
      event_id: {
        type: 'string',
        description: 'Event ID from a previous calendar_read result (required for update and delete).',
      },
      attendees: {
        type: 'array',
        items: { type: 'string' },
        description: 'Email addresses of attendees.',
      },
      location: { type: 'string', description: 'Physical location or venue.' },
      description: { type: 'string', description: 'Event description or agenda.' },
      account: {
        type: 'string',
        description: 'Account email to create/update/delete on. If the user has multiple accounts, ask which one to use.',
      },
      calendar_id: {
        type: 'string',
        description: 'Calendar ID for Google events (defaults to "primary"). Not needed for Outlook.',
      },
      all_day: { type: 'boolean', description: 'Whether this is an all-day event.' },
      notify_attendees: {
        type: 'boolean',
        description: 'Whether to send notification emails to attendees (default true).',
      },
      add_meet: {
        type: 'boolean',
        description: 'Add a Google Meet link to an existing event (update only).',
      },
    },
    required: ['action'],
  },
  inputExamples: [
    { action: 'create', title: 'Team standup', start_time: '2026-03-17T09:00:00+11:00', end_time: '2026-03-17T09:30:00+11:00' },
    { action: 'create', title: 'Lunch with Sarah', start_time: '2026-03-18T12:00:00+11:00', end_time: '2026-03-18T13:00:00+11:00', attendees: ['sarah@example.com'], location: 'Cafe Sydney' },
    { action: 'update', event_id: 'abc123', start_time: '2026-03-17T10:00:00+11:00', end_time: '2026-03-17T10:30:00+11:00' },
    { action: 'delete', event_id: 'abc123' },
  ],
  handler: async (input, ctx) => {
    if (!ctx.authUserId) {
      return { content: 'Calendar not connected. The user needs to verify their account first.' };
    }

    const action = input.action as string;

    try {
      const {
        resolveCalendarToken,
        fetchCalendarTimezone,
        fetchOutlookTimezone,
        createGoogleEvent,
        createOutlookEvent,
        updateGoogleEvent,
        updateOutlookEvent,
        deleteGoogleEvent,
        deleteOutlookEvent,
        isGoogleAuthError,
        isMicrosoftAuthError,
      } = await import('../calendar-helpers.ts');

      const token = await resolveCalendarToken(ctx.authUserId, input.account as string | undefined);
      let tz = 'UTC';
      if (token.provider === 'google') {
        try { tz = await fetchCalendarTimezone(token.accessToken); } catch { /* UTC fallback */ }
      } else if (token.provider === 'microsoft') {
        try { tz = await fetchOutlookTimezone(token.accessToken); } catch { /* UTC fallback */ }
      }

      if (action === 'create') {
        if (!input.title) return { content: "Missing 'title'. What should the event be called?" };
        if (!input.start_time) return { content: "Missing 'start_time'. When should this event start? (ISO 8601 format)" };
        if (!input.end_time) return { content: "Missing 'end_time'. When should this event end?" };

        if (token.provider === 'microsoft') {
          const result = await createOutlookEvent(token.accessToken, {
            title: input.title as string,
            start_time: input.start_time as string,
            end_time: input.end_time as string,
            attendees: input.attendees as string[] | undefined,
            location: input.location as string | undefined,
            description: input.description as string | undefined,
            all_day: input.all_day as boolean | undefined,
          }, tz);
          return { content: JSON.stringify({ ...result, verified: true, account: token.email, provider: 'microsoft' }), structuredData: { ...result, verified: true } };
        }

        const result = await createGoogleEvent(token.accessToken, {
          title: input.title as string,
          start_time: input.start_time as string,
          end_time: input.end_time as string,
          attendees: input.attendees as string[] | undefined,
          location: input.location as string | undefined,
          description: input.description as string | undefined,
          all_day: input.all_day as boolean | undefined,
          send_updates: (input.notify_attendees === false) ? 'none' : 'all',
        }, tz);
        return { content: JSON.stringify({ ...result, verified: true, account: token.email, provider: 'google' }), structuredData: { ...result, verified: true } };
      }

      if (action === 'update') {
        if (!input.event_id) return { content: "Missing 'event_id'. Use calendar_read first to find the event you want to update." };

        const updates: Record<string, unknown> = {};
        if (input.title) updates.title = input.title;
        if (input.start_time) updates.start_time = input.start_time;
        if (input.end_time) updates.end_time = input.end_time;
        if (input.attendees) updates.attendees = input.attendees;
        if (input.location) updates.location = input.location;
        if (input.description) updates.description = input.description;
        if (input.add_meet) updates.add_meet = true;

        if (token.provider === 'microsoft') {
          const result = await updateOutlookEvent(token.accessToken, input.event_id as string, updates, tz);
          return { content: JSON.stringify({ ...result, verified: true, account: token.email, provider: 'microsoft' }), structuredData: { ...result, verified: true } };
        }

        const calId = (input.calendar_id as string) || 'primary';
        const sendUpdates = (input.notify_attendees === false) ? 'none' : 'all';
        const result = await updateGoogleEvent(token.accessToken, input.event_id as string, calId, updates, tz, sendUpdates);
        return { content: JSON.stringify({ ...result, verified: true, account: token.email, provider: 'google' }), structuredData: { ...result, verified: true } };
      }

      if (action === 'delete') {
        if (!input.event_id) return { content: "Missing 'event_id'. Use calendar_read first to find the event you want to delete." };

        if (token.provider === 'microsoft') {
          const result = await deleteOutlookEvent(token.accessToken, input.event_id as string);
          return { content: JSON.stringify({ ...result, verified: true, account: token.email, provider: 'microsoft' }), structuredData: { ...result, verified: true } };
        }

        const calId = (input.calendar_id as string) || 'primary';
        const sendUpdates = (input.notify_attendees === false) ? 'none' : 'all';
        const result = await deleteGoogleEvent(token.accessToken, input.event_id as string, calId, sendUpdates);
        return { content: JSON.stringify({ ...result, verified: true, account: token.email, provider: 'google' }), structuredData: { ...result, verified: true } };
      }

      return { content: "Invalid action. Use 'create', 'update', or 'delete'." };
    } catch (err) {
      const msg = (err as Error).message;
      const { isGoogleAuthError, isMicrosoftAuthError } = await import('../calendar-helpers.ts');
      if (isGoogleAuthError(msg)) {
        return { content: 'Google account access expired. The user needs to reconnect their Google account in Settings.' };
      }
      if (isMicrosoftAuthError(msg)) {
        return { content: 'Microsoft account access expired. The user needs to reconnect their Microsoft account in Settings.' };
      }
      return { content: `Calendar write failed: ${msg}` };
    }
  },
};
