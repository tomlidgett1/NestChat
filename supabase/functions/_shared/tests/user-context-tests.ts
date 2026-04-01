import {
  extractUserContextPatch,
  mergeUserContextProfile,
  resolveUserContextForMessage,
} from "../user-context.ts";
import type { MemoryItem, UserProfile } from "../state.ts";

function assert(condition: boolean, name: string): void {
  if (!condition) {
    throw new Error(`FAIL: ${name}`);
  }
  console.log(`PASS: ${name}`);
}

const patch = extractUserContextPatch("I'm currently in Melbourne CBD today.");
assert(!!patch?.currentLocation, "extracts current location");
assert(
  patch?.currentLocation?.value === "Melbourne CBD",
  "normalises current location value",
);

const dietPatch = extractUserContextPatch("I'm vegetarian.");
assert(
  dietPatch?.dietaryPreferences?.includes("vegetarian") ?? false,
  "extracts dietary preferences",
);

const merged = mergeUserContextProfile(
  {
    homeLocation: {
      value: "Melbourne",
      precision: "city",
      updatedAt: "2026-03-23T09:00:00.000Z",
      source: "explicit_user",
    },
    dietaryPreferences: ["vegetarian"],
  },
  extractUserContextPatch("I often work from Southbank.") ?? {},
);
assert(merged.workLocation?.value === "Southbank", "merges work location");
assert(
  merged.dietaryPreferences?.includes("vegetarian") ?? false,
  "preserves dietary preferences when merging",
);

const profile: UserProfile = {
  handle: "+61400000000",
  name: "Tom",
  facts: [],
  useLinq: false,
  firstSeen: 0,
  lastSeen: 0,
  deepProfileSnapshot: null,
  deepProfileBuiltAt: null,
  contextProfile: {
    homeLocation: {
      value: "Melbourne",
      precision: "city",
      updatedAt: "2026-03-23T09:00:00.000Z",
      source: "explicit_user",
    },
    currentLocation: {
      value: "Melbourne CBD",
      precision: "suburb",
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      source: "explicit_user",
    },
    workLocation: {
      value: "Southbank",
      precision: "suburb",
      updatedAt: "2026-03-23T09:00:00.000Z",
      source: "explicit_user",
    },
    dietaryPreferences: ["vegetarian"],
  },
};

const noMemories: MemoryItem[] = [];

const weatherContext = resolveUserContextForMessage(
  "Will it rain this afternoon?",
  profile,
  noMemories,
  "Australia/Melbourne",
);
assert(
  weatherContext?.assumedLocation?.label === "Melbourne CBD",
  "weather prefers fresh current location",
);
assert(
  weatherContext?.assumptionPolicy === "direct",
  "weather uses direct assumption with structured context",
);

const workContext = resolveUserContextForMessage(
  "Good lunch near my office?",
  profile,
  noMemories,
  "Australia/Melbourne",
);
assert(
  workContext?.assumedLocation?.label === "Southbank",
  "work prompts prefer work location",
);

const serviceContext = resolveUserContextForMessage(
  "Can Uber Eats deliver here?",
  profile,
  noMemories,
  "Australia/Melbourne",
);
assert(
  serviceContext?.assumptionPolicy === "clarify",
  "service availability clarifies when only city precision is known",
);

const fallbackProfile: UserProfile = {
  ...profile,
  contextProfile: null,
  facts: ["Lives in Melbourne", "Works from Southbank"],
};
const fallbackContext = resolveUserContextForMessage(
  "Any good coffee near me?",
  fallbackProfile,
  noMemories,
  "Australia/Melbourne",
);
assert(
  fallbackContext?.assumedLocation?.label.toLowerCase().includes("melbourne"),
  "falls back to legacy profile facts when structured context is missing",
);

console.log("All user context tests passed.");
