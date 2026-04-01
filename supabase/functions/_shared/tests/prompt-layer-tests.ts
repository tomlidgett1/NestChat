import { chatAgent } from "../agents/chat.ts";
import {
  composeCompactPrompt,
  composePrompt,
  composeResearchLitePrompt,
} from "../agents/prompt-layers.ts";
import { smartAgent } from "../agents/smart.ts";
import { emptyWorkingMemory } from "../orchestrator/types.ts";
import type {
  ConversationSummary,
  MemoryItem,
  TurnContext,
  TurnInput,
} from "../orchestrator/types.ts";

function assert(condition: boolean, name: string): void {
  if (!condition) {
    throw new Error(`FAIL: ${name}`);
  }
  console.log(`PASS: ${name}`);
}

function makeInput(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    chatId: "TEST#prompt-layers",
    userMessage: "good morning",
    images: [],
    audio: [],
    senderHandle: "tom@example.com",
    isGroupChat: false,
    participantNames: [],
    chatName: null,
    authUserId: null,
    isOnboarding: false,
    timezone: "Australia/Melbourne",
    ...overrides,
  };
}

function makeMemoryItem(overrides: Partial<MemoryItem>): MemoryItem {
  return {
    id: 1,
    handle: "tom@example.com",
    chatId: "TEST#prompt-layers",
    memoryType: "identity",
    category: "name",
    valueText: "Tom",
    normalizedValue: "tom",
    confidence: 0.9,
    status: "active",
    scope: "user",
    sourceKind: "legacy_migration",
    firstSeenAt: "2026-03-01T00:00:00.000Z",
    lastSeenAt: "2026-03-10T00:00:00.000Z",
    lastConfirmedAt: "2026-03-10T00:00:00.000Z",
    expiryAt: null,
    metadata: {},
    createdAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSummary(
  overrides: Partial<ConversationSummary>,
): ConversationSummary {
  return {
    id: 1,
    chatId: "TEST#prompt-layers",
    senderHandle: "tom@example.com",
    summary:
      "Tom was planning a Blacklane strategy session and a dinner later in the week.",
    topics: ["work", "dinner"],
    openLoops: ["follow up on strategy session timing"],
    summaryKind: "rolling",
    firstMessageAt: "2026-03-10T00:00:00.000Z",
    lastMessageAt: "2026-03-12T00:00:00.000Z",
    messageCount: 6,
    confidence: 0.9,
    createdAt: "2026-03-12T00:00:00.000Z",
    ...overrides,
  };
}

function makeContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    history: [],
    formattedHistory: [],
    messageContent: [{ type: "input_text", text: "good morning" }],
    recentTurns: [
      { role: "assistant", content: "Morning. Big day?" },
      { role: "user", content: "yeah, got that strategy session later" },
    ],
    memoryItems: [],
    summaries: [],
    toolTraces: [],
    ragEvidence: "",
    ragEvidenceBlockCount: 0,
    senderProfile: {
      handle: "tom@example.com",
      name: "Tom",
      facts: ["Lives in Melbourne", "Works at Blacklane"],
      useLinq: false,
      firstSeen: 1740960000,
      lastSeen: Math.floor(Date.now() / 1000) - 60 * 60 * 14,
      deepProfileSnapshot: null,
      deepProfileBuiltAt: null,
    },
    connectedAccounts: [],
    transcriptions: [],
    transcriptionFailed: false,
    workingMemory: emptyWorkingMemory(),
    pendingEmailSend: null,
    pendingEmailSends: [],
    resolvedUserContext: {
      homeLocation: {
        label: "Melbourne",
        role: "home",
        precision: "city",
        confidence: "high",
        source: "memory",
        explicitness: "explicit",
        memoryId: 2,
        lastUpdatedAt: "2026-03-10T00:00:00.000Z",
      },
      currentLocation: null,
      workLocation: null,
      assumedLocation: {
        label: "Melbourne",
        role: "home",
        precision: "city",
        confidence: "high",
        source: "memory",
        explicitness: "explicit",
        memoryId: 2,
        lastUpdatedAt: "2026-03-10T00:00:00.000Z",
      },
      assumptionPolicy: "direct",
      dietaryPreferences: [],
      reasons: ["Home location candidate: Melbourne (high, city)."],
    },
    ...overrides,
  };
}

const richContext = makeContext({
  memoryItems: [
    makeMemoryItem({
      id: 1,
      category: "name",
      valueText: "Tom",
      normalizedValue: "tom",
    }),
    makeMemoryItem({
      id: 2,
      memoryType: "bio_fact",
      category: "home",
      valueText: "Lives in Melbourne",
      normalizedValue: "lives in melbourne",
    }),
    makeMemoryItem({
      id: 3,
      memoryType: "bio_fact",
      category: "job",
      valueText: "Works at Blacklane",
      normalizedValue: "works at blacklane",
    }),
    makeMemoryItem({
      id: 4,
      memoryType: "preference",
      category: "food",
      valueText: "Prefers late-night food spots",
      normalizedValue: "prefers late-night food spots",
    }),
  ],
  summaries: [
    makeSummary(),
  ],
});

const chatPrompt = composePrompt(
  chatAgent,
  richContext,
  makeInput({ userMessage: "good morning" }),
);

assert(
  chatPrompt.includes("Conversation behaviour"),
  "shared behaviour layer is included",
);
assert(
  chatPrompt.includes("Memory and continuity"),
  "shared continuity layer is included",
);
assert(
  chatPrompt.includes("Message shaping"),
  "shared message shaping layer is included",
);
assert(chatPrompt.includes("Mode: Casual chat"), "chat mode layer is included");
assert(
  chatPrompt.includes("The user is writing in lowercase."),
  "lowercase style cue is included",
);
assert(
  chatPrompt.includes("capitalise the first letter of every sentence"),
  "lowercase style cue requires sentence case",
);
assert(chatPrompt.includes("Thread state:"), "re-entry thread cue is included");
assert(
  chatPrompt.includes("Location anchors:"),
  "location anchors are surfaced",
);
assert(chatPrompt.includes("Work anchors:"), "work anchors are surfaced");
assert(chatPrompt.includes("Open threads:"), "open loops are surfaced");
assert(
  chatPrompt.includes('Never start a follow-up question with "Want...?"'),
  "want-style follow-up ban is present",
);
assert(
  chatPrompt.includes("Have a point of view."),
  "shared behaviour layer includes honest point-of-view guidance",
);
assert(
  chatPrompt.includes("Do not over-function."),
  "shared behaviour layer includes anti-overfunction guidance",
);

const smartPrompt = composePrompt(
  smartAgent,
  richContext,
  makeInput({ userMessage: "draft a reply to that email" }),
);

assert(
  smartPrompt.includes("Mode: Task and agentic work"),
  "smart mode layer is included",
);
assert(
  smartPrompt.includes("Resolved local context"),
  "full prompt carries resolved local context",
);

const compactUnknownTimezone = composeCompactPrompt(
  makeContext({
    memoryItems: [],
    summaries: [],
    senderProfile: {
      handle: "tom@example.com",
      name: "Tom",
      facts: [],
      useLinq: false,
      firstSeen: 1740960000,
      lastSeen: Math.floor(Date.now() / 1000) - 60 * 60 * 20,
      deepProfileSnapshot: null,
      deepProfileBuiltAt: null,
    },
    resolvedUserContext: null,
  }),
  makeInput({ timezone: null, userMessage: "hey" }),
);

assert(
  compactUnknownTimezone.includes("timezone is unknown"),
  "compact prompt does not guess a timezone",
);
assert(
  !compactUnknownTimezone.includes("Australia/Sydney"),
  "compact prompt no longer falls back to Sydney",
);

const compactRich = composeCompactPrompt(
  richContext,
  makeInput({ userMessage: "good morning" }),
);

assert(
  compactRich.includes("Relevant personal context"),
  "compact prompt carries personal context",
);
assert(
  compactRich.includes("Open thread"),
  "compact prompt carries an open thread",
);
assert(
  compactRich.includes("Local daypart:"),
  "compact prompt carries a daypart cue",
);

const researchLitePrompt = composeResearchLitePrompt(
  richContext,
  makeInput({ userMessage: "weather today" }),
);

assert(
  researchLitePrompt.includes("Resolved local context"),
  "research-lite prompt carries resolved local context",
);
assert(
  researchLitePrompt.includes("Assumed location for low-risk local questions: Melbourne."),
  "research-lite prompt carries the assumed local location",
);

console.log("All prompt layer tests passed.");
