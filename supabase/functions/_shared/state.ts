import { CONVERSATION_MESSAGES_TABLE, CONVERSATIONS_TABLE, JOB_FAILURES_TABLE, OUTBOUND_MESSAGES_TABLE, USER_PROFILES_TABLE, WEBHOOK_EVENTS_TABLE, MEMORY_ITEMS_TABLE, CONVERSATION_SUMMARIES_TABLE, TOOL_TRACES_TABLE } from './env.ts';
import { getAdminClient } from './supabase.ts';
import type { MessageService, NormalisedIncomingMessage, SendblueWebhookEvent } from './sendblue.ts';

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  handle?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Memory System v2 Types
// ============================================================================

export type MemoryType =
  | 'identity'
  | 'preference'
  | 'plan'
  | 'task_commitment'
  | 'relationship'
  | 'emotional_context'
  | 'bio_fact'
  | 'contextual_note';

export type MemoryStatus =
  | 'active'
  | 'uncertain'
  | 'stale'
  | 'expired'
  | 'superseded'
  | 'rejected';

export type SourceKind =
  | 'realtime_tool'
  | 'background_extraction'
  | 'legacy_migration';

export interface MemoryItem {
  id: number;
  handle: string;
  chatId: string | null;
  memoryType: MemoryType;
  category: string;
  valueText: string;
  normalizedValue: string | null;
  confidence: number;
  status: MemoryStatus;
  scope: string;
  sourceKind: SourceKind;
  firstSeenAt: string;
  lastSeenAt: string;
  lastConfirmedAt: string | null;
  expiryAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ConversationSummary {
  id: number;
  chatId: string;
  senderHandle: string | null;
  summary: string;
  topics: string[];
  openLoops: string[];
  summaryKind: string;
  firstMessageAt: string;
  lastMessageAt: string;
  messageCount: number;
  confidence: number;
  createdAt: string;
}

export interface ToolTrace {
  id: number;
  chatId: string;
  toolName: string;
  outcome: string;
  safeSummary: string | null;
  createdAt: string;
}

export interface IdleConversation {
  chatId: string;
  messageCount: number;
  firstMessageAt: string;
  lastMessageAt: string;
  sinceTs: string;
}

export interface UnsummarisedMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  handle: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface UserProfile {
  handle: string;
  name: string | null;
  facts: string[];
  firstSeen: number;
  lastSeen: number;
}

export interface WebhookEventRow {
  id: number;
  provider: string;
  provider_message_id: string;
  chat_id: string;
  sender_handle: string;
  bot_number: string;
  status: string;
  raw_payload: Record<string, unknown>;
  normalized_payload: NormalisedIncomingMessage;
  last_error: string | null;
}

interface RpcWebhookEventResult {
  event_id: number;
  created: boolean;
}

interface ConversationWindowRow {
  role: 'user' | 'assistant';
  content: string;
  handle: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface UserProfileRow {
  handle: string;
  name: string | null;
  facts: unknown;
  first_seen: number;
  last_seen: number;
}

function sanitiseFacts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export async function enqueueWebhookEvent(rawPayload: Record<string, unknown>, message: NormalisedIncomingMessage): Promise<{ eventId: number; created: boolean }> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('enqueue_webhook_event', {
    p_provider: 'sendblue',
    p_provider_message_id: message.messageId,
    p_chat_id: message.chatId,
    p_sender_handle: message.from,
    p_bot_number: message.conversation.fromNumber,
    p_raw_payload: rawPayload,
    p_normalized_payload: message,
  });

  if (error) {
    throw error;
  }

  const result = (data as RpcWebhookEventResult[] | null)?.[0];
  if (!result) {
    throw new Error('enqueue_webhook_event returned no data');
  }

  return { eventId: result.event_id, created: result.created };
}

export async function getWebhookEvent(eventId: number): Promise<WebhookEventRow | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from(WEBHOOK_EVENTS_TABLE)
    .select('id, provider, provider_message_id, chat_id, sender_handle, bot_number, status, raw_payload, normalized_payload, last_error')
    .eq('id', eventId)
    .maybeSingle<WebhookEventRow>();

  if (error) {
    throw error;
  }

  return data;
}

export async function markWebhookEventStatus(eventId: number, status: string, lastError?: string | null): Promise<void> {
  const supabase = getAdminClient();
  const patch: Record<string, unknown> = {
    status,
    last_error: lastError ?? null,
  };

  if (status === 'processing') {
    patch.processing_started_at = new Date().toISOString();
  }

  if (status === 'completed' || status === 'failed') {
    patch.processed_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from(WEBHOOK_EVENTS_TABLE)
    .update(patch)
    .eq('id', eventId);

  if (error) {
    throw error;
  }
}

export async function recordJobFailure(queueName: string, queueMessageId: number, webhookEventId: number | null, attemptNumber: number, errorMessage: string, payload: Record<string, unknown>): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase
    .from(JOB_FAILURES_TABLE)
    .insert({
      queue_name: queueName,
      queue_message_id: queueMessageId,
      webhook_event_id: webhookEventId,
      attempt_number: attemptNumber,
      error: errorMessage,
      payload,
    });

  if (error) {
    console.error('[state] Failed to record job failure:', error);
  }
}

export async function logOutboundMessage(chatId: string, kind: string, payload: Record<string, unknown>, status = 'pending', providerMessageId?: string | null, errorText?: string | null): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase
    .from(OUTBOUND_MESSAGES_TABLE)
    .insert({
      chat_id: chatId,
      kind,
      payload,
      status,
      provider_message_id: providerMessageId ?? null,
      error: errorText ?? null,
      sent_at: status === 'sent' ? new Date().toISOString() : null,
    });

  if (error) {
    console.error('[state] Failed to log outbound message:', error);
  }
}

function getOutboundChatId(event: SendblueWebhookEvent): string {
  const groupId = event.group_id?.trim();
  if (groupId) {
    return `GROUP#${groupId}`;
  }

  const botNumber = event.sendblue_number?.trim() || event.from_number?.trim() || '';
  const recipient = event.number?.trim() || event.to_number?.trim() || '';

  if (botNumber && recipient) {
    return `DM#${botNumber}#${recipient}`;
  }

  return `OUTBOUND#${event.message_handle?.trim() || 'unknown'}`;
}

function extractWebhookError(event: SendblueWebhookEvent): string | null {
  const parts = [event.error_message, event.error_reason, event.error_detail]
    .map((value) => value?.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  return parts.join(' | ');
}

export async function recordOutboundStatusWebhook(event: SendblueWebhookEvent): Promise<void> {
  const messageId = event.message_handle?.trim();
  if (!messageId) {
    throw new Error('Outbound webhook missing message_handle');
  }

  const chatId = getOutboundChatId(event);
  const errorText = extractWebhookError(event);
  const supabase = getAdminClient();

  const { error: statusEventError } = await supabase
    .from('sendblue_status_events')
    .insert({
      provider_message_id: messageId,
      chat_id: chatId,
      direction: 'outbound',
      status: event.status || 'UNKNOWN',
      raw_payload: event,
      error: errorText,
    });

  if (statusEventError) {
    throw statusEventError;
  }

  const { data: existing, error: existingError } = await supabase
    .from(OUTBOUND_MESSAGES_TABLE)
    .select('id, kind, payload')
    .eq('provider_message_id', messageId)
    .maybeSingle<{ id: number; kind: string; payload: Record<string, unknown> | null }>();

  if (existingError) {
    throw existingError;
  }

  const payload = existing?.payload && typeof existing.payload === 'object'
    ? {
        ...existing.payload,
        status_webhook: event,
      }
    : { status_webhook: event };

  if (existing) {
    const { error } = await supabase
      .from(OUTBOUND_MESSAGES_TABLE)
      .update({
        chat_id: chatId,
        payload,
        status: event.status || 'UNKNOWN',
        error: errorText,
        sent_at: new Date(event.date_updated || event.date_sent || new Date().toISOString()).toISOString(),
      })
      .eq('id', existing.id);

    if (error) {
      throw error;
    }

    return;
  }

  const { error } = await supabase
    .from(OUTBOUND_MESSAGES_TABLE)
    .insert({
      chat_id: chatId,
      kind: 'status_update',
      payload,
      provider_message_id: messageId,
      status: event.status || 'UNKNOWN',
      error: errorText,
      sent_at: new Date(event.date_updated || event.date_sent || new Date().toISOString()).toISOString(),
    });

  if (error) {
    throw error;
  }
}

export async function getConversation(chatId: string, limit = 20): Promise<StoredMessage[]> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('get_conversation_window', {
    p_chat_id: chatId,
    p_limit: limit,
  });

  if (error) {
    console.error('[state] Error getting conversation window:', error);
    return [];
  }

  return ((data as ConversationWindowRow[] | null) || []).map((row) => ({
    role: row.role,
    content: row.content,
    ...(row.handle ? { handle: row.handle } : {}),
    createdAt: row.created_at,
    ...(row.metadata && Object.keys(row.metadata).length > 0 ? { metadata: row.metadata } : {}),
  }));
}

export async function addMessage(
  chatId: string,
  role: 'user' | 'assistant',
  content: string,
  handle?: string,
  context?: {
    isGroupChat?: boolean;
    chatName?: string | null;
    participantNames?: string[];
    service?: MessageService;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase.rpc('append_conversation_message', {
    p_chat_id: chatId,
    p_role: role,
    p_content: content,
    p_handle: handle ?? null,
    p_metadata: context?.metadata ?? {},
    p_is_group_chat: context?.isGroupChat ?? false,
    p_chat_name: context?.chatName ?? null,
    p_participant_names: context?.participantNames ?? [],
    p_service: context?.service ?? null,
  });

  if (error) {
    console.error('[state] Error appending conversation message:', error);
  }
}

export async function clearConversation(chatId: string): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase.rpc('clear_conversation_history', {
    p_chat_id: chatId,
  });

  if (error) {
    console.error('[state] Error clearing conversation:', error);
  }
}

export async function getUserProfile(handle: string): Promise<UserProfile | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from(USER_PROFILES_TABLE)
    .select('handle, name, facts, first_seen, last_seen')
    .eq('handle', handle)
    .maybeSingle<UserProfileRow>();

  if (error) {
    console.error('[state] Error getting user profile:', error);
    return null;
  }

  if (!data) {
    return null;
  }

  return {
    handle: data.handle,
    name: data.name,
    facts: sanitiseFacts(data.facts),
    firstSeen: data.first_seen,
    lastSeen: data.last_seen,
  };
}

export async function addUserFact(handle: string, fact: string): Promise<boolean> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('add_user_fact_atomic', {
    p_handle: handle,
    p_fact: fact,
  });

  if (error) {
    console.error('[state] Error adding user fact:', error);
    return false;
  }

  return Boolean(data);
}

export async function setUserName(handle: string, name: string): Promise<boolean> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('set_user_name_atomic', {
    p_handle: handle,
    p_name: name,
  });

  if (error) {
    console.error('[state] Error setting user name:', error);
    return false;
  }

  return Boolean(data);
}

export async function clearUserProfile(handle: string): Promise<boolean> {
  const supabase = getAdminClient();
  const { error } = await supabase
    .from(USER_PROFILES_TABLE)
    .delete()
    .eq('handle', handle);

  if (error) {
    console.error('[state] Error clearing user profile:', error);
    return false;
  }

  return true;
}

export async function verifyTables(): Promise<void> {
  const supabase = getAdminClient();
  for (const table of [CONVERSATIONS_TABLE, CONVERSATION_MESSAGES_TABLE, USER_PROFILES_TABLE, WEBHOOK_EVENTS_TABLE, MEMORY_ITEMS_TABLE, CONVERSATION_SUMMARIES_TABLE, TOOL_TRACES_TABLE]) {
    const { error } = await supabase.from(table).select('*', { head: true, count: 'exact' }).limit(1);
    if (error) {
      console.warn(`[state] Table "${table}" is not ready: ${error.message}`);
    }
  }
}

// ============================================================================
// Memory Items — structured memory with provenance
// ============================================================================

interface MemoryItemRow {
  id: number;
  handle: string;
  chat_id: string | null;
  memory_type: string;
  category: string;
  value_text: string;
  normalized_value: string | null;
  confidence: number;
  status: string;
  scope: string;
  source_kind: string;
  first_seen_at: string;
  last_seen_at: string;
  last_confirmed_at: string | null;
  expiry_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

function rowToMemoryItem(row: MemoryItemRow): MemoryItem {
  return {
    id: row.id,
    handle: row.handle,
    chatId: row.chat_id,
    memoryType: row.memory_type as MemoryType,
    category: row.category,
    valueText: row.value_text,
    normalizedValue: row.normalized_value,
    confidence: row.confidence,
    status: row.status as MemoryStatus,
    scope: row.scope,
    sourceKind: row.source_kind as SourceKind,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastConfirmedAt: row.last_confirmed_at,
    expiryAt: row.expiry_at,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

export async function insertMemoryItem(params: {
  handle: string;
  chatId?: string | null;
  memoryType: MemoryType;
  category: string;
  valueText: string;
  normalizedValue: string | null;
  confidence: number;
  status: MemoryStatus;
  scope?: string;
  sourceKind: SourceKind;
  sourceMessageIds?: number[];
  sourceSummaryId?: number | null;
  extractorVersion?: string | null;
  expiryAt?: string | null;
  supersedesMemoryId?: number | null;
  metadata?: Record<string, unknown>;
}): Promise<number | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('insert_memory_item', {
    p_handle: params.handle,
    p_chat_id: params.chatId ?? null,
    p_memory_type: params.memoryType,
    p_category: params.category,
    p_value_text: params.valueText,
    p_normalized_value: params.normalizedValue,
    p_confidence: params.confidence,
    p_status: params.status,
    p_scope: params.scope ?? 'user',
    p_source_kind: params.sourceKind,
    p_source_message_ids: JSON.stringify(params.sourceMessageIds ?? []),
    p_source_summary_id: params.sourceSummaryId ?? null,
    p_extractor_version: params.extractorVersion ?? null,
    p_expiry_at: params.expiryAt ?? null,
    p_supersedes_memory_id: params.supersedesMemoryId ?? null,
    p_metadata: params.metadata ?? {},
  });

  if (error) {
    console.error('[state] Error inserting memory item:', error);
    return null;
  }

  return data as number;
}

export async function supersedeMemoryItem(oldId: number, newId: number): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase.rpc('supersede_memory_item', {
    p_old_id: oldId,
    p_new_id: newId,
  });

  if (error) {
    console.error('[state] Error superseding memory item:', error);
  }
}

export async function markMemoryItemStatus(id: number, status: MemoryStatus): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase.rpc('mark_memory_item_status', {
    p_id: id,
    p_status: status,
  });

  if (error) {
    console.error('[state] Error marking memory item status:', error);
  }
}

export async function confirmMemoryItem(id: number): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase.rpc('confirm_memory_item', { p_id: id });

  if (error) {
    console.error('[state] Error confirming memory item:', error);
  }
}

export async function getActiveMemoryItems(handle: string, limit = 30): Promise<MemoryItem[]> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('get_active_memory_items', {
    p_handle: handle,
    p_limit: limit,
  });

  if (error) {
    console.error('[state] Error getting active memory items:', error);
    return [];
  }

  return ((data as MemoryItemRow[] | null) || []).map(rowToMemoryItem);
}

export async function rejectMemoryItem(id: number, handle: string): Promise<boolean> {
  const supabase = getAdminClient();
  const { data: existing, error: fetchError } = await supabase
    .from(MEMORY_ITEMS_TABLE)
    .select('id')
    .eq('id', id)
    .eq('handle', handle)
    .maybeSingle<{ id: number }>();

  if (fetchError || !existing) {
    console.error('[state] Memory item not found or handle mismatch:', fetchError);
    return false;
  }

  const { error } = await supabase.rpc('mark_memory_item_status', {
    p_id: id,
    p_status: 'rejected',
  });

  if (error) {
    console.error('[state] Error rejecting memory item:', error);
    return false;
  }

  return true;
}

export async function rejectAllMemoryItems(handle: string): Promise<number> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from(MEMORY_ITEMS_TABLE)
    .update({ status: 'rejected' })
    .eq('handle', handle)
    .in('status', ['active', 'uncertain'])
    .select('id');

  if (error) {
    console.error('[state] Error rejecting all memory items:', error);
    return 0;
  }

  return data?.length ?? 0;
}

// ============================================================================
// Conversation Summaries
// ============================================================================

interface ConversationSummaryRow {
  id: number;
  chat_id: string;
  sender_handle: string | null;
  summary: string;
  topics: string[];
  open_loops: string[];
  summary_kind: string;
  first_message_at: string;
  last_message_at: string;
  message_count: number;
  confidence: number;
  created_at: string;
}

function rowToSummary(row: ConversationSummaryRow): ConversationSummary {
  return {
    id: row.id,
    chatId: row.chat_id,
    senderHandle: row.sender_handle,
    summary: row.summary,
    topics: row.topics ?? [],
    openLoops: row.open_loops ?? [],
    summaryKind: row.summary_kind,
    firstMessageAt: row.first_message_at,
    lastMessageAt: row.last_message_at,
    messageCount: row.message_count,
    confidence: row.confidence,
    createdAt: row.created_at,
  };
}

export async function getIdleConversationsNeedingSummary(idleMinutes = 15, limit = 10): Promise<IdleConversation[]> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('get_idle_conversations_needing_summary', {
    p_idle_minutes: idleMinutes,
    p_limit: limit,
  });

  if (error) {
    console.error('[state] Error getting idle conversations:', error);
    return [];
  }

  return ((data as Array<{ chat_id: string; message_count: number; first_message_at: string; last_message_at: string; since_ts: string }> | null) || []).map((row) => ({
    chatId: row.chat_id,
    messageCount: Number(row.message_count),
    firstMessageAt: row.first_message_at,
    lastMessageAt: row.last_message_at,
    sinceTs: row.since_ts,
  }));
}

export async function getUnsummarisedMessages(chatId: string, since?: string): Promise<UnsummarisedMessage[]> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('get_unsummarised_messages', {
    p_chat_id: chatId,
    p_since: since ?? '1970-01-01T00:00:00Z',
  });

  if (error) {
    console.error('[state] Error getting unsummarised messages:', error);
    return [];
  }

  return ((data as Array<{ id: number; role: string; content: string; handle: string | null; metadata: Record<string, unknown> | null; created_at: string }> | null) || []).map((row) => ({
    id: row.id,
    role: row.role as 'user' | 'assistant',
    content: row.content,
    handle: row.handle,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  }));
}

export async function saveConversationSummary(params: {
  chatId: string;
  senderHandle?: string | null;
  summary: string;
  topics: string[];
  openLoops: string[];
  summaryKind?: string;
  firstMessageAt: string;
  lastMessageAt: string;
  messageCount: number;
  confidence?: number;
  sourceMessageIds?: number[];
  extractorVersion?: string | null;
}): Promise<number | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('save_conversation_summary', {
    p_chat_id: params.chatId,
    p_sender_handle: params.senderHandle ?? null,
    p_summary: params.summary,
    p_topics: params.topics,
    p_open_loops: params.openLoops,
    p_summary_kind: params.summaryKind ?? 'segment',
    p_first_message_at: params.firstMessageAt,
    p_last_message_at: params.lastMessageAt,
    p_message_count: params.messageCount,
    p_confidence: params.confidence ?? 0.8,
    p_source_message_ids: JSON.stringify(params.sourceMessageIds ?? []),
    p_extractor_version: params.extractorVersion ?? null,
  });

  if (error) {
    console.error('[state] Error saving conversation summary:', error);
    return null;
  }

  return data as number | null;
}

export async function getConversationSummaries(chatId: string, limit = 5): Promise<ConversationSummary[]> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('get_conversation_summaries', {
    p_chat_id: chatId,
    p_limit: limit,
  });

  if (error) {
    console.error('[state] Error getting conversation summaries:', error);
    return [];
  }

  return ((data as ConversationSummaryRow[] | null) || []).map(rowToSummary);
}

// ============================================================================
// Tool Traces
// ============================================================================

interface ToolTraceRow {
  id: number;
  chat_id: string;
  tool_name: string;
  outcome: string;
  safe_summary: string | null;
  created_at: string;
}

export async function insertToolTrace(params: {
  chatId: string;
  messageId?: number | null;
  toolName: string;
  outcome: string;
  safeSummary?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<number | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('insert_tool_trace', {
    p_chat_id: params.chatId,
    p_message_id: params.messageId ?? null,
    p_tool_name: params.toolName,
    p_outcome: params.outcome,
    p_safe_summary: params.safeSummary ?? null,
    p_metadata: params.metadata ?? {},
  });

  if (error) {
    console.error('[state] Error inserting tool trace:', error);
    return null;
  }

  return data as number;
}

export async function getRecentToolTraces(chatId: string, limit = 5): Promise<ToolTrace[]> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('get_recent_tool_traces', {
    p_chat_id: chatId,
    p_limit: limit,
  });

  if (error) {
    console.error('[state] Error getting tool traces:', error);
    return [];
  }

  return ((data as ToolTraceRow[] | null) || []).map((row) => ({
    id: row.id,
    chatId: row.chat_id,
    toolName: row.tool_name,
    outcome: row.outcome,
    safeSummary: row.safe_summary,
    createdAt: row.created_at,
  }));
}

// ============================================================================
// Onboarding — user lifecycle and verification state
// ============================================================================

export interface NestUser {
  handle: string;
  name: string | null;
  status: string;
  onboardingToken: string;
  onboardMessages: Array<{ role: string; content: string }>;
  onboardCount: number;
  botNumber: string | null;
  pdlProfile: Record<string, unknown> | null;
}

interface EnsureNestUserRow {
  out_handle: string;
  out_name: string | null;
  out_status: string;
  out_onboarding_token: string;
  out_onboard_messages: unknown;
  out_onboard_count: number;
  out_bot_number: string | null;
  out_pdl_profile: Record<string, unknown> | null;
}

function parseOnboardMessages(raw: unknown): Array<{ role: string; content: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is { role: string; content: string } =>
      m && typeof m === 'object' && typeof m.role === 'string' && typeof m.content === 'string',
  );
}

function rowToNestUser(row: EnsureNestUserRow): NestUser {
  return {
    handle: row.out_handle,
    name: row.out_name,
    status: row.out_status,
    onboardingToken: row.out_onboarding_token,
    onboardMessages: parseOnboardMessages(row.out_onboard_messages),
    onboardCount: row.out_onboard_count,
    botNumber: row.out_bot_number,
    pdlProfile: row.out_pdl_profile,
  };
}

export async function ensureNestUser(handle: string, botNumber: string): Promise<NestUser> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('ensure_nest_user', {
    p_handle: handle,
    p_bot_number: botNumber,
  });

  if (error) {
    throw new Error(`ensure_nest_user failed: ${error.message}`);
  }

  const rows = data as EnsureNestUserRow[] | null;
  if (!rows || rows.length === 0) {
    throw new Error('ensure_nest_user returned no data');
  }

  return rowToNestUser(rows[0]);
}

export async function updateOnboardState(
  handle: string,
  messages: Array<{ role: string; content: string }>,
  count: number,
  pdlProfile?: Record<string, unknown> | null,
): Promise<void> {
  const supabase = getAdminClient();
  const patch: Record<string, unknown> = {
    onboard_messages: messages,
    onboard_count: count,
    updated_at: new Date().toISOString(),
  };

  if (pdlProfile !== undefined) {
    patch.pdl_profile = pdlProfile;
  }

  const { error } = await supabase
    .from(USER_PROFILES_TABLE)
    .update(patch)
    .eq('handle', handle);

  if (error) {
    console.error('[state] Error updating onboard state:', error);
  }
}

export async function activateUser(token: string): Promise<string | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('activate_nest_user', {
    p_token: token,
  });

  if (error) {
    console.error('[state] Error activating user:', error);
    return null;
  }

  return (data as string) || null;
}

export async function getUserByToken(token: string): Promise<NestUser | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from(USER_PROFILES_TABLE)
    .select('handle, name, status, onboarding_token, onboard_messages, onboard_count, bot_number, pdl_profile')
    .eq('onboarding_token', token)
    .maybeSingle<EnsureNestUserRow>();

  if (error) {
    console.error('[state] Error getting user by token:', error);
    return null;
  }

  return data ? rowToNestUser(data) : null;
}
