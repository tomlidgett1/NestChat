/**
 * Lightweight telemetry counters for the memory system.
 * Counters are accumulated in-process and flushed to the database periodically.
 * Designed for observability without adding latency to the hot path.
 */

const counters = new Map<string, number>();

export function increment(metric: string, amount = 1): void {
  counters.set(metric, (counters.get(metric) ?? 0) + amount);
}

export function getCounters(): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const [key, value] of counters) {
    snapshot[key] = value;
  }
  return snapshot;
}

export function resetCounters(): void {
  counters.clear();
}

export const METRICS = {
  CANDIDATES_EXTRACTED: 'memory.candidates_extracted',
  CANDIDATES_NORMALISED: 'memory.candidates_normalised',
  CANDIDATES_REJECTED_FILTER: 'memory.candidates_rejected_filter',
  CANDIDATES_ADJUDICATED: 'memory.candidates_adjudicated',
  MEMORIES_WRITTEN: 'memory.memories_written',
  MEMORIES_CONFIRMED: 'memory.memories_confirmed',
  MEMORIES_SUPERSEDED: 'memory.memories_superseded',
  MEMORIES_REJECTED: 'memory.memories_rejected',
  MEMORIES_EXPIRED: 'memory.memories_expired',
  SUMMARIES_CREATED: 'summary.summaries_created',
  SUMMARIES_SKIPPED: 'summary.summaries_skipped',
  TOOL_TRACES_STORED: 'traces.tool_traces_stored',
  EXTRACTION_ERRORS: 'memory.extraction_errors',
  ADJUDICATION_ERRORS: 'memory.adjudication_errors',
  SUMMARY_ERRORS: 'summary.summary_errors',
} as const;
