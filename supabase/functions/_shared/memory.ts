import { getOpenAIClient, MODEL_MAP, REASONING_EFFORT } from './ai/models.ts';
import {
  type MemoryItem,
  type MemoryType,
  type SourceKind,
  type UnsummarisedMessage,
  type ConversationSummary,
  type ToolTrace,
  insertMemoryItem,
  supersedeMemoryItem,
  confirmMemoryItem,
  getActiveMemoryItems,
} from './state.ts';
import { EXTRACTOR_VERSION } from './env.ts';
import { increment, METRICS } from './telemetry.ts';
import { memoryContextHeader, contentHash } from './chunker.ts';
import { embedChunks, type ChunkToEmbed } from './embedder.ts';
import { softDeleteSource, insertEmbeddedChunks } from './ingestion-helpers.ts';
import { getAdminClient } from './supabase.ts';

const client = getOpenAIClient();

// ============================================================================
// Types
// ============================================================================

export interface CandidateMemory {
  handle: string;
  memoryType: MemoryType;
  category: string;
  valueText: string;
  normalizedValue: string | null;
  confidence: number;
  durability: 'durable' | 'temporary' | 'uncertain' | 'corrected';
  sourceMessageIds: number[];
  sourceKind: SourceKind;
}

export type AdjudicationAction =
  | { type: 'ADD_NEW' }
  | { type: 'CONFIRM_EXISTING'; existingId: number }
  | { type: 'SUPERSEDE_EXISTING'; existingId: number }
  | { type: 'MARK_UNCERTAIN' }
  | { type: 'REJECT' };

const VALID_MEMORY_TYPES: Set<string> = new Set([
  'identity', 'preference', 'plan', 'task_commitment',
  'relationship', 'emotional_context', 'bio_fact', 'contextual_note',
]);

export const CATEGORY_TAXONOMY = {
  singular: [
    'location', 'employment', 'education', 'age', 'birthday',
    'relationship_status', 'nationality', 'native_language',
  ],
  multi: [
    'sport_team', 'music', 'food', 'pet', 'hobby', 'interest',
    'skill', 'travel', 'health', 'preference', 'language',
  ],
  fallback: 'general',
} as const;

const ALL_CATEGORIES: Set<string> = new Set([
  ...CATEGORY_TAXONOMY.singular,
  ...CATEGORY_TAXONOMY.multi,
  CATEGORY_TAXONOMY.fallback,
]);

const SINGULAR_CATEGORIES: Set<string> = new Set(CATEGORY_TAXONOMY.singular);

const CATEGORY_ALIASES: Record<string, string> = {
  'job': 'employment', 'work': 'employment', 'career': 'employment', 'occupation': 'employment', 'employer': 'employment',
  'home': 'location', 'city': 'location', 'country': 'location', 'address': 'location', 'lives': 'location', 'residence': 'location',
  'school': 'education', 'university': 'education', 'uni': 'education', 'college': 'education', 'degree': 'education', 'study': 'education',
  'sports team': 'sport_team', 'sports': 'sport_team', 'team': 'sport_team', 'club': 'sport_team', 'supporter': 'sport_team',
  'food preference': 'food', 'diet': 'food', 'cuisine': 'food', 'allergy': 'health', 'allergies': 'health',
  'relationship': 'relationship_status', 'married': 'relationship_status', 'partner': 'relationship_status',
  'born': 'birthday', 'dob': 'birthday', 'date of birth': 'birthday',
  'language spoken': 'language', 'speaks': 'language',
  'nationality': 'nationality', 'citizen': 'nationality', 'citizenship': 'nationality',
  'native language': 'native_language', 'mother tongue': 'native_language',
  'fitness': 'health', 'medical': 'health', 'condition': 'health',
  'trip': 'travel', 'vacation': 'travel', 'holiday': 'travel', 'flight': 'travel',
};

export function normaliseCategory(raw: string): string {
  const cleaned = raw.toLowerCase().trim().replace(/[\s_-]+/g, '_');
  if (ALL_CATEGORIES.has(cleaned)) return cleaned;
  const aliased = CATEGORY_ALIASES[raw.toLowerCase().trim()];
  if (aliased) return aliased;
  return CATEGORY_TAXONOMY.fallback;
}

const CLASSIFY_CATEGORY_PROMPT = `You are a memory category classifier. Given a fact about a person, pick the single best category from this list:

SINGULAR (only one can be active at a time):
- location: where they live (e.g. "Lives in Melbourne")
- employment: job or employer (e.g. "Works at Blacklane")
- education: school, degree (e.g. "Studying CS at MIT")
- age: how old they are (e.g. "28 years old")
- birthday: date of birth (e.g. "Birthday is March 15")
- relationship_status: partner status (e.g. "Married", "Dating someone")
- nationality: citizenship (e.g. "Australian citizen")
- native_language: mother tongue (e.g. "Native Mandarin speaker")

MULTI (multiple can coexist):
- sport_team: favourite teams (e.g. "Supports Sydney Swans")
- music: music taste (e.g. "Loves jazz")
- food: food preferences, diet (e.g. "Vegetarian", "Loves sushi")
- pet: animals they have (e.g. "Has a golden retriever")
- hobby: activities (e.g. "Plays guitar", "Into rock climbing")
- interest: general interests (e.g. "Interested in AI")
- skill: abilities (e.g. "Fluent in Python")
- travel: travel plans or history (e.g. "Going to Japan next month")
- health: medical, fitness (e.g. "Allergic to peanuts")
- preference: other preferences (e.g. "Prefers morning meetings")
- language: languages spoken (e.g. "Speaks French")
- general: anything that doesn't fit above

Reply with ONLY the category slug, nothing else.`;

export async function classifyCategory(fact: string): Promise<string> {
  try {
    const response = await client.responses.create({
      model: MODEL_MAP.orchestration,
      instructions: CLASSIFY_CATEGORY_PROMPT,
      input: fact,
      max_output_tokens: 256,
      store: false,
      reasoning: { effort: REASONING_EFFORT.orchestration },
    } as Parameters<typeof client.responses.create>[0]);

    const text = response.output_text;
    if (!text) return CATEGORY_TAXONOMY.fallback;

    return normaliseCategory(text);
  } catch (error) {
    console.error('[memory] Category classification error:', error);
    return CATEGORY_TAXONOMY.fallback;
  }
}

export async function resolveCategory(fact: string, providedCategory?: string): Promise<string> {
  if (providedCategory) {
    const normalised = normaliseCategory(providedCategory);
    if (normalised !== CATEGORY_TAXONOMY.fallback) return normalised;
  }
  return classifyCategory(fact);
}

// ============================================================================
// Step A: Candidate Extraction (LLM)
// ============================================================================

const EXTRACTION_PROMPT = `You are a memory extraction system for a messaging assistant called Nest. Given a conversation, extract candidate memory items about the participants.

Respond with ONLY valid JSON in this exact format:
{
  "candidates": [
    {
      "handle": "+61400000000",
      "memory_type": "bio_fact",
      "category": "food",
      "value_text": "Prefers spicy food",
      "confidence": 0.85,
      "durability": "durable"
    }
  ]
}

Allowed memory_type values: identity, preference, plan, task_commitment, relationship, emotional_context, bio_fact, contextual_note

Allowed durability values: durable, temporary, uncertain, corrected

## Category Taxonomy (REQUIRED — pick the best match)

SINGULAR categories (only one active per person):
- location: where they live ("Lives in Melbourne", "Moved to Sydney")
- employment: job or employer ("Works at Google", "Software engineer")
- education: school, degree ("Studying CS at MIT", "Graduated from UNSW")
- age: how old they are ("28 years old", "Born in 1997")
- birthday: date of birth ("Birthday is March 15")
- relationship_status: partner status ("Married", "Has a girlfriend")
- nationality: citizenship ("Australian", "British citizen")
- native_language: mother tongue ("Native Mandarin speaker")

MULTI categories (multiple can coexist):
- sport_team: favourite teams ("Supports Sydney Swans", "Arsenal fan")
- music: music taste ("Loves jazz", "Favourite artist is Drake")
- food: food preferences, diet ("Vegetarian", "Loves sushi", "Hates olives")
- pet: animals they have ("Has a golden retriever named Max")
- hobby: activities ("Plays guitar", "Into rock climbing", "Surfs on weekends")
- interest: general interests ("Interested in AI", "Reads a lot of sci-fi")
- skill: abilities ("Fluent in Python", "Good at chess")
- travel: travel plans or history ("Going to Japan next month", "Visited Italy last year")
- health: medical, fitness, allergies ("Allergic to peanuts", "Runs 5k daily")
- preference: other preferences ("Prefers morning meetings", "Night owl")
- language: languages spoken ("Speaks French and German")
- general: anything that doesn't fit above

Rules:
- You MUST include a category for every candidate — pick the best match from the taxonomy above
- Only extract genuinely meaningful personal information
- Skip trivial conversational filler ("said hi", "asked how I am")
- Each value_text should be a concise, standalone statement
- Include the handle of who the fact is about
- If speaker attribution is ambiguous, set confidence below 0.5
- Do NOT convert quoted third-party speech into first-party memory
- Do NOT store facts about others in someone's personal memory space
- Preserve uncertainty qualifiers ("might", "thinking about")
- For temporary plans, set durability to "temporary"
- For emotional context, set durability to "temporary" and confidence conservatively
- For corrections ("no, I said Melbourne not Sydney"), set durability to "corrected"
- If no meaningful facts were shared, return {"candidates": []}
- Be conservative: prefer missing a memory over writing a wrong one`;

export async function extractCandidateMemories(
  messages: UnsummarisedMessage[],
): Promise<CandidateMemory[]> {
  if (messages.length === 0) return [];

  const conversationText = messages
    .map((m) => {
      const sender = m.role === 'assistant' ? 'Nest' : (m.handle || 'User');
      return `[${sender}]: ${m.content}`;
    })
    .join('\n');

  const messageIds = messages.map((m) => m.id);

  try {
    const response = await client.responses.create({
      model: MODEL_MAP.orchestration,
      instructions: EXTRACTION_PROMPT,
      input: conversationText,
      max_output_tokens: 1024,
      store: false,
      reasoning: { effort: REASONING_EFFORT.orchestration },
    } as Parameters<typeof client.responses.create>[0]);

    const text = response.output_text;
    if (!text) return [];

    let rawText = text.trim();
    const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      rawText = fenceMatch[1].trim();
    }

    const parsed = JSON.parse(rawText);
    const rawCandidates = parsed?.candidates;
    if (!Array.isArray(rawCandidates)) return [];

    return rawCandidates
      .filter((c: Record<string, unknown>) =>
        typeof c.handle === 'string' &&
        typeof c.value_text === 'string' &&
        VALID_MEMORY_TYPES.has(c.memory_type as string),
      )
      .map((c: Record<string, unknown>) => ({
        handle: c.handle as string,
        memoryType: c.memory_type as MemoryType,
        category: normaliseCategory((c.category as string) || 'general'),
        valueText: c.value_text as string,
        normalizedValue: null,
        confidence: typeof c.confidence === 'number' ? Math.min(1, Math.max(0, c.confidence)) : 0.5,
        durability: (['durable', 'temporary', 'uncertain', 'corrected'].includes(c.durability as string)
          ? c.durability
          : 'durable') as CandidateMemory['durability'],
        sourceMessageIds: messageIds,
        sourceKind: 'background_extraction' as SourceKind,
      }));
  } catch (error) {
    console.error('[memory] Extraction error:', error);
    return [];
  }
}

// ============================================================================
// Step B: Deterministic Normalisation
// ============================================================================

export function normaliseCandidate(candidate: CandidateMemory): CandidateMemory | null {
  const value = candidate.valueText.trim();

  if (value.length === 0) return null;

  const isIdentity = candidate.memoryType === 'identity';

  if (!isIdentity) {
    if (value.length < 5) return null;
    if (value.split(/\s+/).length < 2) return null;
  }

  const trivialPatterns = [
    /^(said|says|asked|mentioned|told|replied)\s+(hi|hello|hey|ok|okay|yes|no|sure|thanks|bye)/i,
    /^(greeted|acknowledged)/i,
    /^(is|was) (here|there|online|offline)$/i,
  ];
  for (const pattern of trivialPatterns) {
    if (pattern.test(value)) return null;
  }

  const normalized = isIdentity
    ? value.replace(/\s+/g, ' ').trim()
    : value
        .replace(/\s+/g, ' ')
        .replace(/^(they|the user|user|this person)\s+(is|are|was|were|has|have|had)\s+/i, '')
        .trim();

  if (normalized.length === 0) return null;

  return {
    ...candidate,
    valueText: value,
    normalizedValue: normalized.toLowerCase(),
  };
}

// ============================================================================
// Step C: Deterministic Filters
// ============================================================================

export type FilterResult = 'pass' | 'reject' | 'needs_adjudication';

export function filterCandidate(
  candidate: CandidateMemory,
  existingMemories: MemoryItem[],
): FilterResult {
  if (candidate.confidence < 0.3) return 'reject';

  if (candidate.memoryType === 'emotional_context' && candidate.confidence < 0.6) return 'reject';

  if (!candidate.normalizedValue) return 'reject';

  const exactMatch = existingMemories.find(
    (m) => m.normalizedValue === candidate.normalizedValue && m.status === 'active',
  );
  if (exactMatch) return 'reject';

  const sameTypeMemories = existingMemories.filter(
    (m) => m.memoryType === candidate.memoryType && m.status === 'active',
  );

  if (SINGULAR_CATEGORIES.has(candidate.category)) {
    const sameCategoryExists = sameTypeMemories.some(
      (m) => m.category === candidate.category,
    );
    if (sameCategoryExists) return 'needs_adjudication';
  }

  for (const existing of sameTypeMemories) {
    if (!existing.normalizedValue || !candidate.normalizedValue) continue;

    if (existing.category !== 'general' && existing.category === candidate.category) {
      return 'needs_adjudication';
    }

    const similarity = computeStringSimilarity(
      existing.normalizedValue,
      candidate.normalizedValue,
    );

    if (similarity > 0.5) return 'needs_adjudication';
  }

  if (candidate.durability === 'corrected') return 'needs_adjudication';

  return 'pass';
}

function computeStringSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

// ============================================================================
// Step D: LLM Adjudication (ambiguous cases only)
// ============================================================================

export async function adjudicateCandidate(
  candidate: CandidateMemory,
  existingMemories: MemoryItem[],
): Promise<AdjudicationAction> {
  const relevantExisting = existingMemories
    .filter((m) => m.status === 'active')
    .slice(0, 10);

  const existingList = relevantExisting
    .map((m, i) => `${i + 1}. [id=${m.id}] (${m.memoryType}, category=${m.category}) "${m.valueText}"`)
    .join('\n');

  const isSingular = SINGULAR_CATEGORIES.has(candidate.category);
  const sameCategoryExisting = relevantExisting.filter((m) => m.category === candidate.category);

  let singularHint = '';
  if (isSingular && sameCategoryExisting.length > 0) {
    const ids = sameCategoryExisting.map((m) => m.id).join(', ');
    singularHint = `\n\nIMPORTANT: "${candidate.category}" is a SINGULAR category — a person can only have one active value. The new candidate and existing memory id(s) ${ids} share this category. Unless the new candidate is clearly wrong, you should SUPERSEDE the old one.`;
  }

  const prompt = `You are a memory adjudication system. Given existing memories and a new candidate, decide what to do.

Existing memories for this person:
${existingList || '(none)'}

New candidate: (${candidate.memoryType}, category=${candidate.category}) "${candidate.valueText}" confidence=${candidate.confidence}${singularHint}

Category types:
- SINGULAR categories (location, employment, education, age, birthday, relationship_status, nationality, native_language): Only ONE value should be active at a time. If the new candidate shares a singular category with an existing memory, it almost certainly SUPERSEDES it.
- MULTI categories (sport_team, music, food, pet, hobby, interest, skill, travel, health, preference, language, general): Multiple values can coexist.

Reply with EXACTLY one of:
- ADD_NEW — this is genuinely new information
- CONFIRM_EXISTING:<id> — this confirms an existing memory (use the id number)
- SUPERSEDE_EXISTING:<id> — this updates/replaces an existing memory (use the id number)
- MARK_UNCERTAIN — this might be true but evidence is weak
- REJECT — this is a duplicate, trivial, or should not be stored`;

  try {
    const response = await client.responses.create({
      model: MODEL_MAP.orchestration,
      instructions: 'You are a memory adjudication system. Respond with exactly one action line.',
      input: prompt,
      max_output_tokens: 256,
      store: false,
      reasoning: { effort: REASONING_EFFORT.orchestration },
    } as Parameters<typeof client.responses.create>[0]);

    const text = response.output_text;
    if (!text) {
      return isSingular && sameCategoryExisting.length > 0
        ? { type: 'SUPERSEDE_EXISTING', existingId: sameCategoryExisting[0].id }
        : { type: 'REJECT' };
    }

    const answer = text.trim().toUpperCase();

    if (answer.startsWith('ADD_NEW')) return { type: 'ADD_NEW' };
    if (answer.startsWith('MARK_UNCERTAIN')) return { type: 'MARK_UNCERTAIN' };
    if (answer.startsWith('REJECT')) return { type: 'REJECT' };

    const confirmMatch = answer.match(/CONFIRM_EXISTING[:\s]*(\d+)/);
    if (confirmMatch) {
      const existingId = parseInt(confirmMatch[1], 10);
      const found = relevantExisting.find((m) => m.id === existingId);
      if (found) return { type: 'CONFIRM_EXISTING', existingId };
    }

    const supersedeMatch = answer.match(/SUPERSEDE_EXISTING[:\s]*(\d+)/);
    if (supersedeMatch) {
      const existingId = parseInt(supersedeMatch[1], 10);
      const found = relevantExisting.find((m) => m.id === existingId);
      if (found) return { type: 'SUPERSEDE_EXISTING', existingId };
    }

    if (isSingular && sameCategoryExisting.length > 0) {
      return { type: 'SUPERSEDE_EXISTING', existingId: sameCategoryExisting[0].id };
    }

    return { type: 'REJECT' };
  } catch (error) {
    console.error('[memory] Adjudication error:', error);
    if (isSingular && sameCategoryExisting.length > 0) {
      return { type: 'SUPERSEDE_EXISTING', existingId: sameCategoryExisting[0].id };
    }
    return { type: 'REJECT' };
  }
}

// ============================================================================
// Step E: Memory Write
// ============================================================================

export function calculateExpiry(memoryType: MemoryType, _confidence: number): string | null {
  const now = new Date();
  switch (memoryType) {
    case 'plan':
      return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    case 'task_commitment':
      return new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
    case 'emotional_context':
      return new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
    case 'contextual_note':
      return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    default:
      return null;
  }
}

export async function writeMemoryItem(
  candidate: CandidateMemory,
  action: AdjudicationAction,
  sourceSummaryId?: number | null,
): Promise<number | null> {
  switch (action.type) {
    case 'REJECT':
      return null;

    case 'CONFIRM_EXISTING':
      await confirmMemoryItem(action.existingId);
      return action.existingId;

    case 'MARK_UNCERTAIN': {
      return insertMemoryItem({
        handle: candidate.handle,
        memoryType: candidate.memoryType,
        category: candidate.category,
        valueText: candidate.valueText,
        normalizedValue: candidate.normalizedValue,
        confidence: Math.min(candidate.confidence, 0.4),
        status: 'uncertain',
        sourceKind: candidate.sourceKind,
        sourceMessageIds: candidate.sourceMessageIds,
        sourceSummaryId: sourceSummaryId ?? null,
        extractorVersion: EXTRACTOR_VERSION,
        expiryAt: calculateExpiry(candidate.memoryType, candidate.confidence),
      });
    }

    case 'SUPERSEDE_EXISTING': {
      const newId = await insertMemoryItem({
        handle: candidate.handle,
        memoryType: candidate.memoryType,
        category: candidate.category,
        valueText: candidate.valueText,
        normalizedValue: candidate.normalizedValue,
        confidence: candidate.confidence,
        status: 'active',
        sourceKind: candidate.sourceKind,
        sourceMessageIds: candidate.sourceMessageIds,
        sourceSummaryId: sourceSummaryId ?? null,
        extractorVersion: EXTRACTOR_VERSION,
        expiryAt: calculateExpiry(candidate.memoryType, candidate.confidence),
        supersedesMemoryId: action.existingId,
      });

      if (newId) {
        await supersedeMemoryItem(action.existingId, newId);
      }

      return newId;
    }

    case 'ADD_NEW':
    default: {
      return insertMemoryItem({
        handle: candidate.handle,
        memoryType: candidate.memoryType,
        category: candidate.category,
        valueText: candidate.valueText,
        normalizedValue: candidate.normalizedValue,
        confidence: candidate.confidence,
        status: candidate.confidence >= 0.6 ? 'active' : 'uncertain',
        sourceKind: candidate.sourceKind,
        sourceMessageIds: candidate.sourceMessageIds,
        sourceSummaryId: sourceSummaryId ?? null,
        extractorVersion: EXTRACTOR_VERSION,
        expiryAt: calculateExpiry(candidate.memoryType, candidate.confidence),
      });
    }
  }
}

// ============================================================================
// RAG Embedding — index memory items into search_documents/search_embeddings
// ============================================================================

async function embedMemoryItem(
  handle: string,
  memoryId: number,
  memoryType: string,
  category: string,
  valueText: string,
): Promise<void> {
  const supabase = getAdminClient();
  const sourceId = `memory:${memoryId}`;

  try {
    await softDeleteSource(supabase, handle, 'memory_summary', sourceId);

    const header = memoryContextHeader(category, memoryType, handle, new Date().toISOString());
    const chunk: ChunkToEmbed = {
      text: `${header}\n---\n${valueText}`,
      sourceType: 'memory_summary',
      sourceId,
      title: `${category}: ${valueText.slice(0, 80)}`,
      chunkIndex: 0,
      contentHash: contentHash('memory_summary', sourceId, 'summary'),
      metadata: { memory_id: memoryId, category, memory_type: memoryType, handle },
    };

    const embedded = await embedChunks([chunk]);
    const { inserted, errors } = await insertEmbeddedChunks(supabase, handle, embedded);
    if (errors > 0) {
      console.warn(`[memory] embedMemoryItem ${memoryId}: ${inserted} inserted, ${errors} errors`);
    }
  } catch (err) {
    console.warn(`[memory] Failed to embed memory ${memoryId}:`, (err as Error).message);
  }
}

function fireAndForgetEmbed(
  handle: string,
  memoryId: number | null,
  memoryType: string,
  category: string,
  valueText: string,
): void {
  if (!memoryId) return;
  embedMemoryItem(handle, memoryId, memoryType, category, valueText)
    .catch((err) => console.warn('[memory] Background embed failed:', (err as Error).message));
}

// ============================================================================
// Full Pipeline: extract -> normalise -> filter -> adjudicate -> write
// ============================================================================

export interface ExtractionResult {
  candidatesExtracted: number;
  memoriesWritten: number;
  memoriesRejected: number;
  memoriesConfirmed: number;
}

export async function processMemoryExtraction(
  messages: UnsummarisedMessage[],
  sourceSummaryId?: number | null,
): Promise<ExtractionResult> {
  const result: ExtractionResult = {
    candidatesExtracted: 0,
    memoriesWritten: 0,
    memoriesRejected: 0,
    memoriesConfirmed: 0,
  };

  const candidates = await extractCandidateMemories(messages);
  result.candidatesExtracted = candidates.length;
  increment(METRICS.CANDIDATES_EXTRACTED, candidates.length);

  if (candidates.length === 0) return result;

  const handleSet = new Set(candidates.map((c) => c.handle));
  const existingByHandle = new Map<string, MemoryItem[]>();
  for (const handle of handleSet) {
    existingByHandle.set(handle, await getActiveMemoryItems(handle, 30));
  }

  for (const raw of candidates) {
    const candidate = normaliseCandidate(raw);
    if (!candidate) {
      result.memoriesRejected += 1;
      increment(METRICS.CANDIDATES_REJECTED_FILTER);
      continue;
    }
    increment(METRICS.CANDIDATES_NORMALISED);

    const existing = existingByHandle.get(candidate.handle) ?? [];
    const filterResult = filterCandidate(candidate, existing);

    if (filterResult === 'reject') {
      result.memoriesRejected += 1;
      increment(METRICS.CANDIDATES_REJECTED_FILTER);
      continue;
    }

    let action: AdjudicationAction;
    if (filterResult === 'needs_adjudication') {
      increment(METRICS.CANDIDATES_ADJUDICATED);
      action = await adjudicateCandidate(candidate, existing);
    } else {
      action = { type: 'ADD_NEW' };
    }

    const memoryId = await writeMemoryItem(candidate, action, sourceSummaryId);

    if (action.type === 'REJECT' || memoryId === null) {
      result.memoriesRejected += 1;
      increment(METRICS.MEMORIES_REJECTED);
    } else if (action.type === 'CONFIRM_EXISTING') {
      result.memoriesConfirmed += 1;
      increment(METRICS.MEMORIES_CONFIRMED);
    } else if (action.type === 'SUPERSEDE_EXISTING') {
      result.memoriesWritten += 1;
      increment(METRICS.MEMORIES_SUPERSEDED);
      fireAndForgetEmbed(candidate.handle, memoryId, candidate.memoryType, candidate.category, candidate.valueText);
      const updatedMemories = await getActiveMemoryItems(candidate.handle, 30);
      existingByHandle.set(candidate.handle, updatedMemories);
    } else {
      result.memoriesWritten += 1;
      increment(METRICS.MEMORIES_WRITTEN);
      fireAndForgetEmbed(candidate.handle, memoryId, candidate.memoryType, candidate.category, candidate.valueText);
      const updatedMemories = await getActiveMemoryItems(candidate.handle, 30);
      existingByHandle.set(candidate.handle, updatedMemories);
    }
  }

  return result;
}

// ============================================================================
// Real-time tool call pipeline (for remember_user in chat)
// ============================================================================

async function writeRealtimeCandidate(
  candidate: CandidateMemory,
  existing: MemoryItem[],
): Promise<number | null> {
  const normalised = normaliseCandidate(candidate);
  if (!normalised) return null;

  if (existing.length < 2) {
    return writeMemoryItem(normalised, { type: 'ADD_NEW' });
  }

  const filterResult = filterCandidate(normalised, existing);
  if (filterResult === 'reject') return null;

  let action: AdjudicationAction;
  if (filterResult === 'needs_adjudication') {
    action = await adjudicateCandidate(normalised, existing);
  } else {
    action = { type: 'ADD_NEW' };
  }

  const memoryId = await writeMemoryItem(normalised, action);
  return action.type === 'REJECT' ? null : memoryId;
}

export async function processRealtimeMemory(
  handle: string,
  fact: string,
  name?: string,
  _chatId?: string,
  category?: string,
): Promise<{ written: boolean; memoryId: number | null }> {
  const existing = await getActiveMemoryItems(handle, 30);
  let anyWritten = false;
  let lastMemoryId: number | null = null;

  if (name) {
    const nameCandidate: CandidateMemory = {
      handle,
      memoryType: 'identity',
      category: 'name',
      valueText: name,
      normalizedValue: null,
      confidence: 0.95,
      durability: 'durable',
      sourceMessageIds: [],
      sourceKind: 'realtime_tool',
    };
    const id = await writeRealtimeCandidate(nameCandidate, existing);
    if (id !== null) {
      anyWritten = true;
      lastMemoryId = id;
      fireAndForgetEmbed(handle, id, 'identity', 'name', name);
    }
  }

  if (fact && fact.trim().length > 0) {
    const factCategory = await resolveCategory(fact, category);
    const factCandidate: CandidateMemory = {
      handle,
      memoryType: 'bio_fact',
      category: factCategory,
      valueText: fact,
      normalizedValue: null,
      confidence: 0.9,
      durability: 'durable',
      sourceMessageIds: [],
      sourceKind: 'realtime_tool',
    };
    const refreshedExisting = anyWritten ? await getActiveMemoryItems(handle, 30) : existing;
    const id = await writeRealtimeCandidate(factCandidate, refreshedExisting);
    if (id !== null) {
      anyWritten = true;
      lastMemoryId = id;
      fireAndForgetEmbed(handle, id, 'bio_fact', factCategory, fact);
    }
  }

  return { written: anyWritten, memoryId: lastMemoryId };
}

// ============================================================================
// Relevance-Scored Retrieval
// ============================================================================

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  location: ['live', 'lives', 'city', 'country', 'where', 'move', 'moved', 'home', 'based', 'address', 'from'],
  employment: ['work', 'works', 'job', 'career', 'company', 'employer', 'employed', 'role', 'position', 'occupation'],
  education: ['study', 'school', 'university', 'uni', 'college', 'degree', 'graduated', 'major', 'student'],
  age: ['old', 'age', 'years', 'born', 'young'],
  birthday: ['birthday', 'born', 'birth', 'bday'],
  relationship_status: ['married', 'single', 'dating', 'partner', 'wife', 'husband', 'girlfriend', 'boyfriend', 'engaged', 'relationship'],
  nationality: ['nationality', 'citizen', 'passport', 'country'],
  native_language: ['native', 'mother tongue', 'first language'],
  sport_team: ['team', 'sport', 'sports', 'football', 'soccer', 'basketball', 'cricket', 'afl', 'nba', 'nfl', 'support', 'fan'],
  music: ['music', 'song', 'artist', 'band', 'album', 'listen', 'genre', 'concert'],
  food: ['food', 'eat', 'diet', 'vegetarian', 'vegan', 'cuisine', 'restaurant', 'cook', 'meal', 'favourite food', 'allergic'],
  pet: ['pet', 'dog', 'cat', 'animal', 'puppy', 'kitten'],
  hobby: ['hobby', 'hobbies', 'play', 'guitar', 'surf', 'climb', 'paint', 'game', 'gaming'],
  interest: ['interest', 'interested', 'into', 'passionate', 'curious'],
  skill: ['skill', 'good at', 'fluent', 'proficient', 'expert', 'know how'],
  travel: ['travel', 'trip', 'vacation', 'holiday', 'flight', 'visit', 'going to'],
  health: ['health', 'allergy', 'allergic', 'medical', 'fitness', 'gym', 'run', 'exercise', 'condition'],
  preference: ['prefer', 'favourite', 'favorite', 'like', 'hate', 'love'],
  language: ['speak', 'speaks', 'language', 'fluent', 'bilingual'],
};

const FAST_DECAY_TYPES = new Set<string>(['plan', 'task_commitment', 'emotional_context', 'contextual_note']);

export function scoreMemory(memory: MemoryItem, currentMessage: string): number {
  const msgWords = new Set(currentMessage.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const memWords = new Set((memory.normalizedValue || memory.valueText).toLowerCase().split(/\s+/).filter((w) => w.length > 2));

  const intersection = [...msgWords].filter((w) => memWords.has(w)).length;
  const union = new Set([...msgWords, ...memWords]).size;
  const lexicalOverlap = union === 0 ? 0 : (intersection / union) * 0.3;

  let categoryBoost = 0;
  const keywords = CATEGORY_KEYWORDS[memory.category];
  if (keywords) {
    const msgLower = currentMessage.toLowerCase();
    const hits = keywords.filter((kw) => msgLower.includes(kw)).length;
    categoryBoost = Math.min(hits * 0.07, 0.2);
  }

  const confidenceWeight = memory.confidence * 0.2;

  let freshnessWeight = 0.2;
  if (memory.lastConfirmedAt) {
    const ageMs = Date.now() - new Date(memory.lastConfirmedAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const halfLife = FAST_DECAY_TYPES.has(memory.memoryType) ? 3 : 30;
    freshnessWeight = 0.2 * Math.exp(-0.693 * ageDays / halfLife);
  }

  let typeWeight = 0.05;
  if (memory.memoryType === 'identity' || memory.memoryType === 'preference') typeWeight = 0.1;
  if (memory.status === 'uncertain') typeWeight = 0;

  return lexicalOverlap + categoryBoost + confidenceWeight + freshnessWeight + typeWeight;
}

export async function getRelevantMemoryItems(
  handle: string,
  currentMessage: string,
  limit = 20,
): Promise<MemoryItem[]> {
  const all = await getActiveMemoryItems(handle, 50);
  if (all.length === 0) return [];

  const scored = all.map((m) => ({ memory: m, score: scoreMemory(m, currentMessage) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.memory);
}

export function scoreSummary(summary: ConversationSummary, currentMessage: string): number {
  const msgWords = new Set(currentMessage.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const topicWords = new Set(summary.topics.flatMap((t) => t.toLowerCase().split(/\s+/)));
  const summaryWords = new Set(summary.summary.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const allSummaryWords = new Set([...topicWords, ...summaryWords]);

  const intersection = [...msgWords].filter((w) => allSummaryWords.has(w)).length;
  const union = new Set([...msgWords, ...allSummaryWords]).size;
  const overlap = union === 0 ? 0 : (intersection / union) * 0.5;

  let freshness = 0.3;
  if (summary.lastMessageAt) {
    const ageMs = Date.now() - new Date(summary.lastMessageAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    freshness = 0.3 * Math.exp(-0.693 * ageDays / 7);
  }

  const confidenceBoost = summary.confidence * 0.2;

  return overlap + freshness + confidenceBoost;
}

export function getRelevantSummaries(
  summaries: ConversationSummary[],
  currentMessage: string,
  limit = 5,
): ConversationSummary[] {
  if (summaries.length === 0) return [];

  const scored = summaries.map((s) => ({ summary: s, score: scoreSummary(s, currentMessage) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.summary);
}

export function scoreToolTrace(trace: ToolTrace, currentMessage: string): number {
  const msgLower = currentMessage.toLowerCase();
  let relevance = 0;

  if (trace.safeSummary && trace.safeSummary.length > 0) {
    const traceWords = new Set(trace.safeSummary.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    const msgWords = new Set(msgLower.split(/\s+/).filter((w) => w.length > 2));
    const intersection = [...msgWords].filter((w) => traceWords.has(w)).length;
    relevance = Math.min(intersection * 0.15, 0.4);
  }

  let freshness = 0.4;
  if (trace.createdAt) {
    const ageMs = Date.now() - new Date(trace.createdAt).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    freshness = 0.4 * Math.exp(-0.693 * ageHours / 6);
  }

  return relevance + freshness + 0.1;
}

export function getRelevantToolTraces(
  traces: ToolTrace[],
  currentMessage: string,
  limit = 5,
): ToolTrace[] {
  if (traces.length === 0) return [];

  const scored = traces.map((t) => ({ trace: t, score: scoreToolTrace(t, currentMessage) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.trace);
}
