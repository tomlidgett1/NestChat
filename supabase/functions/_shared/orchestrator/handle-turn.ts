import type { TurnInput, TurnResult, TurnTrace } from "./types.ts";
import {
  buildContext,
  buildLightContext,
  buildMemoryLightContext,
  buildRouterContext,
} from "./build-context.ts";
import { routeTurn } from "./route-turn.ts";
import { routeTurnV2 } from "./route-turn-v2.ts";
import { selectAgent } from "./select-agent.ts";
import { runAgentLoop } from "./run-agent-loop.ts";
import { persistTurn } from "./persist-turn.ts";
import {
  extractWorkingMemory,
  persistWorkingMemory,
} from "./working-memory.ts";
import {
  queueBackgroundJob,
  shouldQueueBackgroundWork,
} from "./background-jobs.ts";
import { OPTION_A_ROUTING } from "../env.ts";

// ═══════════════════════════════════════════════════════════════
// Slash command handling (deterministic, no LLM needed)
// ═══════════════════════════════════════════════════════════════

async function handleSlashCommand(
  input: TurnInput,
): Promise<TurnResult | null> {
  const cmd = input.userMessage.toLowerCase().trim();
  const emptyTrace: TurnTrace = {
    turnId: crypto.randomUUID(),
    chatId: input.chatId,
    senderHandle: input.senderHandle,
    timestamp: new Date().toISOString(),
    userMessage: input.userMessage.substring(0, 2000),
    timezoneResolved: input.timezone ?? null,
    routeDecision: {
      mode: "direct",
      agent: "casual",
      allowedNamespaces: [],
      needsMemoryRead: false,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      userStyle: "normal",
      confidence: 1.0,
      fastPathUsed: true,
      routerLatencyMs: 0,
    },
    systemPromptLength: 0,
    systemPromptHash: "",
    memoryItemsLoaded: 0,
    ragEvidenceBlocks: 0,
    summariesLoaded: 0,
    connectedAccountsCount: 0,
    historyMessagesCount: 0,
    contextBuildLatencyMs: 0,
    contextSubTimings: null,
    agentName: "casual",
    modelUsed: "none",
    agentLoopRounds: 0,
    agentLoopLatencyMs: 0,
    roundTraces: [],
    promptComposeMs: 0,
    toolFilterMs: 0,
    toolCalls: [],
    toolCallsBlocked: [],
    toolCallCount: 0,
    toolTotalLatencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    responseText: null,
    responseLength: 0,
    totalLatencyMs: 0,
    routerContextMs: 0,
    contextPath: "light",
    pendingActionDebug: {
      pendingEmailSendCount: 0,
      pendingEmailSendId: null,
      pendingEmailSendStatus: null,
      draftIdPresent: false,
      accountPresent: false,
      confirmationResult: "not_checked",
    },
    systemPrompt: null,
    initialMessages: null,
    availableToolNames: [],
  };

  const empty = {
    reaction: null,
    effect: null,
    rememberedUser: null,
    generatedImage: null,
  };

  if (cmd === "/help") {
    const text =
      "commands:\n/clear - reset our conversation\n/forget me - erase what i know about you\n/memory - see what i remember about you\n/memory delete <id> - remove a specific memory\n/memory clear - wipe all your memories\n/help - this message";
    return {
      text,
      ...empty,
      trace: { ...emptyTrace, responseLength: text.length },
    };
  }

  if (cmd === "/clear") {
    const { clearConversation } = await import("../state.ts");
    await clearConversation(input.chatId);
    const text = "conversation cleared, fresh start 🧹";
    return {
      text,
      ...empty,
      trace: { ...emptyTrace, responseLength: text.length },
    };
  }

  if (cmd === "/forget me" || cmd === "/forgetme") {
    if (input.senderHandle) {
      const { clearUserProfile, rejectAllMemoryItems } = await import(
        "../state.ts"
      );
      await clearUserProfile(input.senderHandle);
      await rejectAllMemoryItems(input.senderHandle);
      const text =
        "done, i've forgotten everything about you. we're strangers now 👋";
      return {
        text,
        ...empty,
        trace: { ...emptyTrace, responseLength: text.length },
      };
    }
    const text = "hmm couldn't figure out who you are to forget you";
    return {
      text,
      ...empty,
      trace: { ...emptyTrace, responseLength: text.length },
    };
  }

  if (cmd === "/memory") {
    if (!input.senderHandle) {
      const text = "couldn't identify you to look up memories";
      return {
        text,
        ...empty,
        trace: { ...emptyTrace, responseLength: text.length },
      };
    }
    const { getActiveMemoryItems } = await import("../state.ts");
    const memories = await getActiveMemoryItems(input.senderHandle, 50);
    if (memories.length === 0) {
      const text = "i don't have any memories saved for you yet";
      return {
        text,
        ...empty,
        trace: { ...emptyTrace, responseLength: text.length },
      };
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
        const conf = m.confidence < 0.6 ? " ⚠️" : "";
        return `  #${m.id} — ${m.valueText}${conf}`;
      });
      sections.push(`**${category}**\n${lines.join("\n")}`);
    }

    const header =
      `here's everything i remember about you (${memories.length} items):\n\n`;
    const footer =
      '\n\nuse "/memory delete <id>" to remove one, or "/memory clear" to wipe everything';
    const text = header + sections.join("\n\n") + footer;
    return {
      text,
      ...empty,
      trace: { ...emptyTrace, responseLength: text.length },
    };
  }

  if (cmd.startsWith("/memory delete ")) {
    if (!input.senderHandle) {
      const text = "couldn't identify you";
      return {
        text,
        ...empty,
        trace: { ...emptyTrace, responseLength: text.length },
      };
    }
    const idStr = cmd.replace("/memory delete ", "").trim();
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      const text =
        `"${idStr}" isn't a valid memory id — use /memory to see your memories with their ids`;
      return {
        text,
        ...empty,
        trace: { ...emptyTrace, responseLength: text.length },
      };
    }
    const { rejectMemoryItem } = await import("../state.ts");
    const deleted = await rejectMemoryItem(id, input.senderHandle);
    const text = deleted
      ? `done, memory #${id} has been deleted`
      : `couldn't find memory #${id} — it might not exist or belong to you`;
    return {
      text,
      ...empty,
      trace: { ...emptyTrace, responseLength: text.length },
    };
  }

  if (cmd === "/memory clear") {
    if (!input.senderHandle) {
      const text = "couldn't identify you";
      return {
        text,
        ...empty,
        trace: { ...emptyTrace, responseLength: text.length },
      };
    }
    const { rejectAllMemoryItems } = await import("../state.ts");
    const count = await rejectAllMemoryItems(input.senderHandle);
    const text = count > 0
      ? `done, cleared ${count} memories. fresh start`
      : "you didn't have any active memories to clear";
    return {
      text,
      ...empty,
      trace: { ...emptyTrace, responseLength: text.length },
    };
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

  // 2. Route the message
  let routerCtx: import("./build-context.ts").RouterContext | undefined;
  let routerContextMs = 0;
  let route: import("./types.ts").RouteDecision;
  let routeMs = 0;

  if (OPTION_A_ROUTING) {
    // Option A: v2 routing (classifier-based, 2-agent model)
    const routerCtxStart = Date.now();
    routerCtx = await buildRouterContext(input);
    routerContextMs = Date.now() - routerCtxStart;

    const routeStart = Date.now();
    route = await routeTurnV2(input, routerCtx);
    routeMs = Date.now() - routeStart;
  } else {
    // Legacy: try instant fast-path BEFORE fetching any context
    const { tryInstantCasual } = await import("./route-turn.ts");
    const instantRoute = tryInstantCasual(input);

    if (instantRoute) {
      route = instantRoute;
      routeMs = 0;
    } else {
      const routerCtxStart = Date.now();
      routerCtx = await buildRouterContext(input);
      routerContextMs = Date.now() - routerCtxStart;

      const routeStart = Date.now();
      route = await routeTurn(input, routerCtx);
      routeMs = Date.now() - routeStart;
    }
  }

  // 3. Build context — select path based on memoryDepth (v2) or heuristics (legacy)
  const contextStart = Date.now();
  let useLightContext: boolean;
  let contextPath: "full" | "light" | "memory-light";

  if (OPTION_A_ROUTING && route.memoryDepth !== undefined) {
    if (route.memoryDepth === "none") {
      useLightContext = true;
      contextPath = "light";
    } else if (route.memoryDepth === "light") {
      useLightContext = true;
      contextPath = "memory-light";
    } else {
      useLightContext = false;
      contextPath = "full";
    }
  } else {
    const isCasualFastPath = route.fastPathUsed &&
      (route.agent === "casual" || route.agent === "chat") &&
      !route.needsMemoryRead;
    const isWebOnlyFastPath = route.fastPathUsed && route.needsWebFreshness &&
      !route.needsMemoryRead;
    const isReadOnlyProductivity = route.fastPathUsed &&
      route.agent === "productivity" && route.modelTierOverride === "fast" &&
      !route.needsMemoryRead;
    useLightContext = isCasualFastPath || isWebOnlyFastPath ||
      isReadOnlyProductivity;
    contextPath = useLightContext ? "light" : "full";
  }

  const context = contextPath === "light"
    ? await buildLightContext(input, routerCtx)
    : contextPath === "memory-light"
    ? await buildMemoryLightContext(input, routerCtx)
    : await buildContext(input, routerCtx);
  const contextBuildLatencyMs = Date.now() - contextStart;
  if (useLightContext) {
    console.log(
      `[handle-turn] light context (${contextPath}): route=${routeMs}ms, ctx=${contextBuildLatencyMs}ms, routerCtx=${routerContextMs}ms`,
    );
  }

  // 5. Select agent
  const agent = selectAgent(route.agent);

  // 6. Run agent loop
  const loopStart = Date.now();
  const loopResult = await runAgentLoop(
    agent,
    context,
    input,
    route.allowedNamespaces,
    route.modelTierOverride,
    route.forcedToolChoice,
    route.primaryDomain,
    route.secondaryDomains,
    route.reasoningEffortOverride,
    route.classifierResult?.requiredCapabilities,
    route.modelOverride,
    route.routeLayer,
  );
  const agentLoopLatencyMs = Date.now() - loopStart;

  // 7. Assemble TurnTrace
  const toolTotalLatencyMs = loopResult.toolCallTraces.reduce(
    (sum, t) => sum + t.latencyMs,
    0,
  );
  const promptHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(String(loopResult.systemPromptLength)),
      ),
    ),
  ).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");

  const trace: TurnTrace = {
    turnId,
    chatId: input.chatId,
    senderHandle: input.senderHandle,
    timestamp: new Date().toISOString(),

    userMessage: input.userMessage.substring(0, 2000),
    timezoneResolved: input.timezone ?? null,

    routeDecision: route,
    classifierResult: route.classifierResult,
    routeLayer: route.routeLayer,
    routeReason: route.routeReason,
    matchedDisqualifierBucket: route.matchedDisqualifierBucket,
    hadPendingState: route.hadPendingState,
    classifierLatencyMs: route.routeLayer === "0C"
      ? route.routerLatencyMs
      : undefined,

    systemPromptLength: loopResult.systemPromptLength,
    systemPromptHash: promptHash,
    memoryItemsLoaded: context.memoryItems.length,
    ragEvidenceBlocks: context.ragEvidenceBlockCount,
    summariesLoaded: context.summaries.length,
    connectedAccountsCount: context.connectedAccounts.length,
    historyMessagesCount: context.history.length,
    contextBuildLatencyMs,
    contextSubTimings: context.subTimings ?? null,

    agentName: agent.name,
    modelUsed: loopResult.effectiveModel,
    agentLoopRounds: loopResult.rounds,
    agentLoopLatencyMs,

    roundTraces: loopResult.roundTraces,
    promptComposeMs: loopResult.promptComposeMs,
    toolFilterMs: loopResult.toolFilterMs,

    toolCalls: loopResult.toolCallTraces,
    toolCallsBlocked: loopResult.toolCallsBlocked,
    toolCallCount: loopResult.toolCallTraces.length,
    toolTotalLatencyMs,

    inputTokens: loopResult.inputTokens,
    outputTokens: loopResult.outputTokens,

    responseText: loopResult.text?.substring(0, 5000) ?? null,
    responseLength: loopResult.text?.length ?? 0,

    totalLatencyMs: Date.now() - turnStart,
    routerContextMs,
    contextPath,
    pendingActionDebug: {
      pendingEmailSendCount: context.pendingEmailSends.length,
      pendingEmailSendId: context.pendingEmailSend?.id ?? null,
      pendingEmailSendStatus: context.pendingEmailSend?.status ?? null,
      draftIdPresent: !!context.pendingEmailSend?.draftId,
      accountPresent: !!context.pendingEmailSend?.account,
      confirmationResult: route.confirmationState ?? "not_checked",
    },

    systemPrompt: loopResult.systemPrompt,
    initialMessages: loopResult.initialMessages,
    availableToolNames: loopResult.availableToolNames,
  };

  console.log(
    `[handle-turn] ${turnId}: agent=${agent.name}, model=${loopResult.effectiveModel}, route=${route.agent}(${route.mode}), routerCtx=${routerContextMs}ms, context=${contextBuildLatencyMs}ms, loop=${agentLoopLatencyMs}ms, tools=${loopResult.toolCallTraces.length}(${toolTotalLatencyMs}ms), tokens=${loopResult.inputTokens}in/${loopResult.outputTokens}out, rounds=${loopResult.rounds}(${
      loopResult.roundTraces.filter((r) => r.wasRetry).length
    } retries), total=${trace.totalLatencyMs}ms`,
  );

  // 8. Persist — messages, tool traces, turn trace (fire-and-forget)
  persistTurn(input, loopResult, trace)
    .catch((err) =>
      console.warn("[handle-turn] persistTurn failed:", (err as Error).message)
    );

  // 9. Queue background work if needed (fire-and-forget)
  const bgJobType = shouldQueueBackgroundWork(
    input.userMessage,
    loopResult.toolsUsed,
  );
  if (bgJobType) {
    queueBackgroundJob({
      jobType: bgJobType,
      chatId: input.chatId,
      senderHandle: input.senderHandle,
      payload: { turnId, userMessage: input.userMessage.substring(0, 500) },
      priority: "low",
    }).catch((err) =>
      console.warn("[handle-turn] background job queue failed:", err)
    );
  }

  // 10. Extract and persist working memory (fire-and-forget)
  import("../state.ts")
    .then(({ getPendingEmailSends }) => getPendingEmailSends(input.chatId))
    .then((pendingEmailSends) =>
      extractWorkingMemory(
        input.userMessage,
        loopResult.text,
        loopResult.toolsUsed,
        context.workingMemory,
        pendingEmailSends,
      )
    )
    .then((wm) => persistWorkingMemory(input.chatId, wm))
    .catch((err) =>
      console.warn("[handle-turn] working memory update failed:", err)
    );

  return {
    text: loopResult.text,
    reaction: loopResult.reaction,
    effect: loopResult.effect,
    rememberedUser: loopResult.rememberedUser,
    generatedImage: loopResult.generatedImage,
    trace,
  };
}
