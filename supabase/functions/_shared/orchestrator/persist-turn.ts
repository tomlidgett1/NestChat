import type { TurnInput, AgentLoopResult, TurnTrace } from './types.ts';
import { MEMORY_V2_ENABLED } from '../env.ts';

const SEPARATOR_RE = /\n---\n|\n---$|^---\n|\s+---\s+|\s+---$|^---\s+/;
function splitBubbles(text: string): string[] {
  const hasSeparator = text.includes('---');
  const parts = hasSeparator ? text.split(SEPARATOR_RE) : [text];
  return parts.map(p => p.trim()).filter(Boolean);
}

export async function persistTurn(
  input: TurnInput,
  loopResult: AgentLoopResult,
  trace: TurnTrace,
): Promise<void> {
  const { addMessage, insertToolTrace } = await import('../state.ts');

  if (loopResult.text) {
    const historyMessage = splitBubbles(loopResult.text).join(' ');

    const messageMetadata = loopResult.toolsUsed.length > 0
      ? { tools_used: loopResult.toolsUsed }
      : undefined;

    await addMessage(input.chatId, 'assistant', historyMessage, undefined, {
      isGroupChat: input.isGroupChat,
      chatName: input.chatName,
      participantNames: input.participantNames,
      service: input.service,
      metadata: messageMetadata,
    });
  } else if (loopResult.effect) {
    await addMessage(input.chatId, 'assistant', `[sent ${loopResult.effect.name} effect]`);
  } else if (loopResult.reaction) {
    const display = loopResult.reaction.type === 'custom'
      ? (loopResult.reaction as { type: 'custom'; emoji: string }).emoji
      : loopResult.reaction.type;
    await addMessage(input.chatId, 'assistant', `[reacted with ${display}]`);
  }

  if (MEMORY_V2_ENABLED && loopResult.toolsUsed.length > 0) {
    const tracePromises = loopResult.toolsUsed.map((t) =>
      insertToolTrace({
        chatId: input.chatId,
        toolName: t.tool,
        outcome: 'success',
        safeSummary: t.detail ?? null,
      }),
    );
    await Promise.allSettled(tracePromises);
  }

  persistTurnTrace(trace).catch(err =>
    console.warn('[persist-turn] TurnTrace insert failed:', (err as Error).message)
  );
}

async function persistTurnTrace(trace: TurnTrace): Promise<void> {
  const { getAdminClient } = await import('../supabase.ts');
  const supabase = getAdminClient();

  const { error } = await supabase.from('turn_traces').insert({
    turn_id: trace.turnId,
    chat_id: trace.chatId,
    sender_handle: trace.senderHandle,

    user_message: trace.userMessage,
    timezone_resolved: trace.timezoneResolved,

    route_agent: trace.routeDecision.agent,
    route_mode: trace.routeDecision.mode,
    route_confidence: trace.routeDecision.confidence,
    route_fast_path: trace.routeDecision.fastPathUsed,
    route_latency_ms: trace.routeDecision.routerLatencyMs,
    route_namespaces: trace.routeDecision.allowedNamespaces,
    route_layer: trace.routeLayer ?? null,
    route_reason: trace.routeReason ?? null,

    system_prompt_length: trace.systemPromptLength,
    system_prompt_hash: trace.systemPromptHash,
    memory_items_loaded: trace.memoryItemsLoaded,
    summaries_loaded: trace.summariesLoaded,
    rag_evidence_blocks: trace.ragEvidenceBlocks,
    connected_accounts_count: trace.connectedAccountsCount,
    history_messages_count: trace.historyMessagesCount,
    context_build_latency_ms: trace.contextBuildLatencyMs,

    agent_name: trace.agentName,
    model_used: trace.modelUsed,
    agent_loop_rounds: trace.agentLoopRounds,
    agent_loop_latency_ms: trace.agentLoopLatencyMs,

    tool_calls: trace.toolCalls,
    tool_calls_blocked: trace.toolCallsBlocked,
    tool_call_count: trace.toolCallCount,
    tool_total_latency_ms: trace.toolTotalLatencyMs,

    input_tokens: trace.inputTokens,
    output_tokens: trace.outputTokens,

    response_text: trace.responseText,
    response_length: trace.responseLength,

    total_latency_ms: trace.totalLatencyMs,

    system_prompt: trace.systemPrompt,
    initial_messages: trace.initialMessages,
    available_tool_names: trace.availableToolNames,

    context_sub_timings: trace.contextSubTimings,
    round_traces: trace.roundTraces,
    prompt_compose_ms: trace.promptComposeMs,
    tool_filter_ms: trace.toolFilterMs,
    router_context_ms: trace.routerContextMs,

    context_path: trace.contextPath ?? 'full',
    pending_action_debug: trace.pendingActionDebug ?? {},

    error_message: trace.errorMessage ?? null,
    error_stage: trace.errorStage ?? null,
  });

  if (error) {
    console.warn('[persist-turn] TurnTrace insert error:', error.message);
  }
}
