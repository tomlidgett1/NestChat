import type { RouteDecision, ToolNamespace, TurnInput } from "./types.ts";

export type CompareRoutePreset = "auto" | "casual_lane" | "full_compose";

/** DBG# compare-tooling only: force routing path for side-by-side testing. */
export function applyCompareRouteOverride(
  input: TurnInput,
  route: RouteDecision,
): RouteDecision {
  if (!input.chatId.startsWith("DBG#")) return route;

  const preset = input.compareRoutePreset as CompareRoutePreset | undefined;
  if (!preset || preset === "auto") return route;

  if (preset === "casual_lane") {
    return {
      ...route,
      routeLayer: "0B-casual",
      memoryDepth: "none",
      agent: "casual",
      mode: "direct",
      allowedNamespaces: [] as ToolNamespace[],
      fastPathUsed: false,
      needsMemoryRead: false,
      needsMemoryWriteCandidate: false,
      needsWebFreshness: false,
      routeReason: `[compare:casual_lane] ${route.routeReason ?? ""}`.trim(),
    };
  }

  if (preset === "full_compose") {
    const layer = route.routeLayer === "0B-casual"
      ? "0C"
      : route.routeLayer;
    return {
      ...route,
      memoryDepth: "full",
      fastPathUsed: false,
      routeLayer: layer,
      routeReason: `[compare:full_compose] ${route.routeReason ?? ""}`.trim(),
    };
  }

  return route;
}
