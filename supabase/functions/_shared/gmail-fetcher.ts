// Gmail thread fetcher for server-side ingestion pipeline.
// Two-phase API:
//   listGmailThreadIds()     — cheap: just lists IDs via search
//   fetchGmailThreadsByIds() — expensive: fetches full thread content for specific IDs
// Adapted from TapMeeting's gmail-fetcher.ts.

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 50;

export interface GmailThread {
  threadId: string;
  subject: string;
  participants: string[];
  messages: GmailParsedMessage[];
  lastMessageDate: string;
}

export interface GmailParsedMessage {
  messageId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  bodyPlain: string;
  internalDate: number;
}

export async function listGmailThreadIds(
  accessToken: string,
  daysBack: number,
  maxThreads = Infinity,
): Promise<string[]> {
  const query = `newer_than:${daysBack}d -in:trash -in:spam`;
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const batchSize = Number.isFinite(maxThreads)
      ? Math.min(100, maxThreads - ids.length)
      : 100;
    const params = new URLSearchParams({ q: query, maxResults: String(batchSize) });
    if (pageToken) params.set('pageToken', pageToken);

    const resp = await fetch(`${GMAIL_API}/threads?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`Gmail list threads failed (${resp.status}): ${detail.slice(0, 200)}`);
    }

    const data = await resp.json();
    for (const t of data.threads ?? []) {
      if (ids.length >= maxThreads) break;
      ids.push(t.id);
    }
    pageToken = data.nextPageToken;

    const cap = Number.isFinite(maxThreads) ? `/${maxThreads}` : '';
    console.log(`[gmail-fetcher] Listed ${ids.length}${cap} thread IDs...`);
  } while (pageToken && ids.length < maxThreads);

  return ids;
}

export async function fetchGmailThreadsByIds(
  accessToken: string,
  threadIds: string[],
): Promise<GmailThread[]> {
  if (threadIds.length === 0) return [];

  const threads: GmailThread[] = [];

  for (let i = 0; i < threadIds.length; i += BATCH_SIZE) {
    const batch = threadIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((id) => fetchAndParseThread(accessToken, id).catch((e) => {
        console.warn(`[gmail-fetcher] Failed to fetch thread ${id}:`, (e as Error).message);
        return null;
      })),
    );
    for (const t of results) {
      if (t) threads.push(t);
    }

    if (i + BATCH_SIZE < threadIds.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return threads;
}

// ── Outlook message fetcher for ingestion ───────────────────────

const GRAPH_API = 'https://graph.microsoft.com/v1.0/me';

export interface OutlookThread {
  threadId: string;
  subject: string;
  participants: string[];
  messages: Array<{ from: string; body: string; date: string }>;
  lastMessageDate: string;
}

export async function fetchOutlookMessages(
  accessToken: string,
  daysBack: number,
  maxMessages = Infinity,
): Promise<OutlookThread[]> {
  const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString();
  const threads = new Map<string, OutlookThread>();
  let nextLink: string | null = null;
  let fetched = 0;
  const MAX_PAGES = 20;

  const top = Number.isFinite(maxMessages) ? Math.min(maxMessages, 50) : 50;
  const initialUrl = `${GRAPH_API}/messages?` + new URLSearchParams({
    $filter: `receivedDateTime ge ${cutoff}`,
    $top: String(top),
    $orderby: 'receivedDateTime desc',
    $select: 'id,conversationId,from,toRecipients,ccRecipients,subject,receivedDateTime,bodyPreview,body',
  }).toString();

  let url: string = initialUrl;
  let page = 0;

  do {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!resp.ok) {
      console.warn(`[gmail-fetcher] Outlook messages fetch failed (${resp.status})`);
      break;
    }

    const data = await resp.json();

    for (const m of data.value ?? []) {
      if (fetched >= maxMessages) break;

      const threadId = m.conversationId ?? m.id;
      const fromAddr = m.from?.emailAddress
        ? `${m.from.emailAddress.name ?? ''} <${m.from.emailAddress.address}>`
        : '';
      const toAddrs = (m.toRecipients ?? []).map((r: any) => r.emailAddress?.address).filter(Boolean);

      let body = '';
      if (m.body?.contentType === 'text') {
        body = m.body.content ?? '';
      } else if (m.body?.content) {
        body = m.body.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      }

      if (!threads.has(threadId)) {
        threads.set(threadId, {
          threadId,
          subject: m.subject ?? '',
          participants: [],
          messages: [],
          lastMessageDate: m.receivedDateTime ?? '',
        });
      }

      const thread = threads.get(threadId)!;
      thread.messages.push({
        from: fromAddr,
        body: body.slice(0, 2000),
        date: m.receivedDateTime ?? '',
      });

      const allParticipants = new Set(thread.participants);
      if (fromAddr) allParticipants.add(fromAddr);
      for (const addr of toAddrs) allParticipants.add(addr);
      thread.participants = [...allParticipants];

      fetched++;
    }

    nextLink = data['@odata.nextLink'] ?? null;
    if (nextLink) url = nextLink;
    page++;
  } while (nextLink && fetched < maxMessages && page < MAX_PAGES);

  for (const thread of threads.values()) {
    thread.messages.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }

  console.log(`[gmail-fetcher] Outlook: ${threads.size} threads from ${fetched} messages`);
  return [...threads.values()];
}

// ── Internal helpers ────────────────────────────────────────────

async function fetchAndParseThread(
  accessToken: string,
  threadId: string,
): Promise<GmailThread> {
  const resp = await fetch(`${GMAIL_API}/threads/${threadId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Gmail get thread failed (${resp.status}): ${detail.slice(0, 200)}`);
  }

  const data = await resp.json();
  const messages: GmailParsedMessage[] = [];
  const participantSet = new Set<string>();
  let subject = '';

  for (const msg of data.messages ?? []) {
    const headers: Record<string, string> = {};
    for (const h of msg.payload?.headers ?? []) {
      headers[h.name] = h.value;
    }

    if (!subject && headers['Subject']) subject = headers['Subject'];

    const from = headers['From'] ?? '';
    const to = headers['To'] ?? '';
    const cc = headers['Cc'] ?? '';

    if (from) participantSet.add(extractEmail(from));
    for (const addr of [to, cc].join(',').split(',')) {
      const e = extractEmail(addr.trim());
      if (e) participantSet.add(e);
    }

    const bodyPlain = extractPlainText(msg.payload) ?? msg.snippet ?? '';

    messages.push({
      messageId: msg.id,
      from,
      to,
      cc,
      subject: headers['Subject'] ?? subject,
      date: headers['Date'] ?? '',
      bodyPlain,
      internalDate: parseInt(msg.internalDate ?? '0', 10),
    });
  }

  messages.sort((a, b) => a.internalDate - b.internalDate);

  return {
    threadId,
    subject,
    participants: [...participantSet],
    messages,
    lastMessageDate: messages.length > 0
      ? new Date(messages[messages.length - 1].internalDate).toISOString()
      : new Date().toISOString(),
  };
}

function extractPlainText(payload: any): string | null {
  if (!payload) return null;

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    try {
      return atob(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
    } catch {
      return null;
    }
  }

  for (const part of payload.parts ?? []) {
    const text = extractPlainText(part);
    if (text) return text;
  }

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    try {
      const html = atob(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
      return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    } catch {
      return null;
    }
  }

  return null;
}

function extractEmail(headerValue: string): string {
  const match = headerValue.match(/<([^>]+)>/);
  if (match) return match[1].toLowerCase();
  if (headerValue.includes('@')) return headerValue.trim().toLowerCase();
  return '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
