/**
 * Mirrors relevance scoring in `supabase/functions/_shared/memory.ts`
 * (`scoreMemory` + top-N selection after `getActiveMemoryItems(..., 200)`).
 * If you change the production algorithm, update this file the same way.
 */

export interface MemoryRowForRelevance {
  memory_type: string;
  category: string;
  value_text: string;
  normalized_value: string | null;
  confidence: number;
  last_confirmed_at: string | null;
  status: string;
}

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
const STABLE_MEMORY_TYPES = new Set<string>(['identity', 'preference', 'bio_fact', 'relationship']);

// Core identity categories always included regardless of score
const CORE_IDENTITY_CATEGORIES = new Set([
  'name', 'location', 'employment', 'age', 'birthday', 'nationality',
]);

function isCoreIdentityRow(row: MemoryRowForRelevance): boolean {
  return row.memory_type === 'identity' && CORE_IDENTITY_CATEGORIES.has(row.category);
}

function getHalfLifeDays(memoryType: string): number {
  if (FAST_DECAY_TYPES.has(memoryType)) return 3;
  if (STABLE_MEMORY_TYPES.has(memoryType)) return Infinity;
  return 90;
}

export function scoreMemoryRow(row: MemoryRowForRelevance, currentMessage: string): number {
  const msgWords = new Set(currentMessage.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const memWords = new Set(
    (row.normalized_value || row.value_text).toLowerCase().split(/\s+/).filter((w) => w.length > 2),
  );

  const intersection = [...msgWords].filter((w) => memWords.has(w)).length;
  const union = new Set([...msgWords, ...memWords]).size;
  const lexicalOverlap = union === 0 ? 0 : (intersection / union) * 0.3;

  let categoryBoost = 0;
  const keywords = CATEGORY_KEYWORDS[row.category];
  if (keywords) {
    const msgLower = currentMessage.toLowerCase();
    const hits = keywords.filter((kw) => msgLower.includes(kw)).length;
    categoryBoost = Math.min(hits * 0.07, 0.2);
  }

  const confidenceWeight = row.confidence * 0.2;

  let freshnessWeight = 0.2;
  if (row.last_confirmed_at) {
    const halfLife = getHalfLifeDays(row.memory_type);
    if (halfLife === Infinity) {
      freshnessWeight = 0.2; // no decay for stable types
    } else {
      const ageMs = Date.now() - new Date(row.last_confirmed_at).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      freshnessWeight = 0.2 * Math.exp(-0.693 * ageDays / halfLife);
    }
  }

  let typeWeight = 0.05;
  if (row.memory_type === 'identity' || row.memory_type === 'preference') typeWeight = 0.1;
  if (row.status === 'uncertain') typeWeight = 0;

  return lexicalOverlap + categoryBoost + confidenceWeight + freshnessWeight + typeWeight;
}

/**
 * Mirrors production `getRelevantMemoryItems`: pool 200 from RPC, extract
 * core identity (always included), score rest, keep top `limit`.
 * Note: semantic boost from embeddings is not available in local compare mode.
 */
export function selectRelevantMemoryRows<T extends MemoryRowForRelevance>(
  rows: T[],
  currentMessage: string,
  limit = 20,
): T[] {
  if (rows.length === 0) return [];

  // Phase 1: Always-include core identity
  const core: T[] = [];
  const rest: T[] = [];
  for (const row of rows) {
    if (isCoreIdentityRow(row)) {
      core.push(row);
    } else {
      rest.push(row);
    }
  }

  // Phase 2: Score and rank the rest
  const remaining = limit - core.length;
  if (remaining <= 0) return core.slice(0, limit);

  const scored = rest.map((row) => ({ row, score: scoreMemoryRow(row, currentMessage) }));
  scored.sort((a, b) => b.score - a.score);

  return [...core, ...scored.slice(0, remaining).map((s) => s.row)];
}
