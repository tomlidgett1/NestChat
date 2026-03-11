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
  useLinq: boolean;
  firstSeen: number;
  lastSeen: number;
}

export interface ConnectedAccount {
  provider: 'google' | 'microsoft';
  email: string;
  name: string | null;
  isPrimary: boolean;
  scopes: string[];
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
  use_linq: boolean;
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
    .select('handle, name, facts, use_linq, first_seen, last_seen')
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
    useLinq: data.use_linq ?? false,
    firstSeen: data.first_seen,
    lastSeen: data.last_seen,
  };
}

export async function getConnectedAccounts(authUserId: string): Promise<ConnectedAccount[]> {
  const supabase = getAdminClient();

  const [googleResult, microsoftResult] = await Promise.all([
    supabase
      .from('user_google_accounts')
      .select('google_email, google_name, is_primary, scopes')
      .eq('user_id', authUserId),
    supabase
      .from('user_microsoft_accounts')
      .select('microsoft_email, microsoft_name, is_primary')
      .eq('user_id', authUserId),
  ]);

  const accounts: ConnectedAccount[] = [];

  if (!googleResult.error && googleResult.data) {
    for (const row of googleResult.data) {
      accounts.push({
        provider: 'google',
        email: row.google_email,
        name: row.google_name ?? null,
        isPrimary: row.is_primary ?? false,
        scopes: row.scopes ?? [],
      });
    }
  }

  if (!microsoftResult.error && microsoftResult.data) {
    for (const row of microsoftResult.data) {
      accounts.push({
        provider: 'microsoft',
        email: row.microsoft_email,
        name: row.microsoft_name ?? null,
        isPrimary: row.is_primary ?? false,
        scopes: [],
      });
    }
  }

  return accounts;
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
  authUserId: string | null;
  onboardState: string;
  entryState: string | null;
  firstValueWedge: string | null;
  firstValueDeliveredAt: string | null;
  secondEngagementAt: string | null;
  checkinOptIn: boolean | null;
  activationScore: number;
  capabilityCategoriesUsed: string[];
  lastProactiveSentAt: string | null;
  lastProactiveIgnored: boolean;
  proactiveIgnoreCount: number;
  recoveryNudgeSentAt: string | null;
  timezone: string | null;
  firstSeen: number;
  lastSeen: number;
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
  out_auth_user_id: string | null;
  out_onboard_state: string;
  out_entry_state: string | null;
  out_first_value_wedge: string | null;
  out_first_value_delivered_at: string | null;
  out_second_engagement_at: string | null;
  out_checkin_opt_in: boolean | null;
  out_activation_score: number;
  out_capability_categories_used: string[];
  out_last_proactive_sent_at: string | null;
  out_last_proactive_ignored: boolean;
  out_proactive_ignore_count: number;
  out_recovery_nudge_sent_at: string | null;
  out_timezone: string | null;
  out_first_seen: number;
  out_last_seen: number;
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
    authUserId: row.out_auth_user_id ?? null,
    onboardState: row.out_onboard_state ?? 'new_user_unclassified',
    entryState: row.out_entry_state ?? null,
    firstValueWedge: row.out_first_value_wedge ?? null,
    firstValueDeliveredAt: row.out_first_value_delivered_at ?? null,
    secondEngagementAt: row.out_second_engagement_at ?? null,
    checkinOptIn: row.out_checkin_opt_in ?? null,
    activationScore: row.out_activation_score ?? 0,
    capabilityCategoriesUsed: row.out_capability_categories_used ?? [],
    lastProactiveSentAt: row.out_last_proactive_sent_at ?? null,
    lastProactiveIgnored: row.out_last_proactive_ignored ?? false,
    proactiveIgnoreCount: row.out_proactive_ignore_count ?? 0,
    recoveryNudgeSentAt: row.out_recovery_nudge_sent_at ?? null,
    timezone: row.out_timezone ?? null,
    firstSeen: row.out_first_seen ?? 0,
    lastSeen: row.out_last_seen ?? 0,
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
  };

  if (pdlProfile !== undefined && pdlProfile !== null) {
    patch.pdl_profile = pdlProfile;
  }

  const { error } = await supabase
    .from(USER_PROFILES_TABLE)
    .update(patch)
    .eq('handle', handle);

  if (error) {
    console.error('[state] Error updating onboard state:', error.message);
    throw new Error(`updateOnboardState failed: ${error.message}`);
  }
}

export async function updateUserTimezone(handle: string, timezone: string): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase
    .from(USER_PROFILES_TABLE)
    .update({ timezone })
    .eq('handle', handle);
  if (error) {
    console.warn('[state] Failed to update timezone:', error.message);
  }
}

export async function getUserTimezone(handle: string): Promise<string | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from(USER_PROFILES_TABLE)
    .select('timezone')
    .eq('handle', handle)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { timezone: string | null }).timezone ?? null;
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
    .select('handle, name, status, onboarding_token, onboard_messages, onboard_count, bot_number, pdl_profile, auth_user_id, onboard_state, entry_state, first_value_wedge, first_value_delivered_at, second_engagement_at, checkin_opt_in, activation_score, capability_categories_used, last_proactive_sent_at, last_proactive_ignored, proactive_ignore_count, recovery_nudge_sent_at, timezone, first_seen, last_seen')
    .eq('onboarding_token', token)
    .maybeSingle();

  if (error) {
    console.error('[state] Error getting user by token:', error);
    return null;
  }

  if (!data) return null;

  return {
    handle: data.handle,
    name: data.name,
    status: data.status,
    onboardingToken: data.onboarding_token,
    onboardMessages: parseOnboardMessages(data.onboard_messages),
    onboardCount: data.onboard_count,
    botNumber: data.bot_number,
    pdlProfile: data.pdl_profile,
    authUserId: data.auth_user_id ?? null,
    onboardState: data.onboard_state ?? 'new_user_unclassified',
    entryState: data.entry_state ?? null,
    firstValueWedge: data.first_value_wedge ?? null,
    firstValueDeliveredAt: data.first_value_delivered_at ?? null,
    secondEngagementAt: data.second_engagement_at ?? null,
    checkinOptIn: data.checkin_opt_in ?? null,
    activationScore: data.activation_score ?? 0,
    capabilityCategoriesUsed: data.capability_categories_used ?? [],
    lastProactiveSentAt: data.last_proactive_sent_at ?? null,
    lastProactiveIgnored: data.last_proactive_ignored ?? false,
    proactiveIgnoreCount: data.proactive_ignore_count ?? 0,
    recoveryNudgeSentAt: data.recovery_nudge_sent_at ?? null,
    timezone: data.timezone ?? null,
    firstSeen: data.first_seen ?? 0,
    lastSeen: data.last_seen ?? 0,
  };
}

// ============================================================================
// First 48 Hours: State Machine, Events, Proactive, Experiments
// ============================================================================

export type OnboardState =
  | 'new_user_unclassified'
  | 'new_user_intro_started'
  | 'first_value_pending'
  | 'first_value_delivered'
  | 'follow_through_pending'
  | 'follow_through_delivered'
  | 'second_engagement_observed'
  | 'checkin_permission_eligible'
  | 'checkin_opted_in'
  | 'checkin_declined'
  | 'memory_moment_eligible'
  | 'memory_moment_delivered'
  | 'referral_eligible'
  | 'quiet_user'
  | 'spam_hold'
  | 'at_risk'
  | 'activated';

export type EntryState =
  | 'curious_opener'
  | 'direct_task_opener'
  | 'drafting_opener'
  | 'overwhelm_opener'
  | 'referral_opener'
  | 'trust_opener'
  | 'ambiguous_opener';

export type ValueWedge = 'offload' | 'draft' | 'organise' | 'ask_plan';

export type OnboardingEventType =
  | 'new_user_first_inbound_received'
  | 'new_user_entry_state_classified'
  | 'new_user_name_captured'
  | 'new_user_clarification_requested'
  | 'new_user_first_value_wedge_selected'
  | 'first_value_delivered'
  | 'first_value_type_offload'
  | 'first_value_type_draft'
  | 'first_value_type_organise'
  | 'first_value_time_to_delivery'
  | 'first_value_failed'
  | 'reminder_created'
  | 'reminder_confirmed'
  | 'reminder_delivered'
  | 'reminder_acknowledged'
  | 'reminder_missed'
  | 'reminder_corrected'
  | 'recovery_nudge_sent'
  | 'recovery_nudge_ignored'
  | 'recovery_nudge_replied'
  | 'checkin_permission_offered'
  | 'checkin_permission_accepted'
  | 'checkin_permission_declined'
  | 'morning_checkin_sent'
  | 'morning_checkin_replied'
  | 'proactive_hold_due_to_spam_rule'
  | 'memory_candidate_generated'
  | 'memory_candidate_rejected_low_confidence'
  | 'memory_candidate_rejected_creep_risk'
  | 'memory_moment_sent'
  | 'memory_moment_positive_response'
  | 'memory_moment_correction'
  | 'trust_hesitation_detected'
  | 'trust_reassurance_sent'
  | 'error_misunderstanding_detected'
  | 'error_hallucination_detected'
  | 'error_recovery_success'
  | 'error_recovery_failure'
  | 'second_engagement_observed'
  | 'second_capability_used'
  | 'day2_return'
  | 'activated_composite'
  | 'at_risk_48h';

export interface EmitEventParams {
  handle: string;
  chatId?: string;
  eventType: OnboardingEventType;
  messageTurnIndex?: number;
  entryState?: string;
  valueWedge?: string;
  currentState?: string;
  experimentVariantIds?: string[];
  confidenceScores?: Record<string, number>;
  payload?: Record<string, unknown>;
}

export async function emitOnboardingEvent(params: EmitEventParams): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase.rpc('emit_onboarding_event', {
    p_handle: params.handle,
    p_chat_id: params.chatId ?? null,
    p_event_type: params.eventType,
    p_message_turn_index: params.messageTurnIndex ?? null,
    p_entry_state: params.entryState ?? null,
    p_value_wedge: params.valueWedge ?? null,
    p_current_state: params.currentState ?? null,
    p_experiment_variant_ids: JSON.stringify(params.experimentVariantIds ?? []),
    p_confidence_scores: params.confidenceScores ? JSON.stringify(params.confidenceScores) : null,
    p_payload: JSON.stringify(params.payload ?? {}),
  });

  if (error) {
    console.error('[state] Error emitting onboarding event:', error.message);
  }
}

export interface StateTransitionParams {
  handle: string;
  newState: OnboardState;
  entryState?: string;
  firstValueWedge?: string;
  firstValueDelivered?: boolean;
  followThroughDelivered?: boolean;
  secondEngagement?: boolean;
  checkinOptIn?: boolean;
  memoryMomentDelivered?: boolean;
  activated?: boolean;
  atRisk?: boolean;
  capabilityCategory?: string;
  timezone?: string;
}

export async function transitionOnboardState(params: StateTransitionParams): Promise<string | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('update_onboard_state_machine', {
    p_handle: params.handle,
    p_new_state: params.newState,
    p_entry_state: params.entryState ?? null,
    p_first_value_wedge: params.firstValueWedge ?? null,
    p_first_value_delivered: params.firstValueDelivered ?? false,
    p_follow_through_delivered: params.followThroughDelivered ?? false,
    p_second_engagement: params.secondEngagement ?? false,
    p_checkin_opt_in: params.checkinOptIn ?? null,
    p_memory_moment_delivered: params.memoryMomentDelivered ?? false,
    p_activated: params.activated ?? false,
    p_at_risk: params.atRisk ?? false,
    p_capability_category: params.capabilityCategory ?? null,
    p_timezone: params.timezone ?? null,
  });

  if (error) {
    console.error('[state] Error transitioning onboard state:', error.message);
    return null;
  }

  return data as string | null;
}

export async function recordProactiveMessage(
  handle: string,
  chatId: string,
  messageType: string,
  content: string,
  metadata?: Record<string, unknown>,
): Promise<number | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('record_proactive_message', {
    p_handle: handle,
    p_chat_id: chatId,
    p_message_type: messageType,
    p_content: content,
    p_metadata: JSON.stringify(metadata ?? {}),
  });

  if (error) {
    console.error('[state] Error recording proactive message:', error.message);
    return null;
  }

  return data as number;
}

export async function markProactiveReplied(handle: string): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase.rpc('mark_proactive_replied', {
    p_handle: handle,
  });

  if (error) {
    console.error('[state] Error marking proactive replied:', error.message);
  }
}

export interface ProactiveEligibleUser {
  handle: string;
  name: string | null;
  onboardState: string;
  entryState: string | null;
  firstValueWedge: string | null;
  firstValueDeliveredAt: string | null;
  followThroughDeliveredAt: string | null;
  secondEngagementAt: string | null;
  checkinOptIn: boolean | null;
  checkinDeclineAt: string | null;
  memoryMomentDeliveredAt: string | null;
  activatedAt: string | null;
  lastProactiveSentAt: string | null;
  lastProactiveIgnored: boolean;
  proactiveIgnoreCount: number;
  recoveryNudgeSentAt: string | null;
  activationScore: number;
  capabilityCategoriesUsed: string[];
  botNumber: string | null;
  firstSeen: number;
  lastSeen: number;
  onboardCount: number;
  timezone: string | null;
}

export async function getProactiveEligibleUsers(limit = 20): Promise<ProactiveEligibleUser[]> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('get_proactive_eligible_users', {
    p_limit: limit,
  });

  if (error) {
    console.error('[state] Error getting proactive eligible users:', error.message);
    return [];
  }

  if (!data || !Array.isArray(data)) return [];

  return (data as Record<string, unknown>[]).map((row) => ({
    handle: row.handle as string,
    name: row.name as string | null,
    onboardState: row.onboard_state as string,
    entryState: row.entry_state as string | null,
    firstValueWedge: row.first_value_wedge as string | null,
    firstValueDeliveredAt: row.first_value_delivered_at as string | null,
    followThroughDeliveredAt: row.follow_through_delivered_at as string | null,
    secondEngagementAt: row.second_engagement_at as string | null,
    checkinOptIn: row.checkin_opt_in as boolean | null,
    checkinDeclineAt: row.checkin_decline_at as string | null,
    memoryMomentDeliveredAt: row.memory_moment_delivered_at as string | null,
    activatedAt: row.activated_at as string | null,
    lastProactiveSentAt: row.last_proactive_sent_at as string | null,
    lastProactiveIgnored: row.last_proactive_ignored as boolean,
    proactiveIgnoreCount: row.proactive_ignore_count as number,
    recoveryNudgeSentAt: row.recovery_nudge_sent_at as string | null,
    activationScore: row.activation_score as number,
    capabilityCategoriesUsed: row.capability_categories_used as string[],
    botNumber: row.bot_number as string | null,
    firstSeen: row.first_seen as number,
    lastSeen: row.last_seen as number,
    onboardCount: row.onboard_count as number,
    timezone: row.timezone as string | null,
  }));
}

export async function assignExperiment(
  handle: string,
  experimentName: string,
  variants: string[],
): Promise<string> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.rpc('assign_experiment', {
    p_handle: handle,
    p_experiment_name: experimentName,
    p_variants: variants,
  });

  if (error) {
    console.error('[state] Error assigning experiment:', error.message);
    return variants[0];
  }

  return (data as string) || variants[0];
}

export async function getUserExperiments(handle: string): Promise<Record<string, string>> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('experiment_assignments')
    .select('experiment_name, variant')
    .eq('handle', handle);

  if (error || !data) return {};

  const result: Record<string, string> = {};
  for (const row of data as { experiment_name: string; variant: string }[]) {
    result[row.experiment_name] = row.variant;
  }
  return result;
}
