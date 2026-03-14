// Server-side RAG pipeline for Nest.
// Adapted from TapMeeting's 10-stage pipeline, simplified to 6 stages:
//
//   1. Casual message gate (instant skip for greetings/chat)
//   2. Query enrichment (coreference resolution from conversation history)
//   3. Sub-query generation (stop-word stripping, topic extraction)
//   4. Batch embed + parallel hybrid search
//   5. Deduplication + MMR diversity
//   6. Evidence block building + formatting (+ agentic fallback if thin)
//
// Performance optimisations:
//   - Casual message gate: "hey", "thanks" etc. skip the pipeline entirely
//   - Batch embeddings: all queries embedded in 1 API call
//   - Embedding cache: duplicate queries across phases are never re-embedded
//   - Parallel search: all sub-queries searched concurrently

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getBatchEmbeddings, vectorString } from "./rag-tools.ts";

const MAX_EVIDENCE_BLOCKS = 15;
const MAX_EVIDENCE_CHARS = 2000;
const MIN_SEMANTIC_SCORE = 0.22;

// ── Source type display names ────────────────────────────────

const SOURCE_DISPLAY: Record<string, string> = {
  conversation_summary: "Conversation",
  conversation_chunk: "Conversation Snippet",
  memory_summary: "Memory",
  memory_chunk: "Memory Snippet",
  email_summary: "Email Summary",
  email_chunk: "Email Snippet",
  calendar_summary: "Calendar",
  calendar_chunk: "Calendar Snippet",
  meeting_summary: "Meeting",
  meeting_chunk: "Meeting Snippet",
  utterance_chunk: "Transcript",
  note_summary: "Note",
  note_chunk: "Note Snippet",
};

// ── Types ────────────────────────────────────────────────────

interface SearchResult {
  document_id: string;
  source_type: string;
  source_id: string;
  title: string;
  summary_text: string | null;
  chunk_text: string | null;
  metadata: any;
  semantic_score: number;
  lexical_score: number | null;
  fused_score: number;
}

interface EvidenceBlock {
  sourceType: string;
  title: string;
  text: string;
  score: number;
  sourceId: string;
}

// ── Embedding Cache ──────────────────────────────────────────

class EmbeddingCache {
  private cache = new Map<string, number[]>();

  async ensureCached(texts: string[]): Promise<void> {
    const uncached = texts.filter((t) => !this.cache.has(t));
    if (uncached.length === 0) return;

    const embeddings = await getBatchEmbeddings(uncached);
    for (let i = 0; i < uncached.length; i++) {
      this.cache.set(uncached[i], embeddings[i]);
    }
  }

  get(text: string): number[] {
    const v = this.cache.get(text);
    if (!v) throw new Error(`Embedding not cached for: ${text.slice(0, 50)}`);
    return v;
  }

  has(text: string): boolean {
    return this.cache.has(text);
  }
}

// ── 1. Skip Detection ──
// Two layers:
//   a) Instant pattern match for obvious greetings/reactions (free, <1ms)
//   b) LLM gate for everything else (~200-400ms, uses gpt-4.1-nano)

const INSTANT_SKIP = new Set([
  "hey", "hi", "hello", "yo", "sup", "hiya", "g'day",
  "thanks", "thank you", "cheers", "ta", "thx",
  "ok", "okay", "k", "kk", "sure", "yep", "yup", "nah", "nope",
  "good morning", "good afternoon", "good evening", "good night",
  "gm", "gn", "morning", "night",
  "lol", "haha", "hahaha", "lmao", "nice", "cool", "great", "awesome",
  "bye", "cya", "see ya", "later", "ttyl",
  "yes", "no", "yeah", "nah", "na", "all good", "no worries",
  "how are you", "how's it going", "what's up", "whats up",
  "send", "send it", "go ahead", "do it", "looks good", "perfect",
]);

function isInstantSkip(msg: string): boolean {
  return INSTANT_SKIP.has(msg.toLowerCase().replace(/[^\w\s']/g, "").trim());
}

const RAG_GATE_PROMPT = `You decide whether a user message needs retrieval from the user's personal knowledge base (emails, meeting notes, calendar, past conversations, saved memories).

Return ONLY one word: "retrieve" or "skip".

Return "retrieve" when the message:
- Asks about something personal (their meetings, emails, notes, conversations, contacts, preferences, past events)
- References a specific person, project, or topic they've discussed before
- Is a follow-up to a previous question that was about personal data
- Asks "what did I/we/they say", "what happened in that call", "remind me", etc.

Return "skip" when the message:
- Is casual chat, a greeting, reaction, or acknowledgement (e.g. "yeah interesting", "cool", "haha")
- Is a general knowledge question answerable without personal data (e.g. "tell me about Japan", "how does solar work")
- Is a web/current-events question (e.g. "what's the weather", "latest F1 results")
- Is a tool-answerable request like "what's on my calendar" or "check my emails" (tools handle these directly)
- Is a creative/drafting request that doesn't need past context

When in doubt, return "retrieve". False skips are worse than unnecessary retrieval.`;

async function shouldRetrieve(
  message: string,
  recentChat: Array<{ role: string; content: string }>,
): Promise<boolean> {
  const { getOpenAIClient } = await import("./ai/models.ts");
  const client = getOpenAIClient();

  const chatSnippet = recentChat.slice(-4).map((m) =>
    `${m.role}: ${m.content.slice(0, 200)}`
  ).join("\n");

  try {
    const res = await client.responses.create({
      model: "gpt-4.1-nano",
      instructions: RAG_GATE_PROMPT,
      input: `Recent conversation:\n${chatSnippet}\n\nCurrent message: ${message}`,
      max_output_tokens: 4,
      temperature: 0,
      store: false,
    });

    const answer = (res.output_text ?? "").trim().toLowerCase();
    const skip = answer.startsWith("skip");
    console.log(`[server-rag] LLM gate: "${message}" → ${skip ? "skip" : "retrieve"} (${answer})`);
    return !skip;
  } catch (err) {
    console.warn(`[server-rag] LLM gate failed, defaulting to retrieve:`, (err as Error).message);
    return true;
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Full pipeline RAG — 6-stage retrieval for Nest.
 * Returns formatted evidence string to inject into Claude context,
 * or empty string if no relevant evidence found.
 */
export async function serverSideRAG(
  message: string,
  recentChat: Array<{ role: string; content: string }>,
  handle: string,
  supabase: SupabaseClient,
): Promise<string> {
  const start = Date.now();

  // 1. Skip gate — two layers
  if (isInstantSkip(message)) {
    console.log(`[server-rag] Instant skip: "${message}" (0ms)`);
    return "";
  }

  const needsRetrieval = await shouldRetrieve(message, recentChat);
  if (!needsRetrieval) {
    const gateMs = Date.now() - start;
    console.log(`[server-rag] LLM gate skipped retrieval (${gateMs}ms)`);
    return "";
  }

  const embedCache = new EmbeddingCache();

  // 2. Query enrichment — resolve pronouns using conversation history
  const enrichedQuery = enrichQuery(message, recentChat);

  // 3. Sub-query generation (fast, local)
  const subQueries = generateSubQueries(enrichedQuery);

  // 4. Batch-embed all sub-queries in ONE API call
  await embedCache.ensureCached(subQueries);

  // 4b. Parallel hybrid search (embeddings already cached — just RPC calls)
  let allResults = await parallelSearchCached(
    subQueries, embedCache, supabase, handle
  );

  // 4c. Keyword-based source-filtered search for better recall
  const keywordResults = await keywordSourceSearchCached(
    message, subQueries, embedCache, supabase, handle
  );
  allResults.push(...keywordResults);

  // 5. Deduplicate + MMR diversity
  allResults = deduplicateResults(allResults);
  const diverseResults = applyMMR(allResults, MAX_EVIDENCE_BLOCKS * 2);

  // 6. Build evidence blocks
  let evidence = buildEvidenceBlocks(diverseResults, MAX_EVIDENCE_BLOCKS);

  // 6b. Agentic fallback — second round if evidence is thin
  if (evidence.length < 3 && enrichedQuery.length > 0) {
    const topicNouns = extractTopicNouns(enrichedQuery);
    const fallbackQuery = topicNouns.length > 0
      ? topicNouns.join(" ")
      : enrichedQuery;

    if (!embedCache.has(fallbackQuery)) {
      await embedCache.ensureCached([fallbackQuery]);
    }
    const fallbackResults = await searchWithCachedEmbedding(
      fallbackQuery, embedCache, supabase, handle
    );
    const fallbackEvidence = buildEvidenceBlocks(
      deduplicateResults(fallbackResults), MAX_EVIDENCE_BLOCKS
    );
    if (fallbackEvidence.length > evidence.length) {
      evidence = fallbackEvidence;
    }
  }

  const elapsed = Date.now() - start;

  if (evidence.length === 0) {
    console.log(`[server-rag] No evidence found (${elapsed}ms)`);
    return "";
  }

  const formatted = formatEvidence(evidence);
  console.log(
    `[server-rag] ${evidence.length} evidence blocks, ` +
    `${allResults.length} total results, ${elapsed}ms`
  );

  return formatted;
}

// ── 2. Query Enrichment ──────────────────────────────────────

function enrichQuery(
  query: string,
  history: Array<{ role: string; content: string }>
): string {
  const recent = history.slice(-6);
  if (recent.length === 0) return query;

  const pronouns = [
    "they", "their", "them", "he", "she", "his", "her",
    "it", "its", "that", "this", "those", "these",
  ];
  const lower = query.toLowerCase();
  const hasPronouns = pronouns.some((p) => {
    const re = new RegExp(`\\b${p}\\b`);
    return re.test(lower);
  });

  const FOLLOW_UP_PATTERNS = [
    /\bprepare\b/i, /\bprep\b/i, /\bready\b/i,
    /\btell me more\b/i, /\bmore detail/i, /\bexpand\b/i,
    /\bwhat should i\b/i, /\bwhat do i need\b/i,
    /\bany tips\b/i, /\bany advice\b/i,
    /\bhelp me\b/i, /\bdig deeper\b/i,
    /\bwhat about\b/i, /\bwhat else\b/i,
    /\bgive me context\b/i, /\bbackground\b/i,
  ];
  const isFollowUp = hasPronouns || FOLLOW_UP_PATTERNS.some((p) => p.test(lower));

  if (isFollowUp) {
    const lastAssistant = [...recent]
      .reverse()
      .find((m) => m.role === "assistant");
    if (lastAssistant) {
      const boldEntities = [...lastAssistant.content.matchAll(/\*\*([^*]+)\*\*/g)]
        .map((m) => m[1])
        .filter((e) => e.length > 2 && e.length < 60);

      const hint = lastAssistant.content.slice(0, 400);

      if (boldEntities.length > 0) {
        return `Context: ${hint}\nKey entities: ${boldEntities.join(", ")}\nQuery: ${query}`;
      }
      return `Context: ${hint}\nQuery: ${query}`;
    }
  }

  return query;
}

// ── 3. Sub-query Generation ──────────────────────────────────

const STOP_WORDS = new Set([
  "what", "when", "where", "who", "how", "why",
  "did", "does", "do", "the", "a", "an",
  "is", "was", "were", "are", "been", "be",
  "about", "from", "with", "for", "of", "in", "on", "at", "to",
  "can", "could", "would", "should", "will",
  "you", "me", "my", "i", "we", "our",
  "tell", "show", "give", "find", "get", "list", "summarise", "summarize", "explain",
  "please", "any", "some", "that", "this", "those", "these", "it", "its",
]);

const TEMPORAL_WORDS = new Set([
  "today", "tomorrow", "yesterday", "tonight", "morning", "afternoon", "evening",
  "last", "next", "recent", "latest", "upcoming", "past",
  "week", "month", "year",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
]);

function generateSubQueries(query: string): string[] {
  const queries: string[] = [query];
  const words = query.split(/\s+/);

  const keywords = words.filter((w) => {
    const lower = w.toLowerCase().replace(/[^\w]/g, "");
    return !STOP_WORDS.has(lower) && !TEMPORAL_WORDS.has(lower) && lower.length > 1;
  });

  const temporalWords = words.filter((w) => {
    const lower = w.toLowerCase().replace(/[^\w]/g, "");
    return TEMPORAL_WORDS.has(lower) || /^\d{4}$/.test(lower);
  });

  if (keywords.length >= 2) {
    queries.push(keywords.join(" "));
  }

  if (temporalWords.length > 0 && keywords.length > 0) {
    queries.push([...temporalWords, ...keywords].join(" "));
  }

  const topicWords = [...keywords].sort((a, b) => b.length - a.length).slice(0, 3);
  if (topicWords.length > 0) {
    const primary = topicWords[0];
    if (primary.toLowerCase() !== keywords.join(" ").toLowerCase()) {
      queries.push(primary);
      if (topicWords.length >= 2) {
        queries.push(topicWords.join(" "));
      }
    }
  }

  const seen = new Set<string>();
  return queries.filter((q) => {
    const key = q.toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Cached Search Functions ──────────────────────────────────

async function searchWithCachedEmbedding(
  queryText: string,
  cache: EmbeddingCache,
  supabase: SupabaseClient,
  handle: string,
  sourceFilters?: string[] | null,
  matchCount = 15
): Promise<SearchResult[]> {
  const embedding = cache.get(queryText);
  const embStr = vectorString(embedding);

  const { data, error } = await supabase.rpc("hybrid_search_documents", {
    p_handle: handle,
    query_text: queryText,
    query_embedding: embStr,
    match_count: matchCount,
    source_filters: sourceFilters ?? null,
    min_semantic_score: MIN_SEMANTIC_SCORE,
  });

  if (error) {
    console.warn("[server-rag] hybrid_search error, trying fallback:", error.message);
    const fallback = await supabase.rpc("match_search_documents", {
      p_handle: handle,
      query_embedding: embStr,
      match_count: matchCount,
      source_filters: sourceFilters ?? null,
      min_score: MIN_SEMANTIC_SCORE,
    });
    if (fallback.error) {
      console.error("[server-rag] fallback search error:", fallback.error.message);
      return [];
    }
    return (fallback.data ?? []).map((d: any) => ({
      ...d,
      fused_score: d.semantic_score ?? 0,
      lexical_score: null,
    }));
  }

  return data ?? [];
}

async function parallelSearchCached(
  queries: string[],
  cache: EmbeddingCache,
  supabase: SupabaseClient,
  handle: string
): Promise<SearchResult[]> {
  const results = await Promise.all(
    queries.map((q) =>
      searchWithCachedEmbedding(q, cache, supabase, handle).catch(() => [])
    )
  );
  return results.flat();
}

// ── Keyword-based Source-filtered Search ──────────────────────

async function keywordSourceSearchCached(
  query: string,
  subQueries: string[],
  cache: EmbeddingCache,
  supabase: SupabaseClient,
  handle: string
): Promise<SearchResult[]> {
  const lower = query.toLowerCase();

  const emailKeywords = ["email", "emails", "inbox", "thread", "replied", "wrote"];
  const conversationKeywords = ["said", "told", "mentioned", "talked", "chatted",
    "conversation", "discussed with me", "i said", "you said", "we talked",
    "last time", "remember when"];
  const memoryKeywords = ["my name", "my dog", "my cat", "i like", "i hate",
    "i prefer", "do i", "who is", "what's my", "favourite", "favorite",
    "preference", "remember"];
  const meetingKeywords = ["meeting", "meetings", "transcript", "discussed",
    "call", "standup", "sync", "recap", "granola", "action item", "decided",
    "meeting notes", "what was said"];
  const calendarKeywords = ["calendar", "schedule", "event", "appointment",
    "busy", "free", "available"];
  const noteKeywords = ["note", "notes", "wrote down", "jotted"];

  const wantsEmails = emailKeywords.some((k) => lower.includes(k));
  const wantsConversations = conversationKeywords.some((k) => lower.includes(k));
  const wantsMemory = memoryKeywords.some((k) => lower.includes(k));
  const wantsMeetings = meetingKeywords.some((k) => lower.includes(k));
  const wantsCalendar = calendarKeywords.some((k) => lower.includes(k));
  const wantsNotes = noteKeywords.some((k) => lower.includes(k));

  const promises: Promise<SearchResult[]>[] = [];

  const searchWithFilters = (filters: string[]) => {
    for (const q of subQueries) {
      if (cache.has(q)) {
        promises.push(
          searchWithCachedEmbedding(q, cache, supabase, handle, filters).catch(() => [])
        );
      }
    }
  };

  if (wantsEmails) searchWithFilters(["email_summary", "email_chunk"]);
  if (wantsConversations) searchWithFilters(["conversation_summary", "conversation_chunk"]);
  if (wantsMemory) searchWithFilters(["memory_summary", "memory_chunk"]);
  if (wantsMeetings) searchWithFilters(["meeting_summary", "meeting_chunk", "utterance_chunk"]);
  if (wantsCalendar) searchWithFilters(["calendar_summary", "calendar_chunk"]);
  if (wantsNotes) searchWithFilters(["note_summary", "note_chunk"]);

  const results = await Promise.all(promises);
  return results.flat();
}

// ── 5. Deduplication ─────────────────────────────────────────

function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results
    .filter((r) => {
      const id = r.document_id;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => (b.fused_score ?? 0) - (a.fused_score ?? 0));
}

// ── 5b. MMR Diversity ────────────────────────────────────────

function applyMMR(results: SearchResult[], maxResults: number): SearchResult[] {
  if (results.length <= maxResults) return results;

  const selected: SearchResult[] = [];
  const sourceCount: Record<string, number> = {};
  const DIVERSITY_PENALTY = 0.3;

  const sorted = [...results].sort((a, b) => (b.fused_score ?? 0) - (a.fused_score ?? 0));

  for (const candidate of sorted) {
    if (selected.length >= maxResults) break;

    const sourceKey = `${candidate.source_type}::${candidate.source_id}`;
    const count = sourceCount[sourceKey] ?? 0;

    if (count < 3) {
      const penalty = count * DIVERSITY_PENALTY;
      const adjustedScore = (candidate.fused_score ?? 0) * (1.0 - penalty);
      if (adjustedScore > 0 || selected.length < 4) {
        selected.push(candidate);
        sourceCount[sourceKey] = count + 1;
      }
    }
  }

  return selected;
}

// ── 6. Evidence Block Building ───────────────────────────────

function buildEvidenceBlocks(results: SearchResult[], max: number): EvidenceBlock[] {
  const blocks: EvidenceBlock[] = [];

  for (const r of results.slice(0, max)) {
    let body = (r.chunk_text ?? r.summary_text ?? "").trim();
    if (!body) continue;

    blocks.push({
      sourceType: SOURCE_DISPLAY[r.source_type] ?? r.source_type,
      title: r.title ?? SOURCE_DISPLAY[r.source_type] ?? r.source_type,
      text: body.slice(0, MAX_EVIDENCE_CHARS),
      score: r.semantic_score ?? r.fused_score ?? 0,
      sourceId: r.source_id ?? "",
    });
  }

  return blocks;
}

// ── Format Evidence String ───────────────────────────────────

function formatEvidence(evidence: EvidenceBlock[]): string {
  const parts: string[] = [
    "Cited context (from semantic search, ordered by relevance):\n",
  ];

  for (let i = 0; i < evidence.length; i++) {
    const e = evidence[i];
    const pct = `${Math.round(e.score * 100)}%`;
    parts.push(
      `[${i + 1}] ${e.title}, Relevance: ${pct}\n` +
      `Source: ${e.sourceType} | ID: ${e.sourceId}\n` +
      `Details: ${e.text}\n`
    );
  }

  return parts.join("\n");
}

// ── Topic Noun Extraction (for agentic fallback) ─────────────

const FALLBACK_STOP_WORDS = new Set([
  ...STOP_WORDS,
  ...TEMPORAL_WORDS,
  "key", "highlights", "details", "related",
]);

function extractTopicNouns(query: string): string[] {
  return query
    .split(/\s+/)
    .map((w) => w.toLowerCase().replace(/[^\w]/g, ""))
    .filter((w) => !FALLBACK_STOP_WORDS.has(w) && w.length > 1);
}
