import type { ToolContract } from './types.ts';

export const granolaReadTool: ToolContract = {
  name: 'granola_read',
  description:
    "Search and read the user's Granola meeting notes. Supports four actions: 'query' to ask questions across all meeting notes (e.g. action items, decisions, topics discussed), 'list' to browse recent meetings with titles/dates/attendees, 'get' to retrieve full notes for a specific meeting by ID, and 'transcript' to get the raw transcript of a specific meeting (paid Granola tiers only). Use 'query' for open-ended questions about meetings. Use 'list' then 'get' to drill into specific meetings. IMPORTANT: If 'query' returns no results, ALWAYS fall back to 'list' (with 'after' set to the relevant date) to find the meeting by date/title, then use 'get' on the matching meeting ID.",
  namespace: 'granola.read',
  sideEffect: 'read',
  idempotent: true,
  timeoutMs: 15000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['query', 'list', 'get', 'transcript'],
        description: "'query' searches across all notes. 'list' shows recent meetings. 'get' retrieves a specific meeting's notes. 'transcript' retrieves raw transcript.",
      },
      query: {
        type: 'string',
        description: "Natural language question to ask across meeting notes (required for 'query' action). E.g. 'What action items came out of last week's meetings?' or 'What did we discuss about the Q1 roadmap?'",
      },
      meeting_id: {
        type: 'string',
        description: "The meeting ID from a previous 'list' result (required for 'get' and 'transcript' actions).",
      },
      limit: {
        type: 'number',
        description: "Max meetings to return for 'list' action (default 10).",
      },
      before: {
        type: 'string',
        description: "ISO date string. Only return meetings before this date (for 'list' action).",
      },
      after: {
        type: 'string',
        description: "ISO date string. Only return meetings after this date (for 'list' action).",
      },
    },
    required: ['action'],
  },
  inputExamples: [
    { action: 'query', query: 'What action items came out of meetings this week?' },
    { action: 'list', limit: 5 },
    { action: 'get', meeting_id: 'abc123' },
    { action: 'transcript', meeting_id: 'abc123' },
  ],
  handler: async (input, ctx) => {
    if (!ctx.authUserId) {
      return { content: 'Granola is not connected. The user needs to connect their Granola account first.' };
    }

    const action = input.action as string;

    try {
      if (action === 'query') {
        if (!input.query) return { content: "Missing 'query' parameter. Ask a question like 'What were the action items from last week?'" };
        const { queryGranolaMeetings } = await import('../granola-helpers.ts');
        const result = await queryGranolaMeetings(ctx.authUserId, input.query as string);
        return { content: result };
      }

      if (action === 'list') {
        const { listGranolaMeetings } = await import('../granola-helpers.ts');
        const result = await listGranolaMeetings(ctx.authUserId, {
          limit: input.limit as number | undefined,
          before: input.before as string | undefined,
          after: input.after as string | undefined,
        });
        return { content: result };
      }

      if (action === 'get') {
        if (!input.meeting_id) return { content: "Missing 'meeting_id'. Use granola_read with action 'list' first to find the meeting ID." };
        const { getGranolaMeeting } = await import('../granola-helpers.ts');
        const result = await getGranolaMeeting(ctx.authUserId, input.meeting_id as string);
        return { content: result };
      }

      if (action === 'transcript') {
        if (!input.meeting_id) return { content: "Missing 'meeting_id'. Use granola_read with action 'list' first to find the meeting ID." };
        const { getGranolaMeetingTranscript } = await import('../granola-helpers.ts');
        const result = await getGranolaMeetingTranscript(ctx.authUserId, input.meeting_id as string);
        return { content: result };
      }

      return { content: "Invalid action. Use 'query' to search notes, 'list' to browse meetings, 'get' for full notes, or 'transcript' for raw transcript." };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('authentication') || msg.includes('auth') || msg.includes('token') || msg.includes('No Granola account')) {
        return { content: `Granola access error: ${msg}. The user may need to reconnect their Granola account.` };
      }
      return { content: `Granola read failed: ${msg}` };
    }
  },
};
