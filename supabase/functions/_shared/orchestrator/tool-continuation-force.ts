import type { StoredMessage } from "../state.ts";

/**
 * Unified tool-continuation detector.
 *
 * When the user sends a short, ambiguous follow-up after an assistant turn
 * that used a specific tool, force that same tool so the model cannot
 * hallucinate stale or invented data.
 *
 * Covers: travel_time, weather_lookup, web_search, places_search,
 *         email_read, calendar_read, granola_read, semantic_search,
 *         manage_reminder, manage_notification_watch.
 */

export type ForcedToolChoice =
  | string
  | { type: "function"; name: string };

// ═══════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════

function lastAssistantMsg(history: StoredMessage[]): StoredMessage | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") return history[i];
  }
  return undefined;
}

function lastNAssistantMsgs(history: StoredMessage[], n: number): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (let i = history.length - 1; i >= 0 && out.length < n; i--) {
    if (history[i].role === "assistant") out.push(history[i]);
  }
  return out;
}

function assistantUsedTool(msg: StoredMessage, toolName: string): boolean {
  const tools = msg.metadata?.tools_used as Array<{ tool: string }> | undefined;
  return tools?.some((t) => t.tool === toolName) === true;
}

function assistantUsedAnyTool(msg: StoredMessage, toolNames: string[]): string | undefined {
  const tools = msg.metadata?.tools_used as Array<{ tool: string }> | undefined;
  if (!tools) return undefined;
  for (const t of tools) {
    if (toolNames.includes(t.tool)) return t.tool;
  }
  return undefined;
}

const TOPIC_SHIFT =
  /\b(password|recipe|capital of|define\s+\w|stock price|crypto|bitcoin|what is the meaning of)\b/i;

function isGenericShortFollowUp(msg: string, maxLen: number): boolean {
  const t = msg.trim();
  if (t.length === 0 || t.length > maxLen) return false;
  if (TOPIC_SHIFT.test(t)) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════
// 1. Transit (travel_time)
// ═══════════════════════════════════════════════════════════════

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

const TRANSIT_CONTENT =
  /Google Maps is showing|\*\*Fastest right now:\*\*|Board at:|Get off:|Fewest transfers:|\[travel_time\]\s*$/i;

const TRANSIT_NOUNS =
  /\b(train|tram|bus|drive|cycle|walk|transit|transport|commute)\b/i;

function detectTransit(
  msg: string,
  history: StoredMessage[],
  available: Set<string>,
): ForcedToolChoice | undefined {
  if (!available.has("travel_time")) return undefined;
  const t = msg.trim();
  if (t.length === 0 || t.length > 80) return undefined;

  const a = lastAssistantMsg(history);
  if (!a) return undefined;
  const isTransitReply = assistantUsedTool(a, "travel_time") || TRANSIT_CONTENT.test(a.content);
  if (!isTransitReply) return undefined;

  if (/\b(weather|email|calendar|remind me)\b/i.test(t)) return undefined;

  if (AMBIGUOUS_TRANSIT_MSG.test(t)) return { type: "function", name: "travel_time" };
  if (t.length <= 14 && !/\?/.test(t) && /^[\w\s.',!…-]+$/u.test(t)) {
    return { type: "function", name: "travel_time" };
  }
  if (TRANSIT_NOUNS.test(t) && t.length <= 80) {
    return { type: "function", name: "travel_time" };
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════
// 2. Weather (weather_lookup)
// ═══════════════════════════════════════════════════════════════

const WEATHER_CONTENT =
  /\b(forecast|°C|°F|humidity|wind speed|rain chance|UV index|showers|partly cloudy|mostly sunny|thunderstorm)\b/i;

const WEATHER_TEMPORAL =
  /\b(tomorrow|tmrw|tomoz|today|tonight|sunday|monday|tuesday|wednesday|thursday|friday|saturday|this week|next week|weekend|arvo|afternoon|morning|evening|later)\b/i;

const WEATHER_WORDS =
  /\b(wind|rain|humid|uv|sun|cloud|storm|thunder|shower|cold|hot|warm|cool|fog|hail|snow|drizzle|umbrella|jacket|coat|freezing|degrees|temperature)\b/i;

function detectWeather(
  msg: string,
  history: StoredMessage[],
  available: Set<string>,
): ForcedToolChoice | undefined {
  if (!available.has("weather_lookup")) return undefined;
  const t = msg.trim();
  if (!isGenericShortFollowUp(t, 50)) return undefined;

  const recent = lastNAssistantMsgs(history, 3);
  const weatherContext = recent.some((a) =>
    assistantUsedTool(a, "weather_lookup") || WEATHER_CONTENT.test(a.content)
  );
  if (!weatherContext) return undefined;

  if (/\b(email|calendar|remind|schedule|draft|send)\b/i.test(t)) return undefined;

  if (WEATHER_TEMPORAL.test(t) || WEATHER_WORDS.test(t) || /\b(what about|and|how about|how's)\b/i.test(t)) {
    return { type: "function", name: "weather_lookup" };
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════
// 3. Web search (web_search)
// ═══════════════════════════════════════════════════════════════

const WEB_SEARCH_CONTENT =
  /\b(according to|search results?|sources? (say|indicate|suggest)|reports? (say|indicate|suggest))\b/i;

function detectWebSearch(
  msg: string,
  history: StoredMessage[],
  available: Set<string>,
): ForcedToolChoice | undefined {
  if (!available.has("web_search")) return undefined;
  const t = msg.trim();
  if (!isGenericShortFollowUp(t, 80)) return undefined;

  const recent = lastNAssistantMsgs(history, 3);
  const usedWebSearch = recent.some((a) =>
    assistantUsedTool(a, "web_search") || WEB_SEARCH_CONTENT.test(a.content)
  );
  if (!usedWebSearch) return undefined;

  if (/\b(email|calendar|remind|schedule|draft|send)\b/i.test(t)) return undefined;

  if (/\b(what about|and|also|more|latest|update|news|any other|how.{0,15}(gone|going|doing|been)|this season|this year)\b/i.test(t)) {
    return { type: "function", name: "web_search" };
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════
// 4. Places search (places_search)
// ═══════════════════════════════════════════════════════════════

const PLACES_CONTENT =
  /\b(rating|stars?|open (now|until|from)|closed|reviews?|phone|address|located at)\b/i;

const PLACES_WORDS =
  /\b(closer|nearer|cheaper|better|other|different|italian|thai|chinese|japanese|indian|mexican|korean|vietnamese|french|greek|pizza|sushi|burger|coffee|brunch|breakfast|lunch|dinner|dessert|vegan|vegetarian|gluten|halal|bar|pub|cafe|restaurant|bakery)\b/i;

function detectPlaces(
  msg: string,
  history: StoredMessage[],
  available: Set<string>,
): ForcedToolChoice | undefined {
  if (!available.has("places_search")) return undefined;
  const t = msg.trim();
  if (!isGenericShortFollowUp(t, 60)) return undefined;

  const a = lastAssistantMsg(history);
  if (!a) return undefined;
  const usedPlaces = assistantUsedTool(a, "places_search") || PLACES_CONTENT.test(a.content);
  if (!usedPlaces) return undefined;

  if (/\b(email|calendar|remind|schedule|draft|send)\b/i.test(t)) return undefined;

  if (PLACES_WORDS.test(t) || /\b(any other|what about|how about|and|more|another)\b/i.test(t)) {
    return { type: "function", name: "places_search" };
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════
// 5. Email read (email_read)
// ═══════════════════════════════════════════════════════════════

function detectEmailRead(
  msg: string,
  history: StoredMessage[],
  available: Set<string>,
): ForcedToolChoice | undefined {
  if (!available.has("email_read")) return undefined;
  const t = msg.trim();
  if (!isGenericShortFollowUp(t, 50)) return undefined;

  const recent = lastNAssistantMsgs(history, 2);
  const emailContext = recent.some((a) => assistantUsedTool(a, "email_read"));
  if (!emailContext) return undefined;

  if (/\b(any (others?|more)|what about|from \w+|older|newer|latest|unread|show me more|next one)\b/i.test(t)) {
    return { type: "function", name: "email_read" };
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════
// 6. Calendar read (calendar_read)
// ═══════════════════════════════════════════════════════════════

const CALENDAR_TEMPORAL =
  /\b(tomorrow|next week|this week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next month|afternoon|morning|evening|tonight)\b/i;

function detectCalendarRead(
  msg: string,
  history: StoredMessage[],
  available: Set<string>,
): ForcedToolChoice | undefined {
  if (!available.has("calendar_read")) return undefined;
  const t = msg.trim();
  if (!isGenericShortFollowUp(t, 50)) return undefined;

  const recent = lastNAssistantMsgs(history, 2);
  const calContext = recent.some((a) => assistantUsedTool(a, "calendar_read"));
  if (!calContext) return undefined;

  if (/\b(email|draft|send|remind)\b/i.test(t)) return undefined;

  if (CALENDAR_TEMPORAL.test(t) || /\b(and|what about|how about|any other|free|busy|available)\b/i.test(t)) {
    return { type: "function", name: "calendar_read" };
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════
// 7. Granola / meeting notes (granola_read)
// ═══════════════════════════════════════════════════════════════

function detectGranolaRead(
  msg: string,
  history: StoredMessage[],
  available: Set<string>,
): ForcedToolChoice | undefined {
  if (!available.has("granola_read")) return undefined;
  const t = msg.trim();
  if (!isGenericShortFollowUp(t, 60)) return undefined;

  const recent = lastNAssistantMsgs(history, 2);
  const granolaContext = recent.some((a) => assistantUsedTool(a, "granola_read"));
  if (!granolaContext) return undefined;

  if (/\b(what else|anything else|more|details?|expand|also discussed|other topics?|full transcript)\b/i.test(t)) {
    return { type: "function", name: "granola_read" };
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════
// 8. Semantic search / recall (semantic_search)
// ═══════════════════════════════════════════════════════════════

function detectSemanticSearch(
  msg: string,
  history: StoredMessage[],
  available: Set<string>,
): ForcedToolChoice | undefined {
  if (!available.has("semantic_search")) return undefined;
  const t = msg.trim();
  if (!isGenericShortFollowUp(t, 50)) return undefined;

  const recent = lastNAssistantMsgs(history, 2);
  const recallContext = recent.some((a) => assistantUsedTool(a, "semantic_search"));
  if (!recallContext) return undefined;

  if (/\b(what else|anything else|more|also|and|what about)\b/i.test(t)) {
    return { type: "function", name: "semantic_search" };
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════
// 9. Reminders (manage_reminder)
// ═══════════════════════════════════════════════════════════════

const REMINDER_MODIFICATION =
  /\b(actually|change|make it|move it|push it|delay|earlier|later|instead|different time|different day|cancel|delete|remove|never ?mind)\b/i;

function detectReminder(
  msg: string,
  history: StoredMessage[],
  available: Set<string>,
): ForcedToolChoice | undefined {
  if (!available.has("manage_reminder")) return undefined;
  const t = msg.trim();
  if (!isGenericShortFollowUp(t, 60)) return undefined;

  const recent = lastNAssistantMsgs(history, 2);
  const reminderContext = recent.some((a) => assistantUsedTool(a, "manage_reminder"));
  if (!reminderContext) return undefined;

  if (REMINDER_MODIFICATION.test(t)) {
    return { type: "function", name: "manage_reminder" };
  }
  // Very short continuations after reminder creation
  if (t.length <= 20 && /^[\w\s.',!…-]+$/u.test(t) && !/\?/.test(t)) {
    return { type: "function", name: "manage_reminder" };
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════
// 10. Notification watches (manage_notification_watch)
// ═══════════════════════════════════════════════════════════════

function detectNotificationWatch(
  msg: string,
  history: StoredMessage[],
  available: Set<string>,
): ForcedToolChoice | undefined {
  if (!available.has("manage_notification_watch")) return undefined;
  const t = msg.trim();
  if (!isGenericShortFollowUp(t, 60)) return undefined;

  const recent = lastNAssistantMsgs(history, 2);
  const watchContext = recent.some((a) => assistantUsedTool(a, "manage_notification_watch"));
  if (!watchContext) return undefined;

  if (/\b(also|and|what about|cancel|delete|remove|change|update|never ?mind)\b/i.test(t)) {
    return { type: "function", name: "manage_notification_watch" };
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════
// 11. Sports follow-up (web_search) — after a web_search for sports
// ═══════════════════════════════════════════════════════════════

const SPORTS_CONTEXT =
  /\b(score|fixture|ladder|standings|round|played|won|lost|beat|defeated|premiership|grand final|semi|final|afl|nrl|nba|nfl|epl|cricket|rugby|tennis|golf|f1|formula\s*1|grand\s*prix|qualifying|quali|fp[1-3]|podium|constructors|drivers.{0,5}championship|motogp|supercars|ufc|mma|soccer|football|season|championship)\b/i;

function detectSportsFollowUp(
  msg: string,
  history: StoredMessage[],
  available: Set<string>,
): ForcedToolChoice | undefined {
  if (!available.has("web_search")) return undefined;
  const t = msg.trim();
  if (!isGenericShortFollowUp(t, 80)) return undefined;

  const recent = lastNAssistantMsgs(history, 3);
  const sportsContext = recent.some((a) =>
    (assistantUsedTool(a, "web_search") && SPORTS_CONTEXT.test(a.content))
  );
  if (!sportsContext) return undefined;

  if (SPORTS_CONTEXT.test(t) || /\b(what about|and|how about|who|any other|how.{0,15}(gone|going|doing|been)|this season|this year)\b/i.test(t)) {
    return { type: "function", name: "web_search" };
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════
// Main entry point — try all detectors in priority order
// ═══════════════════════════════════════════════════════════════

const DETECTORS = [
  detectTransit,
  detectWeather,
  detectSportsFollowUp,
  detectWebSearch,
  detectPlaces,
  detectEmailRead,
  detectCalendarRead,
  detectGranolaRead,
  detectSemanticSearch,
  detectReminder,
  detectNotificationWatch,
] as const;

export function detectToolContinuation(
  userMessage: string,
  history: StoredMessage[],
  availableToolNames: string[],
): ForcedToolChoice | undefined {
  if (availableToolNames.length === 0) return undefined;
  const available = new Set(availableToolNames);

  for (const detect of DETECTORS) {
    const result = detect(userMessage, history, available);
    if (result) {
      const name = typeof result === "string" ? result : result.name;
      console.log(`[tool-continuation] forcing ${name} (detector: ${detect.name})`);
      return result;
    }
  }
  return undefined;
}

// Re-exports for backward compat with transit-tool-force.ts consumers
export { detectTransit as detectTransitContinuationToolChoice };
export type { ForcedToolChoice as ForcedNamedFunctionChoice };
