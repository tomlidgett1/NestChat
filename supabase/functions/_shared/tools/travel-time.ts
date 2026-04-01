import type { ToolContract } from './types.ts';
import { getOptionalEnv } from '../env.ts';

// ═══════════════════════════════════════════════════════════════
// Constants — Routes API v2 only
// ═══════════════════════════════════════════════════════════════

const ROUTES_API = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const FETCH_TIMEOUT_MS = 10_000;

const TRANSIT_FIELD_MASK = [
  'routes.legs.duration',
  'routes.legs.steps.transitDetails',
  'routes.legs.steps.startLocation',
  'routes.legs.steps.endLocation',
  'routes.legs.steps.polyline',
  'routes.legs.steps.travelMode',
  'routes.legs.steps.localizedValues',
  'routes.legs.steps.navigationInstruction',
  'routes.legs.stepsOverview',
  'routes.localizedValues',
  'routes.travelAdvisory',
  'routes.legs.localizedValues',
].join(',');

const DRIVE_FIELD_MASK = [
  'routes.duration',
  'routes.distanceMeters',
  'routes.localizedValues',
  'routes.legs.duration',
  'routes.legs.distanceMeters',
  'routes.legs.localizedValues',
  'routes.legs.steps.navigationInstruction',
  'routes.legs.steps.localizedValues',
].join(',');

// Maps our mode names to Routes API travelMode values
const MODE_MAP: Record<string, string> = {
  driving: 'DRIVE',
  walking: 'WALK',
  bicycling: 'BICYCLE',
  transit: 'TRANSIT',
};

const MAX_ROUTES_IN_BRIEF = 2;
const MAX_STEPS_PER_ROUTE = 5;

// ═══════════════════════════════════════════════════════════════
// Travel brief — decision-first JSON for agents (chat bubble layer)
// ═══════════════════════════════════════════════════════════════

function parseMinutesFromDurationText(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const h = text.match(/(\d+)\s*h(?:our)?s?/i);
  const m = text.match(/(\d+)\s*m(?:in)?s?/i);
  let total = 0;
  if (h) total += parseInt(h[1], 10) * 60;
  if (m) total += parseInt(m[1], 10);
  if (total > 0) return total;
  const lone = text.match(/^(\d+)\s*$/);
  return lone ? parseInt(lone[1], 10) : undefined;
}

function vehicleTypeToMode(vehicleType: string | undefined): string {
  const v = (vehicleType ?? '').toLowerCase();
  if (v === 'bus') return 'bus';
  if (v === 'heavy_rail' || v === 'rail' || v === 'subway' || v === 'high_speed_train') return 'train';
  if (v === 'light_rail') return 'light_rail';
  if (v === 'ferry') return 'ferry';
  return 'transit';
}

function modalityLabelForVehicleType(vehicleType: string | undefined): string {
  const m = vehicleTypeToMode(vehicleType);
  if (m === 'bus') return 'Bus';
  if (m === 'train') return 'Train';
  if (m === 'light_rail') return 'Tram / light rail';
  if (m === 'ferry') return 'Ferry';
  return 'Transit';
}

function computeTransitReliabilityScore(params: {
  transfers: number;
  walkingMinutes: number;
  totalStopsOnTransit: number;
}): number {
  let s = 0.88;
  s -= params.transfers * 0.07;
  s -= Math.min(0.12, Math.max(0, params.walkingMinutes - 6) * 0.012);
  s -= Math.min(0.1, params.totalStopsOnTransit * 0.006);
  return Math.round(Math.max(0.38, Math.min(0.94, s)) * 100) / 100;
}

function parseFareToCostEstimate(
  fareText: string | undefined,
  currencyHint: string | undefined,
): Record<string, unknown> | undefined {
  if (!fareText?.trim()) return undefined;
  const nums = fareText.match(/\d+(?:\.\d+)?/g);
  if (!nums?.length) {
    return { display: fareText.trim() };
  }
  const values = nums.map((n) => parseFloat(n));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const cur = currencyHint ?? (fareText.includes('AUD') ? 'AUD' : fareText.includes('$') ? 'AUD' : undefined);
  const est: Record<string, unknown> = { display: fareText.trim() };
  if (cur) est.currency = cur;
  if (!Number.isNaN(min)) est.min = min;
  if (!Number.isNaN(max) && max !== min) est.max = max;
  else if (!Number.isNaN(min)) est.max = min;
  return est;
}

// deno-lint-ignore no-explicit-any
function buildCompressedTransitSteps(legs: any[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < legs.length && out.length < MAX_STEPS_PER_ROUTE; i++) {
    const s = legs[i];
    if (s.mode === 'walking') {
      // Collapse consecutive walking sub-legs into a single step
      let totalWalkMin = parseMinutesFromDurationText(s.duration) ?? 0;
      let j = i + 1;
      while (j < legs.length && legs[j].mode === 'walking') {
        totalWalkMin += parseMinutesFromDurationText(legs[j].duration) ?? 0;
        j++;
      }
      const nextT = legs.slice(j).find((x: { mode?: string }) => x.mode === 'transit');
      const prevT = [...legs.slice(0, i)].reverse().find((x: { mode?: string }) => x.mode === 'transit');
      out.push({
        mode: 'walk',
        from: prevT?.arrival_stop ?? 'start',
        to: nextT?.departure_stop ?? 'destination',
        duration_min: totalWalkMin > 0 ? totalWalkMin : undefined,
        duration_text: totalWalkMin > 0 ? `${totalWalkMin} mins` : s.duration,
      });
      i = j - 1;
    } else if (s.mode === 'transit') {
      const vm = vehicleTypeToMode(s.vehicle_type as string | undefined);
      out.push({
        mode: vm,
        line: s.line_name ?? s.line_full_name,
        direction: s.direction,
        from: s.departure_stop,
        to: s.arrival_stop,
        duration_min: parseMinutesFromDurationText(s.duration),
        duration_text: s.duration,
        board_at: s.departs_at,
        alight_at: s.arrives_at,
        platform: s.platform_inferred,
        stops_on_board: s.num_stops,
      });
    }
  }
  return out;
}

function titleCaseMode(mode: string): string {
  if (!mode) return 'Transit';
  if (mode === 'light_rail') return 'Tram / light rail';
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function formatCompressedStepImessage(st: Record<string, unknown>): string {
  const mode = String(st.mode ?? '');
  if (mode === 'walk') {
    const from = st.from != null ? String(st.from) : '';
    const to = st.to != null ? String(st.to) : '';
    const dur = st.duration_text
      ? String(st.duration_text)
      : (st.duration_min != null ? `~${st.duration_min} min` : '');
    return `• **Walk** · **${from}** → **${to}**${dur ? ` · **${dur}**` : ''}`;
  }
  const line = st.line != null ? String(st.line) : 'Service';
  const from = st.from != null ? String(st.from) : '?';
  const to = st.to != null ? String(st.to) : '?';
  const dir = st.direction ? ` · **${String(st.direction)}**` : '';
  const board = st.board_at ? `**Board:** **${st.board_at}**` : '';
  const alight = st.alight_at ? `**Get off:** **${st.alight_at}**` : '';
  const plat = st.platform ? `**Platform:** **${st.platform}**` : '';
  const bits = [`• **${titleCaseMode(mode)}** · **${line}**${dir}`, `  **${from}** → **${to}**`];
  const tail = [board, alight, plat].filter(Boolean).join(' · ');
  if (tail) bits.push(`  ${tail}`);
  return bits.join('\n');
}

function buildImessageScanBlockForTransitRoute(
  route: Record<string, unknown>,
  rank: number,
): string {
  const summary = String(route.summary ?? 'Transit');
  const label = rank === 0 ? 'fastest' : 'backup';
  const lines: string[] = [];
  lines.push(`**Option ${rank + 1}** · **${label}** — **${summary}**`);

  if (route.total_duration_text) {
    lines.push(`**Total:** **${route.total_duration_text}**`);
  } else if (route.total_duration_min != null) {
    lines.push(`**Total:** **~${route.total_duration_min} min**`);
  }

  if (route.departure_time_local) {
    lines.push(`**First departure:** **${route.departure_time_local}**`);
  }
  if (route.arrival_time_local) lines.push(`**Arrive:** **${route.arrival_time_local}**`);
  lines.push(`**Transfers:** **${route.transfers ?? 0}**`);
  if (route.walking_minutes) {
    lines.push(`**Walking:** **~${route.walking_minutes} min**`);
  }

  const ce = route.cost_estimate as Record<string, unknown> | undefined;
  if (ce?.display) lines.push(`**Cost (estimate):** **${ce.display}**`);
  else if (ce?.min != null && typeof ce.min === 'number') {
    const cur = ce.currency ? `${String(ce.currency)} ` : '';
    const hi = ce.max != null && ce.max !== ce.min && typeof ce.max === 'number' ? `–${ce.max}` : '';
    lines.push(`**Cost (estimate):** **${cur}${ce.min}${hi}**`);
  }

  lines.push(
    `**Reliability:** **${route.reliability_score}** — ${route.reliability_note}`,
  );

  const steps = route.steps as Record<string, unknown>[] | undefined;
  if (steps?.length) {
    lines.push('');
    lines.push('**Steps:**');
    for (const st of steps) {
      lines.push(formatCompressedStepImessage(st));
    }
  }

  return lines.join('\n');
}

function buildTransitFeasibility(
  arrivalTargetRaw: string | undefined,
  bestOption: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!arrivalTargetRaw || arrivalTargetRaw === 'now' || !bestOption) return null;
  const targetMs = new Date(arrivalTargetRaw).getTime();
  if (Number.isNaN(targetMs)) return null;
  const lastIso = bestOption.last_arrival_iso as string | undefined;
  if (!lastIso) return null;
  const arrivalMs = new Date(lastIso).getTime();
  if (Number.isNaN(arrivalMs)) return null;
  const bufferMinutes = Math.round((targetMs - arrivalMs) / 60000);
  const canArrive = bufferMinutes >= 0;
  let comfort_label: string;
  if (bufferMinutes >= 20) comfort_label = 'comfortable';
  else if (bufferMinutes >= 5) comfort_label = 'tight';
  else if (bufferMinutes >= 0) comfort_label = 'risky';
  else comfort_label = 'late';

  return {
    has_arrival_target: true,
    arrival_target_iso: arrivalTargetRaw,
    route_final_arrival_iso: lastIso,
    recommended_arrival_local: bestOption.arrive_at,
    buffer_minutes: bufferMinutes,
    can_arrive_on_time: canArrive,
    comfort_label,
    headline:
      canArrive
        ? (bufferMinutes >= 20
          ? `**Yes** — you're on track with a **comfortable** buffer (**${bufferMinutes} min** before your deadline).`
          : bufferMinutes >= 5
          ? `**Yes** — you should make it, but it's **tight** (**${bufferMinutes} min** buffer).`
          : `**Yes** — you'll make the deadline, but the margin is **very thin** (**${bufferMinutes} min**).`)
        : `**No** — this route gets you there about **${Math.abs(bufferMinutes)} min late** for your deadline. **Not viable** unless you leave earlier or switch mode.`,
  };
}

// deno-lint-ignore no-explicit-any
function buildTravelBriefRouteFromTransitOption(
  opt: Record<string, unknown>,
  rank: number,
): Record<string, unknown> {
  // deno-lint-ignore no-explicit-any
  const legs = (opt.legs as any[]) ?? [];
  const transits = legs.filter((l) => l.mode === 'transit');
  const transfers = Math.max(0, transits.length - 1);
  let walkingMinutes = 0;
  for (const w of legs.filter((l) => l.mode === 'walking')) {
    walkingMinutes += parseMinutesFromDurationText(w.duration) ?? 0;
  }
  let totalStopsOnTransit = 0;
  for (const t of transits) {
    if (t.num_stops != null) totalStopsOnTransit += Number(t.num_stops);
  }
  const modalities = [...new Set(transits.map((t) => modalityLabelForVehicleType(t.vehicle_type)))];
  const reliability = computeTransitReliabilityScore({
    transfers,
    walkingMinutes,
    totalStopsOnTransit,
  });
  const durationMin = opt.duration_seconds != null
    ? Math.round(Number(opt.duration_seconds) / 60)
    : undefined;

  const steps = buildCompressedTransitSteps(legs);
  const route: Record<string, unknown> = {
    id: `route_${rank + 1}`,
    rank: rank + 1,
    label: rank === 0 ? 'fastest' : 'backup',
    summary: modalities.length ? modalities.join(' + ') : 'Transit',
    total_duration_min: durationMin,
    total_duration_text: opt.duration,
    departure_time_local: opt.depart_at ?? opt.first_transit_departs_at,
    departure_time_iso: opt.first_departure_iso,
    arrival_time_local: opt.arrive_at,
    arrival_time_iso: opt.last_arrival_iso,
    transfers,
    walking_minutes: walkingMinutes > 0 ? walkingMinutes : undefined,
    cost_estimate: parseFareToCostEstimate(opt.fare as string | undefined, opt.fare_currency as string | undefined),
    reliability_score: reliability,
    reliability_note:
      reliability >= 0.78
        ? 'Fewer handoffs than average for this kind of trip.'
        : 'Several connections or a long walk — allow extra buffer.',
    steps,
    itinerary_detail: opt.user_readable_itinerary,
  };
  route.imessage_scan_block = buildImessageScanBlockForTransitRoute(route, rank);
  return route;
}

/** One-line clause the model can weave into the opening bubble for credibility (Google Maps branding). */
function buildSuggestedCredibilityLine(params: {
  total_duration_text?: string;
  total_duration_min?: number;
  mode?: string;
}): string | undefined {
  if (params.total_duration_text) {
    if (params.mode === 'driving') {
      return `Google Maps is showing about **${params.total_duration_text}** by car right now.`;
    }
    if (params.mode === 'walking' || params.mode === 'bicycling') {
      return `Google Maps is showing about **${params.total_duration_text}** for that trip right now.`;
    }
    return `Google Maps is showing about **${params.total_duration_text}** door-to-door right now.`;
  }
  if (params.total_duration_min != null) {
    return `Google Maps is showing about **${params.total_duration_min} min** right now.`;
  }
  return undefined;
}

// deno-lint-ignore no-explicit-any
function buildTravelBriefTransit(
  origin: string,
  destination: string,
  options: Record<string, unknown>[],
  arrivalTime: string | undefined,
  departureTime: string | undefined,
): Record<string, unknown> {
  const sliced = options.slice(0, MAX_ROUTES_IN_BRIEF);
  const routes = sliced.map((opt, i) => buildTravelBriefRouteFromTransitOption(opt, i));
  const feasibility = buildTransitFeasibility(arrivalTime, sliced[0] as Record<string, unknown> | undefined);

  const decision_bubble_lines: string[] = [];
  if (feasibility?.headline) {
    decision_bubble_lines.push(String(feasibility.headline));
  } else {
    decision_bubble_lines.push('**Here is the best route** with live times.');
  }
  const r0 = routes[0];
  if (r0) {
    const parts: string[] = [];
    if (r0.total_duration_text) parts.push(`**Total:** **${r0.total_duration_text}**`);
    if (r0.departure_time_local) {
      parts.push(`**First departure:** **${r0.departure_time_local}**`);
    }
    if (r0.arrival_time_local) parts.push(`**Arrive:** **${r0.arrival_time_local}**`);
    if (parts.length) {
      decision_bubble_lines.push(parts.join('\n'));
    }
    if (r0.transfers != null || r0.walking_minutes != null) {
      const t = `**Transfers:** **${r0.transfers ?? 0}**`;
      const w = r0.walking_minutes != null
        ? `**Walking:** **~${r0.walking_minutes} min**`
        : '';
      decision_bubble_lines.push([t, w].filter(Boolean).join(' · '));
    }
    if (r0.reliability_score != null) {
      decision_bubble_lines.push(
        `**Reliability (heuristic):** **${r0.reliability_score}** — ${r0.reliability_note}`,
      );
    }
  }

  const suggested_credibility_line = buildSuggestedCredibilityLine({
    total_duration_text: routes[0]?.total_duration_text as string | undefined,
    total_duration_min: routes[0]?.total_duration_min as number | undefined,
    mode: 'transit',
  });

  return {
    query: {
      origin,
      destination,
      mode: 'transit',
      arrival_time_target: arrivalTime && arrivalTime !== 'now' ? arrivalTime : undefined,
      departure_time_target: departureTime && departureTime !== 'now' ? departureTime : undefined,
    },
    feasibility,
    routes,
    decision_bubble_lines,
    suggested_credibility_line,
    presentation: {
      max_bubbles: routes.length > 1 ? 6 : 5,
      bubble_plan: [
        '1_decision — use decision_bubble_lines (each line uses **bold** for labels/values); optionally fold in suggested_credibility_line once, subtly',
        '2_best_route — paste or mirror routes[0].imessage_scan_block (already **bold**-formatted)',
        '3_backup — routes[1].imessage_scan_block if present',
        '4_itinerary_detail — optional third bubble: routes[n].itinerary_detail for exact Board/Get off lines',
        '5_actions — optional: reminder, live departures (no Uber unless user asks and you have a tool)',
      ],
      bold_rendering:
        'Use **double asterisks** around field names and key values. Nest converts **...** to Unicode bold on send so it displays correctly in iMessage.',
      rules:
        'Numbers and times MUST match travel_brief. Do not invent platforms. Use --- between bubbles. Keep ** pairs balanced. No emoji unless the user uses them.',
      source_credibility:
        'If suggested_credibility_line is set, you may use it or a natural paraphrase once in the first bubble — establishes that live data is from Google Maps. Do not repeat or sound like an ad.',
    },
    meta: {
      generated_at: new Date().toISOString(),
      data_sources: ['google_maps_routes_v2'],
      route_provider: 'Google Maps',
    },
  };
}

function buildTravelBriefNonTransit(params: {
  origin: string;
  destination: string;
  mode: string;
  durationText: string | undefined;
  durationSeconds: number | undefined;
  distanceText: string | undefined;
  trafficVolatile: boolean;
  departureTime?: string;
  estimatedArrivalIso?: string;
}): Record<string, unknown> {
  const durationMin = params.durationSeconds != null
    ? Math.round(params.durationSeconds / 60)
    : undefined;
  const reliability = params.mode === 'driving'
    ? (params.trafficVolatile ? 0.55 : 0.62)
    : 0.82;

  const route: Record<string, unknown> = {
    id: 'route_1',
    rank: 1,
    label: params.mode === 'driving' ? 'driving' : params.mode,
    summary: params.mode === 'driving' ? 'Driving' : params.mode === 'walking' ? 'Walking' : 'Cycling',
    total_duration_min: durationMin,
    total_duration_text: params.durationText,
    distance_text: params.distanceText,
    traffic_dependent: params.mode === 'driving',
    reliability_score: reliability,
    reliability_note: params.mode === 'driving'
      ? 'Duration moves with traffic — treat as indicative.'
      : 'Usually steady compared with driving in peak hour.',
  };
  if (params.estimatedArrivalIso) {
    route.arrival_time_iso = params.estimatedArrivalIso;
  }

  const lines: string[] = [];
  if (params.durationText) {
    lines.push(
      params.mode === 'driving'
        ? `**Duration:** **${params.durationText}** by car${params.distanceText ? ` · **Distance:** **${params.distanceText}**` : ''}.`
        : `**Duration:** **${params.durationText}**${params.distanceText ? ` · **Distance:** **${params.distanceText}**` : ''}.`,
    );
  }
  if (params.trafficVolatile && params.mode === 'driving') {
    lines.push('**Traffic:** **variable** — allow extra buffer.');
  }
  lines.push(
    `**Reliability (heuristic):** **${reliability}** — ${String(route.reliability_note)}`,
  );

  const scanLines: string[] = [];
  scanLines.push(`**${String(route.summary)}**`);
  if (params.durationText) scanLines.push(`**Duration:** **${params.durationText}**`);
  if (params.distanceText) scanLines.push(`**Distance:** **${params.distanceText}**`);
  if (params.trafficVolatile && params.mode === 'driving') {
    scanLines.push('**Traffic-dependent:** **yes**');
  }
  scanLines.push(`**Reliability:** **${reliability}** — ${String(route.reliability_note)}`);
  route.imessage_scan_block = scanLines.join('\n');

  const suggested_credibility_line = buildSuggestedCredibilityLine({
    total_duration_text: params.durationText,
    total_duration_min: durationMin,
    mode: params.mode,
  });

  return {
    query: {
      origin: params.origin,
      destination: params.destination,
      mode: params.mode,
      departure_time_target: params.departureTime && params.departureTime !== 'now'
        ? params.departureTime
        : undefined,
    },
    feasibility: null,
    routes: [route],
    decision_bubble_lines: lines,
    suggested_credibility_line,
    presentation: {
      max_bubbles: 3,
      bubble_plan: ['1_decision', '2_route paste routes[0].imessage_scan_block if useful', '3_actions_optional'],
      bold_rendering:
        'Use **double asterisks**; Nest converts them to Unicode bold on send for iMessage.',
      rules: 'Match travel_brief numbers. Balanced ** only. Split with ---.',
      source_credibility:
        'If suggested_credibility_line is set, use it or a natural paraphrase once — data is live from Google Maps. Keep it subtle.',
    },
    meta: {
      generated_at: new Date().toISOString(),
      data_sources: ['google_maps_routes_v2'],
      route_provider: 'Google Maps',
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Fetch helpers
// ═══════════════════════════════════════════════════════════════

function fetchWithTimeout(
  url: string | URL,
  init?: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

async function retryFetch(
  url: string | URL,
  init?: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const MAX_ATTEMPTS = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, init, timeoutMs);
      if (resp.ok || (resp.status >= 400 && resp.status < 500 && resp.status !== 429)) {
        return resp;
      }
      if (attempt < MAX_ATTEMPTS - 1) {
        const backoff = (attempt + 1) * 1500;
        console.warn(`[travel_time] ${resp.status} on attempt ${attempt + 1}, retrying in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      return resp;
    } catch (e) {
      lastError = e as Error;
      if (attempt < MAX_ATTEMPTS - 1) {
        const backoff = (attempt + 1) * 1500;
        console.warn(`[travel_time] Error on attempt ${attempt + 1}: ${lastError.message}, retrying in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastError ?? new Error('retryFetch: max attempts exceeded');
}

// ═══════════════════════════════════════════════════════════════
// Direction simplifier — strips compass directions so a 5-year-old can follow
// ═══════════════════════════════════════════════════════════════

const COMPASS_RE = /\b(north|south|east|west|northeast|northwest|southeast|southwest|NE|NW|SE|SW|N|S|E|W)\b/gi;
const HEAD_COMPASS_RE = /^Head\s+(north|south|east|west|northeast|northwest|southeast|southwest)\s*/i;
const HEAD_TOWARD_RE = /^Head\s+(north|south|east|west|northeast|northwest|southeast|southwest)\s+(on\s+.+?)\s*(toward\s+.+)?$/i;
const HEAD_ON_RE = /^Head\s+(north|south|east|west|northeast|northwest|southeast|southwest)\s+on\s+/i;

function simplifyDirection(instruction: string): string {
  if (!instruction) return instruction;

  // "Head north on X toward Y" → "Start on X toward Y"
  const headToward = instruction.match(HEAD_TOWARD_RE);
  if (headToward) {
    const onPart = headToward[2]; // "on Some St"
    const towardPart = headToward[3] ?? ''; // "toward Other St"
    return `Start ${onPart}${towardPart ? ' ' + towardPart : ''}`.trim();
  }

  // "Head north on X" → "Start on X"
  if (HEAD_ON_RE.test(instruction)) {
    return instruction.replace(HEAD_ON_RE, 'Start on ');
  }

  // "Head north" (bare) → "Go straight"
  if (HEAD_COMPASS_RE.test(instruction)) {
    return instruction.replace(HEAD_COMPASS_RE, 'Go straight ').trim();
  }

  // For other instructions, remove stray compass references like "Turn left to go north"
  // but keep street names containing compass words (e.g. "North Rd")
  // Only strip standalone compass words not preceded by a capital letter (part of a name)
  return instruction;
}

// ═══════════════════════════════════════════════════════════════
// Transit route parser
// ═══════════════════════════════════════════════════════════════

/** Routes API returns ISO strings for stop times in REST; protobuf uses seconds/nanos. */
function normaliseTransitInstant(t: unknown): string | undefined {
  if (t == null) return undefined;
  if (typeof t === 'string' && t.length > 0) return t;
  if (typeof t === 'object' && t !== null && 'seconds' in t) {
    const sec = Number((t as { seconds: string | number }).seconds);
    if (Number.isNaN(sec)) return undefined;
    const nanos = Number((t as { nanos?: number }).nanos ?? 0);
    return new Date(sec * 1000 + Math.floor(nanos / 1e6)).toISOString();
  }
  return undefined;
}

/** Google TransitStop only has name + location — platform is sometimes embedded in the name. */
function inferPlatformFromStopName(stopName: string | undefined): string | undefined {
  if (!stopName) return undefined;
  const platform = stopName.match(/\bplatform\s*([A-Za-z0-9]+)\b/i);
  if (platform) return `Platform ${platform[1]}`;
  const pf = stopName.match(/\bpf\.?\s*([A-Za-z0-9]+)\b/i);
  if (pf) return `Platform ${pf[1]}`;
  const bay = stopName.match(/\bbay\s*([A-Za-z0-9]+)\b/i);
  if (bay) return `Bay ${bay[1]}`;
  return undefined;
}

// deno-lint-ignore no-explicit-any
function buildUserReadableTransitItinerary(
  option: Record<string, unknown>,
  optionLabel: string,
): string {
  // deno-lint-ignore no-explicit-any
  const legs = option.legs as any[] | undefined;
  if (!legs?.length) return '';

  const parts: string[] = [];
  const dur = option.duration ? String(option.duration) : '';
  const arriveEnd = option.arrive_at ? String(option.arrive_at) : '';
  const firstDep = option.first_transit_departs_at
    ? String(option.first_transit_departs_at)
    : '';
  parts.push(`━━ ${optionLabel}${dur ? ` · total ${dur}` : ''}${firstDep ? ` · first vehicle departs **${firstDep}**` : ''}${arriveEnd ? ` · last stop **${arriveEnd}**` : ''} ━━`);
  parts.push(
    'Legend: **Board** = vehicle pulls away from that stop at this time. **Get off** = you exit at this time. Platform only appears when it is embedded in the stop name; otherwise check station screens.',
  );

  let stepNum = 0;
  for (let i = 0; i < legs.length; i++) {
    const s = legs[i];
    if (s.mode === 'walking') {
      // Collapse consecutive walking sub-legs into a single step
      let totalMin = parseMinutesFromDurationText(s.duration) ?? 0;
      let totalDistM = 0;
      const distMatch = (s.distance as string | undefined)?.match(/([\d.]+)\s*(km|m)\b/i);
      if (distMatch) {
        totalDistM = distMatch[2].toLowerCase() === 'km'
          ? parseFloat(distMatch[1]) * 1000
          : parseFloat(distMatch[1]);
      }
      let j = i + 1;
      while (j < legs.length && legs[j].mode === 'walking') {
        totalMin += parseMinutesFromDurationText(legs[j].duration) ?? 0;
        const dm = (legs[j].distance as string | undefined)?.match(/([\d.]+)\s*(km|m)\b/i);
        if (dm) {
          totalDistM += dm[2].toLowerCase() === 'km'
            ? parseFloat(dm[1]) * 1000
            : parseFloat(dm[1]);
        }
        j++;
      }
      const nextTransit = legs.slice(j).find((x: { mode?: string }) => x.mode === 'transit');
      const boardAt = nextTransit?.departure_stop as string | undefined;
      const durStr = totalMin > 0 ? `${totalMin} mins` : '';
      const distStr = totalDistM >= 1000
        ? `${(totalDistM / 1000).toFixed(1)} km`
        : totalDistM > 0 ? `${Math.round(totalDistM)} m` : '';
      const bits = [durStr, distStr].filter(Boolean).join(' · ');
      stepNum++;
      parts.push(
        `${stepNum}. Walk${bits ? ` ${bits}` : ''}${boardAt ? ` → ${boardAt}` : ''}`,
      );
      i = j - 1;
    } else if (s.mode === 'transit') {
      stepNum++;
      const vehicle = (s.vehicle_name as string) || 'Transit';
      const line = (s.line_name as string) || (s.line_full_name as string) || 'Service';
      const dir = s.direction ? ` towards ${s.direction}` : '';
      const tripShort = s.trip_short_text ? String(s.trip_short_text) : '';
      parts.push(
        `${stepNum}. ${vehicle}: **${line}**${dir}${tripShort ? ` (${tripShort})` : ''}`,
      );

      const depT = s.departs_at ? String(s.departs_at) : '';
      const arrT = s.arrives_at ? String(s.arrives_at) : '';
      const depStop = s.departure_stop ? String(s.departure_stop) : '';
      const arrStop = s.arrival_stop ? String(s.arrival_stop) : '';

      parts.push(
        `   **Board:** **${depT || '?'}** — ${depStop || 'departure stop'}`,
      );
      const plat = s.platform_inferred ? String(s.platform_inferred) : '';
      if (plat) {
        parts.push(`   **Platform:** **${plat}**`);
      }
      parts.push(
        `   **Get off:** **${arrT || '?'}** — ${arrStop || 'arrival stop'}`,
      );
      if (s.num_stops != null && Number(s.num_stops) > 0) {
        parts.push(`   (${Number(s.num_stops)} stops while on board)`);
      }
    }
  }

  if (option.fare) {
    parts.push(`**Fare (estimate):** **${option.fare}**`);
  }

  return parts.join('\n');
}

// deno-lint-ignore no-explicit-any
function parseTransitRoutesV2(
  routes: any[],
  origin: string,
  destination: string,
  arrivalTime: string | undefined,
  departureTime: string | undefined,
): unknown {
  const options = routes.slice(0, 3).map((route: Record<string, unknown>, idx: number) => {
    // deno-lint-ignore no-explicit-any
    const leg = (route.legs as any[])?.[0];
    if (!leg) return null;

    const option: Record<string, unknown> = {
      option: idx + 1,
      duration: route.localizedValues
        // deno-lint-ignore no-explicit-any
        ? (route.localizedValues as any).duration?.text
        : leg.localizedValues?.duration?.text,
      duration_seconds: leg.duration ? parseInt(String(leg.duration).replace('s', ''), 10) : undefined,
    };

    // Transit fare from travel advisory
    // deno-lint-ignore no-explicit-any
    const advisory = route.travelAdvisory as any;
    if (advisory?.transitFare) {
      const fare = advisory.transitFare;
      const amount = (parseInt(fare.units ?? '0', 10) + (fare.nanos ?? 0) / 1e9).toFixed(2);
      if (fare.currencyCode) {
        option.fare = `${fare.currencyCode} ${amount}`;
        option.fare_currency = fare.currencyCode;
      } else {
        option.fare = `$${amount}`;
      }
    }
    // deno-lint-ignore no-explicit-any
    const locValues = route.localizedValues as any;
    if (locValues?.transitFare?.text) {
      option.fare = locValues.transitFare.text;
    }

    // deno-lint-ignore no-explicit-any
    const transitSteps = (leg.steps ?? [])
      // deno-lint-ignore no-explicit-any
      .filter((s: any) => s.travelMode === 'TRANSIT' || s.travelMode === 'WALK')
      .slice(0, 10)
      // deno-lint-ignore no-explicit-any
      .map((s: any) => {
        const step: Record<string, unknown> = {
          mode: s.travelMode === 'WALK' ? 'walking' : 'transit',
        };

        if (s.localizedValues) {
          step.distance = s.localizedValues.distance?.text;
          step.duration = s.localizedValues.staticDuration?.text;
        }

        if (s.navigationInstruction?.instructions) {
          step.instruction = simplifyDirection(s.navigationInstruction.instructions);
        }

        if (s.travelMode === 'WALK') {
          if (s.startLocation?.latLng) step.start_location = s.startLocation.latLng;
          if (s.endLocation?.latLng) step.end_location = s.endLocation.latLng;
        }

        if (s.transitDetails) {
          const td = s.transitDetails;
          const line = td.transitLine;
          if (line) {
            step.line_name = line.nameShort || line.name;
            step.line_full_name = line.name;
            step.line_color = line.color;
            if (line.vehicle) {
              step.vehicle_type = line.vehicle.type?.toLowerCase();
              step.vehicle_name = line.vehicle.name?.text;
            }
            if (line.agencies?.length) {
              step.agency = line.agencies[0].name;
            }
          }
          step.num_stops = td.stopCount;
          if (typeof td.tripShortText === 'string' && td.tripShortText.trim()) {
            step.trip_short_text = td.tripShortText.trim();
          }
          if (td.stopDetails) {
            const depStopName = td.stopDetails.departureStop?.name as string | undefined;
            const arrStopName = td.stopDetails.arrivalStop?.name as string | undefined;
            step.departure_stop = depStopName;
            step.arrival_stop = arrStopName;

            const depIso = normaliseTransitInstant(td.stopDetails.departureTime);
            const arrIso = normaliseTransitInstant(td.stopDetails.arrivalTime);
            if (depIso) step.departure_time_iso = depIso;
            if (arrIso) step.arrival_time_iso = arrIso;

            const locDep = td.localizedValues?.departureTime?.time?.text as string | undefined;
            const locArr = td.localizedValues?.arrivalTime?.time?.text as string | undefined;
            const tz = td.localizedValues?.departureTime?.timeZone as string | undefined;
            if (tz) step.local_time_zone = tz;

            step.departs_at = locDep || depIso;
            step.arrives_at = locArr || arrIso;

            const inferred = inferPlatformFromStopName(depStopName);
            if (inferred) step.platform_inferred = inferred;
          }
          if (td.headsign) step.direction = td.headsign;
        }
        return step;
      });

    if (transitSteps.length) option.legs = transitSteps;

    // Extract departure/arrival from first and last transit steps
    // deno-lint-ignore no-explicit-any
    const firstTransit = transitSteps.find((s: any) => s.mode === 'transit');
    // deno-lint-ignore no-explicit-any
    const lastTransit = [...transitSteps].reverse().find((s: any) => s.mode === 'transit');
    if (firstTransit?.departs_at) option.depart_at = firstTransit.departs_at;
    if (lastTransit?.arrives_at) option.arrive_at = lastTransit.arrives_at;
    if (firstTransit?.departure_time_iso) {
      option.first_departure_iso = firstTransit.departure_time_iso;
    }
    if (lastTransit?.arrival_time_iso) {
      option.last_arrival_iso = lastTransit.arrival_time_iso;
    }
    if (firstTransit?.departs_at) {
      option.first_transit_departs_at = firstTransit.departs_at;
    }
    if (firstTransit) {
      option.first_vehicle_summary = [
        firstTransit.vehicle_name,
        firstTransit.line_name,
        firstTransit.departs_at ? `departs ${firstTransit.departs_at}` : null,
        firstTransit.departure_stop ? `from ${firstTransit.departure_stop}` : null,
      ].filter(Boolean).join(' · ');
    }

    // deno-lint-ignore no-explicit-any
    const firstWalk = transitSteps.find((s: any) => s.mode === 'walking');
    if (firstWalk) {
      option.walk_to_station = {
        duration: firstWalk.duration,
        distance: firstWalk.distance,
      };
    }

    const optionTitle = idx === 0 ? 'Best option' : `Option ${idx + 1}`;
    option.user_readable_itinerary = buildUserReadableTransitItinerary(option, optionTitle);

    // Steps overview
    if (leg.stepsOverview?.multiModalSegments) {
      // deno-lint-ignore no-explicit-any
      option.segments_overview = leg.stepsOverview.multiModalSegments.map((seg: any) => ({
        mode: seg.travelMode?.toLowerCase(),
        navigation: seg.navigationInstruction?.instructions,
        steps: seg.stepStartIndex !== undefined ? `steps ${seg.stepStartIndex}-${seg.stepEndIndex}` : undefined,
      }));
    }

    return option;
  }).filter(Boolean);

  const optList = options as Record<string, unknown>[];
  const travel_brief = buildTravelBriefTransit(
    origin,
    destination,
    optList,
    arrivalTime,
    departureTime,
  );

  return {
    mode: 'transit',
    origin,
    destination,
    travel_brief,
    primary_contract:
      'Present using `travel_brief` (decision-first). Prefer `routes[n].imessage_scan_block` for the main route bubble (**bold** is pre-applied). Use `itinerary_detail` only for exact Board/Get off lines — never invent times.',
    options,
  };
}

// ═══════════════════════════════════════════════════════════════
// Routes API v2 — all modes
// ═══════════════════════════════════════════════════════════════

async function routesAPI(
  apiKey: string,
  origin: string,
  destination: string,
  mode: string,
  departureTime: string | undefined,
  arrivalTime: string | undefined,
  transitPreference: string | undefined,
  allowedModes: string[] | undefined,
): Promise<unknown> {
  const travelMode = MODE_MAP[mode] ?? 'DRIVE';
  const isTransit = travelMode === 'TRANSIT';

  const body: Record<string, unknown> = {
    origin: { address: origin },
    destination: { address: destination },
    travelMode,
  };

  if (isTransit) {
    body.computeAlternativeRoutes = true;

    if (arrivalTime && arrivalTime !== 'now') {
      body.arrivalTime = new Date(arrivalTime).toISOString();
    } else if (departureTime && departureTime !== 'now') {
      const depDate = new Date(departureTime);
      if (!isNaN(depDate.getTime()) && depDate.getTime() > Date.now()) {
        body.departureTime = depDate.toISOString();
      }
    }

    const transitPreferences: Record<string, unknown> = {};
    if (transitPreference === 'less_walking' || transitPreference === 'LESS_WALKING') {
      transitPreferences.routingPreference = 'LESS_WALKING';
    } else if (transitPreference === 'fewer_transfers' || transitPreference === 'FEWER_TRANSFERS') {
      transitPreferences.routingPreference = 'FEWER_TRANSFERS';
    }
    if (allowedModes?.length) {
      transitPreferences.allowedTravelModes = allowedModes.map((m: string) => m.toUpperCase());
    }
    if (Object.keys(transitPreferences).length) {
      body.transitPreferences = transitPreferences;
    }
  } else if (travelMode === 'DRIVE') {
    body.routingPreference = 'TRAFFIC_AWARE';

    if (departureTime && departureTime !== 'now') {
      const depDate = new Date(departureTime);
      if (!isNaN(depDate.getTime()) && depDate.getTime() > Date.now()) {
        body.departureTime = depDate.toISOString();
      }
    }
  }

  const fieldMask = isTransit ? TRANSIT_FIELD_MASK : DRIVE_FIELD_MASK;

  console.log(`[travel_time] Routes API ${mode}: ${origin} → ${destination}`);

  const resp = await retryFetch(ROUTES_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify(body),
  });

  // deno-lint-ignore no-explicit-any
  const data: any = await resp.json();

  if (data.error) {
    return {
      error: data.error.message ?? `Routes API error: ${data.error.status}`,
      fallback_query: `${origin} to ${destination} by ${mode}`,
    };
  }

  if (!data.routes?.length) {
    return {
      error: `No ${mode} routes found.`,
      fallback_query: `${origin} to ${destination} by ${mode}`,
    };
  }

  // Transit gets special multi-option parsing
  if (isTransit) {
    return parseTransitRoutesV2(data.routes, origin, destination, arrivalTime, departureTime);
  }

  // Non-transit: simpler response
  const route = data.routes[0];
  const leg = route.legs?.[0];
  const locValues = route.localizedValues ?? leg?.localizedValues;

  const result: Record<string, unknown> = {
    origin,
    destination,
    distance: locValues?.distance?.text,
    duration: locValues?.duration?.text,
    mode,
  };

  // Static duration (without traffic) vs actual duration
  if (locValues?.staticDuration?.text && locValues.staticDuration.text !== locValues.duration?.text) {
    result.duration_without_traffic = locValues.staticDuration.text;
  }

  const durationSec = route.duration ? parseInt(String(route.duration).replace('s', ''), 10) : undefined;
  if (durationSec) result.duration_seconds = durationSec;

  let estimatedArrivalIso: string | undefined;
  if (departureTime && departureTime !== 'now') {
    result.departure_time = departureTime;
    const depMs = new Date(departureTime).getTime();
    if (!isNaN(depMs) && durationSec) {
      estimatedArrivalIso = new Date(depMs + durationSec * 1000).toISOString();
      result.estimated_arrival = estimatedArrivalIso;
    }
  }

  // Route summary from steps — simplified for humans
  // deno-lint-ignore no-explicit-any
  const steps = (leg?.steps ?? []).slice(0, 5).map((s: any) => ({
    instruction: simplifyDirection(s.navigationInstruction?.instructions ?? ''),
    distance: s.localizedValues?.distance?.text,
    duration: s.localizedValues?.staticDuration?.text,
  })).filter((s: Record<string, unknown>) => s.instruction);
  if (steps.length) result.route_summary = steps;

  const trafficVolatile = !!(mode === 'driving' && locValues?.staticDuration?.text &&
    locValues.staticDuration.text !== locValues.duration?.text);

  result.travel_brief = buildTravelBriefNonTransit({
    origin,
    destination,
    mode,
    durationText: locValues?.duration?.text,
    durationSeconds: durationSec,
    distanceText: locValues?.distance?.text,
    trafficVolatile,
    departureTime,
    estimatedArrivalIso,
  });
  result.primary_contract =
    'Use `travel_brief` for how to open the reply; keep turn-by-turn in `route_summary` only if the user asks for driving directions.';

  return result;
}

// ═══════════════════════════════════════════════════════════════
// Tool contract
// ═══════════════════════════════════════════════════════════════

export const travelTimeTool: ToolContract = {
  name: 'travel_time',
  description:
    'Get travel time and directions between two locations. Supports driving, transit (bus, train, tram), walking, and bicycling. Returns a structured `travel_brief` (decision-first: feasibility vs deadline, compressed routes, transfers, walking, cost, reliability) plus raw detail for transit. Use `arrival_time` (ISO) when the user must arrive by a specific time. Call again on follow-ups ("Please", "yes the train one", "fewer transfers") — prior turn output is not fresh. Use `transit_preference: fewer_transfers` for simpler routes with fewer changes. Use for "how long to get to X", "next bus/train to X", "can I make it by 7:30", walking times, and transit schedules.',
  namespace: 'travel.search',
  sideEffect: 'read',
  idempotent: true,
  timeoutMs: 12000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      origin: {
        type: 'string',
        description: 'Starting location (address, place name, or landmark). For "next train/bus", use nearest station as origin.',
      },
      destination: {
        type: 'string',
        description: 'Destination location (address, place name, or landmark).',
      },
      mode: {
        type: 'string',
        enum: ['driving', 'transit', 'walking', 'bicycling'],
        description: "Travel mode. Default 'driving'. Use 'transit' for all public transport (bus, train, tram).",
      },
      departure_time: {
        type: 'string',
        description: "ISO 8601 datetime or 'now'. Default 'now'.",
      },
      arrival_time: {
        type: 'string',
        description:
          'ISO 8601 datetime. Transit only — use when the user must arrive by a deadline ("by 7:30am"). Cannot combine with departure_time. The tool returns travel_brief.feasibility (buffer vs deadline) when this is set.',
      },
      transit_preference: {
        type: 'string',
        enum: ['less_walking', 'fewer_transfers'],
        description: 'Transit routing preference.',
      },
      allowed_transit_modes: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['BUS', 'SUBWAY', 'TRAIN', 'LIGHT_RAIL', 'RAIL'],
        },
        description: 'Filter transit to specific vehicle types.',
      },
    },
    required: ['origin', 'destination'],
  },
  inputExamples: [
    { origin: 'Melbourne CBD', destination: 'Melbourne Airport', mode: 'driving' },
    { origin: 'Flinders Street Station', destination: 'Caulfield Station', mode: 'transit' },
    { origin: 'Federation Square', destination: 'South Yarra', mode: 'walking' },
  ],

  handler: async (input) => {
    const origin = input.origin as string | undefined;
    const destination = input.destination as string | undefined;

    if (!origin || !destination) {
      return { content: JSON.stringify({ error: "Both 'origin' and 'destination' are required." }) };
    }

    const apiKey = getOptionalEnv('GOOGLE_MAPS_API_KEY');
    if (!apiKey) {
      const query = `travel time from ${origin} to ${destination} by ${(input.mode as string) ?? 'driving'}`;
      return { content: JSON.stringify({ error: 'Google Maps not configured. Use web_search as fallback.', fallback_query: query }) };
    }

    const mode = (input.mode as string) ?? 'driving';
    const departureTime = input.departure_time as string | undefined;
    const arrivalTime = input.arrival_time as string | undefined;
    const transitPreference = input.transit_preference as string | undefined;
    const allowedModes = input.allowed_transit_modes as string[] | undefined;

    try {
      const result = await routesAPI(apiKey, origin, destination, mode, departureTime, arrivalTime, transitPreference, allowedModes);
      return { content: JSON.stringify(result) };
    } catch (e) {
      console.error('[travel_time] error:', (e as Error).message);
      const query = `travel time from ${origin} to ${destination} by ${mode}`;
      return { content: JSON.stringify({ error: (e as Error).message, fallback_query: query }) };
    }
  },
};
