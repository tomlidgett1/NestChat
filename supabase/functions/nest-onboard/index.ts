import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { activateUser, getUserByToken, updateUserTimezone } from '../_shared/state.ts';
import { getAdminClient } from '../_shared/supabase.ts';
import { createChat } from '../_shared/linq.ts';
import { fetchGrantedScopes, mergeScopes, BASE_SCOPES } from '../_shared/google-scopes.ts';
import { scheduleEnsureNotificationWebhooksAfterAccountLink } from '../_shared/ensure-notification-webhooks.ts';
import { internalJsonHeaders } from '../_shared/internal-auth.ts';
import { enrichByPhone } from '../_shared/pdl.ts';
import { fetchCalendarTimezone, fetchOutlookTimezone } from '../_shared/calendar-helpers.ts';
import { getOpenAIClient, MODEL_MAP } from '../_shared/ai/models.ts';
import { isGeminiModel, geminiSimpleText } from '../_shared/ai/gemini.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function fetchGoogleProfile(accessToken: string): Promise<{ email: string; name: string; picture: string } | null> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[nest-onboard] Google profile fetch failed: ${res.status} ${body.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    console.log(`[nest-onboard] Google profile fetched: email=${data.email}, name=${data.name}`);
    return { email: data.email ?? '', name: data.name ?? '', picture: data.picture ?? '' };
  } catch (e) {
    console.error('[nest-onboard] Google profile fetch error:', (e as Error).message);
    return null;
  }
}

async function fetchMicrosoftProfile(accessToken: string): Promise<{ email: string; name: string; picture: string } | null> {
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const email = data.mail ?? data.userPrincipalName ?? '';
    const name = data.displayName ?? '';
    let picture = '';
    try {
      const photoRes = await fetch('https://graph.microsoft.com/v1.0/me/photo/$value', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (photoRes.ok) {
        const blob = await photoRes.arrayBuffer();
        const bytes = new Uint8Array(blob);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        picture = `data:image/jpeg;base64,${btoa(binary)}`;
      }
    } catch { /* photo not available */ }
    return { email, name, picture };
  } catch {
    return null;
  }
}

// ── Personalised welcome helpers ──

const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com',
  'yahoo.co.uk', 'icloud.com', 'me.com', 'mac.com', 'live.com', 'live.co.uk',
  'protonmail.com', 'proton.me', 'aol.com', 'mail.com', 'zoho.com',
  'fastmail.com', 'hey.com', 'pm.me', 'ymail.com', 'rocketmail.com',
]);

function isPersonalEmail(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  return !domain || PERSONAL_EMAIL_DOMAINS.has(domain);
}

function timezoneToCity(tz: string): string | null {
  if (!tz || tz === 'UTC') return null;
  const parts = tz.split('/');
  const city = parts[parts.length - 1];
  if (!city) return null;
  return city.replace(/_/g, ' ');
}

async function fetchTimezoneWithFallback(accessToken: string, isMicrosoft: boolean): Promise<string> {
  if (isMicrosoft) {
    return fetchOutlookTimezone(accessToken);
  }

  // Try the settings endpoint first (requires calendar.readonly or calendar.settings.readonly)
  const settingsTz = await fetchCalendarTimezone(accessToken);
  if (settingsTz && settingsTz !== 'UTC') {
    console.log(`[nest-onboard] Timezone from settings endpoint: ${settingsTz}`);
    return settingsTz;
  }

  // Fallback: the events list endpoint returns the calendar's timeZone in the response body
  // and only requires calendar.events scope
  console.log('[nest-onboard] Settings endpoint returned UTC/failed — trying events endpoint fallback');
  try {
    const now = new Date().toISOString();
    const resp = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now}&maxResults=1&singleEvents=true&orderBy=startTime`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (resp.ok) {
      const data = await resp.json();
      const tz = data.timeZone ?? '';
      console.log(`[nest-onboard] Timezone from events endpoint: ${tz}`);
      if (tz && tz !== 'UTC') return tz;
    } else {
      console.warn(`[nest-onboard] Events endpoint failed: ${resp.status}`);
    }
  } catch (e) {
    console.warn('[nest-onboard] Events timezone fallback error:', (e as Error).message);
  }

  return settingsTz;
}

async function fastLlmText(systemPrompt: string, userMessage: string, maxTokens = 150): Promise<string> {
  const model = MODEL_MAP.fast;
  if (isGeminiModel(model)) {
    const result = await geminiSimpleText({ model, systemPrompt, userMessage, maxOutputTokens: maxTokens });
    return result.text;
  }
  const client = getOpenAIClient();
  const response = await client.responses.create({
    model,
    instructions: systemPrompt,
    input: userMessage,
    max_output_tokens: maxTokens,
    store: false,
  } as Parameters<typeof client.responses.create>[0]);
  return response.output_text ?? '';
}

interface CompanyProfile {
  name: string;
  oneLiner: string;
}

async function inferCompanyFromDomain(domain: string): Promise<CompanyProfile | null> {
  console.log(`[nest-onboard] inferCompanyFromDomain called — domain=${domain}`);
  try {
    const rawText = await fastLlmText(
      `You are a company lookup tool. Given an email domain, return a JSON object with two fields:
- "name": the company name
- "oneLiner": a short, specific description of what the company does (max 15 words). Be specific about their product/service, not generic.

If you cannot determine the company, return exactly: {"name":"unknown","oneLiner":""}

Examples:
- "blacklane.com" → {"name":"Blacklane","oneLiner":"premium chauffeur and airport transfer service for business travellers"}
- "canva.com" → {"name":"Canva","oneLiner":"online design platform for creating graphics, presentations and social content"}
- "atlassian.com" → {"name":"Atlassian","oneLiner":"makes Jira, Confluence and collaboration tools for software teams"}

Output ONLY the JSON object, nothing else.`,
      domain,
      120,
    );
    console.log(`[nest-onboard] inferCompanyFromDomain raw result: "${rawText.trim()}"`);
    try {
      const cleaned = rawText.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(cleaned);
      if (!parsed.name || parsed.name.toLowerCase() === 'unknown') {
        console.warn('[nest-onboard] inferCompanyFromDomain returned unknown');
        return null;
      }
      const profile: CompanyProfile = {
        name: parsed.name,
        oneLiner: parsed.oneLiner ?? '',
      };
      console.log(`[nest-onboard] inferCompanyFromDomain parsed — name="${profile.name}", oneLiner="${profile.oneLiner}"`);
      return profile;
    } catch {
      const text = rawText.trim().toLowerCase();
      if (!text || text === 'unknown' || text.length > 100) return null;
      return { name: rawText.trim(), oneLiner: '' };
    }
  } catch (e) {
    console.error('[nest-onboard] inferCompanyFromDomain failed:', (e as Error).message);
    return null;
  }
}

async function generatePersonalisedWelcome(name: string | null, company: CompanyProfile | null, city: string | null): Promise<string | null> {
  console.log(`[nest-onboard] generatePersonalisedWelcome called — name=${name}, company=${JSON.stringify(company)}, city=${city}`);
  if (!company && !city) {
    console.warn('[nest-onboard] generatePersonalisedWelcome skipped — no company and no city');
    return null;
  }
  try {
    const context = [
      name ? `Name: ${name}` : '',
      company ? `Company: ${company.name}` : '',
      company?.oneLiner ? `What they do: ${company.oneLiner}` : '',
      city ? `City: ${city}` : '',
    ].filter(Boolean).join('\n');
    console.log(`[nest-onboard] generatePersonalisedWelcome LLM input: "${context}"`);

    const systemPrompt = `You are Nest, a personal AI assistant. Generate a short, cheeky welcome message for someone who just verified their account.

CRITICAL RULES:
- Use what you know about their company to make a SPECIFIC, knowing comment. Reference what the company actually does — not just the name. Show you know things.
- Keep it under 30 words total.
- No emojis. Australian spelling.
- Normal sentence case: start every sentence with a capital letter; keep the rest casual (natural lowercase within sentences, not title case). Never begin a sentence with a lowercase letter.
- Tone: warm, confident, slightly cheeky, like a well-connected mate who knows the industry.
- Output a SINGLE LINE of text. NO line breaks, NO newlines. Just one flowing sentence or two short sentences on the same line.
- NEVER say "personal assistant", never pitch features, never use exclamation marks.
- NEVER be generic. "heard good things about X" is BANNED. Reference something specific about what the company does.

Good examples (do NOT copy — generate something original):
- Name: Sarah, Company: Canva, City: Sydney
  "Hey sarah, welcome — designing the future of visual content from sydney, not a bad gig"

- Name: James, Company: Atlassian (makes Jira and Confluence), City: Sydney  
  "James, welcome — so you're one of the people behind every standup meeting in tech. respect"

- Name: Tom, Company: Blacklane (premium chauffeur service), City: Melbourne
  "Tom, welcome — keeping the world's execs moving in style from melbourne, i like it"

Bad examples (NEVER do this):
- "heard good things about [company]" ← too generic
- "[city] treating you well?" ← filler, says nothing
- "welcome to the inner circle" ← cringe
- "hey tom" ← must start with capital: "Hey tom"
- Any output with line breaks or newlines ← BANNED

Output ONLY the single-line message, nothing else.`;

    let text = (await fastLlmText(systemPrompt, context, 150)).trim();
    console.log(`[nest-onboard] generatePersonalisedWelcome LLM output: "${text}"`);
    text = text.replace(/\n---\n/g, ' ').replace(/^---\n/g, '').replace(/\n---$/g, '').replace(/\n+/g, ' ').trim();
    if (text) text = text.charAt(0).toUpperCase() + text.slice(1);
    return text || null;
  } catch (e) {
    console.error('[nest-onboard] generatePersonalisedWelcome failed:', (e as Error).message);
    return null;
  }
}

async function buildWelcomeMessage(
  handle: string,
  profile: { email: string; name: string } | null,
  providerToken: string,
  isMicrosoft: boolean,
): Promise<string> {
  const fallbackMessages = [
    "Well look at that, you're actually human — I'm all yours now, go on, ask me anything",
    "Alright you passed the vibe check. I'm ready when you are, what do you need?",
    "And just like that, you're in — go on then, put me to work",
    "Confirmed real human, good start. Now the fun part, what can I help with?",
    "You're verified, nice one. Hit me with something, anything",
  ];

  console.log(`[nest-onboard] buildWelcomeMessage called — handle=${handle.slice(0, 6)}***, profile=${JSON.stringify(profile ? { email: profile.email, name: profile.name } : null)}, hasProviderToken=${!!providerToken}, isMicrosoft=${isMicrosoft}`);

  if (!profile?.email) {
    console.warn('[nest-onboard] No profile email — skipping personalisation, using fallback');
    return fallbackMessages[Math.floor(Math.random() * fallbackMessages.length)];
  }

  const email = profile.email;
  const name = profile.name?.split(' ')[0] ?? null;
  console.log(`[nest-onboard] Welcome inputs — email=${email}, firstName=${name}, isPersonalEmail=${isPersonalEmail(email)}`);

  // Try to get timezone → city
  let city: string | null = null;
  try {
    if (providerToken) {
      const tz = await fetchTimezoneWithFallback(providerToken, isMicrosoft);
      console.log(`[nest-onboard] Timezone resolved: ${tz}`);
      city = timezoneToCity(tz);
      console.log(`[nest-onboard] City from timezone: ${city}`);
    } else {
      console.log('[nest-onboard] No provider token — skipping timezone fetch');
    }
  } catch (e) {
    console.warn('[nest-onboard] Timezone fetch failed:', (e as Error).message);
  }

  // Path 1: Company email → infer company from domain
  if (!isPersonalEmail(email)) {
    const domain = email.split('@')[1]?.toLowerCase();
    console.log(`[nest-onboard] Path 1: Company email detected — domain=${domain}`);
    if (domain) {
      const company = await inferCompanyFromDomain(domain);
      console.log(`[nest-onboard] Path 1: Company inferred from domain — ${JSON.stringify(company)}`);
      if (company) {
        const welcome = await generatePersonalisedWelcome(name, company, city);
        console.log(`[nest-onboard] Path 1: Generated welcome — result=${welcome ? welcome.slice(0, 80) + '...' : 'null'}`);
        if (welcome) return welcome;
      } else {
        console.warn('[nest-onboard] Path 1: Company inference returned null — falling through to PDL');
      }
    }
  } else {
    console.log('[nest-onboard] Path 1 skipped: personal email domain');
  }

  // Path 2: PDL phone enrichment (always try, not just for personal emails)
  console.log(`[nest-onboard] Path 2: Attempting PDL enrichment for ${handle.slice(0, 6)}***`);
  try {
    const pdlResult = await enrichByPhone(handle);
    console.log(`[nest-onboard] Path 2: PDL result — found=${!!pdlResult}, firstName=${pdlResult?.firstName}, company=${pdlResult?.jobCompanyName}, city=${pdlResult?.locationLocality ?? pdlResult?.locationName}`);
    if (pdlResult) {
      const supabase = getAdminClient();
      await supabase
        .from('user_profiles')
        .update({ pdl_profile: pdlResult as unknown as Record<string, unknown> })
        .eq('handle', handle)
        .then(({ error }) => {
          if (error) console.error('[nest-onboard] PDL save error:', error.message);
          else console.log('[nest-onboard] PDL profile saved to user_profiles');
        });

      const pdlName = pdlResult.firstName ?? name;
      const pdlCompanyName = pdlResult.jobCompanyName ?? null;
      const pdlCity = pdlResult.locationLocality ?? pdlResult.locationName ?? city;
      console.log(`[nest-onboard] Path 2: PDL context — name=${pdlName}, company=${pdlCompanyName}, city=${pdlCity}`);

      if (pdlCompanyName || pdlCity) {
        let pdlCompanyProfile: CompanyProfile | null = null;
        if (pdlCompanyName) {
          pdlCompanyProfile = { name: pdlCompanyName, oneLiner: pdlResult.jobCompanyIndustry ?? '' };
        }
        const welcome = await generatePersonalisedWelcome(pdlName, pdlCompanyProfile, pdlCity);
        console.log(`[nest-onboard] Path 2: Generated welcome — result=${welcome ? welcome.slice(0, 80) + '...' : 'null'}`);
        if (welcome) return welcome;
      } else {
        console.warn('[nest-onboard] Path 2: PDL had no company or city — cannot personalise');
      }
    } else {
      console.warn('[nest-onboard] Path 2: PDL returned no result for this phone number');
    }
  } catch (e) {
    console.error('[nest-onboard] Path 2: PDL enrichment failed:', (e as Error).message);
  }

  // Path 3: Nothing worked → random welcome
  console.warn('[nest-onboard] All personalisation paths failed — using random fallback');
  return fallbackMessages[Math.floor(Math.random() * fallbackMessages.length)];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
  const providerToken = typeof body.provider_token === 'string' ? body.provider_token : '';
  const providerRefreshToken = typeof body.provider_refresh_token === 'string' ? body.provider_refresh_token : '';
  const provider: string = typeof body.provider === 'string' ? body.provider : 'google';
  const bodyUserId = typeof body.user_id === 'string' ? body.user_id : '';
  const isMicrosoft = provider === 'azure';

  console.log(`[nest-onboard] Request received — token=${token ? token.slice(0, 8) + '...' : 'none'}, provider=${provider}, hasAccessToken=${!!accessToken}, hasProviderToken=${!!providerToken}, hasProviderRefreshToken=${!!providerRefreshToken}, userId=${bodyUserId || 'none'}`);

  const supabase = getAdminClient();

  // Resolve the Supabase auth user
  let uid = bodyUserId;
  if (!uid && accessToken) {
    const { data: { user }, error } = await supabase.auth.getUser(accessToken);
    if (error || !user) {
      console.error('[nest-onboard] Auth lookup failed:', error?.message);
      return json({ error: 'bad_token' }, 401);
    }
    uid = user.id;
  }

  // ── iMessage token activation flow ──
  if (token) {
    const nestUser = await getUserByToken(token);
    if (!nestUser) {
      return json({ error: 'invalid_token' }, 404);
    }

    if (nestUser.status === 'active') {
      // Still store account if we have provider tokens (re-auth case)
      if (uid && providerToken && providerRefreshToken) {
        await storeAccount(supabase, uid, providerToken, providerRefreshToken, isMicrosoft);
        await supabase.from('user_profiles').update({ auth_user_id: uid }).eq('handle', nestUser.handle);

        // Update timezone if not already set
        if (!nestUser.timezone) {
          try {
            const tz = await fetchTimezoneWithFallback(providerToken, isMicrosoft);
            if (tz && tz !== 'UTC') {
              console.log(`[nest-onboard] Saving timezone for ${nestUser.handle.slice(0, 6)}*** (re-auth): ${tz}`);
              await updateUserTimezone(nestUser.handle, tz);
            }
          } catch (e) {
            console.warn('[nest-onboard] Timezone fetch/save failed (re-auth):', (e as Error).message);
          }
        }
      }
      return json({ success: true, already_active: true });
    }

    const handle = await activateUser(token);
    if (!handle) {
      return json({ error: 'activation_failed' }, 500);
    }

    console.log(`[nest-onboard] Activated user ${handle.slice(0, 6)}*** via iMessage token`);

    // Link auth user and store account
    if (uid) {
      await supabase.from('user_profiles').update({ auth_user_id: uid }).eq('handle', handle);

      if (providerToken && providerRefreshToken) {
        const result = await storeAccount(supabase, uid, providerToken, providerRefreshToken, isMicrosoft);
        if (result?.error) {
          console.error('[nest-onboard] Account store error:', result.error);
        }
      } else {
        console.warn('[nest-onboard] No provider tokens — account not stored');
      }
    }

    // Fetch and persist the user's timezone from their calendar
    if (providerToken) {
      try {
        const tz = await fetchTimezoneWithFallback(providerToken, isMicrosoft);
        if (tz && tz !== 'UTC') {
          console.log(`[nest-onboard] Saving timezone for ${handle.slice(0, 6)}***: ${tz}`);
          await updateUserTimezone(handle, tz);
        } else {
          console.log(`[nest-onboard] Timezone resolved as UTC/empty — not saving`);
        }
      } catch (e) {
        console.warn('[nest-onboard] Timezone fetch/save failed:', (e as Error).message);
      }
    }

    // Send personalised verified welcome message in background
    if (providerToken) {
      // Provider tokens available on this call — send welcome now
      console.log(`[nest-onboard] Fetching profile for welcome (provider=${provider})`);
      const fetched = isMicrosoft
        ? await fetchMicrosoftProfile(providerToken)
        : await fetchGoogleProfile(providerToken);
      const welcomeProfile = fetched ? { email: fetched.email, name: fetched.name } : null;
      console.log(`[nest-onboard] Welcome profile resolved: ${JSON.stringify(welcomeProfile)}`);

      const bgWork = (async () => {
        try {
          if (!nestUser.botNumber) {
            console.error('[nest-onboard] Cannot send welcome - no bot number for user');
            return;
          }
          const welcomeMsg = await buildWelcomeMessage(handle, welcomeProfile, providerToken, isMicrosoft);
          await new Promise((r) => setTimeout(r, 3000));
          await createChat(nestUser.botNumber, [handle], welcomeMsg);
          console.log(`[nest-onboard] Sent personalised welcome to ${handle.slice(0, 6)}***`);
        } catch (e) {
          console.error('[nest-onboard] Welcome message failed:', e);
        }
      })();

      // @ts-ignore — Deno Deploy EdgeRuntime
      if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(bgWork);
      } else {
        bgWork.catch(() => {});
      }
    } else {
      // No provider tokens on this call — the direct sign-up call (with tokens)
      // will follow shortly and handle the personalised welcome there.
      console.log('[nest-onboard] No provider tokens on activation call — deferring welcome to direct sign-up call');
    }

    return json({ success: true });
  }

  // ── Direct website sign-up (no iMessage token) ──
  if (!uid) {
    return json({ error: 'missing_token', detail: 'Provide either a verification token or an access_token.' }, 400);
  }

  if (providerToken && providerRefreshToken) {
    const result = await storeAccount(supabase, uid, providerToken, providerRefreshToken, isMicrosoft);
    if (result?.error) {
      if (result.errorType === 'email_conflict') {
        return json({ error: 'email_conflict', detail: result.detail, hint: result.hint }, 409);
      }
      if (result.errorType === 'no_refresh_token') {
        return json({ error: 'no_refresh_token', detail: result.detail, hint: result.hint }, 400);
      }
      console.error('[nest-onboard] Account store failed:', result.error);
    }
  } else {
    console.warn('[nest-onboard] Direct sign-up without provider tokens');
  }

  // Check if this user was just activated (within last 60s) by the token call
  // that had no provider tokens. If so, send the personalised welcome now
  // since this call has the tokens needed for personalisation.
  if (providerToken) {
    const { data: userRow } = await supabase
      .from('user_profiles')
      .select('handle, bot_number, status, updated_at, timezone')
      .eq('auth_user_id', uid)
      .eq('status', 'active')
      .maybeSingle();

    // Persist timezone if not already set
    if (userRow?.handle && !userRow.timezone) {
      try {
        const tz = await fetchTimezoneWithFallback(providerToken, isMicrosoft);
        if (tz && tz !== 'UTC') {
          console.log(`[nest-onboard] Saving timezone for ${userRow.handle.slice(0, 6)}*** (direct sign-up): ${tz}`);
          await updateUserTimezone(userRow.handle, tz);
        }
      } catch (e) {
        console.warn('[nest-onboard] Timezone fetch/save failed (direct sign-up):', (e as Error).message);
      }
    }

    if (userRow?.handle && userRow.bot_number) {
      const updatedAt = new Date(userRow.updated_at).getTime();
      const justActivated = Date.now() - updatedAt < 60_000;

      if (justActivated) {
        console.log(`[nest-onboard] User ${userRow.handle.slice(0, 6)}*** was just activated — sending personalised welcome from direct sign-up call`);

        const fetched = isMicrosoft
          ? await fetchMicrosoftProfile(providerToken)
          : await fetchGoogleProfile(providerToken);
        const welcomeProfile = fetched ? { email: fetched.email, name: fetched.name } : null;

        const bgWork = (async () => {
          try {
            const handle = userRow.handle;
            const botNumber = userRow.bot_number!;
            const welcomeMsg = await buildWelcomeMessage(handle, welcomeProfile, providerToken, isMicrosoft);
            await new Promise((r) => setTimeout(r, 3000));
            await createChat(botNumber, [handle], welcomeMsg);
            console.log(`[nest-onboard] Sent personalised welcome to ${handle.slice(0, 6)}*** (from direct sign-up path)`);
          } catch (e) {
            console.error('[nest-onboard] Welcome message failed (direct sign-up path):', e);
          }
        })();

        // @ts-ignore — Deno Deploy EdgeRuntime
        if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
          // @ts-ignore
          EdgeRuntime.waitUntil(bgWork);
        } else {
          bgWork.catch(() => {});
        }
      }
    }
  }

  console.log(`[nest-onboard] Direct website sign-up: ${uid}`);
  return json({ success: true, uid });
});

// ── Store Google or Microsoft account ──

interface StoreResult {
  error?: string;
  errorType?: string;
  detail?: string;
  hint?: string;
}

async function storeAccount(
  supabase: ReturnType<typeof getAdminClient>,
  userId: string,
  providerToken: string,
  providerRefreshToken: string,
  isMicrosoft: boolean,
): Promise<StoreResult | null> {
  if (!providerRefreshToken) {
    const providerName = isMicrosoft ? 'Microsoft' : 'Google';
    return {
      error: 'no_refresh_token',
      errorType: 'no_refresh_token',
      detail: `${providerName} did not provide a refresh token. Please try signing in again.`,
      hint: 'Make sure you grant all permissions when asked.',
    };
  }

  const profile = isMicrosoft
    ? await fetchMicrosoftProfile(providerToken)
    : await fetchGoogleProfile(providerToken);

  if (!profile?.email) {
    // Non-blocking: profile fetch can fail if provider_token expired
    console.warn('[nest-onboard] Could not fetch profile from provider token');

    // Try resolving from Supabase auth metadata
    try {
      const { data: { user } } = await supabase.auth.admin.getUserById(userId);
      if (user?.email) {
        const fallbackProfile = {
          email: user.email,
          name: user.user_metadata?.full_name ?? user.user_metadata?.name ?? '',
          picture: user.user_metadata?.avatar_url ?? '',
        };
        return await upsertAccount(supabase, userId, fallbackProfile, providerRefreshToken, providerToken, isMicrosoft);
      }
    } catch { /* fall through */ }

    console.error('[nest-onboard] No email resolved — cannot store account');
    return { error: 'profile_fetch_failed' };
  }

  return await upsertAccount(supabase, userId, profile, providerRefreshToken, providerToken, isMicrosoft);
}

async function upsertAccount(
  supabase: ReturnType<typeof getAdminClient>,
  userId: string,
  profile: { email: string; name: string; picture: string },
  refreshToken: string,
  providerToken: string,
  isMicrosoft: boolean,
): Promise<StoreResult | null> {
  if (isMicrosoft) {
    // Check email conflict
    const { data: conflict } = await supabase
      .from('user_microsoft_accounts')
      .select('user_id')
      .eq('microsoft_email', profile.email)
      .neq('user_id', userId)
      .maybeSingle();

    if (conflict) {
      return {
        error: 'email_conflict',
        errorType: 'email_conflict',
        detail: 'This Microsoft account is already linked to a different Nest user.',
      };
    }

    const { data: existing } = await supabase
      .from('user_microsoft_accounts')
      .select('id, is_primary')
      .eq('user_id', userId)
      .eq('microsoft_email', profile.email)
      .maybeSingle();

    let shouldBePrimary = existing?.is_primary ?? false;
    if (!existing) {
      const { count } = await supabase
        .from('user_microsoft_accounts')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);
      shouldBePrimary = (count ?? 0) === 0;
    }

    const { error } = await supabase.from('user_microsoft_accounts').upsert(
      {
        user_id: userId,
        microsoft_email: profile.email,
        microsoft_name: profile.name,
        microsoft_avatar_url: profile.picture,
        refresh_token: refreshToken,
        is_primary: shouldBePrimary,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,microsoft_email' },
    );

    if (error) return { error: error.message };
    console.log(`[nest-onboard] Stored Microsoft account ${profile.email} for ${userId}`);
    triggerIngestion(userId).catch((e) => console.warn(`[nest-onboard] ingestion trigger failed: ${(e as Error).message}`));
    scheduleEnsureNotificationWebhooksAfterAccountLink(userId, null);
    return null;
  }

  // Google
  const { data: conflict } = await supabase
    .from('user_google_accounts')
    .select('user_id')
    .eq('google_email', profile.email)
    .neq('user_id', userId)
    .maybeSingle();

  if (conflict) {
    return {
      error: 'email_conflict',
      errorType: 'email_conflict',
      detail: 'This Google account is already linked to a different Nest user.',
    };
  }

  const grantedScopes = providerToken ? await fetchGrantedScopes(providerToken) : [];
  const resolvedScopes = grantedScopes.length > 0 ? grantedScopes : [...BASE_SCOPES];

  const { data: existing } = await supabase
    .from('user_google_accounts')
    .select('id, is_primary, scopes')
    .eq('user_id', userId)
    .eq('google_email', profile.email)
    .maybeSingle();

  const finalScopes = existing?.scopes?.length
    ? mergeScopes(existing.scopes, resolvedScopes)
    : resolvedScopes;

  let shouldBePrimary = existing?.is_primary ?? false;
  if (!existing) {
    const { count } = await supabase
      .from('user_google_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    shouldBePrimary = (count ?? 0) === 0;
  }

  const { error } = await supabase.from('user_google_accounts').upsert(
    {
      user_id: userId,
      google_email: profile.email,
      google_name: profile.name,
      google_avatar_url: profile.picture,
      refresh_token: refreshToken,
      scopes: finalScopes,
      is_primary: shouldBePrimary,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,google_email' },
  );

  if (error) return { error: error.message };
  console.log(`[nest-onboard] Stored Google account ${profile.email} for ${userId}`);
  triggerIngestion(userId).catch((e) => console.warn(`[nest-onboard] ingestion trigger failed: ${(e as Error).message}`));
  scheduleEnsureNotificationWebhooksAfterAccountLink(userId, null);
  return null;
}

async function triggerIngestion(authUserId: string): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const resp = await fetch(`${supabaseUrl}/functions/v1/ingest-pipeline`, {
      method: 'POST',
      headers: internalJsonHeaders(),
      body: JSON.stringify({
        auth_user_id: authUserId,
        mode: 'full',
        sources: ['emails', 'calendar'],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const data = await resp.json().catch(() => ({}));
    console.log(`[nest-onboard] Triggered ingestion for ${authUserId}: job=${data.job_id ?? 'none'}, status=${resp.status}`);
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (msg.includes('abort')) {
      console.log(`[nest-onboard] Ingestion request sent for ${authUserId} (timed out — pipeline is running)`);
    } else {
      console.warn('[nest-onboard] triggerIngestion failed:', msg);
    }
  }
}
