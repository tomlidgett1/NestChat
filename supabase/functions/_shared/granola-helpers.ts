import { getGranolaAccessToken } from './token-broker.ts';

const GRANOLA_MCP_URL = 'https://mcp.granola.ai/mcp';

interface GranolaMCPRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface GranolaMCPResponse {
  jsonrpc: string;
  id: number;
  result?: {
    content?: Array<{ type: string; text?: string }>;
  };
  error?: { code: number; message: string };
}

async function parseMCPResponse(resp: Response): Promise<GranolaMCPResponse> {
  const raw = await resp.text();

  const dataMatch = raw.match(/^data:\s*(.+)$/m);
  if (dataMatch) {
    return JSON.parse(dataMatch[1]);
  }

  return JSON.parse(raw);
}

async function callGranolaMCP(
  accessToken: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const request: GranolaMCPRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  };

  const resp = await fetch(GRANOLA_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(request),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    if (resp.status === 401 || resp.status === 403) {
      throw new Error('Granola authentication expired. The user needs to reconnect their Granola account.');
    }
    throw new Error(`Granola MCP error (${resp.status}): ${text}`);
  }

  const data = await parseMCPResponse(resp);

  if (data.error) {
    throw new Error(`Granola MCP error: ${data.error.message}`);
  }

  const textContent = data.result?.content
    ?.filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('\n');

  return textContent || 'No results returned from Granola.';
}

export async function queryGranolaMeetings(
  userId: string,
  query: string,
): Promise<string> {
  const token = await getGranolaAccessToken(userId);
  return callGranolaMCP(token.accessToken, 'query_granola_meetings', { query });
}

export async function listGranolaMeetings(
  userId: string,
  options?: { limit?: number; before?: string; after?: string },
): Promise<string> {
  const token = await getGranolaAccessToken(userId);
  const args: Record<string, unknown> = {};
  if (options?.limit) args.limit = options.limit;
  if (options?.before) args.before = options.before;
  if (options?.after) args.after = options.after;
  return callGranolaMCP(token.accessToken, 'list_meetings', args);
}

export async function getGranolaMeeting(
  userId: string,
  meetingId: string,
): Promise<string> {
  const token = await getGranolaAccessToken(userId);
  return callGranolaMCP(token.accessToken, 'get_meetings', { meeting_ids: [meetingId] });
}

export async function getGranolaMeetingTranscript(
  userId: string,
  meetingId: string,
): Promise<string> {
  const token = await getGranolaAccessToken(userId);
  return callGranolaMCP(token.accessToken, 'get_meeting_transcript', { meeting_id: meetingId });
}
