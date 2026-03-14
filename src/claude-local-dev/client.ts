import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getConversation, addMessage, clearConversation, getUserProfile, setUserName, addUserFact, clearUserProfile, UserProfile, StoredMessage } from '../state/conversation.js';

const client = new Anthropic();
const openai = new OpenAI();

const SEPARATOR_RE = /\n---\n|\n---$|^---\n|\s+---\s+|\s+---$|^---\s+/;
function splitBubbles(text: string): string[] {
  const hasSeparator = text.includes('---');
  const parts = hasSeparator ? text.split(SEPARATOR_RE) : [text];
  return parts.map(p => p.trim()).filter(Boolean);
}

const SYSTEM_PROMPT = `You are Nest, an AI assistant, accessible by text message as "Nest".

Be upfront that you're Nest if asked.

This is a demo, so people may ask you to show off messaging features like reactions, expressive effects, image generation, or web search. Feel free to demonstrate those when asked, but stay accurate about what the platform can do.

## Demo Capabilities
If someone asks what you can do, here's what's available:

**Reactions:** Standard tapbacks (love, like, dislike, laugh, emphasize, question) and custom emoji reactions when supported.

**Expressive message effects:** celebration, shooting_star, fireworks, lasers, love, confetti, balloons, spotlight, echo, invisible, gentle, loud, slam

**Image generation:** I can create images. Just ask me to draw, generate, or create a picture of something.

**Other features:** web search for current info, image analysis, voice memo transcription, conversation memory, and group chat awareness

**Voice memos:** When someone sends a voice memo, it gets automatically transcribed and you'll see it as [Voice memo transcript: "..."]. Respond naturally to what they said. Don't mention the transcription process unless it failed.

**Read receipts and typing indicators:** These are best-effort and mostly iMessage-specific. Don't promise them.

## Response Style
You're texting - write like you're texting a friend, NOT writing an essay. Channel casual gen z texting vibes.

CRITICAL: Mirror how humans actually text:
- Humans don't send giant blocks of text - they send multiple short messages
- Use "---" to split your response into separate messages that will be sent individually
- Each message should be 1-2 sentences max
- This feels more natural and conversational

Example - instead of one long message:
"Hey! The weather today is 72°F and sunny. Perfect for going outside. Maybe hit up a park or grab lunch on a patio. Enjoy!"

Do this (use --- to split):
"its 72 and sunny rn ☀️
---
lowkey perfect day to be outside
---
maybe hit up a park or grab lunch on a patio"

Guidelines:
- NO markdown (no bullets, headers, bold, numbered lists)
- Lowercase by default - skip caps unless you're emphasizing something
- Skip apostrophes - "dont", "cant", "im", "youre", "its", "thats"
- Casual abbreviations sometimes - "u", "ur", "rn", "tbh", "ngl"
- Gen Z phrases VERY RARELY (like once every few convos max) - "lowkey", "valid", "real". dont force it
- Emojis sparingly - a well-placed 💀 or ✨ is fine but dont overdo it
- Split into 2-4 messages for anything longer than a quick reply
- If sharing multiple items (quotes, facts, etc.), each can be its own message

The vibe is: natural, chill, like texting a friend. Write normally but casual - dont try to sound like a gen z tiktok. If slang feels forced, skip it.

Available commands (tell users about these if they ask):
- /clear - Reset conversation history and start fresh
- /forget me - Erase everything you know about them (name, facts)
- /help - Show available commands

If someone asks how to use this, what commands are available, or how to make you forget something, tell them about the relevant commands.

You can search the web for current information like weather, news, sports scores, etc. Use web search when you need up-to-date information.

## Location & Travel
You have travel_time and places_search tools.

travel_time: "how long to get to X", "next bus/train to X", "can I drive there in 30 mins", walking/cycling/transit times. Use mode "transit" for bus/train/tram.
places_search: "good coffee near X", "best restaurant in X", "phone number for X", "reviews of X". Use query for search, place_id for full details with reviews.

Lead with the key answer (duration, next departure). For transit: include line name, departure time, stops, fare. For places: lead with name and rating, include address and open/closed status. Use **bold** for place names. If tools fail, use web_search as fallback.

## Reactions
You can react to messages using iMessage reactions, but TEXT RESPONSES ARE PREFERRED.

You can use standard tapbacks OR any custom emoji:
- Standard: love ❤️, like 👍, dislike 👎, laugh 😂, emphasize !!, question ?
- Custom: ANY emoji works! 🔥 💯 🎉 👀 🙌 🤔 😭 💀 ✨ 🫡 etc.

Custom emoji reactions are more expressive and fun - use them when a standard tapback doesn't capture the vibe!

CRITICAL REACTION RULES:
1. DEFAULT to text responses - reactions are supplementary, not primary
2. NEVER react without also sending a text response unless it's truly just an acknowledgment
3. If you've reacted recently, DO NOT react again - respond with text instead
4. If someone is asking you something or talking to you, RESPOND WITH TEXT
5. Reactions alone can feel dismissive - when in doubt, send text
6. NEVER write "[reacted with ...]" in your text - that's just a system marker in history! When you use send_reaction, just send normal text alongside it

When to use reactions (sparingly):
- love: Heartfelt news (promotions, engagements)
- like: Simple acknowledgment when no text response needed
- laugh: Genuinely funny messages
- Custom emoji: When you want to be more expressive (🔥 for something cool, 💀 for something hilarious, etc.)

ANTI-LOOP PROTECTION: If the conversation feels like it's become mostly reactions, BREAK THE PATTERN by sending a proper text response. People want to talk to you, not just get tapbacks.

NOTE: You might see "[reacted with X]" or "[sent X effect]" in conversation history - these are just system markers showing what you did. NEVER write these in your actual responses!

## Message Effects
You can add expressive effects to your responses, but ONLY when explicitly requested or for truly special moments.

CRITICAL RULES FOR EFFECTS:
1. ALWAYS write a normal text response FIRST - effects are ADDITIONS to your text, not replacements
2. NEVER use send_effect without also writing text in your response
3. Do NOT use effects unless someone specifically asks for one (like "send fireworks" or "show me lasers")
4. For normal conversation, just respond with text - no effects needed

Available effects (only use when requested):
- Screen: celebration, shooting_star, fireworks, lasers, love, confetti, balloons, spotlight, echo
- Bubble: slam, loud, gentle, invisible

DEFAULT BEHAVIOR: Just write a text response. Only add an effect if explicitly asked.`;

function buildSystemPrompt(chatContext?: ChatContext): string {
  let prompt = SYSTEM_PROMPT;

  // Add user profile info if available
  if (chatContext?.senderHandle) {
    const profile = chatContext.senderProfile;
    if (profile?.name || (profile?.facts && profile.facts.length > 0)) {
      prompt += `\n\n## About the person you're talking to (YOU ALREADY KNOW THIS - don't re-save it!)`;
      prompt += `\nHandle: ${chatContext.senderHandle}`;
      if (profile.name) {
        prompt += `\nName: ${profile.name} (already saved - do NOT call remember_user for this)`;
      }
      if (profile.facts && profile.facts.length > 0) {
        prompt += `\nThings you remember about them (already saved):\n- ${profile.facts.join('\n- ')}`;
      }
      prompt += `\n\nUse their name naturally in conversation! Only use remember_user for genuinely NEW info.`;
    } else {
      prompt += `\n\n## About the person you're talking to
Handle: ${chatContext.senderHandle}
You don't know their name yet. If they share it or it comes up naturally, use the remember_user tool to save it!`;
    }
  }

  if (chatContext?.isGroupChat) {
    const participants = chatContext.participantNames.join(', ');
    const chatName = chatContext.chatName ? `"${chatContext.chatName}"` : 'an unnamed group';
    prompt += `\n\n## Group Chat Context
You're in a group chat called ${chatName} with these participants: ${participants}

In group chats:
- Address people by name when responding to them specifically
- Be aware others can see your responses
- Keep responses even shorter since group chats move fast
- Don't react as often in groups - it can feel spammy`;
  }

  if (chatContext?.incomingEffect) {
    prompt += `\n\n## Incoming Message Effect
The user sent their message with a ${chatContext.incomingEffect.type} effect: "${chatContext.incomingEffect.name}". You can acknowledge this if relevant (e.g., "nice ${chatContext.incomingEffect.name} effect!").`;
  }

  if (chatContext?.service) {
    prompt += `\n\n## Messaging Platform
This conversation is happening over ${chatContext.service}.`;
    if (chatContext.service === 'iMessage') {
      prompt += ' Reactions and expressive effects can work here.';
    } else if (chatContext.service === 'RCS') {
      prompt += ' Prefer plain text and media. Avoid assuming expressive effects or typing indicators are available.';
    } else if (chatContext.service === 'SMS') {
      prompt += ' This is basic SMS - avoid reactions and expressive effects. Keep responses simple and concise.';
    }
  }

  return prompt;
}

const REACTION_TOOL: Anthropic.Tool = {
  name: 'send_reaction',
  description: 'Send an iMessage reaction to the user\'s message. Use standard tapbacks (love, like, laugh, etc.) OR any custom emoji. Custom emoji reactions are great for more expressive responses!',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'custom'],
        description: 'The reaction type. Use "custom" to send any emoji.',
      },
      emoji: {
        type: 'string',
        description: 'Required when type is "custom". The emoji to react with (e.g., "🔥", "💯", "🎉", "👀", "🙌").',
      },
    },
    required: ['type'],
  },
};

const EFFECT_TOOL: Anthropic.Tool = {
  name: 'send_effect',
  description: 'Add a Sendblue expressive effect to your text response. ONLY use when the user explicitly asks for an effect. You MUST also write a text message - the effect enhances your text, it does not replace it. Do NOT use for normal conversation.',
  input_schema: {
    type: 'object' as const,
    properties: {
      effect_type: {
        type: 'string',
        enum: ['screen', 'bubble'],
        description: 'Whether this is a full-screen effect or a bubble effect',
      },
      effect: {
        type: 'string',
        enum: ['celebration', 'shooting_star', 'fireworks', 'lasers', 'love', 'confetti', 'balloons', 'spotlight', 'echo', 'slam', 'loud', 'gentle', 'invisible'],
        description: 'The specific effect to use',
      },
    },
    required: ['effect_type', 'effect'],
  },
};

const REMEMBER_USER_TOOL: Anthropic.Tool = {
  name: 'remember_user',
  description: 'Save NEW information about someone. ONLY use when you learn genuinely NEW info. NEVER re-save info already shown in the system prompt. CRITICAL: You MUST write a text response too - this tool does NOT send any message, so if you use it without text, the user gets nothing!',
  input_schema: {
    type: 'object' as const,
    properties: {
      handle: {
        type: 'string',
        description: 'The phone number/handle of the person this info is about. In group chats, use this to save info about someone OTHER than the current sender. If omitted, saves to the current sender.',
      },
      name: {
        type: 'string',
        description: 'The person\'s name if they shared it (e.g., "Patrick", "Sarah"). Set this whenever you learn someone\'s name!',
      },
      fact: {
        type: 'string',
        description: 'An interesting fact about them worth remembering (e.g., "Works at Google", "Has a dog named Max", "Loves hiking"). Keep facts concise.',
      },
    },
  },
};

const GENERATE_IMAGE_TOOL: Anthropic.Tool = {
  name: 'generate_image',
  description: 'Generate an image using DALL-E. Use when the user asks you to create, draw, generate, or make an image/picture/photo. Expand their request into a detailed prompt for better results. IMPORTANT: You MUST also write a brief text message (like "on it, making that corgi now" or "lemme draw that for u") - this message will be sent BEFORE the image starts generating so the user knows something is happening.',
  input_schema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: 'Detailed description of the image to generate. Be specific about style, composition, lighting, etc. Example: "a fluffy corgi surfing on a wave, sunny day, action shot, ocean spray, photorealistic style"',
      },
    },
    required: ['prompt'],
  },
};

// Web search uses a special tool type - cast to bypass strict typing
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
} as unknown as Anthropic.Tool;

const TRAVEL_TIME_TOOL: Anthropic.Tool = {
  name: 'travel_time',
  description: 'Get travel time and directions between two locations. Supports driving, transit (bus, train, tram), walking, and bicycling. Use for "how long to get to X", "next bus/train to X", "can I drive there in 30 mins", walking times, and transit schedules.',
  input_schema: {
    type: 'object' as const,
    properties: {
      origin: { type: 'string', description: 'Starting location (address, place name, or landmark).' },
      destination: { type: 'string', description: 'Destination location (address, place name, or landmark).' },
      mode: { type: 'string', enum: ['driving', 'transit', 'walking', 'bicycling'], description: "Travel mode. Default 'driving'. Use 'transit' for public transport." },
      departure_time: { type: 'string', description: "ISO 8601 datetime or 'now'. Default 'now'." },
      arrival_time: { type: 'string', description: 'ISO 8601 datetime. Transit only.' },
      transit_preference: { type: 'string', enum: ['less_walking', 'fewer_transfers'], description: 'Transit routing preference.' },
      allowed_transit_modes: { type: 'array', items: { type: 'string', enum: ['BUS', 'SUBWAY', 'TRAIN', 'LIGHT_RAIL', 'RAIL'] }, description: 'Filter transit to specific vehicle types.' },
    },
    required: ['origin', 'destination'],
  },
};

const PLACES_SEARCH_TOOL: Anthropic.Tool = {
  name: 'places_search',
  description: 'Search for places, restaurants, cafes, bars, attractions, and businesses. Get details like phone numbers, hours, ratings, and reviews. Provide a query for search, or a place_id for full details including reviews.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Search query (e.g. "best coffee in Melbourne CBD").' },
      place_id: { type: 'string', description: 'Google Place ID from a previous search. Returns full details including reviews.' },
      location: { type: 'string', description: 'Location bias (e.g. "Melbourne CBD"). Appended to query as "near <location>".' },
      max_results: { type: 'number', description: 'Maximum results (1-10, default 5).' },
    },
  },
};

// ═══════════════════════════════════════════════════════════════
// Google Maps API handlers — Routes API v2 only (for local dev tool-use loop)
// ═══════════════════════════════════════════════════════════════

const ROUTES_API = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const PLACES_TEXT_SEARCH_API = 'https://places.googleapis.com/v1/places:searchText';
const PLACES_DETAIL_API = 'https://places.googleapis.com/v1/places';
const MAPS_FETCH_TIMEOUT_MS = 10_000;

const TRANSIT_FIELD_MASK = [
  'routes.legs.duration', 'routes.legs.steps.transitDetails',
  'routes.legs.steps.startLocation', 'routes.legs.steps.endLocation',
  'routes.legs.steps.travelMode', 'routes.legs.steps.localizedValues',
  'routes.legs.steps.navigationInstruction', 'routes.legs.stepsOverview',
  'routes.localizedValues', 'routes.travelAdvisory', 'routes.legs.localizedValues',
].join(',');

const DRIVE_FIELD_MASK = [
  'routes.duration', 'routes.distanceMeters', 'routes.localizedValues',
  'routes.legs.duration', 'routes.legs.distanceMeters', 'routes.legs.localizedValues',
  'routes.legs.steps.navigationInstruction', 'routes.legs.steps.localizedValues',
].join(',');

const MODE_MAP: Record<string, string> = { driving: 'DRIVE', walking: 'WALK', bicycling: 'BICYCLE', transit: 'TRANSIT' };

function mapsFetchWithTimeout(url: string, init?: RequestInit, timeoutMs = MAPS_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function mapsRetryFetch(url: string, init?: RequestInit, timeoutMs = MAPS_FETCH_TIMEOUT_MS): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await mapsFetchWithTimeout(url, init, timeoutMs);
      if (resp.ok || (resp.status >= 400 && resp.status < 500 && resp.status !== 429)) return resp;
      if (attempt < 1) await new Promise(r => setTimeout(r, 1500));
      else return resp;
    } catch (e) {
      if (attempt < 1) await new Promise(r => setTimeout(r, 1500));
      else throw e;
    }
  }
  throw new Error('mapsRetryFetch: should not reach here');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseTransitRoutesV2(routes: any[], origin: string, destination: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const options = routes.slice(0, 3).map((route: any, idx: number) => {
    const leg = route.legs?.[0];
    if (!leg) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const option: any = {
      option: idx + 1,
      duration: route.localizedValues?.duration?.text ?? leg.localizedValues?.duration?.text,
      duration_seconds: leg.duration ? parseInt(String(leg.duration).replace('s', ''), 10) : undefined,
    };
    const advisory = route.travelAdvisory;
    if (advisory?.transitFare) {
      const fare = advisory.transitFare;
      option.fare = `${fare.currencyCode} ${(parseInt(fare.units ?? '0', 10) + (fare.nanos ?? 0) / 1e9).toFixed(2)}`;
    }
    if (route.localizedValues?.transitFare?.text) option.fare = route.localizedValues.transitFare.text;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transitSteps = (leg.steps ?? []).filter((s: any) => s.travelMode === 'TRANSIT' || s.travelMode === 'WALK').slice(0, 10).map((s: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const step: any = { mode: s.travelMode === 'WALK' ? 'walking' : 'transit' };
      if (s.localizedValues) { step.distance = s.localizedValues.distance?.text; step.duration = s.localizedValues.staticDuration?.text; }
      if (s.navigationInstruction?.instructions) step.instruction = s.navigationInstruction.instructions;
      if (s.transitDetails) {
        const td = s.transitDetails;
        const line = td.transitLine;
        if (line) { step.line_name = line.nameShort || line.name; step.line_full_name = line.name; if (line.vehicle) { step.vehicle_type = line.vehicle.type?.toLowerCase(); } if (line.agencies?.length) step.agency = line.agencies[0].name; }
        step.num_stops = td.stopCount;
        if (td.stopDetails) {
          step.departure_stop = td.stopDetails.departureStop?.name;
          step.arrival_stop = td.stopDetails.arrivalStop?.name;
          if (td.stopDetails.departureTime) step.departs_at = td.localizedValues?.departureTime?.time?.text ?? td.stopDetails.departureTime;
          if (td.stopDetails.arrivalTime) step.arrives_at = td.localizedValues?.arrivalTime?.time?.text ?? td.stopDetails.arrivalTime;
        }
        if (td.headsign) step.direction = td.headsign;
      }
      return step;
    });
    if (transitSteps.length) option.legs = transitSteps;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstTransit = transitSteps.find((s: any) => s.mode === 'transit');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lastTransit = [...transitSteps].reverse().find((s: any) => s.mode === 'transit');
    if (firstTransit?.departs_at) option.depart_at = firstTransit.departs_at;
    if (lastTransit?.arrives_at) option.arrive_at = lastTransit.arrives_at;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstWalk = transitSteps.find((s: any) => s.mode === 'walking');
    if (firstWalk) option.walk_to_station = { duration: firstWalk.duration, distance: firstWalk.distance };
    return option;
  }).filter(Boolean);
  return { mode: 'transit', origin, destination, options };
}

async function executeTravelTime(input: Record<string, unknown>): Promise<string> {
  const origin = input.origin as string;
  const destination = input.destination as string;
  if (!origin || !destination) return JSON.stringify({ error: "Both 'origin' and 'destination' are required." });

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return JSON.stringify({ error: 'Google Maps not configured. Use web_search as fallback.', fallback_query: `travel time from ${origin} to ${destination}` });

  const mode = (input.mode as string) ?? 'driving';
  const travelMode = MODE_MAP[mode] ?? 'DRIVE';
  const isTransit = travelMode === 'TRANSIT';
  const departureTime = input.departure_time as string | undefined;
  const arrivalTime = input.arrival_time as string | undefined;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = { origin: { address: origin }, destination: { address: destination }, travelMode };

    if (isTransit) {
      body.computeAlternativeRoutes = true;
      if (arrivalTime && arrivalTime !== 'now') body.arrivalTime = new Date(arrivalTime).toISOString();
      else if (departureTime && departureTime !== 'now') { const d = new Date(departureTime); if (!isNaN(d.getTime()) && d.getTime() > Date.now()) body.departureTime = d.toISOString(); }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prefs: any = {};
      const tp = input.transit_preference as string | undefined;
      if (tp === 'less_walking' || tp === 'LESS_WALKING') prefs.routingPreference = 'LESS_WALKING';
      else if (tp === 'fewer_transfers' || tp === 'FEWER_TRANSFERS') prefs.routingPreference = 'FEWER_TRANSFERS';
      const am = input.allowed_transit_modes as string[] | undefined;
      if (am?.length) prefs.allowedTravelModes = am.map(m => m.toUpperCase());
      if (Object.keys(prefs).length) body.transitPreferences = prefs;
    } else if (travelMode === 'DRIVE') {
      body.routingPreference = 'TRAFFIC_AWARE';
      if (departureTime && departureTime !== 'now') { const d = new Date(departureTime); if (!isNaN(d.getTime()) && d.getTime() > Date.now()) body.departureTime = d.toISOString(); }
    }

    const fieldMask = isTransit ? TRANSIT_FIELD_MASK : DRIVE_FIELD_MASK;
    console.log(`[travel_time] Routes API ${mode}: ${origin} → ${destination}`);
    const resp = await mapsRetryFetch(ROUTES_API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fieldMask }, body: JSON.stringify(body) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await resp.json();

    if (data.error) return JSON.stringify({ error: data.error.message, fallback_query: `${origin} to ${destination} by ${mode}` });
    if (!data.routes?.length) return JSON.stringify({ error: `No ${mode} routes found.`, fallback_query: `${origin} to ${destination} by ${mode}` });

    if (isTransit) return JSON.stringify(parseTransitRoutesV2(data.routes, origin, destination));

    // Non-transit: simple response
    const route = data.routes[0];
    const leg = route.legs?.[0];
    const locValues = route.localizedValues ?? leg?.localizedValues;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = { origin, destination, distance: locValues?.distance?.text, duration: locValues?.duration?.text, mode };
    if (locValues?.staticDuration?.text && locValues.staticDuration.text !== locValues.duration?.text) result.duration_without_traffic = locValues.staticDuration.text;
    const durationSec = route.duration ? parseInt(String(route.duration).replace('s', ''), 10) : undefined;
    if (durationSec) result.duration_seconds = durationSec;
    if (departureTime && departureTime !== 'now') {
      result.departure_time = departureTime;
      const depMs = new Date(departureTime).getTime();
      if (!isNaN(depMs) && durationSec) result.estimated_arrival = new Date(depMs + durationSec * 1000).toISOString();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps = (leg?.steps ?? []).slice(0, 5).map((s: any) => ({ instruction: s.navigationInstruction?.instructions, distance: s.localizedValues?.distance?.text, duration: s.localizedValues?.staticDuration?.text })).filter((s: any) => s.instruction);
    if (steps.length) result.route_summary = steps;
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message, fallback_query: `travel time from ${origin} to ${destination} by ${mode}` });
  }
}

async function executePlacesSearch(input: Record<string, unknown>): Promise<string> {
  const query = input.query as string | undefined;
  const placeId = input.place_id as string | undefined;
  if (!query && !placeId) return JSON.stringify({ error: "Provide 'query' or 'place_id'." });

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return JSON.stringify({ error: 'Google Maps not configured. Use web_search as fallback.', fallback_query: query ?? `place ${placeId}` });

  try {
    if (placeId) {
      const fieldMask = ['displayName', 'formattedAddress', 'rating', 'userRatingCount', 'priceLevel', 'types', 'websiteUri', 'nationalPhoneNumber', 'internationalPhoneNumber', 'currentOpeningHours', 'editorialSummary', 'reviews', 'googleMapsUri', 'adrFormatAddress'].join(',');
      console.log(`[places_search] Detail: ${placeId}`);
      const resp = await mapsFetchWithTimeout(`${PLACES_DETAIL_API}/${placeId}`, { headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fieldMask } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p: any = await resp.json();
      if (p.error) return JSON.stringify({ error: p.error.message });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = { name: p.displayName?.text, address: p.formattedAddress, google_maps_url: p.googleMapsUri };
      if (p.rating) result.rating = `${p.rating}/5 (${p.userRatingCount ?? 0} reviews)`;
      if (p.nationalPhoneNumber) result.phone = p.nationalPhoneNumber;
      if (p.internationalPhoneNumber) result.international_phone = p.internationalPhoneNumber;
      if (p.websiteUri) result.website = p.websiteUri;
      if (p.editorialSummary?.text) result.summary = p.editorialSummary.text;
      if (p.currentOpeningHours) { result.open_now = p.currentOpeningHours.openNow; if (p.currentOpeningHours.weekdayDescriptions?.length) result.hours = p.currentOpeningHours.weekdayDescriptions; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (p.reviews?.length) result.top_reviews = p.reviews.slice(0, 3).map((r: any) => ({ rating: r.rating, text: r.text?.text?.slice(0, 200), time: r.relativePublishTimeDescription }));
      return JSON.stringify(result);
    }

    // Text search
    const maxResults = Math.min((input.max_results as number) ?? 5, 10);
    const locationBias = input.location as string | undefined;
    const textQuery = locationBias ? `${query} near ${locationBias}` : query!;
    const fieldMask = ['places.displayName', 'places.formattedAddress', 'places.rating', 'places.userRatingCount', 'places.priceLevel', 'places.types', 'places.websiteUri', 'places.nationalPhoneNumber', 'places.currentOpeningHours', 'places.editorialSummary', 'places.googleMapsUri', 'places.id'].join(',');
    console.log(`[places_search] Text search: "${textQuery}"`);
    const resp = await mapsFetchWithTimeout(PLACES_TEXT_SEARCH_API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fieldMask }, body: JSON.stringify({ textQuery, maxResultCount: maxResults, languageCode: 'en' }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await resp.json();
    if (data.error) return JSON.stringify({ error: data.error.message });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const places = (data.places ?? []).map((p: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = { name: p.displayName?.text, address: p.formattedAddress, place_id: p.id, google_maps_url: p.googleMapsUri };
      if (p.rating) r.rating = `${p.rating}/5 (${p.userRatingCount ?? 0} reviews)`;
      if (p.priceLevel) r.price_level = p.priceLevel;
      if (p.nationalPhoneNumber) r.phone = p.nationalPhoneNumber;
      if (p.websiteUri) r.website = p.websiteUri;
      if (p.editorialSummary?.text) r.summary = p.editorialSummary.text;
      if (p.currentOpeningHours?.openNow !== undefined) r.open_now = p.currentOpeningHours.openNow;
      return r;
    });
    return JSON.stringify({ results: places, count: places.length });
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message, fallback_query: query ?? `place ${placeId}` });
  }
}

const MAPS_TOOLS = new Set(['travel_time', 'places_search']);

export type StandardReactionType = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';
export type ReactionType = StandardReactionType | 'custom';
export type MessageEffect = { type: 'screen' | 'bubble'; name: string };

export type Reaction = {
  type: StandardReactionType;
} | {
  type: 'custom';
  emoji: string;
};

export interface ChatResponse {
  text: string | null;
  reaction: Reaction | null;
  effect: MessageEffect | null;
  rememberedUser: { name?: string; fact?: string; isForSender?: boolean } | null;
  generatedImage: { url: string; prompt: string } | null;
}

export interface ImageInput {
  url: string;
  mimeType: string;
}

export interface AudioInput {
  url: string;
  mimeType: string;
}

// Generate an image using OpenAI DALL-E API
export async function generateImage(prompt: string): Promise<string | null> {
  try {
    console.log(`[claude] Generating image with DALL-E: "${prompt.substring(0, 50)}..."`);
    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt: prompt,
      n: 1,
      size: '1024x1024',
      quality: 'standard',
    });

    const imageUrl = response.data?.[0]?.url;
    if (imageUrl) {
      console.log(`[claude] Image generated: ${imageUrl.substring(0, 50)}...`);
      return imageUrl;
    }
    console.error('[claude] No image URL in DALL-E response');
    return null;
  } catch (error) {
    console.error('[claude] DALL-E error:', error);
    return null;
  }
}

// Transcribe audio using OpenAI Whisper API
async function transcribeAudio(url: string): Promise<string | null> {
  try {
    console.log(`[claude] Fetching audio for transcription: ${url.substring(0, 50)}...`);
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[claude] Failed to fetch audio: ${response.status}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'audio/mp4';
    console.log(`[claude] Audio fetched: ${Math.round(arrayBuffer.byteLength / 1024)}KB, type: ${contentType}`);

    // Create a File-like object for the Whisper API
    const blob = new Blob([arrayBuffer], { type: contentType });
    const file = new File([blob], 'voice_memo.m4a', { type: contentType });

    console.log(`[claude] Transcribing with Whisper...`);
    const transcription = await openai.audio.transcriptions.create({
      file: file,
      model: 'whisper-1',
    });

    console.log(`[claude] Transcription complete: "${transcription.text.substring(0, 50)}..."`);
    return transcription.text;
  } catch (error) {
    console.error(`[claude] Transcription error:`, error);
    return null;
  }
}

export type MessageService = 'iMessage' | 'SMS' | 'RCS';

export interface ChatContext {
  isGroupChat: boolean;
  participantNames: string[];
  chatName: string | null;
  incomingEffect?: { type: 'screen' | 'bubble'; name: string };
  senderHandle?: string;
  senderProfile?: UserProfile | null;
  service?: MessageService;
}

/**
 * Convert stored messages to Anthropic format, adding sender attribution for group chats.
 * In group chats, user messages are prefixed with the sender's handle so Claude knows who said what.
 */
function formatHistoryForClaude(messages: StoredMessage[], isGroupChat: boolean): Anthropic.MessageParam[] {
  return messages.map(msg => {
    let content = msg.content;

    // In group chats, prefix user messages with who sent them
    if (isGroupChat && msg.role === 'user' && msg.handle) {
      content = `[${msg.handle}]: ${content}`;
    }

    return {
      role: msg.role,
      content: content,
    };
  });
}

export async function chat(chatId: string, userMessage: string, images: ImageInput[] = [], audio: AudioInput[] = [], chatContext?: ChatContext): Promise<ChatResponse> {
  const emptyResponse = {
    reaction: null,
    effect: null,
    rememberedUser: null,
    generatedImage: null,
  };

  const cmd = userMessage.toLowerCase().trim();

  // Handle special commands
  if (cmd === '/help') {
    return {
      text: "commands:\n/clear - reset our conversation\n/forget me - erase what i know about you\n/help - this message",
      ...emptyResponse,
    };
  }

  if (cmd === '/clear') {
    await clearConversation(chatId);
    return {
      text: "conversation cleared, fresh start 🧹",
      ...emptyResponse,
    };
  }

  if (cmd === '/forget me' || cmd === '/forgetme') {
    if (chatContext?.senderHandle) {
      await clearUserProfile(chatContext.senderHandle);
      return {
        text: "done, i've forgotten everything about you. we're strangers now 👋",
        ...emptyResponse,
      };
    }
    return {
      text: "hmm couldn't figure out who you are to forget you",
      ...emptyResponse,
    };
  }

  // Get conversation history (keyed by chat_id to keep conversations separate)
  const history = await getConversation(chatId);

  // Build message content (text + images + audio)
  const messageContent: Anthropic.ContentBlockParam[] = [];

  // Add images first
  for (const image of images) {
    messageContent.push({
      type: 'image',
      source: {
        type: 'url',
        url: image.url,
      },
    });
    console.log(`[claude] Including image: ${image.url.substring(0, 50)}...`);
  }

  // Transcribe audio files and add as text context
  const transcriptions: string[] = [];
  let transcriptionFailed = false;
  for (const audioFile of audio) {
    const transcript = await transcribeAudio(audioFile.url);
    if (transcript) {
      transcriptions.push(transcript);
    } else {
      transcriptionFailed = true;
    }
  }

  // Build the text to send
  let textToSend = userMessage.trim();

  // If we have transcriptions, prepend them to the message
  if (transcriptions.length > 0) {
    const transcriptText = transcriptions.join('\n');
    if (textToSend) {
      textToSend = `[Voice memo transcript: "${transcriptText}"]\n\n${textToSend}`;
    } else {
      textToSend = `[Voice memo transcript: "${transcriptText}"]\n\nRespond naturally to what they said in the voice memo.`;
    }
  } else if (audio.length > 0 && transcriptionFailed) {
    // Transcription failed - let Claude know
    textToSend = textToSend || "[Someone sent a voice memo but transcription failed. Let them know you couldn't hear it and ask them to try again or type their message.]";
  } else if (!textToSend) {
    // Default prompts for images only (no audio, no text)
    if (images.length > 0) {
      textToSend = "What's in this image?";
    }
  }
  if (textToSend) {
    messageContent.push({ type: 'text', text: textToSend });
  }

  // Add user message to history with sender handle (for group chat attribution)
  if (textToSend) {
    await addMessage(chatId, 'user', textToSend, chatContext?.senderHandle);
  }

  try {
    if (chatContext?.isGroupChat) {
      console.log(`[claude] Group chat detected: ${chatContext.participantNames.length} participants`);
    }

    // Format history with sender attribution for group chats
    const formattedHistory = formatHistoryForClaude(history, chatContext?.isGroupChat ?? false);

    // Build tools list
    const tools: Anthropic.Tool[] = [REACTION_TOOL, EFFECT_TOOL, REMEMBER_USER_TOOL, GENERATE_IMAGE_TOOL, WEB_SEARCH_TOOL, TRAVEL_TIME_TOOL, PLACES_SEARCH_TOOL];

    // Tool-use loop: allows Claude to call maps tools, receive results, and format them
    const messages: Anthropic.MessageParam[] = [...formattedHistory, { role: 'user', content: messageContent }];
    const MAX_TOOL_ROUNDS = 3;
    let finalResponse: Anthropic.Message | null = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: round === 0 ? 1024 : 2048,
        system: buildSystemPrompt(chatContext),
        tools,
        messages,
      });

      // Check if any maps tools were called that need execution
      const mapsToolUses = response.content.filter(
        (b): b is Anthropic.ContentBlock & { type: 'tool_use' } =>
          b.type === 'tool_use' && MAPS_TOOLS.has(b.name)
      );

      if (mapsToolUses.length === 0 || response.stop_reason !== 'tool_use') {
        finalResponse = response;
        break;
      }

      // Execute maps tools and build tool results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of response.content) {
        if (toolUse.type !== 'tool_use') continue;

        if (MAPS_TOOLS.has(toolUse.name)) {
          const input = toolUse.input as Record<string, unknown>;
          let result: string;
          if (toolUse.name === 'travel_time') {
            result = await executeTravelTime(input);
          } else {
            result = await executePlacesSearch(input);
          }
          console.log(`[claude] ${toolUse.name} result: ${result.substring(0, 100)}...`);
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
        } else {
          // Non-maps tools get an "ok" acknowledgment so the loop can continue
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: 'ok' });
        }
      }

      // Append assistant response + tool results for next round
      messages.push({ role: 'assistant', content: response.content as Anthropic.ContentBlockParam[] });
      messages.push({ role: 'user', content: toolResults });
    }

    if (!finalResponse) {
      throw new Error('Tool-use loop exceeded max rounds');
    }

    // Extract text response and tool calls from final response
    const textParts: string[] = [];
    let reaction: Reaction | null = null;
    let effect: MessageEffect | null = null;
    let rememberedUser: { name?: string; fact?: string; isForSender?: boolean } | null = null;
    let generatedImage: { url: string; prompt: string } | null = null;

    for (const block of finalResponse.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use' && block.name === 'send_reaction') {
        const input = block.input as { type: ReactionType; emoji?: string };
        if (input.type === 'custom' && input.emoji) {
          reaction = { type: 'custom', emoji: input.emoji };
          console.log(`[claude] Wants to react with custom emoji: ${input.emoji}`);
        } else if (input.type !== 'custom') {
          reaction = { type: input.type as StandardReactionType };
          console.log(`[claude] Wants to react with: ${input.type}`);
        }
      } else if (block.type === 'tool_use' && block.name === 'send_effect') {
        const input = block.input as { effect_type: 'screen' | 'bubble'; effect: string };
        effect = { type: input.effect_type, name: input.effect };
        console.log(`[claude] Wants to send with effect: ${input.effect_type} - ${input.effect}`);
      } else if (block.type === 'tool_use' && block.name === 'remember_user') {
        const input = block.input as { handle?: string; name?: string; fact?: string };
        // Use provided handle, or fall back to sender
        const targetHandle = input.handle || chatContext?.senderHandle;
        if (targetHandle) {
          let nameChanged = false;
          let factChanged = false;

          if (input.name) {
            nameChanged = await setUserName(targetHandle, input.name);
            if (nameChanged) {
              console.log(`[claude] Remembered name for ${targetHandle}: ${input.name}`);
            } else {
              console.log(`[claude] Name already known for ${targetHandle}, skipped`);
            }
          }
          if (input.fact) {
            factChanged = await addUserFact(targetHandle, input.fact);
            if (factChanged) {
              console.log(`[claude] Remembered fact for ${targetHandle}: ${input.fact}`);
            } else {
              console.log(`[claude] Fact already known for ${targetHandle}, skipped`);
            }
          }

          // Only set rememberedUser if something actually changed
          if (nameChanged || factChanged) {
            const isForSender = !input.handle || input.handle === chatContext?.senderHandle;
            rememberedUser = {
              name: nameChanged ? input.name : undefined,
              fact: factChanged ? input.fact : undefined,
              isForSender
            };
          }
        }
      } else if (block.type === 'tool_use' && block.name === 'generate_image') {
        const input = block.input as { prompt: string };
        console.log(`[claude] Wants to generate image: ${input.prompt.substring(0, 50)}...`);
        // Don't generate yet - just capture the prompt. We'll generate after sending text.
        generatedImage = { url: '', prompt: input.prompt };
      }
    }

    const textResponse = textParts.length > 0 ? textParts.join('\n') : null;

    // Add assistant response to history (only text part, strip --- delimiters for cleaner context)
    // Note: image generation is handled separately in index.ts after sending text first
    if (textResponse) {
      const historyMessage = splitBubbles(textResponse).join(' ');
      await addMessage(chatId, 'assistant', historyMessage);
    } else if (effect) {
      // Save effect-only responses so Claude knows what it did (prevents effect loops)
      await addMessage(chatId, 'assistant', `[sent ${effect.name} effect]`);
    } else if (reaction) {
      // Save reaction-only responses so Claude knows what it did (prevents reaction loops)
      const reactionDisplay = reaction.type === 'custom' ? (reaction as { type: 'custom'; emoji: string }).emoji : reaction.type;
      await addMessage(chatId, 'assistant', `[reacted with ${reactionDisplay}]`);
    }

    return { text: textResponse, reaction, effect, rememberedUser, generatedImage };
  } catch (error) {
    console.error('[claude] API error:', error);
    throw error;
  }
}

/**
 * Simple text-only completion for follow-up requests (no tools).
 */
export async function getTextForEffect(effectName: string): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: `Write a very short, fun message (under 10 words) to send with a ${effectName} iMessage effect. Just the message, nothing else.`
    }],
  });

  if (response.content[0].type === 'text') {
    return response.content[0].text;
  }
  return `✨ ${effectName}! ✨`;
}

export type GroupChatAction = 'respond' | 'react' | 'ignore';

/**
 * Use Haiku to quickly determine how Claude should handle a group chat message.
 * Returns 'respond' (full message), 'react' (just tapback), or 'ignore'.
 */
export async function getGroupChatAction(
  message: string,
  sender: string,
  chatId: string
): Promise<{ action: GroupChatAction; reaction?: Reaction }> {
  const start = Date.now();

  // Get recent conversation history for context (keyed by chat_id)
  const history = await getConversation(chatId);
  const recentMessages = history.slice(-4); // Last 2 exchanges

  let contextBlock = '';
  if (recentMessages.length > 0) {
    // Format with sender handles so Claude knows who said what
    const formatted = recentMessages.map(msg => {
      if (msg.role === 'assistant') {
        return `Claude: ${msg.content}`;
      } else {
        // Show who sent the message in group chats
        const sender = msg.handle || 'Someone';
        return `${sender}: ${msg.content}`;
      }
    }).join('\n');
    contextBlock = `\nRecent conversation:\n${formatted}\n`;
    console.log(`[claude] groupChatAction context (${recentMessages.length} msgs): ${formatted.substring(0, 100)}...`);
  } else {
    console.log(`[claude] groupChatAction context: no recent messages`);
  }

  try {
    const response = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 20,
      system: `You classify how an AI assistant "Claude" should handle messages in a group chat.

IMPORTANT: BIAS TOWARD "respond" - text responses are almost always better than reactions. Only use "react" for very brief acknowledgments where a text response would be awkward.

Answer with ONE of these:
- "respond" - Claude should send a text reply. USE THIS BY DEFAULT when:
  * They asked Claude anything
  * They mentioned Claude (or misspelled it - cluade, cloude, cladue, claud, etc.)
  * They mentioned "AI", "bot", "assistant", or "Sullivan"
  * They're talking to Claude or continuing a conversation
  * It's a follow-up to Claude's message
  * You're unsure - default to respond
- "react:love" or "react:like" or "react:laugh" - ONLY for brief acknowledgments where text would be weird (like a simple "thanks!" or "lol"). Do NOT overuse reactions.
- "ignore" - Human-to-human conversation not involving Claude at all

ANTI-REACTION-LOOP: If you see reactions in recent context, prefer "respond" to break the pattern. People want conversation, not tapbacks.

MISSPELLING TOLERANCE: People often typo "Claude" as cluade, cloude, cladue, claud, ckaude, etc. Treat these as mentions of Claude and respond!

Examples:
- "hey claude what's the weather" -> respond
- "cluade what do u think" -> respond (misspelling!)
- "cloude help me" -> respond (misspelling!)
- "claude thoughts?" -> respond
- "that's cool claude" -> respond (engage, don't just react!)
- "thanks!" (very brief, nothing to add) -> react:love
- "yo mike you coming tonight?" -> ignore`,
      messages: [{
        role: 'user',
        content: `${contextBlock}New message from ${sender}: "${message}"\n\nHow should Claude handle this?`
      }],
    });

    const answer = response.content[0].type === 'text'
      ? response.content[0].text.toLowerCase().trim()
      : 'ignore';

    let action: GroupChatAction = 'ignore';
    let reaction: Reaction | undefined;

    if (answer.includes('respond')) {
      action = 'respond';
    } else if (answer.includes('react')) {
      action = 'react';
      if (answer.includes('love')) reaction = { type: 'love' };
      else if (answer.includes('laugh')) reaction = { type: 'laugh' };
      else if (answer.includes('like')) reaction = { type: 'like' };
      else if (answer.includes('emphasize')) reaction = { type: 'emphasize' };
      else reaction = { type: 'like' }; // default reaction
    }

    const reactionDisplay = reaction ? (reaction.type === 'custom' ? (reaction as { type: 'custom'; emoji: string }).emoji : reaction.type) : '';
    console.log(`[claude] groupChatAction (${Date.now() - start}ms): "${message.substring(0, 50)}..." -> ${action}${reactionDisplay ? `:${reactionDisplay}` : ''}`);

    return { action, reaction };
  } catch (error) {
    console.error('[claude] groupChatAction error:', error);
    return { action: 'ignore' };
  }
}
