// Google People API + Microsoft Graph contacts helpers for Nest V3.
// Uses token-broker.ts for all token management.
// Falls back to Gmail header search when People API returns no results.

import {
  getGoogleAccessToken,
  getAllGoogleTokens,
  getMicrosoftAccessToken,
  type TokenResult,
} from './token-broker.ts';
import { getAdminClient } from './supabase.ts';

const PEOPLE_API = 'https://people.googleapis.com/v1';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GRAPH_API = 'https://graph.microsoft.com/v1.0/me';

const READ_MASK = 'names,emailAddresses,phoneNumbers,organizations,biographies,urls';

// ══════════════════════════════════════════════════════════════
// NORMALISED CONTACT TYPE
// ══════════════════════════════════════════════════════════════

export interface NormalisedContact {
  name: string | null;
  emails: string[];
  phones: string[];
  organisation: string | null;
  title: string | null;
  biography: string | null;
  urls: string[];
  resourceName: string | null;
  provider: 'google' | 'microsoft';
  account: string;
}

// ══════════════════════════════════════════════════════════════
// GOOGLE PEOPLE API — SEARCH
// ══════════════════════════════════════════════════════════════

async function warmupGoogleContacts(accessToken: string): Promise<void> {
  try {
    await fetch(
      `${PEOPLE_API}/people:searchContacts?query=&readMask=${READ_MASK}&pageSize=1`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
  } catch { /* warmup is best-effort */ }
}

async function warmupGoogleOtherContacts(accessToken: string): Promise<void> {
  try {
    await fetch(
      `${PEOPLE_API}/otherContacts:search?query=&readMask=names,emailAddresses,phoneNumbers&pageSize=1`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
  } catch { /* warmup is best-effort */ }
}

async function searchGoogleContacts(
  accessToken: string,
  query: string,
  pageSize: number,
): Promise<any[]> {
  await warmupGoogleContacts(accessToken);

  const params = new URLSearchParams({
    query,
    readMask: READ_MASK,
    pageSize: String(Math.min(pageSize, 30)),
  });

  const resp = await fetch(`${PEOPLE_API}/people:searchContacts?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) return [];
  const data = await resp.json();
  return data.results?.map((r: any) => r.person) ?? [];
}

async function searchGoogleOtherContacts(
  accessToken: string,
  query: string,
  pageSize: number,
): Promise<any[]> {
  await warmupGoogleOtherContacts(accessToken);

  const params = new URLSearchParams({
    query,
    readMask: 'names,emailAddresses,phoneNumbers',
    pageSize: String(Math.min(pageSize, 30)),
  });

  const resp = await fetch(`${PEOPLE_API}/otherContacts:search?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) return [];
  const data = await resp.json();
  return data.results?.map((r: any) => r.person) ?? [];
}

async function getGoogleContact(
  accessToken: string,
  resourceName: string,
): Promise<any | null> {
  const params = new URLSearchParams({ personFields: READ_MASK });
  const resp = await fetch(`${PEOPLE_API}/${resourceName}?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) return null;
  return await resp.json();
}

function normaliseGooglePerson(person: any, account: string): NormalisedContact {
  const names = person.names ?? [];
  const emails = (person.emailAddresses ?? []).map((e: any) => e.value);
  const phones = (person.phoneNumbers ?? []).map((p: any) => p.value);
  const orgs = person.organizations ?? [];
  const bios = person.biographies ?? [];
  const urls = (person.urls ?? []).map((u: any) => u.value);

  return {
    name: names[0]?.displayName ?? null,
    emails,
    phones,
    organisation: orgs[0]?.name ?? null,
    title: orgs[0]?.title ?? null,
    biography: bios[0]?.value ?? null,
    urls,
    resourceName: person.resourceName ?? null,
    provider: 'google',
    account,
  };
}

// ══════════════════════════════════════════════════════════════
// MICROSOFT GRAPH — SEARCH
// ══════════════════════════════════════════════════════════════

async function searchMicrosoftContacts(
  accessToken: string,
  query: string,
  top: number,
): Promise<any[]> {
  const params = new URLSearchParams({
    $search: `"${query}"`,
    $top: String(top),
    $select: 'displayName,emailAddresses,businessPhones,mobilePhone,companyName,jobTitle',
  });

  const resp = await fetch(`${GRAPH_API}/contacts?${params}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ConsistencyLevel: 'eventual',
    },
  });

  if (!resp.ok) return [];
  const data = await resp.json();
  return data.value ?? [];
}

async function getMicrosoftContact(
  accessToken: string,
  contactId: string,
): Promise<any | null> {
  const resp = await fetch(`${GRAPH_API}/contacts/${contactId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) return null;
  return await resp.json();
}

function normaliseMicrosoftContact(contact: any, account: string): NormalisedContact {
  const emails = (contact.emailAddresses ?? []).map((e: any) => e.address);
  const phones: string[] = [
    ...(contact.businessPhones ?? []),
    ...(contact.mobilePhone ? [contact.mobilePhone] : []),
  ];

  return {
    name: contact.displayName ?? null,
    emails,
    phones,
    organisation: contact.companyName ?? null,
    title: contact.jobTitle ?? null,
    biography: null,
    urls: [],
    resourceName: contact.id ?? null,
    provider: 'microsoft',
    account,
  };
}

// ══════════════════════════════════════════════════════════════
// DEDUPLICATION
// ══════════════════════════════════════════════════════════════

function deduplicateContacts(contacts: NormalisedContact[]): NormalisedContact[] {
  const byEmail = new Map<string, NormalisedContact>();
  const noEmail: NormalisedContact[] = [];

  for (const c of contacts) {
    if (c.emails.length === 0) {
      noEmail.push(c);
      continue;
    }

    const primaryEmail = c.emails[0].toLowerCase();
    const existing = byEmail.get(primaryEmail);
    if (!existing) {
      byEmail.set(primaryEmail, c);
      continue;
    }

    const existingFields = countFields(existing);
    const newFields = countFields(c);
    if (newFields > existingFields) {
      byEmail.set(primaryEmail, c);
    }
  }

  return [...byEmail.values(), ...noEmail];
}

function countFields(c: NormalisedContact): number {
  let count = 0;
  if (c.name) count++;
  count += c.emails.length;
  count += c.phones.length;
  if (c.organisation) count++;
  if (c.title) count++;
  if (c.biography) count++;
  count += c.urls.length;
  return count;
}

// ══════════════════════════════════════════════════════════════
// GMAIL HEADER FALLBACK — find contacts from email history
// ══════════════════════════════════════════════════════════════

const EMAIL_HEADER_RE = /(?:"?([^"<]*)"?\s*)?<?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>?/;

function parseEmailHeader(header: string): { name: string | null; email: string } | null {
  const match = header.match(EMAIL_HEADER_RE);
  if (!match) return null;
  const name = (match[1] ?? '').trim() || null;
  const email = match[2]?.toLowerCase();
  if (!email) return null;
  return { name, email };
}

function splitHeaderAddresses(header: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngle = false;
  for (const ch of header) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === '<') inAngle = true;
    if (ch === '>') inAngle = false;
    if (ch === ',' && !inQuotes && !inAngle) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

async function searchGmailHeaders(
  accessToken: string,
  query: string,
  account: string,
  maxResults: number,
): Promise<NormalisedContact[]> {
  const gmailQuery = `from:${query} OR to:${query}`;
  const params = new URLSearchParams({ q: gmailQuery, maxResults: String(Math.min(maxResults * 3, 30)) });

  const listResp = await fetch(`${GMAIL_API}/messages?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!listResp.ok) return [];
  const listData = await listResp.json();
  const messageIds: string[] = (listData.messages ?? []).map((m: any) => m.id);

  if (messageIds.length === 0) return [];

  const contactMap = new Map<string, NormalisedContact>();
  const queryLower = query.toLowerCase();

  const fetches = messageIds.slice(0, 15).map(async (id) => {
    const resp = await fetch(`${GMAIL_API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return;
    const msg = await resp.json();
    const headers: { name: string; value: string }[] = msg.payload?.headers ?? [];

    for (const h of headers) {
      if (h.name !== 'From' && h.name !== 'To') continue;
      const parts = splitHeaderAddresses(h.value);
      for (const part of parts) {
        const parsed = parseEmailHeader(part.trim());
        if (!parsed) continue;
        const nameMatch = parsed.name && parsed.name.toLowerCase().includes(queryLower);
        const emailMatch = parsed.email.includes(queryLower);
        if (!nameMatch && !emailMatch) continue;
        if (parsed.email === account.toLowerCase()) continue;

        if (!contactMap.has(parsed.email)) {
          contactMap.set(parsed.email, {
            name: parsed.name,
            emails: [parsed.email],
            phones: [],
            organisation: null,
            title: null,
            biography: null,
            urls: [],
            resourceName: null,
            provider: 'google',
            account,
          });
        } else if (parsed.name && !contactMap.get(parsed.email)!.name) {
          contactMap.get(parsed.email)!.name = parsed.name;
        }
      }
    }
  });

  await Promise.allSettled(fetches);
  return [...contactMap.values()].slice(0, maxResults);
}

// ══════════════════════════════════════════════════════════════
// PUBLIC API — SEARCH CONTACTS
// ══════════════════════════════════════════════════════════════

interface SearchContactsOptions {
  query: string;
  account?: string;
  maxResults?: number;
}

export async function searchContactsTool(
  userId: string,
  options: SearchContactsOptions,
): Promise<NormalisedContact[]> {
  const { query, account, maxResults = 10 } = options;
  const allContacts: NormalisedContact[] = [];

  // Google accounts
  const googleTokens = account
    ? [await getGoogleAccessToken(userId, { email: account }).catch(() => null)]
    : await getAllGoogleTokens(userId).catch(() => [] as TokenResult[]);

  const googleResults = await Promise.allSettled(
    (googleTokens.filter(Boolean) as TokenResult[]).map(async (token) => {
      const [contacts, otherContacts] = await Promise.all([
        searchGoogleContacts(token.accessToken, query, maxResults),
        searchGoogleOtherContacts(token.accessToken, query, maxResults),
      ]);
      return [...contacts, ...otherContacts].map((p) =>
        normaliseGooglePerson(p, token.email),
      );
    }),
  );

  for (const result of googleResults) {
    if (result.status === 'fulfilled') allContacts.push(...result.value);
  }

  // Microsoft accounts
  if (!account) {
    const supabase = getAdminClient();
    const { data: msAccounts } = await supabase
      .from('user_microsoft_accounts')
      .select('id, microsoft_email')
      .eq('user_id', userId);

    if (msAccounts && msAccounts.length > 0) {
      const msResults = await Promise.allSettled(
        msAccounts.map(async (msAcct) => {
          const token = await getMicrosoftAccessToken(userId, { email: msAcct.microsoft_email });
          const contacts = await searchMicrosoftContacts(token.accessToken, query, maxResults);
          return contacts.map((c) => normaliseMicrosoftContact(c, token.email));
        }),
      );

      for (const result of msResults) {
        if (result.status === 'fulfilled') allContacts.push(...result.value);
      }
    }
  } else {
    // Check if the specified account is Microsoft
    const supabase = getAdminClient();
    const { data: msAcct } = await supabase
      .from('user_microsoft_accounts')
      .select('id')
      .eq('user_id', userId)
      .eq('microsoft_email', account)
      .maybeSingle();

    if (msAcct) {
      try {
        const token = await getMicrosoftAccessToken(userId, { email: account });
        const contacts = await searchMicrosoftContacts(token.accessToken, query, maxResults);
        allContacts.push(...contacts.map((c) => normaliseMicrosoftContact(c, token.email)));
      } catch { /* skip if token fails */ }
    }
  }

  const deduplicated = deduplicateContacts(allContacts);

  if (deduplicated.length === 0) {
    const gmailFallbackResults: NormalisedContact[] = [];
    const gmailTokens = account
      ? [await getGoogleAccessToken(userId, { email: account }).catch(() => null)]
      : await getAllGoogleTokens(userId).catch(() => [] as TokenResult[]);

    const gmailResults = await Promise.allSettled(
      (gmailTokens.filter(Boolean) as TokenResult[]).map((token) =>
        searchGmailHeaders(token.accessToken, query, token.email, maxResults),
      ),
    );

    for (const result of gmailResults) {
      if (result.status === 'fulfilled') gmailFallbackResults.push(...result.value);
    }

    if (gmailFallbackResults.length > 0) {
      return deduplicateContacts(gmailFallbackResults).slice(0, maxResults);
    }
  }

  return deduplicated.slice(0, maxResults);
}

// ══════════════════════════════════════════════════════════════
// PUBLIC API — GET CONTACT
// ══════════════════════════════════════════════════════════════

interface GetContactOptions {
  resourceName: string;
  account?: string;
}

export async function getContactTool(
  userId: string,
  options: GetContactOptions,
): Promise<NormalisedContact | null> {
  const { resourceName, account } = options;

  // Microsoft contact IDs are UUIDs, Google resource names start with "people/"
  const isMicrosoft = !resourceName.startsWith('people/');

  if (isMicrosoft) {
    const email = account;
    const token = email
      ? await getMicrosoftAccessToken(userId, { email })
      : await getMicrosoftAccessToken(userId);
    const contact = await getMicrosoftContact(token.accessToken, resourceName);
    if (!contact) return null;
    return normaliseMicrosoftContact(contact, token.email);
  }

  const token = account
    ? await getGoogleAccessToken(userId, { email: account })
    : await getGoogleAccessToken(userId);
  const person = await getGoogleContact(token.accessToken, resourceName);
  if (!person) return null;
  return normaliseGooglePerson(person, token.email);
}
