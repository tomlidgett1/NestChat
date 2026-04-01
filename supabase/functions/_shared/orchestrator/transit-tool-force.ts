import type { StoredMessage } from "../state.ts";

/** OpenAI Responses API: force a specific custom tool by name. */
export type ForcedNamedFunctionChoice = { type: "function"; name: string };

const AMBIGUOUS_TRANSIT_MSG = new RegExp(
  "^(" +
    "please|pls|plz|yes|yeah|yep|yup|nah|no|nope|" +
    "ok|okay|sure|\\bk\\b|" +
    "ta|thanks|thank you|cheers|thx|" +
    "do it|go ahead|that works|" +
    "the train|train one|that one|this one|first one|second one|third one|" +
    "option\\s*[123]|op\\s*[123]|#1|#2|#3|" +
    "easier|simplest|fewer transfers?|less walking|walking less|" +
    "bus instead|tram instead|try that|same thing|alternate|other one|" +
    "how about that|go with that|show me" +
    ")[.!?…\\s]*$",
  "i",
);

/** Avoid forcing transit when the user clearly pivots topic. */
const TOPIC_SHIFT =
  /\b(weather|email|calendar|remind me|password|recipe|capital of|what is|who is|define\s+\w|stock price)\b/i;

const TRANSIT_REPLY_SIGNAL =
  /Google Maps is showing|\*\*Fastest right now:\*\*|Board at:|Get off:|Fewest transfers:|\[travel_time\]\s*$/i;

function lastAssistantMessage(history: StoredMessage[]): StoredMessage | undefined {
  let last: StoredMessage | undefined;
  for (const m of history) {
    if (m.role === "assistant") last = m;
  }
  return last;
}

export function lastAssistantLooksLikeTransitReply(history: StoredMessage[]): boolean {
  const a = lastAssistantMessage(history);
  if (!a) return false;

  const tools = a.metadata?.tools_used as Array<{ tool: string }> | undefined;
  if (tools?.some((t) => t.tool === "travel_time")) return true;

  return TRANSIT_REPLY_SIGNAL.test(a.content);
}

export function isAmbiguousTransitFollowUp(userMessage: string): boolean {
  const t = userMessage.trim();
  if (t.length === 0 || t.length > 72) return false;
  if (TOPIC_SHIFT.test(t)) return false;
  if (AMBIGUOUS_TRANSIT_MSG.test(t)) return true;
  // Very short continuations (e.g. "Sure thing") — only used with transit context in the detector below.
  if (t.length <= 14 && !/\?/.test(t) && /^[\w\s.',!…-]+$/u.test(t)) {
    return true;
  }
  return false;
}

/**
 * When the user sends a vague continuation after a transit reply, force `travel_time`
 * so the model cannot invent live PT times without a fresh tool result.
 */
export function detectTransitContinuationToolChoice(
  userMessage: string,
  history: StoredMessage[],
  availableToolNames: string[],
): ForcedNamedFunctionChoice | undefined {
  if (!new Set(availableToolNames).has("travel_time")) return undefined;
  if (!isAmbiguousTransitFollowUp(userMessage)) return undefined;
  if (!lastAssistantLooksLikeTransitReply(history)) return undefined;
  return { type: "function", name: "travel_time" };
}
