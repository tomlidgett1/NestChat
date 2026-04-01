// Run: deno run --allow-all supabase/functions/_shared/tests/test-transit-tool-force.ts

import type { StoredMessage } from "../state.ts";
import {
  detectTransitContinuationToolChoice,
  isAmbiguousTransitFollowUp,
  lastAssistantLooksLikeTransitReply,
} from "../orchestrator/transit-tool-force.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const transitAssistant: StoredMessage = {
  role: "assistant",
  content: "**Fastest right now:** 56 mins",
  metadata: { tools_used: [{ tool: "travel_time", detail: "A → B (transit)" }] },
};

const genericAssistant: StoredMessage = {
  role: "assistant",
  content: "Sounds good, let me know if you need anything else.",
};

assert(
  lastAssistantLooksLikeTransitReply([transitAssistant]),
  "metadata travel_time counts as transit reply",
);
assert(
  !lastAssistantLooksLikeTransitReply([genericAssistant]),
  "generic assistant is not transit",
);
assert(
  lastAssistantLooksLikeTransitReply([
    genericAssistant,
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "Google Maps is showing about 40 min by tram.",
    },
  ]),
  "content signal without metadata still counts",
);

assert(isAmbiguousTransitFollowUp("Please"), '"Please" is ambiguous');
assert(isAmbiguousTransitFollowUp("fewer transfers"), "preference shorthand");
assert(!isAmbiguousTransitFollowUp("What's the weather in Sydney?"), "question + weather");

const names = ["travel_time", "web_search"];
assert(
  detectTransitContinuationToolChoice("Please", [transitAssistant], names)?.name ===
    "travel_time",
  "forces travel_time after transit assistant",
);
assert(
  detectTransitContinuationToolChoice("Please", [genericAssistant], names) === undefined,
  "does not force without transit context",
);
assert(
  detectTransitContinuationToolChoice("Please", [transitAssistant], ["web_search"]) ===
    undefined,
  "does not force when travel_time not available",
);

console.log("transit-tool-force: all assertions passed");
