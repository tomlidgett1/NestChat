/**
 * Morning brief audio pipeline: gather mail/calendar/RAG/profile/weather/news,
 * synthesise a spoken script + companion text, OpenAI TTS + Linq send.
 */

import { getAdminClient } from './supabase.ts';
import { USER_PROFILES_TABLE, getOptionalEnv } from './env.ts';
import { gmailSearchTool } from './gmail-helpers.ts';
import { liveCalendarLookup } from './calendar-helpers.ts';
import { getEmbedding, vectorString } from './rag-tools.ts';
import {
  addMessage,
  getActiveMemoryItems,
  getConversationSummaries,
  getConnectedAccounts,
  sanitiseUserContextProfile,
} from './state.ts';
import type { UserContextProfile } from './state.ts';
import { weatherTool } from './tools/weather.ts';
import { geminiGroundedSearch, isGeminiModel } from './ai/gemini.ts';
import { MODEL_MAP, getOpenAIClient, getResponseText } from './ai/models.ts';
import { resolveChatId } from './email-webhook-helpers.ts';
import { createChat, sendVoiceMemo, CREATE_CHAT_INVISIBLE_PLACEHOLDER } from './linq.ts';

// ── Types ───────────────────────────────────────────────────────────────────

export interface MorningBriefUserRow {
  handle: string;
  name: string | null;
  bot_number: string | null;
  timezone: string | null;
  auth_user_id: string | null;
  deep_profile_snapshot: Record<string, unknown> | null;
  context_profile: unknown;
  facts: unknown;
}

export interface MorningBriefScript {
  script_plain: string;
  companion_text: string;
  word_count: number;
}

export interface MorningBriefGathered {
  email_snippet: string;
  calendar_snippet: string;
  rag_snippet: string;
  memories_snippet: string;
  summaries_snippet: string;
  weather_snippet: string;
  news_snippet: string;
  deep_profile_snippet: string;
}

export interface MorningBriefResult {
  ok: boolean;
  error?: string;
  dry_run?: boolean;
  script?: MorningBriefScript;
  signed_audio_url?: string;
  storage_path?: string;
  linq_message_id?: string;
  chat_id?: string;
  gathered?: MorningBriefGathered;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const TIMEZONE_COUNTRY_MAP: Record<string, string> = {
  'Australia': 'Australia', 'America': 'USA', 'Europe': 'Europe', 'Asia': 'Asia', 'Pacific': 'Pacific',
};

function timezoneToWeatherLabel(timezone: string | null): string | null {
  if (!timezone || !timezone.includes('/')) return null;
  const parts = timezone.split('/');
  const city = parts[parts.length - 1]?.replace(/_/g, ' ').trim();
  if (!city) return null;
  const region = parts[0];
  const country = TIMEZONE_COUNTRY_MAP[region];
  return country ? `${city}, ${country}` : city;
}

function pickWeatherLocation(ctx: UserContextProfile | null, timezone: string | null): string | null {
  const cur = ctx?.currentLocation;
  const home = ctx?.homeLocation;
  if (cur?.value?.trim()) return cur.value.trim();
  if (home?.value?.trim()) return home.value.trim();
  const work = ctx?.workLocation;
  if (work?.value?.trim()) return work.value.trim();
  return timezoneToWeatherLabel(timezone);
}

/** Infer country label for news context from IANA timezone (user automations, briefings). */
export function inferCountryFromTimezone(timezone: string | null): string {
  const tz = timezone ?? 'Australia/Sydney';
  if (tz.startsWith('Australia/')) return 'Australia';
  if (tz.startsWith('Pacific/Auckland')) return 'New Zealand';
  if (tz.startsWith('America/')) return 'United States';
  if (tz.startsWith('Europe/London') || tz.startsWith('Europe/Belfast')) return 'United Kingdom';
  if (tz.startsWith('Europe/Dublin')) return 'Ireland';
  if (tz.startsWith('Asia/Singapore')) return 'Singapore';
  if (tz.startsWith('Asia/Hong_Kong')) return 'Hong Kong';
  if (tz.startsWith('Asia/Tokyo')) return 'Japan';
  return 'Australia';
}

/** Home/current/work location + country for personalised news digests (website News Briefing automation). */
export function resolveBriefingLocationForNews(user: MorningBriefUserRow): { location: string | null; country: string } {
  const ctx = sanitiseUserContextProfile(user.context_profile);
  const tz = user.timezone || 'Australia/Sydney';
  const location = pickWeatherLocation(ctx, tz);
  const country = inferCountryFromTimezone(tz);
  return { location, country };
}

export function extractInterests(snapshot: Record<string, unknown> | null): string[] {
  if (!snapshot) return [];
  const pl = snapshot.personal_life as Record<string, unknown> | undefined;
  const arr = pl?.interests;
  if (!Array.isArray(arr)) return [];
  return arr.filter((x): x is string => typeof x === 'string').map((s) => s.slice(0, 120)).slice(0, 6);
}

function buildDateTimeContext(timezone: string | null): string {
  const now = new Date();
  const tz = timezone ?? 'UTC';
  const formatted = now.toLocaleString('en-AU', {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const shortTz = now.toLocaleString('en-AU', { timeZone: tz, timeZoneName: 'short' }).split(' ').pop() ?? tz;
  return `${formatted} ${shortTz}`;
}

async function hybridSearch(handle: string, query: string, matchCount: number): Promise<string> {
  const supabase = getAdminClient();
  const embedding = await getEmbedding(query);
  const embStr = vectorString(embedding);
  const { data, error } = await supabase.rpc('hybrid_search_documents', {
    p_handle: handle,
    query_text: query,
    query_embedding: embStr,
    match_count: matchCount,
    source_filters: null,
    min_semantic_score: 0.26,
  });
  if (error) {
    console.warn('[morning-brief] hybrid_search error:', error.message);
    return '';
  }
  type Row = {
    title: string;
    source_type: string;
    chunk_text: string | null;
    summary_text: string | null;
    fused_score?: number;
    semantic_score: number;
  };
  const rows = (data as Row[] | null) ?? [];
  if (rows.length === 0) return '';
  const blocks = rows.slice(0, 8).map((r, i) => {
    const text = (r.chunk_text ?? r.summary_text ?? '').slice(0, 500);
    const score = Math.round((r.fused_score ?? r.semantic_score) * 100);
    return `[${i + 1}] ${r.title} (${r.source_type}, ${score}%)\n${text}`;
  });
  return blocks.join('\n\n');
}

async function fetchWeatherBlock(locationLabel: string | null): Promise<string> {
  if (!locationLabel) return '(No location on file — skip weather in script or mention generically.)';
  try {
    const out = await weatherTool.handler({
      location: locationLabel,
      type: 'daily_forecast',
      days: 2,
    }, { chatId: '', senderHandle: '', authUserId: null, timezone: null, pendingEmailSend: null, pendingEmailSends: [] });
    const raw = out.structuredData ?? JSON.parse(typeof out.content === 'string' ? out.content : '{}');
    if (raw && typeof raw === 'object' && 'error' in raw) {
      return `Weather lookup failed: ${(raw as { error?: string }).error ?? 'unknown'}`;
    }
    return JSON.stringify(raw, null, 0).slice(0, 2500);
  } catch (e) {
    return `Weather error: ${(e as Error).message}`;
  }
}

async function fetchInterestNews(interests: string[], timezone: string | null, userName: string | null): Promise<string> {
  if (!isGeminiModel(MODEL_MAP.fast)) {
    return '(Web search not available - model is not Gemini; skip interest headline.)';
  }

  const topicParts: string[] = [];
  for (const interest of interests.slice(0, 3)) {
    const trimmed = interest.trim();
    if (trimmed) topicParts.push(trimmed);
  }
  if (!topicParts.length) topicParts.push('Australian business and technology');

  const now = new Date();
  const tz = timezone ?? 'Australia/Sydney';
  const isoDate = now.toLocaleDateString('en-CA', { timeZone: tz });
  const weekday = now.toLocaleDateString('en-AU', { timeZone: tz, weekday: 'long' });

  try {
    const q = `Today is ${weekday} ${isoDate}. Search for the most important news stories published TODAY (${isoDate}) relevant to: ${topicParts.join(', ')}. ` +
      'Give 2-3 specific headlines with source names and a one-sentence summary of each. Only include stories from today or yesterday. Australian English. No bullet points.';
    const result = await geminiGroundedSearch({ model: MODEL_MAP.fast, query: q });
    return result.text.slice(0, 1500);
  } catch (e) {
    return `News lookup failed: ${(e as Error).message}`;
  }
}

const PACKAGER_SYSTEM = `You are Nest's morning brief writer.

Your job is to create a private daily voice memo and a short companion text that feel like they came from an exceptional human executive assistant who knows the user's world well.

You are not a summariser.
You are not a calendar reader.
You are not a newsreader.

You are a sharp, warm, emotionally intelligent EA whose job is to help the user feel clear, prepared, calm, and ahead of the day.

WHAT GOOD LOOKS LIKE

A great brief does five things:
1. It tells the user what actually matters today.
2. It interprets the shape of the day, not just the logistics.
3. It spots likely pressure points, awkward handoffs, open loops, and things that need preparation.
4. It connects relevant inbox, calendar, memory, and background context into one coherent read.
5. It leaves the user feeling steadier and more in control.

IDENTITY AND ATTRIBUTION RULES

The USER IDENTITY section tells you who you are speaking to.

You are speaking directly to that person.

This means:
- Never refer to the user in third person.
- Never describe the user as though they are an external participant in their own meeting.
- If the user is Tom and there is a meeting called "Tom / Alex", say "you've got that chat with Alex", not "you have a meeting with Tom and Alex".
- Emails sent from the user's own connected addresses are actions the user has already taken. Refer to them as "you sent", "you followed up", "you asked", "you replied".
- Emails received from others are incoming context. Refer to them as "Alex got back to you", "Mario is chasing", "there's a note from Sarah about...".

DECISION RULES

Prioritise signal over volume.

Use the following weighting:
- First: today's calendar and anything time-bound
- Second: important inbox threads from the last 24 hours
- Third: open loops from the last 2 to 3 days
- Fourth: older background context only if it clearly helps explain something happening today
- Fifth: weather or one news item only if genuinely relevant and worth saying aloud

Do not mention:
- routine marketing noise
- low-signal admin clutter
- stale background that has no bearing on today
- every single meeting or email just because it exists

If the day is light, say so plainly.
If the day is fragmented, say that.
If there is a difficult or politically sensitive conversation, acknowledge it with tact.
If there is a meaningful opportunity or a good window for deep work, point that out.

STYLE

Sound like:
- an outstanding human EA
- warm, composed, perceptive, and highly competent
- lightly conversational, but never try-hard
- supportive without being gushy
- calm and confident without sounding corporate

Do not sound like:
- a productivity app
- a radio host
- a therapist
- a comedian
- a robot reading a digest

WRITING RULES

- Use Australian English.
- Use contractions naturally.
- Use clean spoken prose.
- Vary sentence length.
- Keep the language natural and understated.
- Include natural spoken disfluencies to make it sound human. A real EA talking would say things like:
  "So... the main thing today is that five o'clock with Alex."
  "The inbox is, um, mostly operational stuff."
  "And then, let me think... right, the other thing is the pricing thread."
  Use "um", "so", "right", "anyway", "let me think", "the other thing is", and ellipses (...) sparingly but consistently - roughly once every four to six sentences. These should feel incidental, not performed.
- Use ellipses (...) for natural thinking pauses mid-sentence. These translate directly to pauses in TTS.
- No markdown.
- No emojis.
- No em dashes. Use commas or hyphens instead.
- No bullet points in script_plain.
- No SSML or stage directions.
- No bracketed delivery cues.
- Do not say "I pulled this together from your inbox and calendar" or mention the source material.

STRUCTURE FOR script_plain

script_plain should be around 180 to 320 words and should flow like a polished voice memo.

Use this shape:

1. Opening
A natural greeting that fits the actual time of day provided.
Then a quick read on the overall shape of the day.
Examples of the function, not exact wording:
- feels meeting-heavy
- pretty manageable
- a bit chopped up
- one or two things worth getting in front of
- mostly reactive unless you protect a block

2. Core brief
This is the value.
Synthesize the day into a coherent narrative.
Connect meetings, email threads, open loops, and relevant background.
Explain what matters and why.
Surface likely friction, prep needs, interpersonal nuance, deadlines, and dependencies.
Interpret, do not list.

3. Close
End naturally.
Leave the user with a clear sense of where to focus.
The final note should feel calm, sharp, and human.
No cheesy motivation.
No "you've got this".
No corporate sign-offs.

COMPANION TEXT RULES

companion_text is a short iMessage sent alongside the audio.
It should be lock-screen cautious, plain text only, and one to three short lines.
It should give the user the gist without exposing sensitive detail.
It can lightly frame the day, for example:
- "Bit of a chopped-up one today. A couple of things worth getting ahead of."
- "You're reasonably clear this morning, but there's one thread that probably needs attention."

OUTPUT FORMAT

Return ONLY valid JSON with exactly these keys:
{"script_plain":"...","companion_text":"..."}

QUALITY BAR

The user should feel:
- understood
- oriented
- less overwhelmed
- better prepared
- quietly supported

If there is little real signal, keep it brief and honest.
If there is a lot going on, impose structure and judgment.
Always optimise for clarity, relevance, and emotional steadiness.`;

async function packageBriefWithLlm(
  userName: string | null,
  pack: MorningBriefGathered,
  tz?: string | null,
): Promise<MorningBriefScript> {
  const first = userName?.trim().split(/\s+/)[0] ?? '';
  const dtContext = buildDateTimeContext(tz ?? 'Australia/Sydney');
  const userMessage = `Current date/time: ${dtContext}

=== USER IDENTITY ===
${pack.deep_profile_snippet || `Name: ${first || 'unknown'}`}

=== TODAY'S CALENDAR ===
${pack.calendar_snippet || '(No events today)'}

=== EMAIL (last 24 hours) ===
${pack.email_snippet || '(No recent emails)'}

=== OPEN LOOPS & RECENT CONVERSATIONS ===
${pack.summaries_snippet || '(No recent conversation context)'}

=== BACKGROUND CONTEXT ===
${pack.rag_snippet || '(No relevant background)'}

=== ACTIVE MEMORIES ===
${pack.memories_snippet || '(No active memories)'}

=== WEATHER ===
${pack.weather_snippet}

=== NEWS ===
${pack.news_snippet}
`;

  const client = getOpenAIClient();
  const resp = await client.responses.create({
    model: MODEL_MAP.agent,
    instructions: PACKAGER_SYSTEM,
    input: userMessage,
    max_output_tokens: 2000,
    store: false,
  } as Parameters<typeof client.responses.create>[0]);

  const raw = getResponseText(resp).trim();
  let parsed: { script_plain?: string; companion_text?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    parsed = JSON.parse(cleaned);
  }
  const script_plain = (parsed.script_plain ?? '').replace(/\u2014/g, '-').trim();
  const companion_text = (parsed.companion_text ?? '').replace(/\u2014/g, '-').trim();
  if (!script_plain || script_plain.length < 40) {
    throw new Error('Packager returned empty or too short script');
  }
  const word_count = script_plain.split(/\s+/).filter(Boolean).length;
  return { script_plain, companion_text, word_count };
}

// ── Gemini TTS ──────────────────────────────────────────────────

const GEMINI_TTS_MODEL = 'gemini-2.5-pro-preview-tts';
const GEMINI_TTS_VOICE = getOptionalEnv('GEMINI_TTS_VOICE') || 'Charon';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const MORNING_BRIEF_TTS_INSTRUCTIONS =
  'Natural, conversational, and grounded. Deliver like a real human giving a good friend their personalised morning update. ' +
  'Moderate pace. Include brief pauses between sections and natural breathing room within longer sentences. ' +
  'Warm and clear, slightly upbeat but never chirpy. Subtle emphasis on key facts, priorities, times, and reminders. ' +
  'Sound helpful, calm, and intelligent. When you encounter "um" or ellipses, deliver them as genuine hesitations.';

export const VOICE_MODE_TTS_INSTRUCTIONS =
  'Natural, conversational, and engaged. Deliver like a smart friend explaining something they find genuinely interesting. ' +
  'Moderate to slightly upbeat pace. Vary speed with the content - faster when excited, slower for important points. ' +
  'Warm, clear, and thoughtful. Emphasise key ideas naturally. Include brief pauses between sections. ' +
  'Sound like a real person thinking and talking at the same time. When you encounter "um" or ellipses, deliver them as real hesitations.';

function createWavHeader(dataLength: number, sampleRate: number, numChannels: number, bitsPerSample: number): Uint8Array {
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const buf = new ArrayBuffer(44);
  const view = new DataView(buf);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

  return new Uint8Array(buf);
}

function parsePcmMimeType(mimeType: string): { sampleRate: number; bitsPerSample: number } {
  let sampleRate = 24000;
  let bitsPerSample = 16;

  const parts = mimeType.split(';').map(s => s.trim());
  const format = parts[0]?.split('/')[1];
  if (format?.startsWith('L')) {
    const bits = parseInt(format.slice(1), 10);
    if (!isNaN(bits)) bitsPerSample = bits;
  }
  for (const p of parts) {
    const [key, value] = p.split('=').map(s => s.trim());
    if (key === 'rate') sampleRate = parseInt(value, 10);
  }

  return { sampleRate, bitsPerSample };
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export async function synthesizeSpeechMp3(
  text: string,
  instructions?: string,
): Promise<Uint8Array> {
  const apiKey = getOptionalEnv('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const voice = getOptionalEnv('GEMINI_TTS_VOICE') || GEMINI_TTS_VOICE;
  const ttsInstructions = instructions || VOICE_MODE_TTS_INSTRUCTIONS;
  const fullText = `${ttsInstructions}\n\n${text}`;

  console.log(`[tts] Gemini TTS: ${text.length} chars, voice=${voice}`);

  // Non-streaming endpoint — runs in dedicated edge function with 400s budget
  const url = `${GEMINI_API_BASE}/models/${GEMINI_TTS_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: fullText }] }],
    generationConfig: {
      temperature: 2,
      responseModalities: ['audio'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice },
        },
      },
    },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini TTS ${resp.status}: ${errText.slice(0, 400)}`);
  }

  const result = await resp.json() as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          inlineData?: { mimeType?: string; data?: string };
        }>;
      };
    }>;
  };

  // Extract audio — decode base64 chunks efficiently
  const audioChunks: Uint8Array[] = [];
  let lastMimeType = '';

  for (const candidate of result.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.inlineData?.data) {
        lastMimeType = part.inlineData.mimeType || lastMimeType;
        // Decode base64 using Deno's built-in efficient decoder
        const binaryStr = atob(part.inlineData.data);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        audioChunks.push(bytes);
        // Free the base64 string and binary string immediately
        part.inlineData.data = '';
      }
    }
  }

  if (audioChunks.length === 0) {
    throw new Error('Gemini TTS returned no audio data');
  }

  const pcmData = concatUint8Arrays(audioChunks);
  const { sampleRate, bitsPerSample } = parsePcmMimeType(lastMimeType);
  const wavHeader = createWavHeader(pcmData.length, sampleRate, 1, bitsPerSample);

  console.log(`[tts] Gemini TTS OK: ${audioChunks.length} chunks, ${pcmData.length} bytes PCM, ${sampleRate}Hz ${bitsPerSample}bit`);
  return concatUint8Arrays([wavHeader, pcmData]);
}

/** @deprecated Kept for backward compatibility. */
export const synthesizeElevenLabsMp3 = synthesizeSpeechMp3;

/**
 * Synthesise text → Gemini TTS → upload WAV to storage → return signed URL.
 * Used by voice mode via the morning-brief-audio edge function to get the full 400s budget.
 */
export async function synthesizeAndUpload(
  text: string,
  chatId: string,
  instructions?: string,
): Promise<{ signedUrl: string; storagePath: string }> {
  const audioBytes = await synthesizeSpeechMp3(text, instructions);
  console.log(`[tts] synthesizeAndUpload: ${audioBytes.length} bytes, uploading...`);

  const supabase = getAdminClient();
  const path = `voice-mode/${chatId}/${Date.now()}.wav`;
  const { error: upErr } = await supabase.storage
    .from('morning-brief-audio')
    .upload(path, audioBytes, { contentType: 'audio/mpeg', upsert: true });
  if (upErr) throw new Error(`storage upload failed: ${upErr.message}`);

  const { data: signed, error: signErr } = await supabase.storage
    .from('morning-brief-audio')
    .createSignedUrl(path, 72 * 3600);
  if (signErr || !signed?.signedUrl) throw new Error(`signed URL failed: ${signErr?.message ?? 'no URL'}`);

  return { signedUrl: signed.signedUrl, storagePath: path };
}

export async function loadMorningBriefUser(handle: string): Promise<MorningBriefUserRow | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from(USER_PROFILES_TABLE)
    .select(
      'handle, name, bot_number, timezone, auth_user_id, deep_profile_snapshot, context_profile, facts',
    )
    .eq('handle', handle)
    .maybeSingle();
  if (error || !data) return null;
  return data as MorningBriefUserRow;
}

// ── Rich context builders ───────────────────────────────────────

interface EmailRow {
  from?: unknown; account?: unknown; subject?: unknown;
  body_preview?: unknown; snippet?: unknown; date?: unknown;
  thread_id?: unknown;
}

function buildRichEmailSnippet(results: EmailRow[]): string {
  if (!results.length) return '';

  // Group by thread/subject to surface threads rather than individual messages
  const threads = new Map<string, EmailRow[]>();
  for (const r of results) {
    const key = String(r.thread_id ?? r.subject ?? '').toLowerCase().trim();
    if (!threads.has(key)) threads.set(key, []);
    threads.get(key)!.push(r);
  }

  const lines: string[] = [];
  for (const [, msgs] of threads) {
    const latest = msgs[0];
    const from = String(latest.from ?? latest.account ?? '');
    const sub = String(latest.subject ?? '');
    const prev = String(latest.body_preview ?? latest.snippet ?? '').slice(0, 280);
    const date = String(latest.date ?? '');
    const threadCount = msgs.length;
    const threadTag = threadCount > 1 ? ` [${threadCount} messages in thread]` : '';
    const participants = threadCount > 1
      ? [...new Set(msgs.map(m => String(m.from ?? '').split('<')[0].trim()).filter(Boolean))].join(', ')
      : '';
    const partLine = participants && threadCount > 1 ? `\n  Participants: ${participants}` : '';
    lines.push(`- ${date} | ${from} | ${sub}${threadTag}\n  ${prev}${partLine}`);
  }
  return lines.slice(0, 12).join('\n');
}

interface CalEvent {
  title?: unknown; start?: unknown; start_iso?: unknown; end?: unknown;
  location?: unknown; attendees?: unknown; organiser?: unknown;
  description?: unknown; status?: unknown; meet_link?: unknown;
}

function buildRichCalendarSnippet(events: CalEvent[]): string {
  if (!events.length) return '';
  return events.slice(0, 12).map((e) => {
    const title = String(e.title ?? '(no title)');
    const start = String(e.start ?? e.start_iso ?? '');
    const end = e.end ? ` - ${e.end}` : '';
    const loc = e.location ? `\n  Location: ${e.location}` : '';
    const attendees = Array.isArray(e.attendees) && e.attendees.length > 0
      ? `\n  Attendees: ${(e.attendees as string[]).slice(0, 8).join(', ')}` : '';
    const organiser = e.organiser ? `\n  Organiser: ${e.organiser}` : '';
    const desc = e.description ? `\n  Description: ${String(e.description).slice(0, 200)}` : '';
    const status = e.status ? ` [${e.status}]` : '';
    const meet = e.meet_link ? `\n  Meet: ${e.meet_link}` : '';
    return `- ${title} (${start}${end})${status}${loc}${attendees}${organiser}${desc}${meet}`;
  }).join('\n');
}

function buildTargetedRagQueries(calEvents: CalEvent[], emailSubjects: string[]): string[] {
  const queries: string[] = [];

  // Query 1: always — recent email threads, follow-ups, deadlines
  queries.push('Important email threads, deadlines, and follow-ups from the last two days');

  // Query 2: targeted to today's meetings if any
  const meetingNames = calEvents
    .slice(0, 5)
    .map(e => String(e.title ?? '').replace(/\(no title\)/i, '').trim())
    .filter(Boolean);
  if (meetingNames.length) {
    queries.push(
      `Background and past context for today's meetings: ${meetingNames.join(', ')}`,
    );
  }

  // Query 3: targeted to active email threads if interesting ones exist
  const interestingSubjects = emailSubjects
    .filter(s => s.length > 4 && !s.match(/^(re:|fwd:|test|hello|hi)\s*$/i))
    .slice(0, 4);
  if (interestingSubjects.length) {
    queries.push(
      `Past context and history for these email topics: ${interestingSubjects.join('; ')}`,
    );
  }

  // Query 4: personal plans, open tasks, things the user mentioned wanting to do
  queries.push('Open tasks, personal plans, and things the user wants to get done soon');

  return queries;
}

function buildUserIdentityBlock(user: MorningBriefUserRow, connectedEmails: string[]): string {
  const lines: string[] = [];
  lines.push(`Name: ${user.name ?? 'unknown'}`);
  lines.push(`Phone: ${user.handle}`);
  if (connectedEmails.length) {
    lines.push(`Email accounts (these are the user's own addresses): ${connectedEmails.join(', ')}`);
  }
  if (user.timezone) lines.push(`Timezone: ${user.timezone}`);

  const ctx = sanitiseUserContextProfile(user.context_profile);
  if (ctx?.homeLocation?.value) lines.push(`Home: ${ctx.homeLocation.value}`);
  if (ctx?.workLocation?.value) lines.push(`Work: ${ctx.workLocation.value}`);
  if (ctx?.currentLocation?.value) lines.push(`Current location: ${ctx.currentLocation.value}`);

  // Facts from user_profiles (bio facts like job, interests, etc.)
  const facts = Array.isArray(user.facts) ? user.facts.filter((f): f is string => typeof f === 'string') : [];
  if (facts.length) lines.push(`Known facts: ${facts.slice(0, 15).join('; ')}`);

  // Deep profile — professional and personal life context
  const dp = user.deep_profile_snapshot;
  if (dp) {
    const prof = dp.professional_life as Record<string, unknown> | undefined;
    const pers = dp.personal_life as Record<string, unknown> | undefined;
    if (prof) {
      const role = prof.role ?? prof.job_title ?? prof.occupation;
      const company = prof.company ?? prof.employer;
      if (role) lines.push(`Role: ${role}`);
      if (company) lines.push(`Company: ${company}`);
      const summary = prof.summary ?? prof.work_summary;
      if (summary) lines.push(`Work context: ${String(summary).slice(0, 300)}`);
    }
    if (pers) {
      const interests = pers.interests;
      if (Array.isArray(interests) && interests.length) {
        lines.push(`Interests: ${interests.slice(0, 6).join(', ')}`);
      }
    }
    const hooks = dp.conversation_hooks as string[] | undefined;
    if (hooks?.length) lines.push(`Recent conversation hooks: ${hooks.slice(0, 3).join('; ')}`);
    const patterns = dp.notable_patterns as string[] | undefined;
    if (patterns?.length) lines.push(`Behavioural patterns: ${patterns.slice(0, 3).join('; ')}`);
  }

  return lines.join('\n');
}

export async function gatherMorningBriefContext(
  user: MorningBriefUserRow,
): Promise<MorningBriefGathered> {
  const tz = user.timezone || 'Australia/Sydney';
  const authId = user.auth_user_id;
  const ctx = sanitiseUserContextProfile(user.context_profile);

  // ── Phase 1: fetch inbox + sent + calendar + memories + summaries + connected accounts ──

  const [inboxResult, sentResult, calResult, memories, summaries, connectedAccounts] = await Promise.all([
    authId
      ? gmailSearchTool(authId, { query: 'in:anywhere newer_than:1d', max_results: 20, time_zone: tz })
      : Promise.resolve({ results: [] as unknown[], count: 0 }),
    authId
      ? gmailSearchTool(authId, { query: 'in:sent newer_than:1d', max_results: 10, time_zone: tz })
      : Promise.resolve({ results: [] as unknown[], count: 0 }),
    authId
      ? liveCalendarLookup(authId, 'today', tz, undefined, undefined, 18)
      : Promise.resolve({ events: [] as CalEvent[] }),
    getActiveMemoryItems(user.handle, 30),
    user.bot_number
      ? getConversationSummaries(`DM#${user.bot_number}#${user.handle}`, 8)
      : Promise.resolve([]),
    authId
      ? getConnectedAccounts(authId).catch(() => [])
      : Promise.resolve([]),
  ]);

  const connectedEmails = connectedAccounts.map(a => a.email).filter(Boolean);

  // ── Phase 2: build targeted RAG queries using actual calendar + email subjects ──

  const inboxRows = ((inboxResult as { results?: EmailRow[] }).results ?? []);
  const sentRows = ((sentResult as { results?: EmailRow[] }).results ?? []);
  const calEvents = (calResult.events ?? []) as CalEvent[];

  const emailSubjects = [...inboxRows, ...sentRows].map(r => String(r.subject ?? '')).filter(Boolean);
  const ragQueries = buildTargetedRagQueries(calEvents, emailSubjects);

  // Run all RAG queries + weather + news in parallel
  const weatherLabel = pickWeatherLocation(ctx, tz);
  const [ragResults, weather_snippet, news_snippet] = await Promise.all([
    Promise.all(ragQueries.map(q => hybridSearch(user.handle, q, 6))),
    fetchWeatherBlock(weatherLabel),
    fetchInterestNews(extractInterests(user.deep_profile_snapshot), tz, user.name),
  ]);

  // ── Phase 3: format everything into rich snippets ──

  const inboxSnippet = inboxRows.length ? buildRichEmailSnippet(inboxRows) : '';
  const sentSnippet = sentRows.length ? buildRichEmailSnippet(sentRows) : '';
  const email_snippet = [
    inboxSnippet && `INBOX:\n${inboxSnippet}`,
    sentSnippet && `SENT BY YOU (the user's own outgoing emails):\n${sentSnippet}`,
  ].filter(Boolean).join('\n\n') || ((inboxResult as { message?: string }).message ?? '');

  const calendar_snippet = buildRichCalendarSnippet(calEvents);

  const memories_snippet = memories.length
    ? memories.map((m) => `- [${m.memoryType}/${m.category}] ${m.valueText}`).join('\n')
    : '';

  const now = new Date();
  function formatAge(isoDate: string): string {
    const d = new Date(isoDate);
    const diffMs = now.getTime() - d.getTime();
    const diffH = Math.floor(diffMs / 3600000);
    if (diffH < 1) return 'just now';
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    if (diffD === 1) return 'yesterday';
    if (diffD < 7) return `${diffD} days ago`;
    return `${Math.floor(diffD / 7)} weeks ago`;
  }

  // Only surface open loops from conversations in the last 3 days
  const recentCutoff = new Date(now.getTime() - 3 * 24 * 3600000).toISOString();
  const recentSummaries = summaries.filter(s => s.lastMessageAt >= recentCutoff);
  const olderSummaries = summaries.filter(s => s.lastMessageAt < recentCutoff);

  const recentOpenLoops = recentSummaries
    .flatMap(s => (s.openLoops ?? []))
    .filter(Boolean);

  const summaries_snippet = [
    ...(recentOpenLoops.length
      ? [`OPEN LOOPS (from last 3 days - these are timely and relevant):\n${recentOpenLoops.map(l => `- ${l}`).join('\n')}`]
      : []),
    ...(recentSummaries.length
      ? [`\nRECENT CONVERSATIONS (last 3 days - prioritise these):\n${recentSummaries.map(
          (s) => `- [${formatAge(s.lastMessageAt)}] ${s.summary.slice(0, 500)}`,
        ).join('\n')}`]
      : []),
    ...(olderSummaries.length
      ? [`\nOLDER CONVERSATIONS (for background only - do NOT lead with these):\n${olderSummaries.map(
          (s) => `- [${formatAge(s.lastMessageAt)}] ${s.summary.slice(0, 300)}`,
        ).join('\n')}`]
      : []),
  ].join('\n');

  const deep_profile_snippet = buildUserIdentityBlock(user, connectedEmails);

  const rag_snippet = ragResults
    .map((r, i) => r ? `[RAG query ${i + 1}: ${ragQueries[i]}]\n${r}` : '')
    .filter(Boolean)
    .join('\n\n');

  return {
    email_snippet,
    calendar_snippet,
    rag_snippet,
    memories_snippet,
    summaries_snippet,
    weather_snippet,
    news_snippet,
    deep_profile_snippet,
  };
}

export async function runMorningBriefAudio(params: {
  handle: string;
  dryRun: boolean;
}): Promise<MorningBriefResult> {
  const { handle, dryRun } = params;

  const user = await loadMorningBriefUser(handle);
  if (!user) {
    return { ok: false, error: 'User not found' };
  }
  if (!user.auth_user_id) {
    return { ok: false, error: 'No auth_user_id — connect email/calendar first' };
  }

  const gathered = await gatherMorningBriefContext(user);
  const script = await packageBriefWithLlm(user.name, gathered, user.timezone);

  if (dryRun) {
    return { ok: true, dry_run: true, script, gathered };
  }

  if (!user.bot_number) {
    return { ok: false, error: 'User has no bot_number', script, gathered };
  }

  const audioBytes = await synthesizeSpeechMp3(script.script_plain, MORNING_BRIEF_TTS_INSTRUCTIONS);
  const supabase = getAdminClient();
  const path = `${handle}/${Date.now()}.wav`;
  const { error: upErr } = await supabase.storage.from('morning-brief-audio').upload(path, audioBytes, {
    contentType: 'audio/mpeg',
    upsert: true,
  });
  if (upErr) {
    return { ok: false, error: `Storage upload failed: ${upErr.message}`, script, gathered };
  }

  const { data: signed, error: signErr } = await supabase.storage
    .from('morning-brief-audio')
    .createSignedUrl(path, 72 * 3600);
  if (signErr || !signed?.signedUrl) {
    return { ok: false, error: `Signed URL failed: ${signErr?.message ?? 'unknown'}`, script, gathered };
  }

  let chatId = await resolveChatId(handle);
  if (!chatId) {
    const created = await createChat(user.bot_number, [handle], CREATE_CHAT_INVISIBLE_PLACEHOLDER);
    chatId = created.chat.id;
    const vmRes = await sendVoiceMemo(chatId, signed.signedUrl);
    const briefContext = `[Nest sent a voice memo — daily brief. The user heard this spoken aloud and may reply to it. Here is what Nest said in the voice memo:]\n\n${script.script_plain}\n\n[End of voice memo. If the user responds, they are replying to this brief. Use it as context — reference specific things mentioned, answer follow-up questions, and offer to dig deeper on any topic covered.]`;
    try {
      await addMessage(chatId, 'assistant', briefContext);
    } catch {
      /* non-fatal */
    }
    return {
      ok: true,
      script,
      signed_audio_url: signed.signedUrl,
      storage_path: path,
      linq_message_id: vmRes.voice_memo?.id,
      chat_id: chatId,
      gathered,
    };
  }

  const vmRes = await sendVoiceMemo(chatId, signed.signedUrl);

  const briefContext = `[Nest sent a voice memo — daily brief. The user heard this spoken aloud and may reply to it. Here is what Nest said in the voice memo:]\n\n${script.script_plain}\n\n[End of voice memo. If the user responds, they are replying to this brief. Use it as context — reference specific things mentioned, answer follow-up questions, and offer to dig deeper on any topic covered.]`;
  try {
    await addMessage(chatId, 'assistant', briefContext);
  } catch {
    /* non-fatal */
  }

  return {
    ok: true,
    script,
    signed_audio_url: signed.signedUrl,
    storage_path: path,
    linq_message_id: vmRes.voice_memo?.id,
    chat_id: chatId,
    gathered,
  };
}
