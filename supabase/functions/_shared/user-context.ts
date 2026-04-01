import type {
  MemoryItem,
  UserContextLocation,
  UserContextLocationPrecision,
  UserContextProfile,
  UserProfile,
} from "./state.ts";
import type {
  AssumptionPolicy,
  LocationConfidence,
  LocationPrecision,
  LocationRole,
  ResolvedLocationContext,
  ResolvedUserContext,
} from "./orchestrator/types.ts";

const CURRENT_LOCATION_TTL_MS = 24 * 60 * 60 * 1000;

const HOME_LOCATION_PATTERNS = [
  /\b(?:i live in|i'm based in|i am based in|i'm from|i am from)\s+(.+)$/i,
  /\b(?:home is in|my home is in)\s+(.+)$/i,
];
const CURRENT_LOCATION_PATTERNS = [
  /\b(?:i'm currently in|i am currently in|currently in)\s+(.+)$/i,
  /\b(?:i'm in|i am in|staying in|visiting)\s+(.+?)\s+(?:today|tonight|this week|this weekend|for now)$/i,
  /\b(?:i'm in|i am in|staying in|visiting)\s+(.+)$/i,
];
const WORK_LOCATION_PATTERNS = [
  /\b(?:i often work from|i usually work from|i work from)\s+(.+)$/i,
  /\b(?:i work in|i work at)\s+(.+)$/i,
  /\b(?:my office is in|my office is at)\s+(.+)$/i,
];

const DIETARY_PATTERNS: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /\b(i'm vegetarian|i am vegetarian|i dont eat meat|i don't eat meat)\b/i, value: "vegetarian" },
  { pattern: /\b(i'm vegan|i am vegan)\b/i, value: "vegan" },
  { pattern: /\b(i'm gluten[- ]free|i am gluten[- ]free)\b/i, value: "gluten_free" },
  { pattern: /\b(i'm dairy[- ]free|i am dairy[- ]free)\b/i, value: "dairy_free" },
  { pattern: /\b(i eat halal|i'm halal|i am halal)\b/i, value: "halal" },
  { pattern: /\b(i eat kosher|i'm kosher|i am kosher)\b/i, value: "kosher" },
];

const WORK_PROMPT_PATTERN =
  /\b(work|office|after work|near work|near my office|my office)\b/i;
const WEATHER_PROMPT_PATTERN =
  /\b(weather|forecast|rain|temperature|degrees|humid|umbrella|jacket|sunset|sunrise|air quality)\b/i;
const LOCAL_DISCOVERY_PATTERN =
  /\b(near me|nearby|nearest|good lunch|good coffee|coffee|brunch|dinner|lunch|restaurant|restaurants|pharmacy|chemist|park|gym|what's on|what’s on|events?|markets?|open now|opening hours?)\b/i;
const SERVICE_AVAILABILITY_PATTERN =
  /\b(deliver(?:y)?|available here|same[- ]day|coverage|provider|providers|internet|ubereats|doordash|instacart|service area|ship here)\b/i;
const EXACT_TRAVEL_PATTERN =
  /\b(directions?\b|how long to get|how far to|from .{1,40} to .{1,40}|walk to|drive to|cycle to|train from .{1,40} to|bus from .{1,40} to|tram from .{1,40} to|airport from home|from home)\b/i;

type PromptClass =
  | "general"
  | "weather"
  | "local_discovery"
  | "service_availability"
  | "exact_travel"
  | "work_local";

function normaliseLocationValue(raw: string): string {
  return raw
    .replace(
      /^(?:lives?|living|home(?: is)?|based|from|currently|staying|visiting|works?|working|office(?: is)?)\s+(?:in|at|from)?\s*/i,
      "",
    )
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/\b(?:today|tonight|this week|this weekend|for now)$/i, "")
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "")
    .trim();
}

function inferPrecision(value: string): UserContextLocationPrecision {
  if (/\b\d{1,5}\s+[\w'.-]+\s+(street|st|road|rd|avenue|ave|boulevard|blvd|drive|dr|lane|ln|way|place|pl|court|ct|crescent|cr|parade|pde|highway|hwy|circuit)\b/i.test(value)) {
    return "address";
  }
  if (/\b(cbd|suburb|district|neighbourhood|neighborhood|borough|shire)\b/i.test(value)) {
    return "suburb";
  }
  if (value.split(",").length >= 2) {
    return "city";
  }
  if (/\b(vic|victoria|nsw|new south wales|qld|queensland|wa|western australia|sa|south australia|tas|tasmania|act|nt)\b/i.test(value)) {
    return "state";
  }
  if (value.trim().split(/\s+/).length <= 3) {
    return "city";
  }
  return "unknown";
}

function buildLocation(
  value: string,
  source: UserContextLocation["source"],
  opts?: { expiresAt?: string | null },
): UserContextLocation {
  return {
    value,
    precision: inferPrecision(value),
    updatedAt: new Date().toISOString(),
    expiresAt: opts?.expiresAt ?? null,
    source,
  };
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

function isCurrentLocationFresh(location: UserContextLocation | null | undefined): boolean {
  if (!location) return false;
  if (!location.expiresAt) return true;
  return new Date(location.expiresAt).getTime() > Date.now();
}

function toResolvedLocation(
  location: UserContextLocation,
  role: LocationRole,
  source: ResolvedLocationContext["source"],
): ResolvedLocationContext {
  const freshnessMs = Date.now() - new Date(location.updatedAt).getTime();
  let confidence: LocationConfidence = "high";
  if (role === "current" && freshnessMs > CURRENT_LOCATION_TTL_MS) {
    confidence = "low";
  } else if (freshnessMs > 30 * 24 * 60 * 60 * 1000) {
    confidence = "medium";
  }

  return {
    label: location.value,
    role,
    precision: location.precision as LocationPrecision,
    confidence,
    source,
    explicitness: source === "timezone" ? "fallback" : "explicit",
    memoryId: null,
    lastUpdatedAt: location.updatedAt,
  };
}

function classifyPrompt(message: string): PromptClass {
  if (WORK_PROMPT_PATTERN.test(message)) return "work_local";
  if (EXACT_TRAVEL_PATTERN.test(message)) return "exact_travel";
  if (SERVICE_AVAILABILITY_PATTERN.test(message)) return "service_availability";
  if (WEATHER_PROMPT_PATTERN.test(message)) return "weather";
  if (LOCAL_DISCOVERY_PATTERN.test(message)) return "local_discovery";
  return "general";
}

function timezoneFallbackLocation(timezone?: string | null): ResolvedLocationContext | null {
  if (!timezone || !timezone.includes("/")) return null;
  const label = timezone.split("/").pop()?.replace(/_/g, " ").trim();
  if (!label) return null;
  return {
    label,
    role: "regional",
    precision: "timezone_region",
    confidence: "low",
    source: "timezone",
    explicitness: "fallback",
    memoryId: null,
    lastUpdatedAt: null,
  };
}

function memoryToFallbackLocation(
  memoryItems: MemoryItem[],
  role: "home" | "current" | "work",
): ResolvedLocationContext | null {
  for (const memory of memoryItems) {
    const category = memory.category.toLowerCase();
    const value = memory.valueText.trim();
    if (!value) continue;
    const hasLocationSignal = category.includes("location") ||
      category.includes("home") || category.includes("city") ||
      category.includes("address");
    if (!hasLocationSignal) continue;

    const lower = value.toLowerCase();
    if (role === "work" && !/\b(work|works|office)\b/.test(lower)) continue;
    if (role === "current" && !/\b(currently|today|tonight|this week|for now|staying|visiting)\b/.test(lower)) continue;
    if (
      role === "home" &&
      /\b(currently|today|tonight|this week|for now|staying|visiting|work|works|office)\b/
        .test(lower)
    ) continue;

    return {
      label: normaliseLocationValue(value),
      role: role === "work" ? "frequent" : role,
      precision: inferPrecision(value) as LocationPrecision,
      confidence: "medium",
      source: "memory",
      explicitness: "inferred",
      memoryId: memory.id,
      lastUpdatedAt: memory.lastConfirmedAt ?? memory.lastSeenAt ?? memory.createdAt,
    };
  }
  return null;
}

function factsToFallbackLocation(
  facts: string[],
  role: "home" | "current" | "work",
): ResolvedLocationContext | null {
  for (const fact of facts) {
    const lower = fact.toLowerCase();
    if (role === "work" && !/\b(work|works|office)\b/.test(lower)) continue;
    if (role === "current" && !/\b(currently|today|tonight|this week|for now|staying|visiting)\b/.test(lower)) continue;
    if (
      role === "home" &&
      /\b(currently|today|tonight|this week|for now|staying|visiting|work|works|office)\b/
        .test(lower)
    ) continue;
    if (!/\b(live|lives|based|home|from|currently|work|works|office|staying|visiting)\b/.test(lower)) {
      continue;
    }

    return {
      label: normaliseLocationValue(fact),
      role: role === "work" ? "frequent" : role,
      precision: inferPrecision(fact) as LocationPrecision,
      confidence: "medium",
      source: "profile",
      explicitness: "inferred",
      memoryId: null,
      lastUpdatedAt: null,
    };
  }
  return null;
}

export function extractUserContextPatch(
  message: string,
): Partial<UserContextProfile> | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  const patch: Partial<UserContextProfile> = {};
  const currentExpiry = new Date(Date.now() + CURRENT_LOCATION_TTL_MS).toISOString();

  for (const pattern of HOME_LOCATION_PATTERNS) {
    const match = trimmed.match(pattern);
    if (!match?.[1]) continue;
    const value = normaliseLocationValue(match[1]);
    if (value) {
      patch.homeLocation = buildLocation(value, "explicit_user");
      break;
    }
  }

  for (const pattern of CURRENT_LOCATION_PATTERNS) {
    const match = trimmed.match(pattern);
    if (!match?.[1]) continue;
    const value = normaliseLocationValue(match[1]);
    if (value) {
      patch.currentLocation = buildLocation(value, "explicit_user", {
        expiresAt: currentExpiry,
      });
      break;
    }
  }

  for (const pattern of WORK_LOCATION_PATTERNS) {
    const match = trimmed.match(pattern);
    if (!match?.[1]) continue;
    const value = normaliseLocationValue(match[1]);
    if (value) {
      patch.workLocation = buildLocation(value, "explicit_user");
      break;
    }
  }

  const dietaryPreferences = DIETARY_PATTERNS
    .filter(({ pattern }) => pattern.test(trimmed))
    .map(({ value }) => value);
  if (dietaryPreferences.length > 0) {
    patch.dietaryPreferences = dedupeStrings(dietaryPreferences);
  }

  if (Object.keys(patch).length === 0) return null;
  patch.updatedAt = new Date().toISOString();
  return patch;
}

export function mergeUserContextProfile(
  existing: UserContextProfile | null | undefined,
  patch: Partial<UserContextProfile>,
): UserContextProfile {
  const merged: UserContextProfile = {
    ...(existing ?? {}),
    ...patch,
    dietaryPreferences: dedupeStrings([
      ...((existing?.dietaryPreferences ?? [])),
      ...((patch.dietaryPreferences ?? [])),
    ]),
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
  };

  if (merged.currentLocation && !isCurrentLocationFresh(merged.currentLocation)) {
    merged.currentLocation = null;
  }

  return merged;
}

export function resolveUserContextForMessage(
  message: string,
  senderProfile: UserProfile | null,
  memoryItems: MemoryItem[],
  timezone?: string | null,
): ResolvedUserContext | null {
  const contextProfile = senderProfile?.contextProfile ?? null;
  const promptClass = classifyPrompt(message);
  const facts = senderProfile?.facts ?? [];

  const homeLocation =
    (contextProfile?.homeLocation
      ? toResolvedLocation(contextProfile.homeLocation, "home", "profile")
      : null) ??
    memoryToFallbackLocation(memoryItems, "home") ??
    factsToFallbackLocation(facts, "home");
  const currentLocation =
    (contextProfile?.currentLocation && isCurrentLocationFresh(contextProfile.currentLocation)
      ? toResolvedLocation(contextProfile.currentLocation, "current", "profile")
      : null) ??
    memoryToFallbackLocation(memoryItems, "current") ??
    factsToFallbackLocation(facts, "current");
  const workLocation =
    (contextProfile?.workLocation
      ? toResolvedLocation(contextProfile.workLocation, "frequent", "profile")
      : null) ??
    memoryToFallbackLocation(memoryItems, "work") ??
    factsToFallbackLocation(facts, "work");

  let assumedLocation: ResolvedLocationContext | null = null;
  let assumptionPolicy: AssumptionPolicy = "clarify";
  const reasons = [`Prompt class: ${promptClass}.`];

  if (promptClass === "work_local") {
    if (workLocation) {
      assumedLocation = workLocation;
      assumptionPolicy = "direct";
      reasons.push(`Using work location: ${workLocation.label}.`);
    } else {
      reasons.push("Work prompt with no work location saved.");
    }
  } else if (promptClass === "weather" || promptClass === "local_discovery") {
    assumedLocation = currentLocation ?? homeLocation ?? timezoneFallbackLocation(timezone);
    if (assumedLocation) {
      assumptionPolicy = assumedLocation.source === "timezone"
        ? "soft_assumption"
        : "direct";
      reasons.push(`Using low-risk local anchor: ${assumedLocation.label}.`);
    }
  } else if (promptClass === "service_availability") {
    assumedLocation = homeLocation ?? currentLocation ?? timezoneFallbackLocation(timezone);
    if (assumedLocation) {
      const preciseEnough = ["suburb", "address"].includes(assumedLocation.precision);
      assumptionPolicy = preciseEnough ? "direct" : "clarify";
      reasons.push(
        preciseEnough
          ? `Using service-availability anchor: ${assumedLocation.label}.`
          : `Need finer location precision than ${assumedLocation.precision}.`,
      );
    }
  } else if (promptClass === "exact_travel") {
    assumedLocation = workLocation ?? currentLocation ?? homeLocation;
    assumptionPolicy = "clarify";
    reasons.push("Exact travel prompt requires explicit routable origin/destination.");
  } else {
    assumedLocation = currentLocation ?? homeLocation ?? workLocation ?? timezoneFallbackLocation(timezone);
    if (assumedLocation) {
      assumptionPolicy = assumedLocation.source === "timezone"
        ? "soft_assumption"
        : "direct";
    }
  }

  return {
    homeLocation,
    currentLocation,
    workLocation,
    assumedLocation,
    assumptionPolicy,
    dietaryPreferences: dedupeStrings(contextProfile?.dietaryPreferences ?? []),
    reasons,
  };
}
