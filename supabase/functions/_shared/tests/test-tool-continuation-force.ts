// Run: deno run --allow-all supabase/functions/_shared/tests/test-tool-continuation-force.ts

import type { StoredMessage } from "../state.ts";
import { detectToolContinuation } from "../orchestrator/tool-continuation-force.ts";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    passed++;
  }
}

function toolName(result: ReturnType<typeof detectToolContinuation>): string | undefined {
  if (!result) return undefined;
  return typeof result === "string" ? result : result.name;
}

function mkAssistant(content: string, tools?: string[]): StoredMessage {
  return {
    role: "assistant",
    content,
    metadata: tools ? { tools_used: tools.map((t) => ({ tool: t })) } : undefined,
  };
}

const ALL_TOOLS = [
  "travel_time", "weather_lookup", "web_search", "places_search",
  "email_read", "calendar_read", "granola_read", "semantic_search",
  "manage_reminder", "manage_notification_watch",
];

// ═══════════════════════════════════════════════════════════════
// 1. Transit
// ═══════════════════════════════════════════════════════════════
console.log("--- Transit ---");

assert(
  toolName(detectToolContinuation("Please", [mkAssistant("**Fastest right now:** 56 mins", ["travel_time"])], ALL_TOOLS)) === "travel_time",
  '"Please" after transit → travel_time',
);
assert(
  toolName(detectToolContinuation("fewer transfers", [mkAssistant("Board at: ...", ["travel_time"])], ALL_TOOLS)) === "travel_time",
  '"fewer transfers" after transit → travel_time',
);
assert(
  toolName(detectToolContinuation("what about the train?", [mkAssistant("Google Maps is showing 40min", ["travel_time"])], ALL_TOOLS)) === "travel_time",
  '"what about the train?" (transit noun) after transit → travel_time',
);
assert(
  toolName(detectToolContinuation("What's the weather?", [mkAssistant("56 mins", ["travel_time"])], ALL_TOOLS)) === undefined,
  "weather topic shift after transit → undefined",
);
assert(
  toolName(detectToolContinuation("Please", [mkAssistant("Sounds good!")], ALL_TOOLS)) === undefined,
  '"Please" with no transit context → undefined',
);

// ═══════════════════════════════════════════════════════════════
// 2. Weather
// ═══════════════════════════════════════════════════════════════
console.log("--- Weather ---");

assert(
  toolName(detectToolContinuation("tomorrow?", [mkAssistant("Current: 24°C, sunny", ["weather_lookup"])], ALL_TOOLS)) === "weather_lookup",
  '"tomorrow?" after weather → weather_lookup',
);
assert(
  toolName(detectToolContinuation("what about Saturday?", [mkAssistant("forecast: rain", ["weather_lookup"])], ALL_TOOLS)) === "weather_lookup",
  '"what about Saturday?" after weather → weather_lookup',
);
assert(
  toolName(detectToolContinuation("will I need an umbrella?", [mkAssistant("24°C, sunny", ["weather_lookup"])], ALL_TOOLS)) === "weather_lookup",
  '"will I need an umbrella?" (weather word) → weather_lookup',
);
assert(
  toolName(detectToolContinuation("draft an email", [mkAssistant("24°C", ["weather_lookup"])], ALL_TOOLS)) === undefined,
  "email topic shift after weather → undefined",
);

// ═══════════════════════════════════════════════════════════════
// 3. Sports / web search continuation
// ═══════════════════════════════════════════════════════════════
console.log("--- Sports / Web Search ---");

assert(
  toolName(detectToolContinuation("what about Collingwood?", [mkAssistant("Essendon won by 30 points [web_search]", ["web_search"])], ALL_TOOLS)) === "web_search",
  "sports follow-up after web_search with sports content → web_search",
);
assert(
  toolName(detectToolContinuation("any other news?", [mkAssistant("Here's the latest...", ["web_search"])], ALL_TOOLS)) === "web_search",
  '"any other news?" after web_search → web_search',
);

// ═══════════════════════════════════════════════════════════════
// 4. Places search
// ═══════════════════════════════════════════════════════════════
console.log("--- Places ---");

assert(
  toolName(detectToolContinuation("any Italian?", [mkAssistant("Here are 3 restaurants, rating 4.5 stars", ["places_search"])], ALL_TOOLS)) === "places_search",
  '"any Italian?" after places_search → places_search',
);
assert(
  toolName(detectToolContinuation("what about closer?", [mkAssistant("Located at Collins St", ["places_search"])], ALL_TOOLS)) === "places_search",
  '"what about closer?" after places → places_search',
);

// ═══════════════════════════════════════════════════════════════
// 5. Email read
// ═══════════════════════════════════════════════════════════════
console.log("--- Email Read ---");

assert(
  toolName(detectToolContinuation("any others?", [mkAssistant("Found 3 emails from Sarah", ["email_read"])], ALL_TOOLS)) === "email_read",
  '"any others?" after email_read → email_read',
);
assert(
  toolName(detectToolContinuation("what about from Daniel?", [mkAssistant("Found emails...", ["email_read"])], ALL_TOOLS)) === "email_read",
  '"what about from Daniel?" after email_read → email_read',
);

// ═══════════════════════════════════════════════════════════════
// 6. Calendar read
// ═══════════════════════════════════════════════════════════════
console.log("--- Calendar Read ---");

assert(
  toolName(detectToolContinuation("and next week?", [mkAssistant("You have 3 meetings tomorrow", ["calendar_read"])], ALL_TOOLS)) === "calendar_read",
  '"and next week?" after calendar_read → calendar_read',
);
assert(
  toolName(detectToolContinuation("am I free Thursday?", [mkAssistant("Your schedule for today", ["calendar_read"])], ALL_TOOLS)) === "calendar_read",
  '"am I free Thursday?" after calendar_read → calendar_read',
);

// ═══════════════════════════════════════════════════════════════
// 7. Granola / meeting notes
// ═══════════════════════════════════════════════════════════════
console.log("--- Granola ---");

assert(
  toolName(detectToolContinuation("what else was discussed?", [mkAssistant("In the meeting, Ryan mentioned...", ["granola_read"])], ALL_TOOLS)) === "granola_read",
  '"what else was discussed?" after granola_read → granola_read',
);
assert(
  toolName(detectToolContinuation("any other topics?", [mkAssistant("Meeting notes from...", ["granola_read"])], ALL_TOOLS)) === "granola_read",
  '"any other topics?" after granola → granola_read',
);

// ═══════════════════════════════════════════════════════════════
// 8. Semantic search / recall
// ═══════════════════════════════════════════════════════════════
console.log("--- Semantic Search ---");

assert(
  toolName(detectToolContinuation("what else do you know?", [mkAssistant("I remember you said...", ["semantic_search"])], ALL_TOOLS)) === "semantic_search",
  '"what else do you know?" after semantic_search → semantic_search',
);

// ═══════════════════════════════════════════════════════════════
// 9. Reminders
// ═══════════════════════════════════════════════════════════════
console.log("--- Reminders ---");

assert(
  toolName(detectToolContinuation("actually make it 3pm", [mkAssistant("Done ✓ — I'll remind you at 2pm", ["manage_reminder"])], ALL_TOOLS)) === "manage_reminder",
  '"actually make it 3pm" after manage_reminder → manage_reminder',
);
assert(
  toolName(detectToolContinuation("cancel that", [mkAssistant("Done ✓ — reminder set", ["manage_reminder"])], ALL_TOOLS)) === "manage_reminder",
  '"cancel that" after manage_reminder → manage_reminder',
);

// ═══════════════════════════════════════════════════════════════
// 10. Notification watches
// ═══════════════════════════════════════════════════════════════
console.log("--- Notification Watches ---");

assert(
  toolName(detectToolContinuation("also watch for calendar invites", [mkAssistant("Done ✓ — watching for emails from Tom", ["manage_notification_watch"])], ALL_TOOLS)) === "manage_notification_watch",
  '"also watch for calendar invites" after watch → manage_notification_watch',
);

// ═══════════════════════════════════════════════════════════════
// 11. No false positives — long messages or topic shifts
// ═══════════════════════════════════════════════════════════════
console.log("--- No false positives ---");

assert(
  toolName(detectToolContinuation(
    "Actually I changed my mind, can you tell me about the history of ancient Rome?",
    [mkAssistant("24°C", ["weather_lookup"])],
    ALL_TOOLS,
  )) === undefined,
  "long topic shift after weather → undefined",
);
assert(
  toolName(detectToolContinuation("", [mkAssistant("test", ["web_search"])], ALL_TOOLS)) === undefined,
  "empty message → undefined",
);
assert(
  toolName(detectToolContinuation("any others?", [mkAssistant("Sounds good, let me know!")], ALL_TOOLS)) === undefined,
  '"any others?" with no tool context → undefined',
);

// ═══════════════════════════════════════════════════════════════
// Results
// ═══════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) Deno.exit(1);
console.log("tool-continuation-force: all assertions passed");
