import {
  getOpenAIClient,
  MODEL_MAP,
  REASONING_EFFORT,
  type OpenAITool,
  type FunctionCallOutput,
  type ModelTier,
  type ReasoningEffort,
} from '../ai/models.ts';
import type {
  AgentConfig,
  TurnContext,
  TurnInput,
  AgentLoopResult,
  ToolCallTrace,
  ToolCallBlockedTrace,
  ToolNamespace,
  RoundTrace,
  Reaction,
  MessageEffect,
  RememberedUser,
  GeneratedImage,
} from './types.ts';
import type { PendingToolCall, ToolContext, ToolExecutionResult } from '../tools/types.ts';
import { toOpenAITool } from '../tools/types.ts';
import { filterToolsByNamespace } from '../tools/namespace-filter.ts';
import { executePoliciedToolCalls } from '../tools/executor.ts';
import { composePrompt, composeCompactPrompt } from '../agents/prompt-layers.ts';

type StandardReactionType = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';

// ═══════════════════════════════════════════════════════════════
// Side-effect extraction from executor structuredData
// ═══════════════════════════════════════════════════════════════

interface SideEffects {
  reaction: Reaction | null;
  effect: MessageEffect | null;
  rememberedUser: RememberedUser | null;
  generatedImage: GeneratedImage | null;
}

function extractSideEffectsFromExecutor(execResults: ToolExecutionResult[]): SideEffects {
  let reaction: Reaction | null = null;
  let effect: MessageEffect | null = null;
  let rememberedUser: RememberedUser | null = null;
  let generatedImage: GeneratedImage | null = null;

  for (const r of execResults) {
    if (!r.structuredData) continue;

    if (r.toolName === 'send_reaction') {
      reaction = { type: r.structuredData.type as StandardReactionType };
    } else if (r.toolName === 'send_effect') {
      effect = {
        type: r.structuredData.effect_type as 'screen' | 'bubble',
        name: r.structuredData.effect as string,
      };
    } else if (r.toolName === 'remember_user' && r.outcome === 'success') {
      rememberedUser = {
        name: r.structuredData.name as string | undefined,
        fact: r.structuredData.fact as string | undefined,
        isForSender: r.structuredData.isForSender as boolean | undefined,
      };
    } else if (r.toolName === 'generate_image') {
      generatedImage = { url: '', prompt: r.structuredData.prompt as string };
    }
  }

  return { reaction, effect, rememberedUser, generatedImage };
}

// ═══════════════════════════════════════════════════════════════
// Model resolution — upgrade casual tier when judgement tools present
// ═══════════════════════════════════════════════════════════════

function resolveModelTier(agent: AgentConfig): ModelTier {
  return agent.modelTier;
}

function stripLinksFromText(text: string): string {
  // Convert markdown links to plain anchor text.
  let cleaned = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, '$1');
  // Remove any remaining raw URLs.
  cleaned = cleaned.replace(/\bhttps?:\/\/[^\s)]+/gi, '');
  // Remove orphaned angle-bracket URLs.
  cleaned = cleaned.replace(/<\s*https?:\/\/[^>]+>/gi, '');
  // Normalise extra spaces created by removals.
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

function detectForcedToolChoice(
  msg: string,
  availableToolNames: string[],
): string | undefined {
  const toolSet = new Set(availableToolNames);
  const lower = msg.toLowerCase();

  const wantsWebSearch = /\b(use (the )?(internet|web)|search (the )?(web|internet|online)|google|look.{0,10}up online|browse)\b/i.test(lower);
  if (wantsWebSearch && toolSet.has('web_search')) {
    return 'required';
  }

  return undefined;
}

// ═══════════════════════════════════════════════════════════════
// Main agent loop — OpenAI Responses API with reasoning
// ═══════════════════════════════════════════════════════════════

export async function runAgentLoop(
  agent: AgentConfig,
  context: TurnContext,
  input: TurnInput,
  allowedNamespaces: ToolNamespace[],
  modelTierOverride?: ModelTier,
  routerForcedToolChoice?: string,
  primaryDomain?: import('./types.ts').DomainTag,
  secondaryDomains?: import('./types.ts').DomainTag[],
  reasoningEffortOverride?: ReasoningEffort,
  capabilities?: import('./types.ts').Capability[],
  modelOverride?: string,
): Promise<AgentLoopResult> {
  const client = getOpenAIClient();

  const promptStart = Date.now();
  const isLightCasual = (agent.name === 'casual' || agent.name === 'chat')
    && context.memoryItems.length === 0
    && context.summaries.length === 0
    && allowedNamespaces.length <= 6;
  const systemPrompt = isLightCasual
    ? composeCompactPrompt(context, input)
    : composePrompt(agent, context, input, primaryDomain, secondaryDomains, capabilities);
  const promptComposeMs = Date.now() - promptStart;

  const filterStart = Date.now();
  const availableTools = isLightCasual ? [] : filterToolsByNamespace(allowedNamespaces);
  const openaiTools: OpenAITool[] = availableTools.map(toOpenAITool);
  const toolFilterMs = Date.now() - filterStart;

  const effectiveTier = modelTierOverride ?? resolveModelTier(agent);
  const effectiveModel = modelOverride ?? MODEL_MAP[effectiveTier];
  const reasoningEffort = reasoningEffortOverride ?? REASONING_EFFORT[effectiveTier];

  if (modelOverride) {
    console.log(`[agent-loop] model overridden to '${modelOverride}' (default would be '${MODEL_MAP[effectiveTier]}')`);
  }
  if (reasoningEffortOverride) {
    console.log(`[agent-loop] reasoning effort overridden to '${reasoningEffortOverride}' (default would be '${REASONING_EFFORT[effectiveTier]}')`);
  }

  const recentHistory = isLightCasual
    ? context.formattedHistory.slice(-4)
    : context.formattedHistory;
  const apiInput: Record<string, unknown>[] = [
    ...recentHistory,
    { role: 'user', content: context.messageContent },
  ];

  const toolCtx: ToolContext = {
    chatId: input.chatId,
    senderHandle: input.senderHandle,
    authUserId: input.authUserId,
    pendingEmailSend: context.pendingEmailSend,
    pendingEmailSends: context.pendingEmailSends,
  };

  let finalText = '';
  const allToolTraces: ToolCallTrace[] = [];
  const allBlocked: ToolCallBlockedTrace[] = [];
  const allExecResults: ToolExecutionResult[] = [];
  const toolsUsed: Array<{ tool: string; detail?: string }> = [];
  const roundTraces: RoundTrace[] = [];
  let roundCount = 0;
  let currentMaxOutputTokens = agent.maxOutputTokens;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const maxRounds = agent.toolPolicy.maxToolRounds;

  const userForcedToolChoice = detectForcedToolChoice(input.userMessage, availableTools.map(t => t.name));
  const forcedToolChoice = routerForcedToolChoice ?? userForcedToolChoice;

  if (forcedToolChoice) {
    const source = routerForcedToolChoice ? 'router' : 'explicit user request';
    console.log(`[agent-loop] forcing tool_choice: ${forcedToolChoice} (${source})`);
  }
  console.log(`[agent-loop] starting: agent=${agent.name}, model=${effectiveModel}, effort=${reasoningEffort}, tools=${availableTools.length}, maxRounds=${maxRounds}, promptLen=${systemPrompt.length}, promptComposeMs=${promptComposeMs}, toolFilterMs=${toolFilterMs}`);

  for (let round = 0; round <= maxRounds; round++) {
    roundCount++;
    const roundStart = Date.now();

    const useToolChoice = round === 0 && forcedToolChoice ? forcedToolChoice : undefined;

    const useReasoning = reasoningEffort !== 'none';
    const keepHighEffort = reasoningEffortOverride && round <= 4;
    const roundEffort = !useReasoning
      ? 'none' as ReasoningEffort
      : keepHighEffort
        ? reasoningEffort
        : round > 0 && reasoningEffort !== 'low'
          ? 'low' as ReasoningEffort
          : reasoningEffort;
    if (useReasoning && roundEffort !== reasoningEffort) {
      console.log(`[agent-loop] round ${round + 1}: reasoning effort downgraded ${reasoningEffort} → ${roundEffort} (post-tool formatting)`);
    }

    const apiCallStart = Date.now();
    const reasoningParams = useReasoning
      ? { reasoning: { effort: roundEffort }, include: ['reasoning.encrypted_content'] }
      : {};
    const response = await client.responses.create({
      model: effectiveModel,
      instructions: systemPrompt,
      input: apiInput as Parameters<typeof client.responses.create>[0]['input'],
      tools: openaiTools as Parameters<typeof client.responses.create>[0]['tools'],
      max_output_tokens: currentMaxOutputTokens,
      store: false,
      ...reasoningParams,
      ...(useToolChoice ? { tool_choice: useToolChoice } : {}),
    } as Parameters<typeof client.responses.create>[0]);
    const apiCallMs = Date.now() - apiCallStart;

    const usage = (response as Record<string, unknown>).usage as Record<string, number> | undefined;
    const roundInputTokens = usage?.input_tokens ?? 0;
    const roundOutputTokens = usage?.output_tokens ?? 0;
    totalInputTokens += roundInputTokens;
    totalOutputTokens += roundOutputTokens;

    const roundText = response.output_text ?? '';
    const pendingCalls: PendingToolCall[] = [];
    let roundWebSearch = false;

    for (const item of response.output) {
      if (item.type === 'function_call') {
        const fc = item as unknown as { call_id: string; name: string; arguments: string };
        let parsedArgs: Record<string, unknown> = {};
        try { parsedArgs = JSON.parse(fc.arguments); } catch { /* empty */ }
        pendingCalls.push({
          id: fc.call_id,
          name: fc.name,
          input: parsedArgs,
        });
        const detail = summariseToolDetail(fc.name, parsedArgs);
        toolsUsed.push({ tool: fc.name, ...(detail ? { detail } : {}) });
        console.log(`[agent-loop] function_call: ${fc.name} ${fc.arguments.substring(0, 200)}`);
      } else if (item.type === 'web_search_call') {
        roundWebSearch = true;
        toolsUsed.push({ tool: 'web_search' });
        allToolTraces.push({
          name: 'web_search',
          namespace: 'web.search',
          sideEffect: 'read',
          latencyMs: 0,
          outcome: 'success',
        });
        console.log(`[agent-loop] web_search_call`);
      }
    }

    console.log(`[agent-loop] round ${roundCount}/${maxRounds + 1}: status=${response.status}, items=${response.output.length}, textLen=${roundText.length}, apiMs=${apiCallMs}, tokens=${roundInputTokens}in/${roundOutputTokens}out`);

    // Handle incomplete response (reasoning exhausted token budget)
    if (response.status === 'incomplete') {
      const reason = (response as Record<string, unknown>).incomplete_details as Record<string, string> | undefined;
      if (reason?.reason === 'max_output_tokens') {
        if (pendingCalls.length > 0 || roundText.length === 0) {
          const prevMax = currentMaxOutputTokens;
          currentMaxOutputTokens = Math.min(currentMaxOutputTokens * 2, 32768);
          console.log(`[agent-loop] token budget exhausted (text=${roundText.length}), retrying with ${currentMaxOutputTokens}`);
          roundTraces.push({
            round: roundCount,
            apiLatencyMs: apiCallMs,
            toolExecLatencyMs: 0,
            totalRoundMs: Date.now() - roundStart,
            inputTokens: roundInputTokens,
            outputTokens: roundOutputTokens,
            status: response.status,
            functionCallCount: pendingCalls.length,
            webSearchCalled: roundWebSearch,
            textLength: roundText.length,
            wasRetry: true,
            retryReason: `max_output_tokens (${prevMax} → ${currentMaxOutputTokens})`,
            maxOutputTokens: prevMax,
            reasoningEffort: roundEffort,
          });
          continue;
        }
        finalText = roundText;
        roundTraces.push({
          round: roundCount,
          apiLatencyMs: apiCallMs,
          toolExecLatencyMs: 0,
          totalRoundMs: Date.now() - roundStart,
          inputTokens: roundInputTokens,
          outputTokens: roundOutputTokens,
          status: 'incomplete_accepted',
          functionCallCount: 0,
          webSearchCalled: roundWebSearch,
          textLength: roundText.length,
          wasRetry: false,
          maxOutputTokens: currentMaxOutputTokens,
          reasoningEffort: roundEffort,
        });
        break;
      }
    }

    // Reasoning model spent entire budget on reasoning/search with no text output
    if (pendingCalls.length === 0 && roundText.length === 0 && response.output.length > 0) {
      if (currentMaxOutputTokens < 32768) {
        const prevMax = currentMaxOutputTokens;
        currentMaxOutputTokens = Math.min(currentMaxOutputTokens * 2, 32768);
        console.warn(`[agent-loop] no text produced despite ${response.output.length} output items, retrying with ${currentMaxOutputTokens} tokens`);
        roundTraces.push({
          round: roundCount,
          apiLatencyMs: apiCallMs,
          toolExecLatencyMs: 0,
          totalRoundMs: Date.now() - roundStart,
          inputTokens: roundInputTokens,
          outputTokens: roundOutputTokens,
          status: 'empty_retry',
          functionCallCount: 0,
          webSearchCalled: roundWebSearch,
          textLength: 0,
          wasRetry: true,
          retryReason: `no text output (${prevMax} → ${currentMaxOutputTokens})`,
          maxOutputTokens: prevMax,
          reasoningEffort: roundEffort,
        });
        continue;
      }
    }

    // No function calls — we're done
    if (pendingCalls.length === 0) {
      finalText = roundText;
      roundTraces.push({
        round: roundCount,
        apiLatencyMs: apiCallMs,
        toolExecLatencyMs: 0,
        totalRoundMs: Date.now() - roundStart,
        inputTokens: roundInputTokens,
        outputTokens: roundOutputTokens,
        status: response.status,
        functionCallCount: 0,
        webSearchCalled: roundWebSearch,
        textLength: roundText.length,
        wasRetry: false,
        maxOutputTokens: currentMaxOutputTokens,
        reasoningEffort: roundEffort,
      });
      break;
    }

    const conversationHistory = context.recentTurns.map(t => ({
      role: t.role,
      content: t.content,
    }));
    conversationHistory.push({ role: 'user', content: input.userMessage });

    const priorTurnToolNames = allExecResults.map(r => r.toolName);

    const toolExecStart = Date.now();
    const { toolResults, execResults } = await executePoliciedToolCalls(
      pendingCalls,
      toolCtx,
      allowedNamespaces,
      allToolTraces,
      allBlocked,
      conversationHistory,
      priorTurnToolNames,
    );
    const toolExecMs = Date.now() - toolExecStart;
    allExecResults.push(...execResults);

    roundTraces.push({
      round: roundCount,
      apiLatencyMs: apiCallMs,
      toolExecLatencyMs: toolExecMs,
      totalRoundMs: Date.now() - roundStart,
      inputTokens: roundInputTokens,
      outputTokens: roundOutputTokens,
      status: response.status,
      functionCallCount: pendingCalls.length,
      webSearchCalled: roundWebSearch,
      textLength: roundText.length,
      wasRetry: false,
      maxOutputTokens: currentMaxOutputTokens,
      reasoningEffort: roundEffort,
    });

    // Feed back all output items (preserves reasoning) + tool results
    apiInput.push(...response.output as unknown as Record<string, unknown>[]);
    apiInput.push(...toolResults);
  }

  const sideEffects = extractSideEffectsFromExecutor(allExecResults);
  let text = finalText.length > 0 ? finalText : null;

  const usedWebSearch = allToolTraces.some((trace) => trace.name === 'web_search');
  if (text && usedWebSearch) {
    text = stripLinksFromText(text);
  }

  const commitToolNames = new Set(['email_send', 'calendar_write']);
  for (const exec of allExecResults) {
    if (commitToolNames.has(exec.toolName) && exec.outcome !== 'success') {
      const reason = exec.structuredData?.error ?? exec.outcome;
      console.warn(`[agent-loop] commit tool ${exec.toolName} did not succeed (${exec.outcome}), overriding response`);
      text = `That didn't go through — ${reason}. Want me to try again?`;
      break;
    }
  }

  return {
    text,
    reaction: sideEffects.reaction,
    effect: sideEffects.effect,
    rememberedUser: sideEffects.rememberedUser,
    generatedImage: sideEffects.generatedImage,
    toolCallTraces: allToolTraces,
    toolCallsBlocked: allBlocked,
    rounds: roundCount,
    toolsUsed,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    systemPromptLength: systemPrompt.length,
    systemPrompt,
    initialMessages: [
      ...context.formattedHistory,
      { role: 'user', content: context.messageContent },
    ],
    availableToolNames: availableTools.map(t => t.name),
    effectiveModel,
    roundTraces,
    promptComposeMs,
    toolFilterMs,
  };
}

// ═══════════════════════════════════════════════════════════════
// Tool detail summariser for toolsUsed metadata
// ═══════════════════════════════════════════════════════════════

function summariseToolDetail(name: string, input: Record<string, unknown>): string | undefined {
  switch (name) {
    case 'send_reaction':
      return input.type as string;
    case 'send_effect':
      return input.effect as string;
    case 'remember_user': {
      const parts = [
        input.name ? `name: ${input.name}` : '',
        input.fact ? String(input.fact).substring(0, 50) : '',
      ].filter(Boolean);
      return parts.join(', ') || undefined;
    }
    case 'generate_image':
      return (input.prompt as string)?.substring(0, 60);
    case 'semantic_search':
      return (input.query as string)?.substring(0, 60);
    case 'email_read':
      return (input.query as string)?.substring(0, 60) ?? (input.message_id as string)?.substring(0, 30);
    case 'email_draft': {
      const to = Array.isArray(input.to) ? (input.to as string[]).join(', ') : String(input.to ?? '');
      return `draft to: ${to.substring(0, 40)}`;
    }
    case 'email_update_draft': {
      const parts = [
        input.subject ? `subject: ${(input.subject as string).substring(0, 40)}` : '',
        input.to ? `to: ${String(input.to).substring(0, 40)}` : '',
      ].filter(Boolean);
      return parts.join(', ') || (input.draft_id as string)?.substring(0, 30);
    }
    case 'email_send':
      return (input.draft_id as string)?.substring(0, 30);
    case 'email_cancel_draft':
      return (input.draft_id as string)?.substring(0, 30);
    case 'travel_time':
      return `${input.origin ?? '?'} → ${input.destination ?? '?'} (${input.mode ?? 'driving'})`;
    case 'places_search':
      return (input.query as string)?.substring(0, 60) ?? `detail: ${(input.place_id as string)?.substring(0, 30)}`;
    case 'web_search':
      return undefined;
    default:
      return undefined;
  }
}
