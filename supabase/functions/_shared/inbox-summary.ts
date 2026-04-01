import { getOpenAIClient, getResponseText, MODEL_MAP, REASONING_EFFORT } from './ai/models.ts';
import { liveCalendarLookup } from './calendar-helpers.ts';
import {
  gmailSearchTool,
  getEmailTool,
  type EmailSearchResponse,
  type EmailSearchResultRow,
} from './gmail-helpers.ts';
import {
  getActiveMemoryItems,
  getConnectedAccounts,
  getConversationSummaries,
  type ConnectedAccount,
  type ConversationSummary,
  type MemoryItem,
  getUserProfile,
} from './state.ts';
import { getAdminClient } from './supabase.ts';
import { getEmbedding, vectorString } from './rag-tools.ts';

const client = getOpenAIClient();
const LOG = '[inbox-summary]';

// ════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'have', 'about',
  'into', 'after', 'before', 'just', 'then', 'than', 'were', 'will', 'would',
  'there', 'their', 'them', 'they', 'what', 'when', 'where', 'which', 'while',
  'also', 'been', 'being', 'because', 'could', 'should', 'hello', 'thanks',
  'thank', 'regards', 're', 'fwd', 'fw', 'you', 'our', 'out', 'all',
]);

const HUMAN_SIGNAL_PATTERNS = [
  /\b(can you|could you|would you|please|let me know|thoughts\??|what do you think|are you free|when works|checking in|wanted to follow up|quick question|heads up|fyi)\b/i,
];

const AUTOMATED_SENDER_PATTERNS = [
  /\breceipts?\b/i, /\bnoreply\b/i, /\bno-?reply\b/i, /\bnotifications?\b/i,
  /\bmailer\b/i, /\bsupport@/i, /\binfo@/i, /\bhelp@/i, /\balerts?@/i,
  /\bbilling@/i, /\bteam@/i, /\bnewsletter/i, /\buber\s+receipts?\b/i,
  /\bgoogle\b/i, /\bapple\b/i, /\bamazon\b/i, /\bpostmaster\b/i, /\bmailer-daemon\b/i,
];

const ADMIN_NOISE_PATTERNS = [
  /\b(invoice|receipt|payment received|payment confirmation|order confirmed|order shipped|delivery notification|tracking number|shipment)\b/i,
  /\b(subscription|renewal|billing|statement|account summary|your plan|plan update)\b/i,
  /\b(verify your|confirm your email|reset your password|security alert|sign-in|two-factor|otp|verification code)\b/i,
  /\b(unsubscribe|manage preferences|view in browser|email preferences|opt out)\b/i,
  /\b(newsletter|weekly digest|daily digest|daily update|weekly update|monthly update)\b/i,
  /\b(promo|promotion|discount|offer ends|limited time|sale|deal|coupon|% off)\b/i,
  /\b(noreply|no-reply|donotreply|notifications?@|mailer-daemon|postmaster)\b/i,
];

const HARD_SKIP_SUBJECT_PATTERNS = [
  /^$/, /^\s*$/, /^no subject$/i, /^\(no subject\)$/i, /^test$/i, /^re:\s*$/i,
];

// ════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════

interface InboxSummaryAutomationInput {
  authUserId: string;
  handle: string;
  name: string | null;
  botNumber: string;
  nextRunAt: string;
  config: { time?: string; timezone?: string };
  deepProfileSnapshot: Record<string, unknown> | null;
}

interface InboxCalendarEvent {
  title: string;
  start: string;
  attendees: string[];
  organiser: string | null;
  location: string | null;
  description: string | null;
}

interface DeepEmailBody {
  messageId: string;
  subject: string;
  from: string;
  body: string;
  account: string;
}

interface SentFollowUp {
  subject: string;
  to: string;
  toName: string;
  sentDate: string;
  hasReply: boolean;
  replyPreview: string | null;
  bodySnippet: string;
}

interface RankedThread {
  key: string;
  subject: string;
  preview: string;
  deepBody: string | null;
  latestFrom: string;
  latestFromName: string;
  latestFromEmail: string | null;
  latestDate: string;
  latestReceivedAtMs: number;
  account: string;
  provider: 'google' | 'microsoft';
  messageCount: number;
  hasAttachments: boolean;
  isImportant: boolean;
  participants: string[];
  matchedSent: boolean;
  matchedSentSummary: string | null;
  calendarLinks: string[];
  score: number;
  reasons: string[];
  isHumanThread: boolean;
  isAdminNoise: boolean;
}

interface RagEvidence { query: string; evidence: string }

interface InboxSummaryContextPack {
  greeting: string;
  firstName: string;
  timezone: string;
  localDateTime: string;
  connectedAccounts: ConnectedAccount[];
  ownEmails: string[];
  inbox: EmailSearchResponse;
  recentActivity: EmailSearchResponse;
  olderUnread: EmailSearchResponse;
  sent: EmailSearchResponse;
  sentFollowUps: SentFollowUp[];
  todayEvents: InboxCalendarEvent[];
  tomorrowEvents: InboxCalendarEvent[];
  rankedThreads: RankedThread[];
  recentSentThreads: string[];
  relevantMemories: MemoryItem[];
  relevantSummaries: ConversationSummary[];
  recentOpenLoops: string[];
  ragEvidence: RagEvidence[];
  deepProfileBlock: string;
  calendarPeopleContext: string;
}

interface InboxSummaryPlanPoint {
  headline: string;
  why_it_matters: string;
  action_state: 'now' | 'today' | 'later' | 'monitor';
}

interface InboxSummaryPlan {
  overall_read: string;
  points: InboxSummaryPlanPoint[];
  closing_nudge: string;
  should_mention_uncertainty: boolean;
  should_mention_older_backlog: boolean;
}

// ════════════════════════════════════════════════════════════════
// Utility helpers
// ════════════════════════════════════════════════════════════════

function asRecord(v: unknown): Record<string, unknown> | null { return v && typeof v === 'object' ? v as Record<string, unknown> : null; }
function readString(v: unknown): string | null { return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null; }
function readStringArray(v: unknown, limit = 5): string[] { if (!Array.isArray(v)) return []; return v.filter((i): i is string => typeof i === 'string' && i.trim().length > 0).map((i) => i.trim()).slice(0, limit); }
function normaliseWhitespace(v: string): string { return v.replace(/\s+/g, ' ').trim(); }
function titleCaseWord(v: string): string { return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase(); }
function tokenize(v: string): string[] { return normaliseWhitespace(v).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2 && !STOP_WORDS.has(t)); }
function uniqueStrings(values: Array<string | null | undefined>, limit = 8): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const v of values) { const t = readString(v); if (!t) continue; const k = t.toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(t); if (out.length >= limit) break; }
  return out;
}

// ════════════════════════════════════════════════════════════════
// Name resolution
// ════════════════════════════════════════════════════════════════

function extractFirstName(v: string | null | undefined): string | null {
  const raw = normaliseWhitespace(String(v ?? '')); if (!raw || raw.includes('@')) return null;
  const cleaned = raw.replace(/<[^>]+>/g, '').trim(); if (!cleaned) return null;
  const first = cleaned.split(/[\s-]+/).find(Boolean); if (!first || first.length < 2 || /\d/.test(first)) return null;
  return titleCaseWord(first);
}

async function resolveFirstName(auto: InboxSummaryAutomationInput): Promise<string | null> {
  const direct = extractFirstName(auto.name); if (direct) return direct;
  const snapshot = auto.deepProfileSnapshot; const identity = asRecord(snapshot?.identity); const personal = asRecord(snapshot?.personal_life);
  for (const c of [identity?.name, identity?.preferred_name, identity?.full_name, personal?.name]) { const f = extractFirstName(readString(c)); if (f) return f; }
  try {
    const profile = await getUserProfile(auto.handle); const pf = extractFirstName(profile?.name); if (pf) return pf;
    const pi = asRecord(profile?.deepProfileSnapshot?.identity);
    for (const c of [pi?.name, pi?.preferred_name, pi?.full_name]) { const f = extractFirstName(readString(c)); if (f) return f; }
  } catch (e) { console.warn(`${LOG} Profile lookup failed:`, (e as Error).message); }
  try {
    const accounts = await getConnectedAccounts(auto.authUserId);
    const ordered = accounts.slice().sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
    for (const a of ordered) { const f = extractFirstName(a.name); if (f) return f; }
  } catch (e) { console.warn(`${LOG} Account lookup failed:`, (e as Error).message); }
  return null;
}

// ════════════════════════════════════════════════════════════════
// Time + greeting
// ════════════════════════════════════════════════════════════════

function getReferenceDate(nextRunAt: string, configTime?: string): Date {
  const p = new Date(nextRunAt); if (!isNaN(p.getTime())) return p;
  if (configTime && /^\d{1,2}:\d{2}$/.test(configTime)) { const f = new Date(); const [h, m] = configTime.split(':').map(Number); f.setHours(h, m, 0, 0); return f; }
  return new Date();
}

function getLocalHour(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: '2-digit', hour12: false }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '9'); return !Number.isFinite(h) ? 9 : h === 24 ? 0 : h;
}

function buildGreeting(firstName: string, d: Date, tz: string): string {
  const h = getLocalHour(d, tz); return `${h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'} ${firstName}`;
}

function formatLocalDateTime(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
}

// ════════════════════════════════════════════════════════════════
// Email + calendar helpers
// ════════════════════════════════════════════════════════════════

function normaliseThreadSubject(s: string): string { let c = normaliseWhitespace(s).toLowerCase(); while (/^(re|fwd|fw):\s*/i.test(c)) c = c.replace(/^(re|fwd|fw):\s*/i, '').trim(); return c; }
function buildThreadKey(r: EmailSearchResultRow): string { const t = readString(r.thread_id); return t ? t.toLowerCase() : normaliseThreadSubject(r.subject); }
function extractEmailAddress(v: string): string | null { const a = v.match(/<([^>]+)>/); if (a?.[1]) return a[1].toLowerCase(); const p = v.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i); return p?.[0]?.toLowerCase() ?? null; }
function extractDisplayName(v: string, fallback = 'Someone'): string {
  const t = normaliseWhitespace(v); if (!t) return fallback;
  const a = t.match(/^"?([^"<]+)"?\s*</); const c = a?.[1]?.trim() || t.replace(/<[^>]+>/g, '').trim();
  if (!c || c.includes('@')) { const e = extractEmailAddress(t); if (!e) return fallback; return titleCaseWord(e.split('@')[0].split(/[._-]/)[0] || fallback); }
  return c;
}
function previewText(r: EmailSearchResultRow): string { return normaliseWhitespace(r.body_preview || r.snippet || '').slice(0, 300); }
function emptyEmailSearch(status: EmailSearchResponse['status'], message: string): EmailSearchResponse { return { results: [], count: 0, status, message }; }
function isHardSkipSubject(s: string): boolean { return HARD_SKIP_SUBJECT_PATTERNS.some((p) => p.test(s.trim())); }
function countPatternMatches(text: string, patterns: RegExp[]): number { return patterns.filter((p) => p.test(text)).length; }
function isAutomatedSender(from: string): boolean { return AUTOMATED_SENDER_PATTERNS.some((p) => p.test(from)); }

function classifyThread(subject: string, preview: string, from: string): { isHuman: boolean; isNoise: boolean } {
  const blob = `${subject} ${preview} ${from}`;
  const humanHits = countPatternMatches(blob, HUMAN_SIGNAL_PATTERNS);
  const noiseHits = countPatternMatches(blob, ADMIN_NOISE_PATTERNS);
  const senderIsBot = isAutomatedSender(from);
  return {
    isHuman: humanHits > 0 && noiseHits < 2 && !senderIsBot,
    isNoise: noiseHits >= 2 || (noiseHits >= 1 && humanHits === 0) || (senderIsBot && humanHits === 0),
  };
}

function normaliseCalendarEvents(events: unknown[] | undefined): InboxCalendarEvent[] {
  if (!Array.isArray(events)) return [];
  return events.map((event) => {
    const r = asRecord(event) ?? {};
    return { title: readString(r.title) ?? '(untitled)', start: readString(r.start) ?? readString(r.start_iso) ?? 'time unknown', attendees: readStringArray(r.attendees, 8), organiser: readString(r.organiser), location: readString(r.location), description: readString(r.description)?.slice(0, 200) ?? null };
  });
}

function buildDeepProfileBlock(snapshot: Record<string, unknown> | null): string {
  if (!snapshot) return '';
  const identity = asRecord(snapshot.identity); const workLife = asRecord(snapshot.work_life ?? snapshot.professional_life); const lines: string[] = [];
  const role = readString(identity?.role) ?? readString(workLife?.role) ?? readString(workLife?.job_title); const company = readString(identity?.company) ?? readString(workLife?.company);
  if (role) lines.push(`Role: ${role}`); if (company) lines.push(`Company: ${company}`);
  const activeProjects = readStringArray(workLife?.active_projects, 4); if (activeProjects.length) lines.push(`Active projects: ${activeProjects.join('; ')}`);
  const keyColleagues = readStringArray(workLife?.key_colleagues, 5); if (keyColleagues.length) lines.push(`Key colleagues: ${keyColleagues.join('; ')}`);
  const hooks = readStringArray(snapshot.conversation_hooks, 3); if (hooks.length) lines.push(`Conversation hooks: ${hooks.join('; ')}`);
  const patterns = readStringArray(snapshot.notable_patterns, 3); if (patterns.length) lines.push(`Notable patterns: ${patterns.join('; ')}`);
  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════
// Deep email body reads
// ════════════════════════════════════════════════════════════════

async function fetchDeepBody(authUserId: string, row: EmailSearchResultRow, tz: string): Promise<DeepEmailBody | null> {
  try {
    const result = await getEmailTool(authUserId, { message_id: row.message_id, account: row.account, time_zone: tz }) as Record<string, unknown>;
    const body = readString(result?.body);
    if (!body || body.length < 20) return null;
    return { messageId: row.message_id, subject: row.subject, from: row.from, body: body.slice(0, 800), account: row.account };
  } catch (e) { console.warn(`${LOG} Deep body fetch failed for ${row.message_id}:`, (e as Error).message); return null; }
}

// ════════════════════════════════════════════════════════════════
// Sent-mail follow-up tracking
// ════════════════════════════════════════════════════════════════

async function trackSentFollowUps(authUserId: string, sentRows: EmailSearchResultRow[], ownEmails: string[], tz: string): Promise<SentFollowUp[]> {
  const meaningful = sentRows
    .filter((r) => !isHardSkipSubject(r.subject) && r.subject.length > 3)
    .filter((r) => {
      const toEmail = extractEmailAddress(r.to || '');
      return toEmail && !ownEmails.includes(toEmail);
    })
    .slice(0, 5);

  const results: SentFollowUp[] = [];
  for (const row of meaningful) {
    const subject = normaliseThreadSubject(row.subject);
    if (!subject) continue;
    try {
      const replySearch = await gmailSearchTool(authUserId, {
        query: `subject:"${subject}" newer_than:7d -in:sent`,
        max_results: 1,
        time_zone: tz,
      });
      const hasReply = replySearch.results.length > 0;
      const replyPreview = hasReply ? previewText(replySearch.results[0]).slice(0, 150) : null;
      results.push({
        subject: row.subject,
        to: row.to || '',
        toName: extractDisplayName(row.to || '', 'someone'),
        sentDate: row.date,
        hasReply,
        replyPreview,
        bodySnippet: previewText(row).slice(0, 200),
      });
    } catch { /* non-fatal */ }
  }
  console.log(`${LOG} Sent follow-ups tracked: ${results.length} (${results.filter((r) => r.hasReply).length} with replies, ${results.filter((r) => !r.hasReply).length} awaiting)`);
  return results;
}

// ════════════════════════════════════════════════════════════════
// Calendar cross-referencing
// ════════════════════════════════════════════════════════════════

function buildCalendarPeopleContext(
  events: InboxCalendarEvent[],
  inboxRows: EmailSearchResultRow[],
  sentRows: EmailSearchResultRow[],
  memories: MemoryItem[],
): string {
  if (!events.length) return '';
  const sections: string[] = [];

  for (const event of events.slice(0, 4)) {
    const attendeeEmails = event.attendees.map((a) => extractEmailAddress(a) ?? a.toLowerCase());
    const attendeeNames = event.attendees.map((a) => extractDisplayName(a, a));

    const relatedInbox = inboxRows.filter((r) => {
      const senderEmail = extractEmailAddress(r.from);
      return senderEmail && attendeeEmails.includes(senderEmail);
    });

    const relatedSent = sentRows.filter((r) => {
      const recipientEmail = extractEmailAddress(r.to || '');
      return recipientEmail && attendeeEmails.includes(recipientEmail);
    });

    const relatedMemories = memories.filter((m) => {
      const memLower = m.valueText.toLowerCase();
      return attendeeNames.some((name) => name.length > 2 && memLower.includes(name.toLowerCase()));
    });

    if (relatedInbox.length || relatedSent.length || relatedMemories.length) {
      const lines: string[] = [`Meeting: ${event.title} (${event.start})`];
      if (event.description) lines.push(`  Description: ${event.description}`);
      lines.push(`  Attendees: ${attendeeNames.join(', ')}`);
      if (relatedInbox.length) lines.push(`  Recent inbox from attendees: ${relatedInbox.map((r) => `"${r.subject}" from ${extractDisplayName(r.from)}`).join('; ')}`);
      if (relatedSent.length) lines.push(`  You recently emailed attendees: ${relatedSent.map((r) => `"${r.subject}" to ${extractDisplayName(r.to || '', 'them')}`).join('; ')}`);
      if (relatedMemories.length) lines.push(`  What you know about these people: ${relatedMemories.map((m) => m.valueText).join('; ')}`);
      sections.push(lines.join('\n'));
    }
  }

  return sections.length ? sections.join('\n\n') : '';
}

function buildCalendarLinks(subject: string, senderName: string, events: InboxCalendarEvent[]): string[] {
  const subjectTokens = new Set(tokenize(`${subject} ${senderName}`)); const senderLower = senderName.toLowerCase(); const links: string[] = [];
  for (const e of events) {
    const blob = `${e.title} ${e.attendees.join(' ')} ${e.organiser ?? ''}`;
    const eventTokens = new Set(tokenize(blob));
    const overlap = [...subjectTokens].filter((t) => eventTokens.has(t)).length;
    if (overlap > 0 || (blob.toLowerCase().includes(senderLower) && senderLower.length > 2)) links.push(e.title);
  }
  return uniqueStrings(links, 3);
}

// ════════════════════════════════════════════════════════════════
// Thread ranking
// ════════════════════════════════════════════════════════════════

function rankThreads(inboxRows: EmailSearchResultRow[], sentRows: EmailSearchResultRow[], calendarEvents: InboxCalendarEvent[]): RankedThread[] {
  const sentBySubject = new Map<string, EmailSearchResultRow[]>();
  for (const r of sentRows) { const k = normaliseThreadSubject(r.subject); if (!k) continue; if (!sentBySubject.has(k)) sentBySubject.set(k, []); sentBySubject.get(k)!.push(r); }
  const grouped = new Map<string, EmailSearchResultRow[]>();
  for (const r of inboxRows) { if (isHardSkipSubject(r.subject)) continue; const k = buildThreadKey(r); if (!grouped.has(k)) grouped.set(k, []); grouped.get(k)!.push(r); }

  const ranked = [...grouped.entries()].map(([key, rows]) => {
    const ordered = rows.slice().sort((a, b) => (b.received_at_ms ?? 0) - (a.received_at_ms ?? 0));
    const latest = ordered[0]; const preview = previewText(latest); const latestFromName = extractDisplayName(latest.from, 'Someone');
    const subjectKey = normaliseThreadSubject(latest.subject); const sentMatches = sentBySubject.get(subjectKey) ?? [];
    const calendarLinks = buildCalendarLinks(latest.subject, latestFromName, calendarEvents);
    const classification = classifyThread(latest.subject, preview, latest.from);
    const reasons: string[] = []; let score = 0;
    const ageHours = latest.received_at_ms ? Math.max(0, (Date.now() - latest.received_at_ms) / 3600000) : 999;
    if (ageHours <= 4) score += 1.0; else if (ageHours <= 12) score += 0.7; else if (ageHours <= 24) score += 0.5; else if (ageHours <= 72) score += 0.2;
    if (sentMatches.length > 0) { score += 1.5; reasons.push('reply to something you sent'); }
    if (classification.isHuman) { score += 1.2; reasons.push('real person writing to you'); }
    if (calendarLinks.length > 0) { score += 0.8; reasons.push(`links to ${calendarLinks[0]}`); }
    if (latest.is_important) { score += 0.5; reasons.push('marked important'); }
    if (ordered.length > 1) { score += 0.4; reasons.push('active thread'); }
    if (latest.has_attachments) score += 0.15;
    if (classification.isNoise) { score -= 2.5; reasons.push('admin/system noise'); }
    const participants = uniqueStrings(ordered.map((r) => extractDisplayName(r.from, 'Someone')), 6);
    return {
      key, subject: latest.subject || 'No subject', preview, deepBody: null as string | null,
      latestFrom: latest.from, latestFromName, latestFromEmail: extractEmailAddress(latest.from),
      latestDate: latest.date, latestReceivedAtMs: latest.received_at_ms ?? 0, account: latest.account, provider: latest.provider,
      messageCount: ordered.length, hasAttachments: latest.has_attachments, isImportant: !!latest.is_important, participants,
      matchedSent: sentMatches.length > 0, matchedSentSummary: sentMatches.length > 0 ? `${sentMatches[0].subject} to ${extractDisplayName(sentMatches[0].to || '', 'someone')}` : null,
      calendarLinks, score, reasons, isHumanThread: classification.isHuman, isAdminNoise: classification.isNoise,
    };
  });
  return ranked.filter((t) => t.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
}

// ════════════════════════════════════════════════════════════════
// Semantic retrieval - seeds from calendar + sent, not noise
// ════════════════════════════════════════════════════════════════

function buildSmartRagQueries(
  humanThreads: RankedThread[],
  todayEvents: InboxCalendarEvent[],
  tomorrowEvents: InboxCalendarEvent[],
  sentFollowUps: SentFollowUp[],
  recentSentThreads: string[],
): string[] {
  const allEvents = [...todayEvents, ...tomorrowEvents];
  const meetingNames = uniqueStrings(allEvents.slice(0, 4).map((e) => e.title), 4);
  const meetingPeople = uniqueStrings(allEvents.flatMap((e) => e.attendees.map((a) => extractDisplayName(a, ''))).filter((n) => n.length > 2), 5);
  const sentPeople = uniqueStrings(sentFollowUps.map((s) => s.toName).filter((n) => n.length > 2 && n !== 'someone'), 4);
  const threadSubjects = humanThreads.slice(0, 3).map((t) => t.subject).filter((s) => s.length > 4);
  const awaitingReplies = sentFollowUps.filter((s) => !s.hasReply).map((s) => s.subject).filter((s) => s.length > 4);

  return uniqueStrings([
    meetingNames.length ? `Context, history, and preparation notes for these upcoming meetings: ${meetingNames.join('; ')}` : null,
    meetingPeople.length ? `What I know about these people, recent interactions and context: ${meetingPeople.join(', ')}` : null,
    sentPeople.length ? `Open threads, commitments, and follow-ups with: ${sentPeople.join(', ')}` : null,
    threadSubjects.length ? `Background and deadlines for inbox threads: ${threadSubjects.join('; ')}` : null,
    awaitingReplies.length ? `Status and context for threads awaiting replies: ${awaitingReplies.join('; ')}` : null,
    'Open tasks, personal commitments, and things the user wants to get done soon',
  ], 5);
}

function scoreOverlap(haystack: string, needle: string): number {
  const ht = new Set(tokenize(haystack)); const nt = new Set(tokenize(needle));
  if (ht.size === 0 || nt.size === 0) return 0; return [...nt].filter((t) => ht.has(t)).length / nt.size;
}

function selectRelevantMemories(memories: MemoryItem[], seed: string, limit = 10): MemoryItem[] {
  return memories.map((m) => ({ memory: m, score: scoreOverlap(m.valueText, seed) + Math.max(0, 1 - Math.min((Date.now() - new Date(m.lastSeenAt).getTime()) / (30 * 86400000), 0.8)) * 0.35 + m.confidence * 0.2 }))
    .sort((a, b) => b.score - a.score).slice(0, limit).map((e) => e.memory);
}

function selectRelevantSummaries(summaries: ConversationSummary[], seed: string, limit = 4): ConversationSummary[] {
  return summaries.map((s) => ({ summary: s, score: scoreOverlap(`${s.summary} ${s.topics.join(' ')} ${s.openLoops.join(' ')}`, seed) + Math.exp(-0.693 * (Date.now() - new Date(s.lastMessageAt).getTime()) / (7 * 86400000)) * 0.35 + s.confidence * 0.2 }))
    .sort((a, b) => b.score - a.score).slice(0, limit).map((e) => e.summary);
}

async function hybridSearchEvidence(handle: string, query: string, matchCount = 4): Promise<string> {
  try {
    const supabase = getAdminClient(); const embedding = await getEmbedding(query); const embStr = vectorString(embedding);
    const { data, error } = await supabase.rpc('hybrid_search_documents', { p_handle: handle, query_text: query, query_embedding: embStr, match_count: matchCount, source_filters: null, min_semantic_score: 0.26 });
    if (error) { console.warn(`${LOG} hybrid_search failed:`, error.message); return ''; }
    const rows = Array.isArray(data) ? data as Array<Record<string, unknown>> : []; if (!rows.length) return '';
    return rows.slice(0, matchCount).map((r, i) => {
      const title = readString(r.title) ?? 'Untitled'; const sourceType = readString(r.source_type) ?? 'context';
      const chunk = readString(r.chunk_text) ?? readString(r.summary_text) ?? '';
      const score = typeof r.fused_score === 'number' ? r.fused_score : typeof r.semantic_score === 'number' ? r.semantic_score : 0;
      return `[${i + 1}] ${title} (${sourceType}, ${Math.round(score * 100)}%)\n${chunk.slice(0, 250)}`;
    }).join('\n\n');
  } catch (e) { console.warn(`${LOG} semantic retrieval failed:`, (e as Error).message); return ''; }
}

// ════════════════════════════════════════════════════════════════
// Context gathering - the full chief-of-staff data pack
// ════════════════════════════════════════════════════════════════

async function gatherContext(auto: InboxSummaryAutomationInput, timezone: string, firstName: string): Promise<InboxSummaryContextPack> {
  const referenceDate = getReferenceDate(auto.nextRunAt, auto.config.time);
  const greeting = buildGreeting(firstName, referenceDate, timezone);
  const localDateTime = formatLocalDateTime(referenceDate, timezone);

  const [inboxRaw, recentActivityRaw, olderUnreadRaw, sentRaw, todayCalRaw, tomorrowCalRaw, connectedAccountsRaw, rawSummaries, rawMemories] =
    await Promise.allSettled([
      gmailSearchTool(auto.authUserId, { query: 'in:inbox is:unread newer_than:7d', max_results: 18, time_zone: timezone }),
      gmailSearchTool(auto.authUserId, { query: 'newer_than:2d -in:sent', max_results: 12, time_zone: timezone }),
      gmailSearchTool(auto.authUserId, { query: 'in:inbox is:unread older_than:7d', max_results: 3, time_zone: timezone }),
      gmailSearchTool(auto.authUserId, { query: 'in:sent newer_than:7d', max_results: 12, time_zone: timezone }),
      liveCalendarLookup(auto.authUserId, 'today', timezone, undefined, undefined, 10),
      liveCalendarLookup(auto.authUserId, 'tomorrow', timezone, undefined, undefined, 6),
      getConnectedAccounts(auto.authUserId),
      auto.botNumber ? getConversationSummaries(`DM#${auto.botNumber}#${auto.handle}`, 8) : Promise.resolve([]),
      getActiveMemoryItems(auto.handle, 25),
    ]);

  const inbox = inboxRaw.status === 'fulfilled' ? inboxRaw.value : emptyEmailSearch('provider_error', 'Inbox lookup failed.');
  const recentActivity = recentActivityRaw.status === 'fulfilled' ? recentActivityRaw.value : emptyEmailSearch('provider_error', 'Recent activity lookup failed.');
  const olderUnread = olderUnreadRaw.status === 'fulfilled' ? olderUnreadRaw.value : emptyEmailSearch('provider_error', 'Older unread lookup failed.');
  const sent = sentRaw.status === 'fulfilled' ? sentRaw.value : emptyEmailSearch('provider_error', 'Sent mail lookup failed.');
  const todayEvents = todayCalRaw.status === 'fulfilled' ? normaliseCalendarEvents(todayCalRaw.value.events) : [];
  const tomorrowEvents = tomorrowCalRaw.status === 'fulfilled' ? normaliseCalendarEvents(tomorrowCalRaw.value.events) : [];
  const connectedAccounts = connectedAccountsRaw.status === 'fulfilled' ? connectedAccountsRaw.value : [];
  const summaries = rawSummaries.status === 'fulfilled' ? rawSummaries.value : [];
  const memories = rawMemories.status === 'fulfilled' ? rawMemories.value : [];
  const ownEmails = connectedAccounts.map((a) => a.email.toLowerCase()).filter(Boolean);

  console.log(`${LOG} Fetched: inbox=${inbox.count}(${inbox.status}), recentActivity=${recentActivity.count}, olderUnread=${olderUnread.count}, sent=${sent.count}, todayEvents=${todayEvents.length}, tomorrowEvents=${tomorrowEvents.length}, accounts=${connectedAccounts.length}(${ownEmails.join(',')}), memories=${memories.length}, summaries=${summaries.length}`);

  const allEvents = [...todayEvents, ...tomorrowEvents];
  const rankedThreads = rankThreads(inbox.results, sent.results, allEvents);

  console.log(`${LOG} Ranked ${rankedThreads.length} threads:`);
  for (const t of rankedThreads.slice(0, 5)) console.log(`${LOG}   [${t.score.toFixed(1)}] "${t.subject}" from ${t.latestFromName} | human=${t.isHumanThread} noise=${t.isAdminNoise} sent=${t.matchedSent} cal=${t.calendarLinks.length > 0} | ${t.reasons.join(', ')}`);

  const humanThreads = rankedThreads.filter((t) => t.isHumanThread || t.matchedSent);
  const deepBodyPromises = humanThreads.slice(0, 3).map((t) => {
    const row = inbox.results.find((r) => r.message_id === t.key || buildThreadKey(r) === t.key);
    return row ? fetchDeepBody(auto.authUserId, row, timezone) : Promise.resolve(null);
  });
  const deepBodies = await Promise.all(deepBodyPromises);
  for (let i = 0; i < humanThreads.length && i < 3; i++) {
    if (deepBodies[i]) { humanThreads[i].deepBody = deepBodies[i]!.body; console.log(`${LOG} Deep body fetched for "${humanThreads[i].subject}" (${deepBodies[i]!.body.length} chars)`); }
  }

  const sentFollowUps = await trackSentFollowUps(auto.authUserId, sent.results, ownEmails, timezone);

  const calendarPeopleContext = buildCalendarPeopleContext(allEvents, [...inbox.results, ...recentActivity.results], sent.results, memories);
  if (calendarPeopleContext) console.log(`${LOG} Calendar cross-ref found connections for ${calendarPeopleContext.split('Meeting:').length - 1} events`);

  const sentThreadLines = [...new Map(sent.results.filter((r) => r.subject.length > 3).map((r) => [normaliseThreadSubject(r.subject), `- ${r.subject} to ${extractDisplayName(r.to || '', 'someone')} (${r.date})`])).values()].slice(0, 6);

  const semanticSeed = uniqueStrings([
    ...allEvents.slice(0, 3).map((e) => e.title),
    ...allEvents.flatMap((e) => e.attendees.map((a) => extractDisplayName(a, ''))).filter((n) => n.length > 2).slice(0, 4),
    ...humanThreads.slice(0, 3).map((t) => t.subject),
    ...sentFollowUps.filter((s) => !s.hasReply).map((s) => s.subject).slice(0, 3),
    'Open loops, commitments, and follow-ups for today',
  ], 10).join(' | ');

  const relevantMemories = semanticSeed ? selectRelevantMemories(memories, semanticSeed, 10) : [];
  const relevantSummaries = semanticSeed ? selectRelevantSummaries(summaries, semanticSeed, 5) : [];
  const recentOpenLoops = uniqueStrings(relevantSummaries.flatMap((s) => s.openLoops ?? []), 5);

  const ragQueries = buildSmartRagQueries(humanThreads, todayEvents, tomorrowEvents, sentFollowUps, sentThreadLines);
  console.log(`${LOG} RAG queries: ${ragQueries.map((q) => q.slice(0, 80)).join(' | ')}`);
  const ragResults = await Promise.all(ragQueries.map(async (q) => { const ev = await hybridSearchEvidence(auto.handle, q, 4); return ev ? { query: q, evidence: ev } : null; }));

  return {
    greeting, firstName, timezone, localDateTime, connectedAccounts, ownEmails,
    inbox, recentActivity, olderUnread, sent, sentFollowUps, todayEvents, tomorrowEvents,
    rankedThreads, recentSentThreads: sentThreadLines, relevantMemories, relevantSummaries, recentOpenLoops,
    ragEvidence: ragResults.filter((r): r is RagEvidence => !!r),
    deepProfileBlock: buildDeepProfileBlock(auto.deepProfileSnapshot),
    calendarPeopleContext,
  };
}

// ════════════════════════════════════════════════════════════════
// Planner + Composer
// ════════════════════════════════════════════════════════════════

function formatThreadsForPlanner(threads: RankedThread[]): string {
  if (!threads.length) return 'No meaningful human threads in the inbox sample.';
  return threads.slice(0, 5).map((t, i) => {
    const tag = t.isHumanThread ? ' [HUMAN]' : t.isAdminNoise ? ' [NOISE]' : '';
    const sentLink = t.matchedSent && t.matchedSentSummary ? `\n  YOU SENT: ${t.matchedSentSummary}` : '';
    const calLink = t.calendarLinks.length ? `\n  CALENDAR LINK: ${t.calendarLinks.join('; ')}` : '';
    const deepBodyBlock = t.deepBody ? `\n  FULL EMAIL BODY:\n  ${t.deepBody.slice(0, 500)}` : '';
    return `[${i + 1}]${tag} ${t.subject}\n  From: ${t.latestFromName} | ${t.latestDate} | score ${t.score.toFixed(1)}\n  Signals: ${t.reasons.join('; ') || 'unread thread'}\n  Preview: ${t.preview.slice(0, 200) || '(no preview)'}${deepBodyBlock}${sentLink}${calLink}`;
  }).join('\n\n');
}

function formatSentFollowUps(followUps: SentFollowUp[]): string {
  if (!followUps.length) return 'No meaningful sent threads tracked.';
  return followUps.map((s) => {
    const status = s.hasReply ? `REPLIED - ${s.replyPreview?.slice(0, 100) ?? 'reply received'}` : 'AWAITING REPLY';
    return `- "${s.subject}" to ${s.toName} (${s.sentDate}) [${status}]`;
  }).join('\n');
}

function formatCalendarBlock(label: string, events: InboxCalendarEvent[]): string {
  if (!events.length) return `${label}: none`;
  return `${label}:\n${events.slice(0, 6).map((e) => {
    const attendees = e.attendees.length ? ` | with ${e.attendees.map((a) => extractDisplayName(a, a)).join(', ')}` : '';
    const loc = e.location ? ` | ${e.location}` : '';
    const desc = e.description ? `\n  ${e.description}` : '';
    return `- ${e.title} (${e.start})${attendees}${loc}${desc}`;
  }).join('\n')}`;
}

function buildPlannerInput(ctx: InboxSummaryContextPack): string {
  const accountErrors = ctx.inbox.account_errors?.length ? ctx.inbox.account_errors.map((e) => `- ${e.account} (${e.provider}): ${e.error}`).join('\n') : 'None';
  return `LOCAL TIME: ${ctx.localDateTime}
USER: ${ctx.firstName}
THEIR EMAIL ADDRESSES: ${ctx.ownEmails.length ? ctx.ownEmails.join(', ') : 'Unknown'}

INBOX STATUS: ${ctx.inbox.status} | unread sampled: ${ctx.inbox.count} | recent activity (all accounts, read+unread): ${ctx.recentActivity.count} | older unread: ${ctx.olderUnread.count} | sent: ${ctx.sent.count}
ACCOUNT ISSUES: ${accountErrors}

RANKED INBOX THREADS (with full email bodies for top human threads):
${formatThreadsForPlanner(ctx.rankedThreads)}

SENT MAIL FOLLOW-UP TRACKING (did people reply?):
${formatSentFollowUps(ctx.sentFollowUps)}

RECENT SENT BY ${ctx.firstName.toUpperCase()}:
${ctx.recentSentThreads.length ? ctx.recentSentThreads.join('\n') : 'No recent sent mail.'}

${formatCalendarBlock("TODAY'S CALENDAR", ctx.todayEvents)}

${formatCalendarBlock("TOMORROW'S CALENDAR", ctx.tomorrowEvents)}

CALENDAR-PEOPLE CROSS-REFERENCE (meetings linked to inbox/sent/memory):
${ctx.calendarPeopleContext || 'No direct connections found between calendar attendees and recent email activity.'}

RELEVANT MEMORIES:
${ctx.relevantMemories.length ? ctx.relevantMemories.slice(0, 8).map((m) => `- [${m.memoryType}/${m.category}] ${m.valueText}`).join('\n') : 'No relevant memories.'}

CONVERSATION CONTEXT:
${ctx.recentOpenLoops.length ? `Open loops:\n${ctx.recentOpenLoops.map((l) => `- ${l}`).join('\n')}` : ''}
${ctx.relevantSummaries.length ? `Recent conversations:\n${ctx.relevantSummaries.slice(0, 4).map((s) => `- ${s.summary.slice(0, 240)}`).join('\n')}` : 'No relevant conversation context.'}

DEEP PROFILE:
${ctx.deepProfileBlock || 'None available.'}

SEMANTIC RETRIEVAL (deep context from RAG):
${ctx.ragEvidence.length ? ctx.ragEvidence.map((r, i) => `[RAG ${i + 1}] ${r.query}\n${r.evidence}`).join('\n\n') : 'No semantic context retrieved.'}`;
}

const PLANNER_SYSTEM = `You are the chief of staff behind Nest, an exceptional personal assistant.

Your job: synthesise EVERYTHING you know about this person's world right now - their inbox, calendar, sent mail, follow-ups awaiting replies, memories, open loops, deep profile, and semantic context - then distill it into the 1-3 insights that will genuinely help them.

WHAT A CHIEF OF STAFF DOES:
- Reads the FULL email bodies when available, not just subjects. Understands what is actually being asked, offered, or escalated
- Tracks sent mail follow-ups: "You emailed Megan about the chauffeur docs on Monday - she hasn't replied yet, might be worth a nudge"
- Cross-references calendar with inbox: "You have the APAC stakeholder meeting at 3, and there's an email from the EK team about schedule changes that's worth reading before then"
- Notices patterns: "You've been forwarding ops issues to the team all day - looks like a busy operational stretch"
- Connects dots across data sources: memories, past conversations, profile context, and semantic retrieval

WHAT YOU HAVE ACCESS TO:
- Full email bodies for the most important threads (not just previews)
- Sent mail follow-up tracking showing which recipients have replied and which haven't
- Calendar-people cross-references showing connections between meeting attendees and recent email/memory
- Recent activity across ALL connected accounts (not just unread)
- Deep semantic retrieval from the user's full knowledge base
- Conversation open loops and memories

DECISION RULES:
- Surface 1-3 points. Quality over quantity
- NEVER surface receipts, payment confirmations, newsletters, promo emails, security alerts, shipping notifications. They do not exist
- When the inbox is quiet, pivot to: calendar shape, sent-mail threads in motion, awaiting replies, meeting prep, open loops
- If someone hasn't replied to something the user sent, that is worth mentioning if the thread matters
- If a meeting is coming up and there's relevant email/memory context about the attendees, connect those dots
- Read email bodies deeply. "Action required - Chauffeur account on hold" is not just a subject - read WHY it's on hold and WHAT needs to happen

OUTPUT FORMAT - valid JSON only:
{
  "overall_read": "one sentence reading the shape of things, no greeting, no name",
  "points": [
    {
      "headline": "conversational, specific, names + context",
      "why_it_matters": "why THIS matters to THEM, with specifics from email bodies/calendar/memory",
      "action_state": "now|today|later|monitor"
    }
  ],
  "closing_nudge": "optional observation about the day ahead, or empty string",
  "should_mention_uncertainty": false,
  "should_mention_older_backlog": false
}

STYLE: sharp, warm, specific. Australian English. No markdown, no em dash. Names, details, connections.`;

const COMPOSER_SYSTEM_PREFIX = `You are Nest, an exceptional personal assistant writing an iMessage.

You sound like a brilliant chief of staff who has read every email, checked every calendar, and connected every dot. You know the people, the projects, the patterns. You are warm, sharp, and insightful.

WHAT GOOD SOUNDS LIKE:
"Good afternoon Tom, inbox is clear so nothing pulling at you there. You've got the EK stakeholder meeting at 3 - worth noting the Emirates schedule change email that came through, might come up. You forwarded the chauffeur docs issue to Megan this morning and she hasn't come back yet, so that's still in motion."

"Good morning Tom, Sarah got back to you on the Acme proposal overnight - she's keen to move forward and wants to lock in pricing by Wednesday. You've got that call with her team at 2, so worth a quick read before then. Otherwise a fairly clear day."

WHAT BAD SOUNDS LIKE:
"Good afternoon Tom, Your live items are the Overdue bill and the No subject thread"
"Good afternoon Tom, A couple of Uber receipts came through from Saturday"
"Good afternoon Tom, inbox is clear. Enjoy the calm."

THE DIFFERENCE: A chief of staff connects dots, tracks follow-ups, prepares you for meetings, and notices what's in motion. A notification bot lists things.

RULES:
- Start with the exact greeting provided
- 2-5 conversational lines
- Use "---" once to split into 2 bubbles if helpful
- Every point must answer: "why does this matter to them specifically?"
- NEVER mention receipts, invoices, newsletters, promos, security alerts
- NEVER say "live items", "action items", "items to note"
- Mention people by first name. Reference specific details from email bodies when available
- If tracking a sent follow-up, say so naturally: "Megan hasn't come back on the chauffeur docs yet"
- If connecting email to calendar, make the link clear: "worth reading before the 3pm with the EK team"
- Australian English. No markdown, no em dash, never say "mate"`;

function extractJsonObject(t: string): string | null { const first = t.indexOf('{'); const last = t.lastIndexOf('}'); return (first === -1 || last === -1 || last <= first) ? null : t.slice(first, last + 1); }

function parsePlan(text: string | null | undefined): InboxSummaryPlan | null {
  if (!text) return null; const json = extractJsonObject(text); if (!json) return null;
  try {
    const p = JSON.parse(json) as Partial<InboxSummaryPlan>;
    const n: InboxSummaryPlan = {
      overall_read: readString(p.overall_read) ?? '', closing_nudge: readString(p.closing_nudge) ?? '',
      should_mention_uncertainty: Boolean(p.should_mention_uncertainty), should_mention_older_backlog: Boolean(p.should_mention_older_backlog),
      points: Array.isArray(p.points) ? p.points.map((pt) => { const r = asRecord(pt); const as = readString(r?.action_state); if (!r || !['now','today','later','monitor'].includes(as ?? '')) return null; return { headline: readString(r.headline) ?? '', why_it_matters: readString(r.why_it_matters) ?? '', action_state: as as InboxSummaryPlanPoint['action_state'] }; }).filter((pt): pt is InboxSummaryPlanPoint => !!pt && !!pt.headline && !!pt.why_it_matters).slice(0, 3) : [],
    };
    if (!n.overall_read && n.points.length === 0) return null; return n;
  } catch { return null; }
}

function buildFallbackPlan(ctx: InboxSummaryContextPack): InboxSummaryPlan {
  if (ctx.inbox.status === 'provider_error' || ctx.inbox.status === 'no_accounts') {
    return { overall_read: "I couldn't get a reliable read on your inbox just now.", points: [], closing_nudge: ctx.todayEvents.length ? `Your calendar ${ctx.todayEvents.length > 3 ? 'looks fairly full' : 'looks manageable'} today though.` : '', should_mention_uncertainty: true, should_mention_older_backlog: false };
  }
  const humanThreads = ctx.rankedThreads.filter((t) => t.isHumanThread || t.matchedSent);
  const hasCalendar = ctx.todayEvents.length > 0 || ctx.tomorrowEvents.length > 0;
  const awaitingReplies = ctx.sentFollowUps.filter((s) => !s.hasReply);
  if (!humanThreads.length) {
    const nudge: string[] = [];
    if (ctx.todayEvents.length) nudge.push(`You have ${ctx.todayEvents.length === 1 ? ctx.todayEvents[0].title : `${ctx.todayEvents.length} things on the calendar`} today.`);
    if (ctx.tomorrowEvents.length) nudge.push(`Tomorrow has ${ctx.tomorrowEvents.length === 1 ? ctx.tomorrowEvents[0].title : `${ctx.tomorrowEvents.length} events`}.`);
    if (awaitingReplies.length) nudge.push(`Still waiting to hear back from ${awaitingReplies[0].toName} on ${awaitingReplies[0].subject}.`);
    if (ctx.recentOpenLoops.length) nudge.push(`Open loop: ${ctx.recentOpenLoops[0]}`);
    return { overall_read: 'Nothing in the inbox that needs your attention right now.', points: [], closing_nudge: nudge.join(' ') || 'Enjoy the calm.', should_mention_uncertainty: false, should_mention_older_backlog: false };
  }
  const points = humanThreads.slice(0, 3).map((t) => ({ headline: `${t.latestFromName} on ${t.subject}`, why_it_matters: t.reasons[0] ?? 'worth a look', action_state: (t.matchedSent || t.calendarLinks.length ? 'today' : 'later') as InboxSummaryPlanPoint['action_state'] }));
  return { overall_read: humanThreads.length === 1 ? 'One thread worth your attention.' : 'A couple of threads worth your attention.', points, closing_nudge: hasCalendar && ctx.todayEvents.length ? `Calendar-wise, ${ctx.todayEvents[0].title} is the main one today.` : '', should_mention_uncertainty: false, should_mention_older_backlog: false };
}

function buildFallbackMessage(greeting: string, plan: InboxSummaryPlan): string {
  const lines = [`${greeting}, ${plan.overall_read}`.trim()];
  for (const p of plan.points) lines.push(`${p.headline} - ${p.why_it_matters}`);
  if (plan.closing_nudge) lines.push(plan.closing_nudge);
  if (lines.length <= 2) return lines.join('\n');
  return `${lines.slice(0, 2).join('\n')}\n---\n${lines.slice(2).join('\n')}`;
}

async function buildPlannerPlan(ctx: InboxSummaryContextPack): Promise<InboxSummaryPlan | null> {
  const input = buildPlannerInput(ctx);
  console.log(`${LOG} Planner input: ${input.length} chars`);
  const response = await client.responses.create({ model: MODEL_MAP.critical, instructions: PLANNER_SYSTEM, input, max_output_tokens: 800, store: false, reasoning: { effort: 'high' as const } } as Parameters<typeof client.responses.create>[0]);
  const raw = getResponseText(response);
  console.log(`${LOG} Planner output: ${raw.slice(0, 500)}`);
  return parsePlan(raw);
}

async function composeFinalMessage(ctx: InboxSummaryContextPack, plan: InboxSummaryPlan): Promise<string | null> {
  const response = await client.responses.create({ model: MODEL_MAP.critical, instructions: `${COMPOSER_SYSTEM_PREFIX}\n\nYou MUST start with "${ctx.greeting}," exactly.`, input: `Strategic plan:\n\n${JSON.stringify(plan, null, 2)}`, max_output_tokens: 450, store: false, reasoning: { effort: REASONING_EFFORT.critical } } as Parameters<typeof client.responses.create>[0]);
  const text = getResponseText(response).trim();
  console.log(`${LOG} Composer output: ${text.slice(0, 300)}`);
  return text && text.length >= 10 ? text : null;
}

// ════════════════════════════════════════════════════════════════
// Main entry point
// ════════════════════════════════════════════════════════════════

export async function generateInboxSummary(auto: InboxSummaryAutomationInput, timezone: string): Promise<{ message: string; metadata: Record<string, unknown> } | null> {
  const startMs = Date.now();
  const firstName = await resolveFirstName(auto);
  if (!firstName) { console.warn(`${LOG} Skipping: no reliable first name. handle=${auto.handle} name=${auto.name}`); return null; }
  console.log(`${LOG} Starting for ${firstName} (${auto.handle}) tz=${timezone}`);

  try {
    const ctx = await gatherContext(auto, timezone, firstName);
    const plannerPlan = await buildPlannerPlan(ctx).catch((e) => { console.warn(`${LOG} Planner failed:`, (e as Error).message); return null; });
    const plan = plannerPlan ?? buildFallbackPlan(ctx);
    console.log(`${LOG} Plan: ${JSON.stringify(plan).slice(0, 400)}`);
    const composed = await composeFinalMessage(ctx, plan).catch((e) => { console.warn(`${LOG} Composer failed:`, (e as Error).message); return null; });
    const message = composed ?? buildFallbackMessage(ctx.greeting, plan);
    const elapsed = Date.now() - startMs;
    console.log(`${LOG} Done in ${elapsed}ms. Message: ${message.slice(0, 250)}`);

    return {
      message,
      metadata: {
        trigger: 'user_scheduled', summary_status: ctx.inbox.status, unread_count: ctx.inbox.count, recent_activity_count: ctx.recentActivity.count,
        older_unread_sample_count: ctx.olderUnread.count, sent_sample_count: ctx.sent.count, connected_account_count: ctx.connectedAccounts.length,
        today_event_count: ctx.todayEvents.length, tomorrow_event_count: ctx.tomorrowEvents.length,
        memory_count: ctx.relevantMemories.length, open_loop_count: ctx.recentOpenLoops.length,
        sent_follow_ups: ctx.sentFollowUps.map((s) => ({ subject: s.subject, to: s.toName, replied: s.hasReply })),
        ranked_threads: ctx.rankedThreads.slice(0, 5).map((t) => ({ subject: t.subject, from: t.latestFromName, score: Number(t.score.toFixed(1)), human: t.isHumanThread, noise: t.isAdminNoise, sent_match: t.matchedSent, cal: t.calendarLinks.length > 0, has_deep_body: !!t.deepBody, reasons: t.reasons })),
        calendar_xref_found: !!ctx.calendarPeopleContext,
        used_rag_queries: ctx.ragEvidence.map((r) => r.query), elapsed_ms: elapsed,
        used_fallback_plan: !plannerPlan, used_fallback_message: !composed,
      },
    };
  } catch (e) { console.error(`${LOG} Fatal:`, (e as Error).message); return null; }
}
