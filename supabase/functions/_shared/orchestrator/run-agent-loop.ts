import {
  type FunctionCallOutput,
  getOpenAIClient,
  isGeminiModel,
  MODEL_MAP,
  type ModelTier,
  type OpenAITool,
  REASONING_EFFORT,
  type ReasoningEffort,
} from "../ai/models.ts";
import {
  geminiGenerateContent,
  type GeminiTool,
  type GeminiUnifiedResponse,
  modelPartsToGeminiContent,
  toGeminiContents,
  toGeminiFunctionResponses,
} from "../ai/gemini.ts";
import type {
  AgentConfig,
  AgentLoopResult,
  GeneratedImage,
  MessageEffect,
  Reaction,
  RememberedUser,
  RoundTrace,
  ToolCallBlockedTrace,
  ToolCallTrace,
  ToolNamespace,
  TurnContext,
  TurnInput,
} from "./types.ts";
import type {
  PendingToolCall,
  ToolContext,
  ToolExecutionResult,
} from "../tools/types.ts";
import { toGeminiTools, toOpenAITool } from "../tools/types.ts";
import { filterToolsByNamespace } from "../tools/namespace-filter.ts";
import { executePoliciedToolCalls } from "../tools/executor.ts";
import {
  composeCompactPrompt,
  composePrompt,
  composeResearchLitePrompt,
} from "../agents/prompt-layers.ts";

type StandardReactionType =
  | "love"
  | "like"
  | "dislike"
  | "laugh"
  | "emphasize"
  | "question";

// ═══════════════════════════════════════════════════════════════
// Side-effect extraction from executor structuredData
// ═══════════════════════════════════════════════════════════════

interface SideEffects {
  reaction: Reaction | null;
  effect: MessageEffect | null;
  rememberedUser: RememberedUser | null;
  generatedImage: GeneratedImage | null;
}

function extractSideEffectsFromExecutor(
  execResults: ToolExecutionResult[],
): SideEffects {
  let reaction: Reaction | null = null;
  let effect: MessageEffect | null = null;
  let rememberedUser: RememberedUser | null = null;
  let generatedImage: GeneratedImage | null = null;

  for (const r of execResults) {
    if (!r.structuredData) continue;

    if (r.toolName === "send_reaction") {
      if (r.structuredData.type === "custom" && r.structuredData.custom_emoji) {
        reaction = { type: "custom", emoji: r.structuredData.custom_emoji as string };
      } else {
        reaction = { type: r.structuredData.type as StandardReactionType };
      }
    } else if (r.toolName === "send_effect") {
      effect = {
        type: r.structuredData.effect_type as "screen" | "bubble",
        name: r.structuredData.effect as string,
      };
    } else if (r.toolName === "remember_user" && r.outcome === "success") {
      rememberedUser = {
        name: r.structuredData.name as string | undefined,
        fact: r.structuredData.fact as string | undefined,
        isForSender: r.structuredData.isForSender as boolean | undefined,
      };
    } else if (r.toolName === "generate_image") {
      generatedImage = { url: "", prompt: r.structuredData.prompt as string };
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
  let cleaned = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, "$1");
  // Remove any remaining raw URLs.
  cleaned = cleaned.replace(/\bhttps?:\/\/[^\s)]+/gi, "");
  // Remove orphaned angle-bracket URLs.
  cleaned = cleaned.replace(/<\s*https?:\/\/[^>]+>/gi, "");
  // Normalise extra spaces created by removals.
  cleaned = cleaned.replace(/[ \t]{2,}/g, " ");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}

function detectForcedToolChoice(
  msg: string,
  availableToolNames: string[],
): string | undefined {
  const toolSet = new Set(availableToolNames);
  const lower = msg.toLowerCase();

  const wantsWebSearch =
    /\b(use (the )?(internet|web)|search (the )?(web|internet|online)|google|look.{0,10}up online|browse)\b/i
      .test(lower);
  if (wantsWebSearch && toolSet.has("web_search")) {
    return "required";
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
  primaryDomain?: import("./types.ts").DomainTag,
  secondaryDomains?: import("./types.ts").DomainTag[],
  reasoningEffortOverride?: ReasoningEffort,
  capabilities?: import("./types.ts").Capability[],
  modelOverride?: string,
  routeLayer?: string,
): Promise<AgentLoopResult> {
  const client = getOpenAIClient();

  const promptStart = Date.now();

  // Prompt mode is driven explicitly by routeLayer:
  // - 0B-casual    → compact prompt, no tools, truncated history (4 msgs)
  // - 0B-research  → research-lite prompt, web tools kept, trimmed history (6 msgs)
  // - 0B-knowledge → full prompt, tools from namespaces (knowledge.search + memory.read)
  // - 0A / 0C / undefined → full prompt, tools as resolved
  const isLane1 = routeLayer === "0B-casual";
  const isResearchLane = routeLayer === "0B-research";

  let systemPrompt: string;
  if (input.isGroupChat) {
    const { buildGroupSystemPrompt, getGroupChat } = await import("../group.ts");
    const group = await getGroupChat(input.chatId);
    systemPrompt = buildGroupSystemPrompt({
      participantNames: input.participantNames,
      chatName: input.chatName,
      groupVibe: (group?.groupVibe as import("../group.ts").GroupVibe) ?? "mixed",
      timezone: input.timezone,
    });
  } else if (isLane1) {
    systemPrompt = composeCompactPrompt(context, input);
  } else if (isResearchLane) {
    systemPrompt = composeResearchLitePrompt(context, input);
  } else {
    systemPrompt = composePrompt(
      agent,
      context,
      input,
      primaryDomain,
      secondaryDomains,
      capabilities,
    );
  }
  const promptComposeMs = Date.now() - promptStart;

  const filterStart = Date.now();
  const availableTools = isLane1
    ? []
    : filterToolsByNamespace(allowedNamespaces); // 0B-research keeps tools
  const openaiTools: OpenAITool[] = availableTools.map(toOpenAITool);
  const geminiTools: GeminiTool[] = availableTools.length > 0
    ? toGeminiTools(availableTools)
    : [];
  const toolFilterMs = Date.now() - filterStart;

  const effectiveTier = modelTierOverride ?? resolveModelTier(agent);
  const effectiveModel = modelOverride ?? MODEL_MAP[effectiveTier];
  const reasoningEffort = reasoningEffortOverride ??
    REASONING_EFFORT[effectiveTier];

  if (modelOverride) {
    console.log(
      `[agent-loop] model overridden to '${modelOverride}' (default would be '${
        MODEL_MAP[effectiveTier]
      }')`,
    );
  }
  if (reasoningEffortOverride) {
    console.log(
      `[agent-loop] reasoning effort overridden to '${reasoningEffortOverride}' (default would be '${
        REASONING_EFFORT[effectiveTier]
      }')`,
    );
  }

  const recentHistory = isLane1
    ? context.formattedHistory.slice(-4)
    : isResearchLane
    ? context.formattedHistory.slice(-6)
    : context.formattedHistory;
  const apiInput: Record<string, unknown>[] = [
    ...recentHistory,
    { role: "user", content: context.messageContent },
  ];

  const useGemini = isGeminiModel(effectiveModel);

  // Gemini maintains its own contents array (different format from OpenAI)
  let geminiContents = useGemini
    ? toGeminiContents(apiInput as Array<{ role: string; content?: string | unknown[] }>)
    : [];
  // Map call_id → function name for Gemini tool result routing
  const geminiCallIdToName = new Map<string, string>();

  const toolCtx: ToolContext = {
    chatId: input.chatId,
    senderHandle: input.senderHandle,
    authUserId: input.authUserId,
    timezone: input.timezone ?? null,
    pendingEmailSend: context.pendingEmailSend,
    pendingEmailSends: context.pendingEmailSends,
  };

  let finalText = "";
  const allToolTraces: ToolCallTrace[] = [];
  const allBlocked: ToolCallBlockedTrace[] = [];
  const allExecResults: ToolExecutionResult[] = [];
  const toolsUsed: Array<{ tool: string; detail?: string }> = [];
  const roundTraces: RoundTrace[] = [];
  let roundCount = 0;
  let currentMaxOutputTokens = isResearchLane
    ? Math.min(agent.maxOutputTokens, 2048)
    : agent.maxOutputTokens;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const maxRounds = isResearchLane
    ? Math.min(agent.toolPolicy.maxToolRounds, 3)
    : agent.toolPolicy.maxToolRounds;

  const userForcedToolChoice = detectForcedToolChoice(
    input.userMessage,
    availableTools.map((t) => t.name),
  );
  const forcedToolChoice = routerForcedToolChoice ?? userForcedToolChoice;

  if (forcedToolChoice) {
    const source = routerForcedToolChoice ? "router" : "explicit user request";
    console.log(
      `[agent-loop] forcing tool_choice: ${forcedToolChoice} (${source})`,
    );
  }
  console.log(
    `[agent-loop] starting: agent=${agent.name}, model=${effectiveModel}, provider=${useGemini ? "gemini" : "openai"}, effort=${reasoningEffort}, tools=${availableTools.length}, maxRounds=${maxRounds}, promptLen=${systemPrompt.length}, promptComposeMs=${promptComposeMs}, toolFilterMs=${toolFilterMs}`,
  );

  for (let round = 0; round <= maxRounds; round++) {
    roundCount++;
    const roundStart = Date.now();

    const useToolChoice = round === 0 && forcedToolChoice
      ? forcedToolChoice
      : undefined;

    const useReasoning = !useGemini && reasoningEffort !== "none";
    const keepHighEffort = reasoningEffortOverride && round <= 4;
    const roundEffort = !useReasoning
      ? "none" as ReasoningEffort
      : keepHighEffort
      ? reasoningEffort
      : round > 0 && reasoningEffort !== "low"
      ? "low" as ReasoningEffort
      : reasoningEffort;
    if (useReasoning && roundEffort !== reasoningEffort) {
      console.log(
        `[agent-loop] round ${
          round + 1
        }: reasoning effort downgraded ${reasoningEffort} → ${roundEffort} (post-tool formatting)`,
      );
    }

    const apiCallStart = Date.now();

    // Unified response variables
    let roundText = "";
    const pendingCalls: PendingToolCall[] = [];
    let roundWebSearch = false;
    let roundInputTokens = 0;
    let roundOutputTokens = 0;
    let responseStatus: string = "completed";
    let responseOutputLength = 0;
    // For Gemini: raw model parts for feeding back into the next round
    let geminiRawParts: import("../ai/gemini.ts").GeminiPart[] = [];
    // For OpenAI: raw response for feeding back
    // deno-lint-ignore no-explicit-any
    let openaiResponse: any = null;

    if (useGemini) {
      // ═══════════════════════ GEMINI PATH ═══════════════════════
      const geminiResult = await geminiGenerateContent({
        model: effectiveModel,
        systemPrompt,
        contents: geminiContents,
        tools: geminiTools.length > 0 ? geminiTools : undefined,
        toolChoice: useToolChoice,
        maxOutputTokens: currentMaxOutputTokens,
      });

      roundText = geminiResult.outputText;
      roundInputTokens = geminiResult.usage.inputTokens;
      roundOutputTokens = geminiResult.usage.outputTokens;
      responseStatus = geminiResult.status;
      responseOutputLength = geminiResult.rawModelParts.length;
      geminiRawParts = geminiResult.rawModelParts;

      for (const fc of geminiResult.functionCalls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(fc.arguments);
        } catch { /* empty */ }
        pendingCalls.push({
          id: fc.callId,
          name: fc.name,
          input: parsedArgs,
        });
        geminiCallIdToName.set(fc.callId, fc.name);
        const detail = summariseToolDetail(fc.name, parsedArgs);
        toolsUsed.push({ tool: fc.name, ...(detail ? { detail } : {}) });
        console.log(
          `[agent-loop] function_call: ${fc.name} ${fc.arguments.substring(0, 200)}`,
        );
      }
    } else {
      // ═══════════════════════ OPENAI PATH ═══════════════════════
      const reasoningParams = useReasoning
        ? {
          reasoning: { effort: roundEffort },
          include: ["reasoning.encrypted_content"],
        }
        : {};
      const response = await client.responses.create(
        {
          model: effectiveModel,
          instructions: systemPrompt,
          input: apiInput as Parameters<
            typeof client.responses.create
          >[0]["input"],
          tools: openaiTools as Parameters<
            typeof client.responses.create
          >[0]["tools"],
          max_output_tokens: currentMaxOutputTokens,
          store: false,
          ...reasoningParams,
          ...(useToolChoice ? { tool_choice: useToolChoice } : {}),
        } as Parameters<typeof client.responses.create>[0],
      );
      openaiResponse = response;

      const usage = (response as Record<string, unknown>).usage as
        | Record<string, number>
        | undefined;
      roundInputTokens = usage?.input_tokens ?? 0;
      roundOutputTokens = usage?.output_tokens ?? 0;
      roundText = response.output_text ?? "";
      responseStatus = response.status;
      responseOutputLength = response.output.length;

      for (const item of response.output) {
        if (item.type === "function_call") {
          const fc = item as unknown as {
            call_id: string;
            name: string;
            arguments: string;
          };
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(fc.arguments);
          } catch { /* empty */ }
          pendingCalls.push({
            id: fc.call_id,
            name: fc.name,
            input: parsedArgs,
          });
          const detail = summariseToolDetail(fc.name, parsedArgs);
          toolsUsed.push({ tool: fc.name, ...(detail ? { detail } : {}) });
          console.log(
            `[agent-loop] function_call: ${fc.name} ${
              fc.arguments.substring(0, 200)
            }`,
          );
        } else if (item.type === "web_search_call") {
          roundWebSearch = true;
          toolsUsed.push({ tool: "web_search" });
          allToolTraces.push({
            name: "web_search",
            namespace: "web.search",
            sideEffect: "read",
            latencyMs: 0,
            outcome: "success",
          });
          console.log(`[agent-loop] web_search_call`);
        }
      }
    }

    const apiCallMs = Date.now() - apiCallStart;
    totalInputTokens += roundInputTokens;
    totalOutputTokens += roundOutputTokens;

    console.log(
      `[agent-loop] round ${roundCount}/${
        maxRounds + 1
      }: status=${responseStatus}, items=${responseOutputLength}, textLen=${roundText.length}, apiMs=${apiCallMs}, tokens=${roundInputTokens}in/${roundOutputTokens}out`,
    );

    // Handle incomplete response (reasoning exhausted token budget)
    if (responseStatus === "incomplete") {
      if (pendingCalls.length > 0 || roundText.length === 0) {
        const prevMax = currentMaxOutputTokens;
        currentMaxOutputTokens = Math.min(currentMaxOutputTokens * 2, 32768);
        console.log(
          `[agent-loop] token budget exhausted (text=${roundText.length}), retrying with ${currentMaxOutputTokens}`,
        );
        roundTraces.push({
          round: roundCount,
          apiLatencyMs: apiCallMs,
          toolExecLatencyMs: 0,
          totalRoundMs: Date.now() - roundStart,
          inputTokens: roundInputTokens,
          outputTokens: roundOutputTokens,
          status: responseStatus,
          functionCallCount: pendingCalls.length,
          webSearchCalled: roundWebSearch,
          textLength: roundText.length,
          wasRetry: true,
          retryReason:
            `max_output_tokens (${prevMax} → ${currentMaxOutputTokens})`,
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
        status: "incomplete_accepted",
        functionCallCount: 0,
        webSearchCalled: roundWebSearch,
        textLength: roundText.length,
        wasRetry: false,
        maxOutputTokens: currentMaxOutputTokens,
        reasoningEffort: roundEffort,
      });
      break;
    }

    // Model spent entire budget on reasoning/search with no text output
    if (
      pendingCalls.length === 0 && roundText.length === 0 &&
      responseOutputLength > 0
    ) {
      if (currentMaxOutputTokens < 32768) {
        const prevMax = currentMaxOutputTokens;
        currentMaxOutputTokens = Math.min(currentMaxOutputTokens * 2, 32768);
        console.warn(
          `[agent-loop] no text produced despite ${responseOutputLength} output items, retrying with ${currentMaxOutputTokens} tokens`,
        );
        roundTraces.push({
          round: roundCount,
          apiLatencyMs: apiCallMs,
          toolExecLatencyMs: 0,
          totalRoundMs: Date.now() - roundStart,
          inputTokens: roundInputTokens,
          outputTokens: roundOutputTokens,
          status: "empty_retry",
          functionCallCount: 0,
          webSearchCalled: roundWebSearch,
          textLength: 0,
          wasRetry: true,
          retryReason:
            `no text output (${prevMax} → ${currentMaxOutputTokens})`,
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
        status: responseStatus,
        functionCallCount: 0,
        webSearchCalled: roundWebSearch,
        textLength: roundText.length,
        wasRetry: false,
        maxOutputTokens: currentMaxOutputTokens,
        reasoningEffort: roundEffort,
      });
      break;
    }

    const conversationHistory = context.recentTurns.map((t) => ({
      role: t.role,
      content: t.content,
    }));
    conversationHistory.push({ role: "user", content: input.userMessage });

    const priorTurnToolNames = allExecResults.map((r) => r.toolName);

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
      status: responseStatus,
      functionCallCount: pendingCalls.length,
      webSearchCalled: roundWebSearch,
      textLength: roundText.length,
      wasRetry: false,
      maxOutputTokens: currentMaxOutputTokens,
      reasoningEffort: roundEffort,
    });

    // Feed back model output + tool results for next round
    if (useGemini) {
      geminiContents.push(modelPartsToGeminiContent(geminiRawParts));
      geminiContents.push(
        toGeminiFunctionResponses(
          toolResults as Array<{ type: string; call_id: string; output: string }>,
          geminiCallIdToName,
        ),
      );
    } else {
      apiInput.push(...openaiResponse.output as unknown as Record<string, unknown>[]);
      apiInput.push(...toolResults);
    }
  }

  const sideEffects = extractSideEffectsFromExecutor(allExecResults);
  let text = finalText.length > 0 ? finalText : null;

  // Strip hallucinated tool tags — model may output [email_draft] etc. without
  // having actually called those tools.
  if (text) {
    const executedToolNames = new Set(allExecResults.map((r) => r.toolName));
    const KNOWN_TOOL_TAGS = new Set([
      "email_read", "email_draft", "email_send", "email_update_draft", "email_cancel_draft",
      "calendar_read", "calendar_write", "contacts_read", "travel_time", "places_search",
      "semantic_search", "granola_read", "web_search", "plan_steps",
    ]);
    text = text.replace(/\[([a-z_]+)\]/g, (match, toolName) => {
      if (KNOWN_TOOL_TAGS.has(toolName) && !executedToolNames.has(toolName)) {
        return "";
      }
      return match;
    });
    text = text.replace(/ {2,}/g, " ").trim();
    if (text.length === 0) text = null;
  }

  const usedWebSearch = allToolTraces.some((trace) =>
    trace.name === "web_search"
  );
  if (text && usedWebSearch) {
    text = stripLinksFromText(text);
  }

  const commitToolNames = new Set(["email_send", "calendar_write"]);
  for (const exec of allExecResults) {
    if (commitToolNames.has(exec.toolName) && exec.outcome !== "success") {
      const reason = exec.structuredData?.error ?? exec.outcome;
      console.warn(
        `[agent-loop] commit tool ${exec.toolName} did not succeed (${exec.outcome}), overriding response`,
      );
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
      { role: "user", content: context.messageContent },
    ],
    availableToolNames: availableTools.map((t) => t.name),
    effectiveModel,
    roundTraces,
    promptComposeMs,
    toolFilterMs,
  };
}

// ═══════════════════════════════════════════════════════════════
// Tool detail summariser for toolsUsed metadata
// ═══════════════════════════════════════════════════════════════

function summariseToolDetail(
  name: string,
  input: Record<string, unknown>,
): string | undefined {
  switch (name) {
    case "send_reaction":
      return input.type === "custom" && input.custom_emoji
        ? `custom:${input.custom_emoji}`
        : input.type as string;
    case "send_effect":
      return input.effect as string;
    case "remember_user": {
      const parts = [
        input.name ? `name: ${input.name}` : "",
        input.fact ? String(input.fact).substring(0, 50) : "",
      ].filter(Boolean);
      return parts.join(", ") || undefined;
    }
    case "generate_image":
      return (input.prompt as string)?.substring(0, 60);
    case "semantic_search":
      return (input.query as string)?.substring(0, 60);
    case "email_read":
      return (input.query as string)?.substring(0, 60) ??
        (input.message_id as string)?.substring(0, 30);
    case "email_draft": {
      const to = Array.isArray(input.to)
        ? (input.to as string[]).join(", ")
        : String(input.to ?? "");
      return `draft to: ${to.substring(0, 40)}`;
    }
    case "email_update_draft": {
      const parts = [
        input.subject
          ? `subject: ${(input.subject as string).substring(0, 40)}`
          : "",
        input.to ? `to: ${String(input.to).substring(0, 40)}` : "",
      ].filter(Boolean);
      return parts.join(", ") || (input.draft_id as string)?.substring(0, 30);
    }
    case "email_send":
      return (input.draft_id as string)?.substring(0, 30);
    case "email_cancel_draft":
      return (input.draft_id as string)?.substring(0, 30);
    case "travel_time":
      return `${input.origin ?? "?"} → ${input.destination ?? "?"} (${
        input.mode ?? "driving"
      })`;
    case "places_search":
      return (input.query as string)?.substring(0, 60) ??
        `detail: ${(input.place_id as string)?.substring(0, 30)}`;
    case "web_search":
      return (input.query as string)?.substring(0, 60);
    default:
      return undefined;
  }
}
