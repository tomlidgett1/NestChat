import { getOpenAIClient, MODEL_MAP, REASONING_EFFORT, isGeminiModel } from "../ai/models.ts";
import { geminiSimpleText } from "../ai/gemini.ts";
import { resolveTools, resolveToolChoice, hasDeepProfile } from "./capability-tools.ts";
import type {
  AgentName,
  Capability,
  ClassifierResult,
  DomainTag,
  MemoryDepth,
  RouteDecision,
  ToolNamespace,
  TurnInput,
  UserStyle,
} from "./types.ts";
import type { RouterContext } from "./build-context.ts";

// ═══════════════════════════════════════════════════════════════
// 100% LLM Test Router
//
// Bypasses all deterministic layers (0A, 0B) and sends every
// message — including greetings, confirmations, and trivial
// acknowledgements — through the LLM classifier. This lets us
// measure quality differences vs the hybrid deterministic router.
// ═══════════════════════════════════════════════════════════════

const LLM_ROUTER_INSTRUCTIONS =
  `You are the routing brain for Nest, a personal assistant people text over iMessage.

Given the user's message and conversation context, output a JSON object that determines how to handle the message. You must classify EVERY message — there is no fast-path. Even greetings, "yes", "no", and single-word acknowledgements must be classified.

## Output schema (strict JSON, no markdown):
{
  "mode": "chat" | "smart",
  "primaryDomain": "email" | "calendar" | "meeting_prep" | "research" | "recall" | "contacts" | "general",
  "secondaryDomains": [],
  "confidence": 0.0-1.0,
  "requiredCapabilities": [],
  "preferredCapabilities": [],
  "memoryDepth": "none" | "light" | "full",
  "requiresToolUse": true | false,
  "isConfirmation": true | false,
  "pendingActionId": null,
  "style": "brief" | "normal" | "deep"
}

## Mode rules
- "chat": casual conversation, banter, emotional support, greetings, jokes, life advice, creative writing, general knowledge questions that don't need tools. Uses a fast non-reasoning model.
- "smart": anything requiring tools, account data, personal context retrieval, multi-step tasks, domain expertise, or location/travel/places queries. Uses a reasoning model with tool access.

When in doubt between chat and smart, prefer smart.

## Confirmation handling
When a pending action is described in the context (e.g. a draft email awaiting send, a calendar event awaiting creation), and the user's message is clearly confirming ("yes", "send it", "looks good") or rejecting ("no", "cancel", "never mind") that action, set isConfirmation=true and route to "smart" mode with the appropriate domain capabilities so the agent can execute or cancel the action.

## Domain rules
- "email": reading, searching, drafting, sending, or managing emails
- "calendar": viewing, creating, updating, or deleting calendar events; schedule queries. If about a flight/booking that might not be on calendar, include email.read and knowledge.search capabilities.
- "meeting_prep": preparing for meetings, briefing, meeting notes recall. Always include granola.read.
- "research": factual questions needing current/live data, current events, news, web lookups
- "recall": what Nest knows/remembers about the user, personal memory retrieval
- "contacts": looking up people in the user's contacts
- "general": casual chat, life advice, creative writing, or tasks that don't fit one domain

## Capabilities (only include what's needed)
email.read, email.write, calendar.read, calendar.write, contacts.read, granola.read, web.search, knowledge.search, memory.read, memory.write, travel.search, weather.search, reminders.manage, notifications.watch, deep_profile

## memoryDepth
- "none": factual/web queries, simple acknowledgements, banter with no need for personal context
- "light": context-aware replies where a memory summary helps
- "full": recall tasks, meeting prep, anything needing deep personal context

## style
- "brief": short messages, reactions, acknowledgements
- "normal": standard conversational messages
- "deep": requests for detailed analysis or comprehensive information`;

function buildLlmRouterInput(
  input: TurnInput,
  context: RouterContext,
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  const contextParts: string[] = [];

  if (context.recentTurns.length > 0) {
    const turnSummary = context.recentTurns
      .slice(-6)
      .map((t) => `${t.role}: ${t.content.substring(0, 200)}`)
      .join("\n");
    contextParts.push(`Recent conversation:\n${turnSummary}`);
  }

  const wm = context.workingMemory;
  if (wm.activeTopics.length > 0) {
    contextParts.push(`Active topics: ${wm.activeTopics.join(", ")}`);
  }
  if (wm.pendingActions.length > 0) {
    contextParts.push(
      `Pending actions: ${wm.pendingActions.map((a) => `[${a.type}] ${a.description}`).join("; ")}`,
    );
  }
  if (wm.awaitingConfirmation) {
    contextParts.push("State: awaiting user confirmation on a previous action");
  }
  if (wm.awaitingChoice) {
    contextParts.push("State: awaiting user choice between options");
  }

  if (context.pendingEmailSends.length > 0) {
    const draft = context.pendingEmailSends[0];
    contextParts.push(
      `Pending email draft: id=${draft.id}, to=${draft.to.join(", ")}, subject="${draft.subject ?? "none"}", status=awaiting_confirmation`,
    );
  }

  if (contextParts.length > 0) {
    messages.push({
      role: "user",
      content: `Context:\n${contextParts.join("\n\n")}`,
    });
    messages.push({
      role: "assistant",
      content: "Understood. I will use this context for classification.",
    });
  }

  messages.push({
    role: "user",
    content: `Classify this message: "${input.userMessage.substring(0, 500)}"`,
  });

  return messages;
}

const CHAT_NAMESPACES: ToolNamespace[] = [
  "memory.read",
  "memory.write",
  "messaging.react",
  "messaging.effect",
  "media.generate",
  "web.search",
  "weather.search",
  "travel.search",
];

const VALID_DOMAINS: Set<string> = new Set([
  "email", "calendar", "meeting_prep", "research", "recall", "contacts", "general",
]);
const VALID_CAPABILITIES: Set<string> = new Set([
  "email.read", "email.write", "calendar.read", "calendar.write", "contacts.read",
  "granola.read", "web.search", "knowledge.search", "memory.read", "memory.write",
  "travel.search", "weather.search", "reminders.manage", "notifications.watch", "deep_profile",
]);

function validateDomain(d: unknown): DomainTag {
  return VALID_DOMAINS.has(d as string) ? (d as DomainTag) : "general";
}
function isValidCapability(c: unknown): c is Capability {
  return VALID_CAPABILITIES.has(c as string);
}
function validateMemoryDepth(d: unknown): MemoryDepth {
  if (d === "none" || d === "light" || d === "full") return d;
  return "none";
}
function validateStyle(s: unknown): UserStyle {
  if (s === "brief" || s === "normal" || s === "deep") return s;
  return "normal";
}

// ═══════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════

export async function routeTurnLlm(
  input: TurnInput,
  context: RouterContext,
): Promise<RouteDecision> {
  const model = MODEL_MAP.agent; // gpt-5.4 — full power for test routing
  const start = Date.now();

  try {
    let text: string;

    if (isGeminiModel(model)) {
      const inputMessages = buildLlmRouterInput(input, context);
      const flatInput = inputMessages.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
      const geminiResult = await geminiSimpleText({
        model,
        systemPrompt: LLM_ROUTER_INSTRUCTIONS,
        userMessage: flatInput,
        maxOutputTokens: 1024,
      });
      text = geminiResult.text;
    } else {
      const client = getOpenAIClient();
      const response = await client.responses.create(
        {
          model,
          instructions: LLM_ROUTER_INSTRUCTIONS,
          input: buildLlmRouterInput(input, context),
          max_output_tokens: 1024,
          store: false,
          reasoning: { effort: "medium" as const },
        } as Parameters<typeof client.responses.create>[0],
      );
      text = response.output_text ?? "";
    }

    const latency = Date.now() - start;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(
        `[route-llm] no JSON in response (${latency}ms): "${text.substring(0, 200)}"`,
      );
      return fallbackRoute(latency);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const result: ClassifierResult = {
      mode: parsed.mode === "smart" ? "smart" : "chat",
      primaryDomain: validateDomain(parsed.primaryDomain),
      secondaryDomains: Array.isArray(parsed.secondaryDomains)
        ? parsed.secondaryDomains.map(validateDomain).filter((d: DomainTag) => d !== "general")
        : undefined,
      confidence: typeof parsed.confidence === "number"
        ? Math.min(1, Math.max(0, parsed.confidence))
        : 0.7,
      requiredCapabilities: Array.isArray(parsed.requiredCapabilities)
        ? parsed.requiredCapabilities.filter(isValidCapability)
        : [],
      preferredCapabilities: Array.isArray(parsed.preferredCapabilities)
        ? parsed.preferredCapabilities.filter(isValidCapability)
        : undefined,
      memoryDepth: validateMemoryDepth(parsed.memoryDepth),
      requiresToolUse: parsed.requiresToolUse === true,
      isConfirmation: parsed.isConfirmation === true,
      pendingActionId: parsed.pendingActionId ?? null,
      style: validateStyle(parsed.style),
    };

    console.log(
      `[route-llm] "${input.userMessage.substring(0, 60)}" → mode=${result.mode}, domain=${result.primaryDomain}${
        result.secondaryDomains?.length ? `+${result.secondaryDomains.join(",")}` : ""
      }, caps=[${result.requiredCapabilities.join(",")}], memory=${result.memoryDepth}, conf=${result.confidence} (${latency}ms)`,
    );

    // Build RouteDecision from ClassifierResult (same logic as classifierRoute in v2)
    if (result.mode === "chat") {
      return {
        mode: "single_agent",
        agent: "chat",
        allowedNamespaces: CHAT_NAMESPACES,
        needsMemoryRead: result.memoryDepth !== "none",
        needsMemoryWriteCandidate: false,
        needsWebFreshness: false,
        userStyle: result.style,
        confidence: result.confidence,
        fastPathUsed: false,
        routerLatencyMs: latency,
        classifierResult: result,
        primaryDomain: result.primaryDomain,
        secondaryDomains: result.secondaryDomains,
        memoryDepth: result.memoryDepth,
        routeLayer: "0C",
        routeReason: "llm_test_router",
        confirmationState: result.isConfirmation ? "confirmed" : "not_confirmation",
      };
    }

    const isDeepProfile = hasDeepProfile(result);
    const namespaces = resolveTools(result);
    const toolChoice = resolveToolChoice(result);

    return {
      mode: "single_agent",
      agent: "smart",
      allowedNamespaces: namespaces,
      needsMemoryRead: result.memoryDepth !== "none" || isDeepProfile ||
        result.requiredCapabilities.includes("travel.search"),
      needsMemoryWriteCandidate: result.requiredCapabilities.includes("memory.write"),
      needsWebFreshness: result.requiredCapabilities.includes("web.search"),
      userStyle: result.style,
      confidence: result.confidence,
      fastPathUsed: false,
      routerLatencyMs: latency,
      classifierResult: result,
      primaryDomain: result.primaryDomain,
      secondaryDomains: result.secondaryDomains,
      memoryDepth: isDeepProfile ? "full" : result.memoryDepth,
      forcedToolChoice: toolChoice ?? (isDeepProfile ? "required" : undefined),
      routeLayer: "0C",
      routeReason: "llm_test_router",
      confirmationState: result.isConfirmation ? "confirmed" : "not_confirmation",
      reasoningEffortOverride: isDeepProfile ? "high" : undefined,
      modelOverride: isDeepProfile ? "gpt-5.4" : undefined,
    };
  } catch (err) {
    const latency = Date.now() - start;
    console.warn(`[route-llm] failed (${latency}ms):`, (err as Error).message);
    return fallbackRoute(latency);
  }
}

function fallbackRoute(latencyMs: number): RouteDecision {
  return {
    mode: "single_agent",
    agent: "smart",
    allowedNamespaces: CHAT_NAMESPACES,
    needsMemoryRead: true,
    needsMemoryWriteCandidate: false,
    needsWebFreshness: false,
    userStyle: "normal",
    confidence: 0.3,
    fastPathUsed: false,
    routerLatencyMs: latencyMs,
    primaryDomain: "general",
    memoryDepth: "light",
    routeLayer: "0C",
    routeReason: "llm_test_router_fallback",
  };
}
