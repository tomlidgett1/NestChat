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
  type GeminiToolChoice,
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
import { detectToolContinuation } from "./tool-continuation-force.ts";

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
    } else if (r.toolName === "edit_image") {
      generatedImage = { url: "", prompt: r.structuredData.prompt as string, isEdit: true };
    }
  }

  return { reaction, effect, rememberedUser, generatedImage };
}

function formatWeatherFallback(
  payload: Record<string, unknown>,
  userMessage: string,
): string | null {
  if (typeof payload.error === "string") return null;
  const location = String(payload.location ?? "there");
  const type = String(payload.type ?? "current_conditions");

  if (type === "current_conditions") {
    const now = payload.temperature_c ?? payload.condition;
    const condition = payload.condition ? `, ${payload.condition}` : "";
    const rain = payload.rain_probability_percent;
    const feelsLike = payload.feels_like_c;
    const lines = [`**Now:** ${now ?? "Weather looks okay"}${condition}`];
    if (feelsLike !== undefined) lines.push(`**Feels like:** ${feelsLike}°C`);
    if (rain !== undefined) lines.push(`**Rain:** ${rain}% chance`);
    lines.push(`**Location:** ${location}`);
    return lines.join("\n");
  }

  if (type === "hourly_forecast" && Array.isArray(payload.hours)) {
    const hours = payload.hours as Array<Record<string, unknown>>;
    const rainyHour = hours.find((hour) =>
      Number(hour.rain_probability_percent ?? 0) >= 40
    );
    const maxRain = hours.reduce((max, hour) =>
      Math.max(max, Number(hour.rain_probability_percent ?? 0)), 0
    );
    const firstTemp = hours[0]?.temperature_c;
    const intro = /\bafternoon\b/i.test(userMessage)
      ? maxRain >= 40
        ? "Looks like a decent chance this afternoon."
        : "Doesn't look too rainy this afternoon."
      : maxRain >= 40
      ? "Yep, looks like some rain around."
      : "Doesn't look too bad.";
    const lines = [intro];
    if (rainyHour?.time) lines.push(`**Likely from:** ${rainyHour.time}`);
    lines.push(`**Peak rain:** ${maxRain}%`);
    if (firstTemp !== undefined) lines.push(`**Temp:** ${firstTemp}°C`);
    lines.push(`**Location:** ${location}`);
    return lines.join("\n");
  }

  if (type === "daily_forecast" && Array.isArray(payload.days)) {
    const days = (payload.days as Array<Record<string, unknown>>).slice(0, 3);
    if (days.length === 0) return null;
    const lines = days.map((day, index) => {
      const label = index === 0 ? "Today" : index === 1 ? "Tomorrow" : String(day.date ?? `Day ${index + 1}`);
      const maxTemp = day.max_temp_c ?? "—";
      const minTemp = day.min_temp_c ?? "—";
      const rain = (day.daytime as Record<string, unknown> | undefined)
        ?.rain_probability_percent;
      const condition = (day.daytime as Record<string, unknown> | undefined)
        ?.condition;
      return `**${label}:** ${maxTemp}°C / ${minTemp}°C${condition ? ` — ${condition}` : ""}${rain !== undefined ? `, ${rain}% rain` : ""}`;
    });
    lines.push(`**Location:** ${location}`);
    return lines.join("\n");
  }

  return null;
}

function formatPlacesFallback(
  payload: Record<string, unknown>,
): string | null {
  if (typeof payload.error === "string") return null;

  if (Array.isArray(payload.results)) {
    const results = (payload.results as Array<Record<string, unknown>>).slice(0, 3);
    if (results.length === 0) return null;
    return results.map((place) => {
      const name = String(place.name ?? "Unknown place");
      const address = String(place.address ?? "");
      const rating = place.rating ? ` — ${place.rating}` : "";
      return `• **${name}**${rating}\n${address}`.trim();
    }).join("\n\n");
  }

  if (payload.name) {
    const lines = [`**${String(payload.name)}**`];
    if (payload.address) lines.push(String(payload.address));
    if (payload.rating) lines.push(String(payload.rating));
    if (payload.summary) lines.push(String(payload.summary));
    return lines.join("\n");
  }

  return null;
}

function buildEmptyResponseFallback(
  execResults: ToolExecutionResult[],
  userMessage: string,
): string | null {
  for (let i = execResults.length - 1; i >= 0; i--) {
    const exec = execResults[i];
    if (exec.outcome !== "success" || !exec.structuredData) continue;
    if (exec.toolName === "weather_lookup") {
      const text = formatWeatherFallback(exec.structuredData, userMessage);
      if (text) return text;
    }
    if (exec.toolName === "places_search") {
      const text = formatPlacesFallback(exec.structuredData);
      if (text) return text;
    }
  }
  return null;
}

/**
 * Last resort when the model burned tool rounds without emitting text (e.g. forced
 * tool_choice + semantic_search loops). Never invent flight times or inbox contents.
 */
function buildPostToolSilenceFallback(
  execResults: ToolExecutionResult[],
  userMessage: string,
): string | null {
  if (execResults.length === 0) return null;
  const anySuccess = execResults.some((r) => r.outcome === "success");
  if (!anySuccess) return null;

  const successfulNames = execResults
    .filter((r) => r.outcome === "success")
    .map((r) => r.toolName);
  const hadSemanticOnlyPipeline =
    successfulNames.length > 0 &&
    successfulNames.every((n) => n === "semantic_search");

  const lower = userMessage.toLowerCase();
  const travelish =
    /\bflight|fly|flying|booking|itinerary|qantas|jetstar|virgin|pnr|e-?ticket|depart|departure|gate|airport|cairns|lounge\b/i
      .test(lower);

  if (hadSemanticOnlyPipeline && travelish) {
    return "Can't see the departure time in what I just searched — I don't want to guess. Want me to check your email for the itinerary or your calendar for that trip?";
  }
  if (hadSemanticOnlyPipeline) {
    return "Couldn't pull a solid answer from that search. If it's in your email or calendar, say the word and I'll look there — or give me one extra detail (date, place, or booking ref) and I'll try again.";
  }
  return "I ran the tools but didn't get a reply out to you — my bad. What should I try next: your inbox, calendar, or a different search?";
}

// ═══════════════════════════════════════════════════════════════
// Model resolution — upgrade casual tier when judgement tools present
// ═══════════════════════════════════════════════════════════════

function resolveModelTier(agent: AgentConfig): ModelTier {
  return agent.modelTier;
}

function stripWebSearchArtifacts(text: string): string {
  // Convert markdown links to plain anchor text.
  let cleaned = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, "$1");
  // Remove any remaining raw URLs.
  cleaned = cleaned.replace(/\bhttps?:\/\/[^\s)]+/gi, "");
  // Remove orphaned angle-bracket URLs.
  cleaned = cleaned.replace(/<\s*https?:\/\/[^>]+>/gi, "");
  // Strip OpenAI web-search citation tokens (e.g. "citeturn1search0turn1search1").
  cleaned = cleaned.replace(/\s*cite(?:turn\d+search\d+)+/gi, "");
  // Strip bracketed citation markers (e.g. "【turn1search0†source】").
  cleaned = cleaned.replace(/[\u3010\u3011][^[\u3010\u3011]*[\u3010\u3011]?/g, "");
  // Strip parenthetical domain citations: (formula1.com), (apnews.com), (cancer.org.au)
  cleaned = cleaned.replace(/\s*\((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/\S*)?\)/gi, "");
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

  if (
    input.comparePromptAppend?.trim() &&
    input.chatId.startsWith("DBG#")
  ) {
    systemPrompt +=
      "\n\n--- Compare testing (highest priority for tone, voice, and style) ---\n" +
      input.comparePromptAppend.trim();
  }

  if (input.voiceMode) {
    systemPrompt +=
      "\n\n--- Voice mode active (HIGHEST PRIORITY) ---\n" +
      "Your response will be converted to speech and sent as a voice memo. The user will NOT ask follow-up questions in this mode - this is a standalone voice note. Treat every voice mode request as a self-contained, complete response.\n\n" +
      "LENGTH AND DEPTH:\n" +
      "- This is like recording a voice note for a friend who asked you something. Give them a REAL answer.\n" +
      "- For any topic with substance (history, explanation, advice, analysis, how-to, opinion): aim for 1.5 to 3 minutes of spoken content (roughly 250-450 words). Cover the topic properly. Give context, nuance, examples, and a clear conclusion.\n" +
      "- For simple factual questions (what time is it, what's the weather, yes/no): 20-30 seconds is fine.\n" +
      "- When in doubt, go longer. A thorough 2-minute explanation is always better than a thin 20-second skim.\n" +
      "- Think of it like explaining something to a smart friend over coffee. You wouldn't give them one sentence and stop.\n\n" +
      "SPOKEN DELIVERY:\n" +
      "- Write for the ear, not the eye. Contractions, conversational flow, natural fillers ('so', 'right', 'I mean', 'you know', 'basically').\n" +
      "- No markdown, no bullet points, no numbered lists, no URLs, no special formatting whatsoever.\n" +
      "- Spell out numbers, times, and abbreviations ('five thirty pm', 'about two hundred million people').\n" +
      "- Flowing paragraphs with natural pauses (...), varied sentence length, occasional rhetorical questions to keep it engaging.\n" +
      "- Sound like you're actually talking, not reading an essay.\n" +
      "- CRITICAL: Start talking immediately. Do NOT begin with any meta-commentary like 'The user asked about...', 'Nest will respond with...', 'Here is my response...', or any bracketed text like '[voice memo]'. Just start answering directly, as if you hit record and started talking.";
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
  /** Preserves assistant text from rounds that also issued tool calls (finalText only updates on tool-free rounds). */
  let lastNonEmptyRoundText = "";
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
  const continuationForcedToolChoice = detectToolContinuation(
    input.userMessage,
    context.history,
    availableTools.map((t) => t.name),
  );
  const forcedToolChoice: GeminiToolChoice | undefined =
    routerForcedToolChoice ??
      userForcedToolChoice ??
      continuationForcedToolChoice;

  if (forcedToolChoice) {
    const choiceStr = typeof forcedToolChoice === "string"
      ? forcedToolChoice
      : `${forcedToolChoice.type}:${forcedToolChoice.name}`;
    const source = routerForcedToolChoice
      ? "router"
      : userForcedToolChoice
      ? "explicit user request"
      : "tool continuation";
    console.log(
      `[agent-loop] forcing tool_choice: ${choiceStr} (${source})`,
    );
  }
  console.log(
    `[agent-loop] starting: agent=${agent.name}, model=${effectiveModel}, provider=${useGemini ? "gemini" : "openai"}, effort=${reasoningEffort}, tools=${availableTools.length}, maxRounds=${maxRounds}, promptLen=${systemPrompt.length}, promptComposeMs=${promptComposeMs}, toolFilterMs=${toolFilterMs}`,
  );

  for (let round = 0; round <= maxRounds; round++) {
    roundCount++;
    const roundStart = Date.now();

    const useToolChoice: GeminiToolChoice | undefined =
      round === 0 && forcedToolChoice ? forcedToolChoice : undefined;

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

    if (roundText.trim().length > 0) {
      lastNonEmptyRoundText = roundText;
    }

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

  if (!text && lastNonEmptyRoundText.trim().length > 0) {
    text = lastNonEmptyRoundText.trim();
  }

  if (!text) {
    text = buildEmptyResponseFallback(allExecResults, input.userMessage);
  }
  if (!text) {
    text = buildPostToolSilenceFallback(allExecResults, input.userMessage);
  }

  // Strip tool tags from response text — models mimic [tool_name] patterns
  // from conversation history (added by formatToolNotes) and output them as
  // plain text. Remove unconditionally regardless of whether the tool was
  // actually called; these are internal metadata, never user-facing.
  if (text) {
    const KNOWN_TOOL_TAGS = new Set([
      "email_read", "email_draft", "email_send", "email_update_draft", "email_cancel_draft",
      "calendar_read", "calendar_write", "contacts_read", "travel_time", "places_search",
      "semantic_search", "granola_read", "web_search", "news_search", "plan_steps", "weather_lookup",
      "manage_reminder", "manage_notification_watch", "generate_image",
      "send_reaction", "send_effect", "remember_user",
    ]);
    text = text.replace(/\[([a-z_]+)(?:\s[^\]]*)?\]/g, (match, toolName) => {
      if (KNOWN_TOOL_TAGS.has(toolName)) {
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
    text = stripWebSearchArtifacts(text);
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

  // Hallucination guard: if the model claims a calendar/email action was
  // completed but the corresponding tool was never called (or not even
  // available), override the response to prevent false confirmations.
  if (text) {
    const availableNames = new Set(availableTools.map((t) => t.name));
    const executedNames = new Set(allExecResults.map((r) => r.toolName));
    const CALENDAR_CLAIM = /\b(added|created|booked|scheduled|put|moved|it'?s on your .{0,20}calendar|on your personal calendar|done ✓?)\b.*\b(calendar|8[:\s]?\d{2}\s?(am|pm)?|tomorrow|event)\b/i;
    const EMAIL_CLAIM = /\b(sent|drafted|forwarded|emailed)\b.*\b(email|draft|inbox|to \w+@)\b/i;

    if (
      CALENDAR_CLAIM.test(text) &&
      !availableNames.has("calendar_write") &&
      !executedNames.has("calendar_write")
    ) {
      console.warn(
        `[agent-loop] hallucination guard: model claimed calendar action without calendar_write tool`,
      );
      text = "I can't actually add that to your calendar from here. Let me try again properly.";
    } else if (
      EMAIL_CLAIM.test(text) &&
      !availableNames.has("email_send") &&
      !availableNames.has("email_draft") &&
      !executedNames.has("email_send") &&
      !executedNames.has("email_draft")
    ) {
      console.warn(
        `[agent-loop] hallucination guard: model claimed email action without email tools`,
      );
      text = "I can't actually send emails from here. Let me try again properly.";
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
    case "news_search": {
      const loc = input.location as string | undefined;
      const topics = input.topics as string | undefined;
      const parts = [
        loc ? `loc: ${loc}` : null,
        topics ? `topics: ${topics.substring(0, 40)}` : "general",
      ].filter(Boolean);
      return parts.join(", ");
    }
    default:
      return undefined;
  }
}
