export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

export function requireAnyEnv(...names: string[]): string {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }

  throw new Error(`${names.join(' or ')} is not configured`);
}

export function getOptionalEnv(name: string): string | undefined {
  const value = Deno.env.get(name);
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

export function getListEnv(name: string): string[] {
  return (Deno.env.get(name) || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export const QUEUE_NAME = getOptionalEnv('INBOUND_QUEUE_NAME') || 'inbound_events';
export const CONVERSATIONS_TABLE = getOptionalEnv('SUPABASE_CONVERSATIONS_TABLE') || 'conversations';
export const USER_PROFILES_TABLE = getOptionalEnv('SUPABASE_USER_PROFILES_TABLE') || 'user_profiles';
export const WEBHOOK_EVENTS_TABLE = getOptionalEnv('WEBHOOK_EVENTS_TABLE') || 'webhook_events';
export const OUTBOUND_MESSAGES_TABLE = getOptionalEnv('OUTBOUND_MESSAGES_TABLE') || 'outbound_messages';
export const JOB_FAILURES_TABLE = getOptionalEnv('JOB_FAILURES_TABLE') || 'job_failures';
export const CONVERSATION_MESSAGES_TABLE = getOptionalEnv('CONVERSATION_MESSAGES_TABLE') || 'conversation_messages';
export const MEMORY_ITEMS_TABLE = getOptionalEnv('MEMORY_ITEMS_TABLE') || 'memory_items';
export const CONVERSATION_SUMMARIES_TABLE = getOptionalEnv('CONVERSATION_SUMMARIES_TABLE') || 'conversation_summaries';
export const TOOL_TRACES_TABLE = getOptionalEnv('TOOL_TRACES_TABLE') || 'tool_traces';

export const ONBOARDING_EVENTS_TABLE = getOptionalEnv('ONBOARDING_EVENTS_TABLE') || 'onboarding_events';
export const PROACTIVE_MESSAGES_TABLE = getOptionalEnv('PROACTIVE_MESSAGES_TABLE') || 'proactive_messages';
export const EXPERIMENT_ASSIGNMENTS_TABLE = getOptionalEnv('EXPERIMENT_ASSIGNMENTS_TABLE') || 'experiment_assignments';

export const SEARCH_DOCUMENTS_TABLE = getOptionalEnv('SEARCH_DOCUMENTS_TABLE') || 'search_documents';
export const SEARCH_EMBEDDINGS_TABLE = getOptionalEnv('SEARCH_EMBEDDINGS_TABLE') || 'search_embeddings';

export const MEMORY_V2_ENABLED = (getOptionalEnv('MEMORY_V2_ENABLED') || 'true') === 'true';
export const EXTRACTOR_VERSION = getOptionalEnv('MEMORY_EXTRACTOR_VERSION') || 'v2.0';
