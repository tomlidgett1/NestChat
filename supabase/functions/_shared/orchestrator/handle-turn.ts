import type { TurnInput, TurnResult, TurnTrace } from './types.ts';
import { buildRouterContext, buildContext } from './build-context.ts';
import { routeTurn } from './route-turn.ts';
import { selectAgent } from './select-agent.ts';
import { runAgentLoop } from './run-agent-loop.ts';
import { persistTurn } from './persist-turn.ts';
import { extractWorkingMemory, persistWorkingMemory } from './working-memory.ts';
import { queueBackgroundJob, shouldQueueBackgroundWork } from './background-jobs.ts';

// ═══════════════════════════════════════════════════════════════
// Slash command handling (deterministic, no LLM needed)
// ═══════════════════════════════════════════════════════════════

async function handleSlashCommand(input: TurnInput): Promise<TurnResult | null> {
  const cmd = input.userMessage.toLowerCase().trim();
  const emptyTrace: TurnTrace = {
    turnId: crypto.randomUUID(),
    chatId: input.chatId,
    senderHandle: input.senderHandle,
    timestamp: new Date().toISOString(),
    userMessage: input.userMessage.substring(0, 2000),
    timezoneResolved: input.timezone ?? null,
    routeDecision: {
      mode: 'direct',
      agent: 'casual',
      allowedNamespaces: [],
      needsMemoryRead: false,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: 'normal',
      confidence: 1.0,
      fastPathUsed: true,
      routerLatencyMs: 0,
    },
    systemPromptLength: 0,
    systemPromptHash: '',
    memoryItemsLoaded: 0,
    ragEvidenceBlocks: 0,
    summariesLoaded: 0,
    connectedAccountsCount: 0,
    historyMessagesCount: 0,
    contextBuildLatencyMs: 0,
    agentName: 'casual',
    modelUsed: 'none',
    agentLoopRounds: 0,
    agentLoopLatencyMs: 0,
    toolCalls: [],
    toolCallsBlocked: [],
    toolCallCount: 0,
    toolTotalLatencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    responseText: null,
    responseLength: 0,
    totalLatencyMs: 0,
    systemPrompt: null,
    initialMessages: null,
    availableToolNames: [],
  };

  const empty = { reaction: null, effect: null, rememberedUser: null, generatedImage: null };

  if (cmd === '/help') {
    const text = 'commands:\n/clear - reset our conversation\n/forget me - erase what i know about you\n/memory - see what i remember about you\n/memory delete <id> - remove a specific memory\n/memory clear - wipe all your memories\n/help - this message';
    return { text, ...empty, trace: { ...emptyTrace, responseLength: text.length } };
  }

  if (cmd === '/clear') {
    const { clearConversation } = await import('../state.ts');
    await clearConversation(input.chatId);
    const text = 'conversation cleared, fresh start 🧹';
    return { text, ...empty, trace: { ...emptyTrace, responseLength: text.length } };
  }

  if (cmd === '/forget me' || cmd === '/forgetme') {
    if (input.senderHandle) {
      const { clearUserProfile, rejectAllMemoryItems } = await import('../state.ts');
      await clearUserProfile(input.senderHandle);
      await rejectAllMemoryItems(input.senderHandle);
      const text = "done, i've forgotten everything about you. we're strangers now 👋";
      return { text, ...empty, trace: { ...emptyTrace, responseLength: text.length } };
    }
    const text = "hmm couldn't figure out who you are to forget you";
    return { text, ...empty, trace: { ...emptyTrace, responseLength: text.length } };
  }

  if (cmd === '/memory') {
    if (!input.senderHandle) {
      const text = "couldn't identify you to look up memories";
      return { text, ...empty, trace: { ...emptyTrace, responseLength: text.length } };
    }
    const { getActiveMemoryItems } = await import('../state.ts');
    const memories = await getActiveMemoryItems(input.senderHandle, 50);
    if (memories.length === 0) {
      const text = "i don't have any memories saved for you yet";
      return { text, ...empty, trace: { ...emptyTrace, responseLength: text.length } };
    }

    const grouped = new Map<string, typeof memories>();
    for (const m of memories) {
      const group = grouped.get(m.category) ?? [];
      group.push(m);
      grouped.set(m.category, group);
    }

    const sections: string[] = [];
    for (const [category, items] of grouped) {
      const lines = items.map((m) => {
        const conf = m.confidence < 0.6 ? ' ⚠️' : '';
        return `  #${m.id} — ${m.valueText}${conf}`;
      });
      sections.push(`**${category}**\n${lines.join('\n')}`);
    }

    const header = `here's everything i remember about you (${memories.length} items):\n\n`;
    const footer = '\n\nuse "/memory delete <id>" to remove one, or "/memory clear" to wipe everything';
    const text = header + sections.join('\n\n') + footer;
    return { text, ...empty, trace: { ...emptyTrace, responseLength: text.length } };
  }

  if (cmd.startsWith('/memory delete ')) {
    if (!input.senderHandle) {
      const text = "couldn't identify you";
      return { text, ...empty, trace: { ...emptyTrace, responseLength: text.length } };
    }
    const idStr = cmd.replace('/memory delete ', '').trim();
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      const text = `"${idStr}" isn't a valid memory id — use /memory to see your memories with their ids`;
      return { text, ...empty, trace: { ...emptyTrace, responseLength: text.length } };
    }
    const { rejectMemoryItem } = await import('../state.ts');
    const deleted = await rejectMemoryItem(id, input.senderHandle);
    const text = deleted
      ? `done, memory #${id} has been deleted`
      : `couldn't find memory #${id} — it might not exist or belong to you`;
    return { text, ...empty, trace: { ...emptyTrace, responseLength: text.length } };
  }

  if (cmd === '/memory clear') {
    if (!input.senderHandle) {
      const text = "couldn't identify you";
      return { text, ...empty, trace: { ...emptyTrace, responseLength: text.length } };
    }
    const { rejectAllMemoryItems } = await import('../state.ts');
    const count = await rejectAllMemoryItems(input.senderHandle);
    const text = count > 0
      ? `done, cleared ${count} memories. fresh start`
      : "you didn't have any active memories to clear";
    return { text, ...empty, trace: { ...emptyTrace, responseLength: text.length } };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// Main orchestrator entry point
// ═══════════════════════════════════════════════════════════════

export async function handleTurn(input: TurnInput): Promise<TurnResult> {
  const turnStart = Date.now();
  const turnId = crypto.randomUUID();

  // 1. Slash commands — deterministic, no LLM
  const slashResult = await handleSlashCommand(input);
  if (slashResult) return slashResult;

  // 2. Fetch lightweight router context (history + working memory)
  const contextStart = Date.now();
  const routerCtx = await buildRouterContext(input);

  // 3. Route + full context build in parallel
  const [route, context] = await Promise.all([
    routeTurn(input, routerCtx),
    buildContext(input, routerCtx),
  ]);
  const contextBuildLatencyMs = Date.now() - contextStart;

  // 4. Select agent
  const agent = selectAgent(route.agent);

  // 5. Run agent loop
  const loopStart = Date.now();
  const loopResult = await runAgentLoop(agent, context, input, route.allowedNamespaces);
  const agentLoopLatencyMs = Date.now() - loopStart;

  // 6. Assemble TurnTrace
  const toolTotalLatencyMs = loopResult.toolCallTraces.reduce((sum, t) => sum + t.latencyMs, 0);
  const promptHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(loopResult.systemPromptLength))))
  ).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');

  const trace: TurnTrace = {
    turnId,
    chatId: input.chatId,
    senderHandle: input.senderHandle,
    timestamp: new Date().toISOString(),

    userMessage: input.userMessage.substring(0, 2000),
    timezoneResolved: input.timezone ?? null,

    routeDecision: route,

    systemPromptLength: loopResult.systemPromptLength,
    systemPromptHash: promptHash,
    memoryItemsLoaded: context.memoryItems.length,
    ragEvidenceBlocks: context.ragEvidenceBlockCount,
    summariesLoaded: context.summaries.length,
    connectedAccountsCount: context.connectedAccounts.length,
    historyMessagesCount: context.history.length,
    contextBuildLatencyMs,

    agentName: agent.name,
    modelUsed: agent.model,
    agentLoopRounds: loopResult.rounds,
    agentLoopLatencyMs,

    toolCalls: loopResult.toolCallTraces,
    toolCallsBlocked: loopResult.toolCallsBlocked,
    toolCallCount: loopResult.toolCallTraces.length,
    toolTotalLatencyMs,

    inputTokens: loopResult.inputTokens,
    outputTokens: loopResult.outputTokens,

    responseText: loopResult.text?.substring(0, 5000) ?? null,
    responseLength: loopResult.text?.length ?? 0,

    totalLatencyMs: Date.now() - turnStart,

    systemPrompt: loopResult.systemPrompt,
    initialMessages: loopResult.initialMessages,
    availableToolNames: loopResult.availableToolNames,
  };

  console.log(`[handle-turn] ${turnId}: agent=${agent.name}, model=${agent.model}, route=${route.agent}(${route.mode}), context=${contextBuildLatencyMs}ms, loop=${agentLoopLatencyMs}ms, tools=${loopResult.toolCallTraces.length}(${toolTotalLatencyMs}ms), tokens=${loopResult.inputTokens}in/${loopResult.outputTokens}out, total=${trace.totalLatencyMs}ms`);

  // 7. Persist — messages, tool traces, turn trace (fire-and-forget)
  persistTurn(input, loopResult, trace)
    .catch(err => console.warn('[handle-turn] persistTurn failed:', (err as Error).message));

  // 8. Queue background work if needed (fire-and-forget)
  const bgJobType = shouldQueueBackgroundWork(input.userMessage, loopResult.toolsUsed);
  if (bgJobType) {
    queueBackgroundJob({
      jobType: bgJobType,
      chatId: input.chatId,
      senderHandle: input.senderHandle,
      payload: { turnId, userMessage: input.userMessage.substring(0, 500) },
      priority: 'low',
    }).catch(err => console.warn('[handle-turn] background job queue failed:', err));
  }

  // 9. Extract and persist working memory (fire-and-forget)
  extractWorkingMemory(
    input.userMessage,
    loopResult.text,
    loopResult.toolsUsed,
    context.workingMemory,
  ).then(wm => persistWorkingMemory(input.chatId, wm))
    .catch(err => console.warn('[handle-turn] working memory update failed:', err));

  return {
    text: loopResult.text,
    reaction: loopResult.reaction,
    effect: loopResult.effect,
    rememberedUser: loopResult.rememberedUser,
    generatedImage: loopResult.generatedImage,
    trace,
  };
}
