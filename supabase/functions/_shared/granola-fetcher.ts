import { getGranolaAccessToken } from './token-broker.ts';

const GRANOLA_MCP_URL = 'https://mcp.granola.ai/mcp';

export interface GranolaMeeting {
  id: string;
  title: string;
  date: string;
  attendees: string[];
  notes: string;
  enhancedNotes: string | null;
  transcript: string | null;
}

interface MCPResponse {
  jsonrpc: string;
  id: number;
  result?: {
    content?: Array<{ type: string; text?: string }>;
  };
  error?: { code: number; message: string };
}

async function parseMCPResponse(resp: Response): Promise<MCPResponse> {
  const raw = await resp.text();

  const dataMatch = raw.match(/^data:\s*(.+)$/m);
  if (dataMatch) {
    return JSON.parse(dataMatch[1]);
  }

  return JSON.parse(raw);
}

async function callMCP(
  accessToken: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const resp = await fetch(GRANOLA_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Granola MCP ${resp.status}: ${text}`);
  }

  const data = await parseMCPResponse(resp);
  if (data.error) throw new Error(`Granola MCP: ${data.error.message}`);

  return data.result?.content
    ?.filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('\n') ?? '';
}

/**
 * Fetch all meetings from Granola, paginating through list_meetings.
 * Returns parsed meeting objects with notes and optional transcripts.
 */
export async function fetchAllGranolaMeetings(
  userId: string,
  options?: { maxMeetings?: number; afterDate?: string },
): Promise<GranolaMeeting[]> {
  const token = await getGranolaAccessToken(userId);
  const accessToken = token.accessToken;
  const maxMeetings = options?.maxMeetings ?? 500;

  const listArgs: Record<string, unknown> = { limit: 50 };
  if (options?.afterDate) listArgs.after = options.afterDate;

  const allMeetings: GranolaMeeting[] = [];
  let hasMore = true;

  while (hasMore && allMeetings.length < maxMeetings) {
    const listResult = await callMCP(accessToken, 'list_meetings', listArgs);
    if (!listResult || listResult === 'No results returned from Granola.') break;

    // Granola returns XML-like text: <meeting id="..." title="..." date="...">
    const meetingMatches = [...listResult.matchAll(/<meeting\s+id="([^"]+)"\s+title="([^"]+)"\s+date="([^"]+)"/g)];

    // Also extract attendees per meeting block
    const meetingBlocks = [...listResult.matchAll(/<meeting\s+id="([^"]+)"[^>]*>([\s\S]*?)(?:<\/meeting>|(?=<meeting\s))/g)];
    const attendeesByMeetingId = new Map<string, string[]>();
    for (const block of meetingBlocks) {
      const blockId = block[1];
      const blockContent = block[2] ?? '';
      const participantSection = blockContent.match(/<known_participants>\s*([\s\S]*?)\s*<\/known_participants>/);
      if (participantSection) {
        const names = participantSection[1]
          .split(',')
          .map((s) => s.trim().replace(/<[^>]+>/g, '').trim())
          .filter(Boolean);
        attendeesByMeetingId.set(blockId, names);
      }
    }

    if (meetingMatches.length === 0) {
      // Fallback: try JSON
      try {
        const parsed = JSON.parse(listResult);
        const jsonMeetings: Array<Record<string, unknown>> = Array.isArray(parsed) ? parsed : (parsed.meetings ?? []);
        for (const m of jsonMeetings) {
          meetingMatches.push([
            '',
            String(m.id ?? m.meeting_id ?? ''),
            String(m.title ?? m.name ?? 'Untitled'),
            String(m.date ?? m.meeting_date ?? ''),
          ] as unknown as RegExpMatchArray);
        }
      } catch {
        console.log('[granola-fetcher] Could not parse list response, stopping');
        break;
      }
    }

    if (meetingMatches.length === 0) break;

    console.log(`[granola-fetcher] Found ${meetingMatches.length} meetings in list response`);

    for (const match of meetingMatches) {
      if (allMeetings.length >= maxMeetings) break;

      const meetingId = match[1];
      const meetingTitle = match[2];
      const meetingDate = match[3];
      if (!meetingId) continue;

      let notes = '';
      let enhancedNotes: string | null = null;
      try {
        const fullMeeting = await callMCP(accessToken, 'get_meetings', { meeting_id: meetingId });
        if (fullMeeting) {
          try {
            const parsed = JSON.parse(fullMeeting);
            notes = parsed.notes ?? parsed.private_notes ?? parsed.content ?? fullMeeting;
            enhancedNotes = parsed.enhanced_notes ?? null;
          } catch {
            notes = fullMeeting;
          }
        }
      } catch (err) {
        console.warn(`[granola-fetcher] Failed to get meeting ${meetingId}:`, (err as Error).message);
      }

      let transcript: string | null = null;
      try {
        const transcriptResult = await callMCP(accessToken, 'get_meeting_transcript', { meeting_id: meetingId });
        if (transcriptResult && !transcriptResult.includes('not available') && !transcriptResult.includes('No results')) {
          transcript = transcriptResult;
        }
      } catch {
        // Transcript may not be available on free tiers
      }

      const attendees = attendeesByMeetingId.get(meetingId) ?? [];

      allMeetings.push({
        id: meetingId,
        title: meetingTitle || 'Untitled Meeting',
        date: meetingDate || new Date().toISOString(),
        attendees,
        notes: typeof notes === 'string' ? notes : JSON.stringify(notes),
        enhancedNotes: enhancedNotes ? (typeof enhancedNotes === 'string' ? enhancedNotes : JSON.stringify(enhancedNotes)) : null,
        transcript,
      });

      // Rate limit between individual meeting fetches
      await new Promise((r) => setTimeout(r, 150));
    }

    // Pagination: Granola returns up to the limit per call
    if (meetingMatches.length >= 50) {
      const lastDate = meetingMatches[meetingMatches.length - 1][3];
      if (lastDate) {
        listArgs.before = lastDate;
      } else {
        hasMore = false;
      }
    } else {
      hasMore = false;
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`[granola-fetcher] Fetched ${allMeetings.length} meetings for user ${userId}`);
  return allMeetings;
}
