// Gmail + Outlook email helpers for Nest V3.
// Uses token-broker.ts for all token management.

import {
  getGoogleAccessToken,
  getAllGoogleTokens,
  getMicrosoftAccessToken,
  type TokenResult,
  type TokenOptions,
} from './token-broker.ts';
import { getAdminClient } from './supabase.ts';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GRAPH_API = 'https://graph.microsoft.com/v1.0/me';
const DEFAULT_TZ = 'Australia/Melbourne';

// Test safety: only allow sends to this address, block writes from protected accounts
const TEST_SAFE_RECIPIENT = Deno.env.get('TEST_SAFE_RECIPIENT') ?? null;
const TEST_PROTECTED_ACCOUNTS = (Deno.env.get('TEST_PROTECTED_ACCOUNTS') ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function enforceTestSafety(to: string[], fromAccount?: string): string | null {
  if (!TEST_SAFE_RECIPIENT) return null;
  const safeRecip = TEST_SAFE_RECIPIENT.toLowerCase();
  const unsafeRecipients = to.filter(r => r.toLowerCase() !== safeRecip);
  if (unsafeRecipients.length > 0) {
    return `TEST SAFETY: blocked send to ${unsafeRecipients.join(', ')} — only ${TEST_SAFE_RECIPIENT} is allowed during testing`;
  }
  if (fromAccount && TEST_PROTECTED_ACCOUNTS.includes(fromAccount.toLowerCase())) {
    return `TEST SAFETY: blocked write from protected account ${fromAccount}`;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// TOKEN RESOLUTION
// ══════════════════════════════════════════════════════════════

export interface ResolvedToken {
  accessToken: string;
  email: string;
  provider: 'google' | 'microsoft';
}

export async function resolveToken(
  userId: string,
  accountEmail?: string,
): Promise<ResolvedToken> {
  if (accountEmail) {
    const provider = await detectProvider(userId, accountEmail);
    if (provider === 'microsoft') {
      const result = await getMicrosoftAccessToken(userId, { email: accountEmail });
      return { accessToken: result.accessToken, email: result.email, provider: 'microsoft' };
    }
    const result = await getGoogleAccessToken(userId, { email: accountEmail });
    return { accessToken: result.accessToken, email: result.email, provider: 'google' };
  }
  try {
    const result = await getGoogleAccessToken(userId);
    return { accessToken: result.accessToken, email: result.email, provider: 'google' };
  } catch {
    const result = await getMicrosoftAccessToken(userId);
    return { accessToken: result.accessToken, email: result.email, provider: 'microsoft' };
  }
}

async function detectProvider(
  userId: string,
  accountEmail: string,
): Promise<'google' | 'microsoft'> {
  const supabase = getAdminClient();

  const { data: msAcct } = await supabase
    .from('user_microsoft_accounts')
    .select('id')
    .eq('user_id', userId)
    .eq('microsoft_email', accountEmail)
    .maybeSingle();

  if (msAcct) return 'microsoft';
  return 'google';
}

// ══════════════════════════════════════════════════════════════
// GMAIL — SEARCH / READ
// ══════════════════════════════════════════════════════════════

export async function listGmailMessages(
  accessToken: string,
  query: string,
  maxResults: number = 5,
): Promise<any[]> {
  const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
  const response = await fetch(
    `${GMAIL_API}/messages?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error(`[gmail-helpers] listGmailMessages failed (${response.status}): ${detail.slice(0, 300)}`);
    return [];
  }
  const data = await response.json();
  return data.messages ?? [];
}

export interface GmailMessageData {
  messageId: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  replyTo: string;
  subject: string;
  date: string;
  snippet: string;
  bodyPreview: string;
  labelIds: string[];
  isImportant: boolean;
  isStarred: boolean;
  internalDate: number;
  attachmentCount: number;
  allHeaders: Record<string, string>;
}

export async function getGmailMessage(
  accessToken: string,
  messageId: string,
): Promise<GmailMessageData> {
  const url = `${GMAIL_API}/messages/${messageId}?format=full`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error(`[gmail-helpers] getGmailMessage failed (${response.status}) for ${messageId}: ${detail.slice(0, 200)}`);
    return emptyGmailMessage(messageId);
  }

  const data = await response.json();

  const allHeaders: Record<string, string> = {};
  const rawHeaders: Array<{ name: string; value: string }> = data.payload?.headers ?? [];
  for (const h of rawHeaders) {
    allHeaders[h.name] = h.value;
  }

  const bodyText = extractPlainTextBody(data.payload);
  const attachmentCount = countAttachments(data.payload);
  const labelIds: string[] = data.labelIds ?? [];

  return {
    messageId: data.id ?? messageId,
    threadId: data.threadId ?? '',
    from: allHeaders['From'] ?? '',
    to: allHeaders['To'] ?? '',
    cc: allHeaders['Cc'] ?? '',
    replyTo: allHeaders['Reply-To'] ?? '',
    subject: allHeaders['Subject'] ?? '',
    date: allHeaders['Date'] ?? '',
    snippet: data.snippet ?? '',
    bodyPreview: bodyText ? bodyText.slice(0, 2000) : (data.snippet ?? ''),
    labelIds,
    isImportant: labelIds.includes('IMPORTANT'),
    isStarred: labelIds.includes('STARRED'),
    internalDate: parseInt(data.internalDate ?? '0', 10),
    attachmentCount,
    allHeaders,
  };
}

function emptyGmailMessage(messageId: string): GmailMessageData {
  return {
    messageId, threadId: '', from: '', to: '', cc: '', replyTo: '',
    subject: '', date: '', snippet: '', bodyPreview: '', labelIds: [],
    isImportant: false, isStarred: false, internalDate: 0, attachmentCount: 0,
    allHeaders: {},
  };
}

function extractPlainTextBody(payload: any): string | null {
  if (!payload) return null;

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    try {
      return atob(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
    } catch {
      return null;
    }
  }

  for (const part of payload.parts ?? []) {
    const text = extractPlainTextBody(part);
    if (text) return text;
  }

  return null;
}

function countAttachments(payload: any): number {
  if (!payload) return 0;
  let count = 0;
  if (payload.filename && payload.filename.length > 0) count++;
  for (const part of payload.parts ?? []) {
    count += countAttachments(part);
  }
  return count;
}

function flattenParts(payload: any): any[] {
  if (!payload) return [];
  const result: any[] = [payload];
  for (const part of payload.parts ?? []) {
    result.push(...flattenParts(part));
  }
  return result;
}

function base64Decode(data: string): string {
  return atob(data.replace(/-/g, '+').replace(/_/g, '/'));
}

// ══════════════════════════════════════════════════════════════
// GMAIL — DRAFT / SEND
// ══════════════════════════════════════════════════════════════

export async function createGmailDraft(
  accessToken: string,
  to: string[],
  subject: string,
  body: string,
  cc?: string[],
  bcc?: string[],
): Promise<{ draftId: string; status: string }> {
  const raw = createRawEmail(to, subject, body, cc, bcc);

  const response = await fetch(`${GMAIL_API}/drafts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: { raw } }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gmail create draft failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const draft = await response.json();
  return { draftId: draft.id, status: 'draft_created' };
}

export async function createGmailReplyDraft(
  accessToken: string,
  threadId: string,
  body: string,
  _replyAll: boolean = false,
  to?: string[],
  subject?: string,
  cc?: string[],
): Promise<{ draftId: string; threadId: string; status: string }> {
  const raw = createRawReply(body, to, subject, cc);

  const response = await fetch(`${GMAIL_API}/drafts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: { threadId, raw } }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gmail reply draft failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const draft = await response.json();
  return { draftId: draft.id, threadId, status: 'reply_draft_created' };
}

export async function sendGmailDraft(
  accessToken: string,
  draftId: string,
): Promise<{ messageId: string; threadId: string; status: string }> {
  const response = await fetch(`${GMAIL_API}/drafts/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ id: draftId }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Send email failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  const sent = await response.json();
  return {
    messageId: sent.message?.id ?? sent.id,
    threadId: sent.message?.threadId ?? sent.threadId ?? '',
    status: 'sent',
  };
}

// ══════════════════════════════════════════════════════════════
// OUTLOOK — GMAIL QUERY TRANSLATION
// ══════════════════════════════════════════════════════════════

interface OutlookQueryParts {
  search: string | null;
  filter: string | null;
}

function gmailQueryToOutlook(gmailQuery: string): OutlookQueryParts {
  let remaining = gmailQuery;
  const filters: string[] = [];

  const newerMatch = remaining.match(/newer_than:(\d+)([dhm])/i);
  if (newerMatch) {
    const val = parseInt(newerMatch[1], 10);
    const unit = newerMatch[2].toLowerCase();
    const ms = unit === 'd' ? val * 86400000 : unit === 'h' ? val * 3600000 : val * 60000;
    const since = new Date(Date.now() - ms).toISOString();
    filters.push(`receivedDateTime ge ${since}`);
    remaining = remaining.replace(newerMatch[0], '');
  }

  const olderMatch = remaining.match(/older_than:(\d+)([dhm])/i);
  if (olderMatch) {
    const val = parseInt(olderMatch[1], 10);
    const unit = olderMatch[2].toLowerCase();
    const ms = unit === 'd' ? val * 86400000 : unit === 'h' ? val * 3600000 : val * 60000;
    const before = new Date(Date.now() - ms).toISOString();
    filters.push(`receivedDateTime le ${before}`);
    remaining = remaining.replace(olderMatch[0], '');
  }

  const fromMatch = remaining.match(/from:(\S+)/i);
  if (fromMatch) {
    filters.push(`from/emailAddress/address eq '${fromMatch[1].replace(/'/g, "''")}'`);
    remaining = remaining.replace(fromMatch[0], '');
  }

  const unreadMatch = remaining.match(/is:unread/i);
  if (unreadMatch) {
    filters.push('isRead eq false');
    remaining = remaining.replace(unreadMatch[0], '');
  }

  const attachMatch = remaining.match(/has:attachment/i);
  if (attachMatch) {
    filters.push('hasAttachments eq true');
    remaining = remaining.replace(attachMatch[0], '');
  }

  remaining = remaining.replace(/\b(in:(inbox|sent|drafts|trash|spam)|label:\S+|is:(starred|important|read))\b/gi, '');

  const subjectMatch = remaining.match(/subject:(?:"([^"]+)"|(\S+))/i);
  let searchText = '';
  if (subjectMatch) {
    searchText = subjectMatch[1] || subjectMatch[2];
    remaining = remaining.replace(subjectMatch[0], '');
  }

  const leftover = remaining.replace(/[()]/g, '').trim();
  if (leftover && !searchText) {
    searchText = leftover;
  } else if (leftover && searchText) {
    searchText = `${searchText} ${leftover}`;
  }

  return {
    search: searchText.trim() || null,
    filter: filters.length > 0 ? filters.join(' and ') : null,
  };
}

// ══════════════════════════════════════════════════════════════
// OUTLOOK — SEARCH / READ
// ══════════════════════════════════════════════════════════════

export async function searchOutlookMessages(
  accessToken: string,
  accountEmail: string,
  query: string,
  maxResults: number,
  tz: string,
): Promise<any[]> {
  const translated = gmailQueryToOutlook(query);
  console.log(`[gmail-helpers] outlook query translation: "${query}" → search=${translated.search}, filter=${translated.filter}`);

  const params = new URLSearchParams({
    $top: String(maxResults),
    $select: 'id,conversationId,from,toRecipients,ccRecipients,subject,receivedDateTime,bodyPreview,body,hasAttachments',
  });

  if (translated.search) {
    params.set('$search', `"${translated.search}"`);
  }
  if (translated.filter) {
    params.set('$filter', translated.filter);
  }
  if (!translated.search) {
    params.set('$orderby', 'receivedDateTime desc');
  }

  const resp = await fetch(
    `${GRAPH_API}/messages?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    console.warn(`[gmail-helpers] outlook search failed for ${accountEmail} (${resp.status}): ${detail.slice(0, 200)}`);
    if (translated.filter && !translated.search) {
      console.log(`[gmail-helpers] retrying outlook search without filter, using simple list`);
      const fallbackParams = new URLSearchParams({
        $top: String(maxResults),
        $orderby: 'receivedDateTime desc',
        $select: 'id,conversationId,from,toRecipients,ccRecipients,subject,receivedDateTime,bodyPreview,body,hasAttachments',
      });
      const fallbackResp = await fetch(
        `${GRAPH_API}/messages?${fallbackParams}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!fallbackResp.ok) return [];
      const fallbackData = await fallbackResp.json();
      return formatOutlookMessages(fallbackData.value ?? [], accountEmail, tz);
    }
    return [];
  }

  const data = await resp.json();
  return formatOutlookMessages(data.value ?? [], accountEmail, tz);
}

function formatOutlookMessages(messages: any[], accountEmail: string, tz: string): any[] {
  return messages.map((m: any) => {
    let dateLocal = m.receivedDateTime ?? '';
    try {
      const parsed = new Date(m.receivedDateTime);
      if (!isNaN(parsed.getTime())) {
        dateLocal = parsed.toLocaleString('en-AU', {
          weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
          hour: 'numeric', minute: '2-digit', hour12: true,
          timeZone: tz,
        });
      }
    } catch { /* keep raw */ }

    const toAddrs = (m.toRecipients ?? []).map((r: any) => r.emailAddress?.address).filter(Boolean).join(', ');
    const ccAddrs = (m.ccRecipients ?? []).map((r: any) => r.emailAddress?.address).filter(Boolean).join(', ');

    return {
      message_id: m.id,
      thread_id: m.conversationId ?? m.id,
      from: m.from?.emailAddress ? `${m.from.emailAddress.name ?? ''} <${m.from.emailAddress.address}>` : '',
      to: toAddrs,
      cc: ccAddrs,
      subject: m.subject ?? '',
      date: dateLocal,
      snippet: (m.bodyPreview ?? '').slice(0, 200),
      body_preview: (m.bodyPreview ?? '').slice(0, 2000),
      has_attachments: !!m.hasAttachments,
      account: accountEmail,
      provider: 'microsoft',
    };
  });
}

export async function getOutlookEmail(
  accessToken: string,
  messageId: string,
  tz: string,
): Promise<unknown> {
  const resp = await fetch(
    `${GRAPH_API}/messages/${encodeURIComponent(messageId)}?$select=id,conversationId,from,toRecipients,ccRecipients,subject,receivedDateTime,body,hasAttachments,attachments`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok) throw new Error(`Get Outlook email failed (${resp.status})`);

  const m = await resp.json();

  let body = '';
  if (m.body?.contentType === 'text') {
    body = m.body.content ?? '';
  } else if (m.body?.content) {
    body = m.body.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  let dateLocal = m.receivedDateTime ?? '';
  try {
    const parsed = new Date(m.receivedDateTime);
    if (!isNaN(parsed.getTime())) {
      dateLocal = parsed.toLocaleString('en-AU', {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
        timeZone: tz,
      });
    }
  } catch { /* keep raw */ }

  const toAddrs = (m.toRecipients ?? []).map((r: any) => r.emailAddress?.address).filter(Boolean).join(', ');
  const ccAddrs = (m.ccRecipients ?? []).map((r: any) => r.emailAddress?.address).filter(Boolean).join(', ');

  const attachments = (m.attachments ?? [])
    .filter((a: any) => a.name)
    .map((a: any) => ({ filename: a.name, mime_type: a.contentType, size: a.size }));

  return {
    message_id: m.id,
    thread_id: m.conversationId ?? m.id,
    from: m.from?.emailAddress ? `${m.from.emailAddress.name ?? ''} <${m.from.emailAddress.address}>` : '',
    to: toAddrs,
    cc: ccAddrs,
    subject: m.subject ?? '',
    date: dateLocal,
    body,
    attachments,
    labels: [],
    provider: 'microsoft',
  };
}

// ══════════════════════════════════════════════════════════════
// OUTLOOK — DRAFT / SEND
// ══════════════════════════════════════════════════════════════

export async function createOutlookDraft(
  accessToken: string,
  acctEmail: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const toList = Array.isArray(args.to) ? args.to : [args.to as string];
  const ccList = args.cc ? (Array.isArray(args.cc) ? args.cc : [args.cc as string]) : [];

  const bodyStr = (args.body as string) ?? '';
  const htmlBody = bodyStr.includes('<br') || bodyStr.includes('<p')
    ? bodyStr
    : bodyStr.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>\n');

  const message: Record<string, unknown> = {
    subject: args.subject,
    body: { contentType: 'html', content: htmlBody },
    toRecipients: toList.map((email: string) => ({ emailAddress: { address: email } })),
  };
  if (ccList.length) {
    message.ccRecipients = ccList.map((email: string) => ({ emailAddress: { address: email } }));
  }

  if (args.reply_to_thread_id) {
    const replyResp = await fetch(
      `${GRAPH_API}/messages/${encodeURIComponent(args.reply_to_thread_id as string)}/createReply`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: '' }),
      },
    );
    if (replyResp.ok) {
      const replyDraft = await replyResp.json();
      await fetch(
        `${GRAPH_API}/messages/${encodeURIComponent(replyDraft.id)}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: { contentType: 'html', content: htmlBody } }),
        },
      );
      return {
        draft_id: replyDraft.id,
        status: 'draft_created',
        to: args.to, subject: args.subject,
        is_reply: true,
        reply_all: !!args.reply_all,
        account: acctEmail,
        provider: 'microsoft',
        _confirmation: 'Email draft created successfully. Show the draft to the user and ask for confirmation before sending.',
      };
    }
  }

  const resp = await fetch(
    `${GRAPH_API}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    },
  );
  if (!resp.ok) throw new Error(`Outlook create draft failed (${resp.status})`);

  const draft = await resp.json();
  return {
    draft_id: draft.id,
    status: 'draft_created',
    to: args.to, subject: args.subject,
    is_reply: false,
    reply_all: false,
    account: acctEmail,
    provider: 'microsoft',
    _confirmation: 'Email draft created successfully. Show the draft to the user and ask for confirmation before sending.',
  };
}

export async function sendOutlookMessage(
  accessToken: string,
  draftId: string,
): Promise<{ messageId: string; status: string }> {
  const resp = await fetch(
    `${GRAPH_API}/messages/${encodeURIComponent(draftId)}/send`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  if (!resp.ok && resp.status !== 202) {
    const detail = await resp.text();
    throw new Error(`Outlook send email failed (${resp.status}): ${detail.slice(0, 200)}`);
  }
  return { messageId: draftId, status: 'sent' };
}

// ══════════════════════════════════════════════════════════════
// POST-SEND VERIFICATION
// ══════════════════════════════════════════════════════════════

export interface SendVerification {
  verified: boolean;
  messageId: string;
  reason?: string;
}

export async function verifyGmailMessageSent(
  accessToken: string,
  messageId: string,
): Promise<SendVerification> {
  try {
    const resp = await fetch(
      `${GMAIL_API}/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=To`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!resp.ok) {
      return { verified: false, messageId, reason: `message lookup failed (${resp.status})` };
    }

    const data = await resp.json();
    const labels: string[] = data.labelIds ?? [];

    if (labels.includes('SENT')) {
      return { verified: true, messageId };
    }

    return { verified: false, messageId, reason: `missing SENT label (labels: ${labels.join(',')})` };
  } catch (err) {
    return { verified: false, messageId, reason: `verification error: ${(err as Error).message}` };
  }
}

export async function verifyOutlookMessageSent(
  accessToken: string,
  messageId: string,
): Promise<SendVerification> {
  try {
    const resp = await fetch(
      `${GRAPH_API}/mailFolders/sentitems/messages?$filter=id eq '${messageId}'&$select=id&$top=1`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (resp.ok) {
      const data = await resp.json();
      if (data.value?.length > 0) {
        return { verified: true, messageId };
      }
    }

    await new Promise(r => setTimeout(r, 1500));

    const retry = await fetch(
      `${GRAPH_API}/mailFolders/sentitems/messages?$filter=id eq '${messageId}'&$select=id&$top=1`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!retry.ok) {
      return { verified: false, messageId, reason: `sent folder lookup failed (${retry.status})` };
    }

    const retryData = await retry.json();
    if (retryData.value?.length > 0) {
      return { verified: true, messageId };
    }

    return { verified: false, messageId, reason: 'message not found in sent folder after retry' };
  } catch (err) {
    return { verified: false, messageId, reason: `verification error: ${(err as Error).message}` };
  }
}

// ══════════════════════════════════════════════════════════════
// HIGH-LEVEL TOOL IMPLEMENTATIONS
// ══════════════════════════════════════════════════════════════

export async function gmailSearchTool(
  userId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const maxResults = Math.min((args.max_results as number) ?? 10, 20);
  const searchTz = (args.time_zone as string) ?? DEFAULT_TZ;
  const targetAccount = (args.account as string)?.toLowerCase() ?? null;

  let googleAccounts: TokenResult[] = [];
  let msAccounts: TokenResult[] = [];

  if (targetAccount) {
    const provider = await detectProvider(userId, targetAccount);
    if (provider === 'microsoft') {
      try {
        msAccounts = [await getMicrosoftAccessToken(userId, { email: targetAccount })];
      } catch (e) {
        console.error(`[gmail-helpers] Microsoft token failed for ${targetAccount}: ${(e as Error).message}`);
      }
    } else {
      try {
        googleAccounts = [await getGoogleAccessToken(userId, { email: targetAccount })];
      } catch (e) {
        console.error(`[gmail-helpers] Google token failed for ${targetAccount}: ${(e as Error).message}`);
      }
    }
  } else {
    [googleAccounts, msAccounts] = await Promise.all([
      getAllGoogleTokens(userId).catch((e) => {
        console.error(`[gmail-helpers] getAllGoogleTokens failed: ${(e as Error).message}`);
        return [] as TokenResult[];
      }),
      getAllMicrosoftTokens(userId).catch((e) => {
        console.error(`[gmail-helpers] getAllMicrosoftTokens failed: ${(e as Error).message}`);
        return [] as TokenResult[];
      }),
    ]);
  }

  const allAccounts = googleAccounts.length + msAccounts.length;
  const perAccountMax = Math.max(Math.ceil(maxResults / Math.max(allAccounts, 1)), 5);

  const googleResults = Promise.all(
    googleAccounts.map(async (acct) => {
      try {
        const messages = await listGmailMessages(acct.accessToken, args.query as string, perAccountMax);
        if (!messages.length) return [];
        const details = await Promise.all(
          messages.map((m: any) => getGmailMessage(acct.accessToken, m.id)),
        );
        return details.map((d) => {
          let dateLocal = d.date;
          try {
            const parsed = d.internalDate ? new Date(d.internalDate) : new Date(d.date);
            if (!isNaN(parsed.getTime())) {
              dateLocal = parsed.toLocaleString('en-AU', {
                weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
                hour: 'numeric', minute: '2-digit', hour12: true,
                timeZone: searchTz,
              });
            }
          } catch { /* keep raw date */ }
          return {
            message_id: d.messageId, thread_id: d.threadId,
            from: d.from, to: d.to, cc: d.cc,
            subject: d.subject, date: dateLocal, snippet: d.snippet,
            body_preview: d.bodyPreview,
            has_attachments: (d.attachmentCount ?? 0) > 0,
            account: acct.email,
            provider: 'google',
          };
        });
      } catch (e) {
        console.warn(`[gmail-helpers] gmail_search error for ${acct.email}: ${(e as Error).message}`);
        return [];
      }
    }),
  );

  const msResults = Promise.all(
    msAccounts.map(async (acct) => {
      try {
        return await searchOutlookMessages(acct.accessToken, acct.email, args.query as string, perAccountMax, searchTz);
      } catch (e) {
        console.warn(`[gmail-helpers] outlook search error for ${acct.email}: ${(e as Error).message}`);
        return [];
      }
    }),
  );

  const [gResults, mResults] = await Promise.all([googleResults, msResults]);

  const allResults = [...gResults.flat(), ...mResults.flat()]
    .sort((a: any, b: any) => {
      const da = new Date(a.date || 0).getTime();
      const db = new Date(b.date || 0).getTime();
      return db - da;
    })
    .slice(0, maxResults);

  if (!allResults.length) {
    if (allAccounts === 0) {
      return { results: [], count: 0, message: 'No email accounts connected. The user may need to reconnect their email via the onboarding link.' };
    }
    return { results: [], count: 0, message: 'No emails found matching that query.' };
  }

  return { results: allResults, count: allResults.length };
}

export async function getEmailTool(
  userId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const messageId = args.message_id as string;
  if (!messageId) return { error: 'message_id is required' };

  const { accessToken, provider } = await resolveToken(userId, args.account as string | undefined);
  const emailTz = (args.time_zone as string) ?? DEFAULT_TZ;

  if (provider === 'microsoft') {
    return getOutlookEmail(accessToken, messageId, emailTz);
  }

  const resp = await fetch(
    `${GMAIL_API}/messages/${encodeURIComponent(messageId)}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok) throw new Error(`Get email failed (${resp.status})`);

  const msg = await resp.json();
  const headers = msg.payload?.headers ?? [];
  const getHeader = (name: string) =>
    headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

  let body = '';
  const parts = flattenParts(msg.payload);

  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      body = base64Decode(part.body.data);
      break;
    }
  }
  if (!body) {
    for (const part of parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        body = base64Decode(part.body.data).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        break;
      }
    }
  }
  if (!body && msg.payload?.body?.data) {
    body = base64Decode(msg.payload.body.data);
  }

  const attachments = parts
    .filter((p: any) => p.filename && p.body?.attachmentId)
    .map((p: any) => ({ filename: p.filename, mime_type: p.mimeType, size: p.body.size }));

  let dateLocal = getHeader('Date') ?? '';
  try {
    const internalMs = parseInt(msg.internalDate ?? '0', 10);
    const parsed = internalMs ? new Date(internalMs) : new Date(dateLocal);
    if (!isNaN(parsed.getTime())) {
      dateLocal = parsed.toLocaleString('en-AU', {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
        timeZone: emailTz,
      });
    }
  } catch { /* keep raw */ }

  return {
    message_id: msg.id, thread_id: msg.threadId,
    from: getHeader('From'), to: getHeader('To'), cc: getHeader('Cc'),
    subject: getHeader('Subject'), date: dateLocal,
    body, attachments, labels: msg.labelIds ?? [],
  };
}

export async function sendDraftTool(
  userId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const toRaw = Array.isArray(args.to) ? args.to : [args.to as string];
  const invalidRecipients = toRaw.filter((r: string) => !r?.includes('@'));
  if (invalidRecipients.length > 0) {
    return {
      error: `Invalid recipient(s): ${invalidRecipients.join(', ')}. Each must be a valid email address.`,
    };
  }

  const { accessToken, email: acctEmail, provider } = await resolveToken(userId, args.account as string | undefined);

  const safetyBlock = enforceTestSafety(toRaw as string[], acctEmail);
  if (safetyBlock) {
    console.warn(`[gmail-helpers] ${safetyBlock}`);
    return { error: safetyBlock };
  }

  if (provider === 'microsoft') {
    return createOutlookDraft(accessToken, acctEmail, args);
  }

  const toList = Array.isArray(args.to) ? args.to as string[] : [args.to as string];
  const ccList = args.cc ? (Array.isArray(args.cc) ? args.cc as string[] : [args.cc as string]) : undefined;

  let result: any;
  if (args.reply_to_thread_id) {
    try {
      result = await createGmailReplyDraft(
        accessToken,
        args.reply_to_thread_id as string,
        args.body as string,
        (args.reply_all as boolean) ?? false,
        toList,
        args.subject as string | undefined,
        ccList,
      );
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (msg.includes('Requested entity was not found') || msg.includes('404')) {
        console.warn('[gmail-helpers] send_draft: reply thread not found, falling back to new draft');
        result = await createGmailDraft(
          accessToken,
          toList,
          args.subject as string,
          args.body as string,
          ccList,
          args.bcc ? (Array.isArray(args.bcc) ? args.bcc : [args.bcc as string]) : undefined,
        );
      } else {
        throw e;
      }
    }
  } else {
    result = await createGmailDraft(
      accessToken,
      toList,
      args.subject as string,
      args.body as string,
      ccList,
      args.bcc ? (Array.isArray(args.bcc) ? args.bcc : [args.bcc as string]) : undefined,
    );
  }

  return {
    draft_id: result.draftId ?? result.id,
    status: 'draft_created',
    to: args.to, subject: args.subject,
    is_reply: !!args.reply_to_thread_id,
    reply_all: !!args.reply_all,
    account: acctEmail,
    _confirmation: 'Email draft created successfully. Show the draft to the user and ask for confirmation before sending.',
  };
}

export async function sendEmailTool(
  userId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { accessToken, provider } = await resolveToken(userId, args.account as string | undefined);
  const draftId = args.draft_id as string;

  if (TEST_PROTECTED_ACCOUNTS.length > 0 && args.account) {
    const acct = String(args.account).toLowerCase();
    if (TEST_PROTECTED_ACCOUNTS.includes(acct)) {
      const msg = `TEST SAFETY: blocked email_send from protected account ${acct}`;
      console.warn(`[gmail-helpers] ${msg}`);
      return { error: msg };
    }
  }

  if (!draftId) {
    throw new Error('draft_id is required. Create a draft with send_draft first.');
  }

  if (provider === 'microsoft') {
    const result = await sendOutlookMessage(accessToken, draftId);
    return {
      status: 'sent',
      message_id: result.messageId,
      provider: 'microsoft',
      _confirmation: 'Email sent successfully. Confirm this to the user.',
    };
  }

  const result = await sendGmailDraft(accessToken, draftId);
  return {
    status: 'sent',
    message_id: result.messageId,
    thread_id: result.threadId,
    _confirmation: 'Email sent successfully. Confirm this to the user.',
  };
}

// ══════════════════════════════════════════════════════════════
// MICROSOFT TOKEN HELPER (wraps token-broker for multi-account)
// ══════════════════════════════════════════════════════════════

async function getAllMicrosoftTokens(userId: string): Promise<TokenResult[]> {
  const supabase = getAdminClient();

  const { data: accounts, error } = await supabase
    .from('user_microsoft_accounts')
    .select('id, microsoft_email, refresh_token')
    .eq('user_id', userId);

  if (error || !accounts || accounts.length === 0) return [];

  const results: TokenResult[] = [];
  for (const acct of accounts) {
    try {
      const token = await getMicrosoftAccessToken(userId, { email: acct.microsoft_email });
      results.push(token);
    } catch (e) {
      console.warn(`[gmail-helpers] Microsoft token refresh failed for ${acct.microsoft_email}: ${(e as Error).message}`);
    }
  }
  return results;
}

// ══════════════════════════════════════════════════════════════
// RAW EMAIL ENCODING (RFC 2822)
// ══════════════════════════════════════════════════════════════

function plainTextToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>\n');
}

function createRawEmail(
  to: string[],
  subject: string,
  body: string,
  cc?: string[],
  bcc?: string[],
): string {
  const htmlBody = body.includes('<br') || body.includes('<p') || body.includes('<div')
    ? body
    : plainTextToHtml(body);

  const headers: string[] = [
    'MIME-Version: 1.0',
    `To: ${to.join(', ')}`,
  ];
  if (cc?.length) headers.push(`Cc: ${cc.join(', ')}`);
  if (bcc?.length) headers.push(`Bcc: ${bcc.join(', ')}`);
  headers.push(`Subject: ${encodeMimeHeader(subject)}`);
  headers.push('Content-Type: text/html; charset=utf-8');
  headers.push('Content-Transfer-Encoding: base64');
  headers.push('');

  const bodyBase64 = btoa(unescape(encodeURIComponent(htmlBody)));
  headers.push(bodyBase64);

  return base64UrlEncode(headers.join('\r\n'));
}

function createRawReply(
  body: string,
  to?: string[],
  subject?: string,
  cc?: string[],
): string {
  const htmlBody = body.includes('<br') || body.includes('<p') || body.includes('<div')
    ? body
    : plainTextToHtml(body);

  const headers: string[] = [
    'MIME-Version: 1.0',
  ];
  if (to?.length) headers.push(`To: ${to.join(', ')}`);
  if (cc?.length) headers.push(`Cc: ${cc.join(', ')}`);
  if (subject) headers.push(`Subject: ${encodeMimeHeader(subject)}`);
  headers.push('Content-Type: text/html; charset=utf-8');
  headers.push('Content-Transfer-Encoding: base64');
  headers.push('');

  const bodyBase64 = btoa(unescape(encodeURIComponent(htmlBody)));
  headers.push(bodyBase64);

  return base64UrlEncode(headers.join('\r\n'));
}

function encodeMimeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const encoded = btoa(unescape(encodeURIComponent(value)));
  return `=?UTF-8?B?${encoded}?=`;
}

function base64UrlEncode(str: string): string {
  const encoded = btoa(unescape(encodeURIComponent(str)));
  return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
