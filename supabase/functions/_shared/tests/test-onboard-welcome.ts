/**
 * Test the onboarding welcome message personalisation pipeline.
 * Run:
 *   deno run --allow-all --env=.env supabase/functions/_shared/tests/test-onboard-welcome.ts
 */

import { getAdminClient } from '../supabase.ts';
import { getOptionalEnv } from '../env.ts';
import { fetchCalendarTimezone } from '../calendar-helpers.ts';
import { MODEL_MAP } from '../ai/models.ts';
import { isGeminiModel, geminiSimpleText } from '../ai/gemini.ts';
import { getOpenAIClient } from '../ai/models.ts';

// ═══════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════

const TARGET_EMAIL = 'thomas.lidgett@blacklane.com';
const SENDER_HANDLE = '+61414187820';
const GOOGLE_CLIENT_ID = getOptionalEnv('GOOGLE_CLIENT_ID') ?? '';
const GOOGLE_CLIENT_SECRET = getOptionalEnv('GOOGLE_CLIENT_SECRET') ?? '';

// ═══════════════════════════════════════════════════════════════
// LLM helper (mirrors nest-onboard)
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// Company inference (mirrors nest-onboard)
// ═══════════════════════════════════════════════════════════════

interface CompanyProfile {
  name: string;
  oneLiner: string;
}

async function inferCompanyFromDomain(domain: string): Promise<CompanyProfile | null> {
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
  try {
    const cleaned = rawText.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(cleaned);
    if (!parsed.name || parsed.name.toLowerCase() === 'unknown') return null;
    return { name: parsed.name, oneLiner: parsed.oneLiner ?? '' };
  } catch {
    const text = rawText.trim().toLowerCase();
    if (!text || text === 'unknown') return null;
    return { name: rawText.trim(), oneLiner: '' };
  }
}

// ═══════════════════════════════════════════════════════════════
// Welcome generation (mirrors nest-onboard)
// ═══════════════════════════════════════════════════════════════

const WELCOME_SYSTEM_PROMPT = `You are Nest, a personal AI assistant. Generate a short, cheeky welcome message for someone who just verified their account.

CRITICAL RULES:
- Use what you know about their company to make a SPECIFIC, knowing comment. Reference what the company actually does — not just the name. Show you know things.
- Keep it under 30 words total.
- No emojis. Australian spelling. Lowercase preferred.
- Tone: warm, confident, slightly cheeky, like a well-connected mate who knows the industry.
- Output EXACTLY 2 lines separated by a single newline. Line 1: short greeting with their name. Line 2: a specific, knowing comment about their company/role/city.
- NEVER say "personal assistant", never pitch features, never use exclamation marks.
- NEVER be generic. "heard good things about X" is BANNED. Reference something specific about what the company does.

Good examples (do NOT copy — generate something original):
- Name: Sarah, Company: Canva, City: Sydney
  "hey sarah, welcome\ndesigning the future of visual content from sydney — not a bad gig"

- Name: James, Company: Atlassian (makes Jira and Confluence), City: Sydney  
  "james, welcome\nso you're one of the people behind every standup meeting in tech. respect"

- Name: Tom, Company: Blacklane (premium chauffeur service), City: Melbourne
  "tom, welcome\nkeeping the world's execs moving in style from melbourne — i like it"

Bad examples (NEVER do this):
- "heard good things about [company]" ← too generic
- "[city] treating you well?" ← filler, says nothing
- "welcome to the inner circle" ← cringe

Output ONLY the 2-line message, nothing else.`;

async function generateWelcome(name: string, company: CompanyProfile, city: string | null): Promise<string> {
  const context = [
    `Name: ${name}`,
    `Company: ${company.name}`,
    company.oneLiner ? `What they do: ${company.oneLiner}` : '',
    city ? `City: ${city}` : '',
  ].filter(Boolean).join('\n');

  return (await fastLlmText(WELCOME_SYSTEM_PROMPT, context, 150)).trim();
}

function timezoneToCity(tz: string): string | null {
  if (!tz || tz === 'UTC') return null;
  const parts = tz.split('/');
  const city = parts[parts.length - 1];
  if (!city) return null;
  return city.replace(/_/g, ' ');
}

// ═══════════════════════════════════════════════════════════════
// Run
// ═══════════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════════════════');
console.log(' ONBOARD WELCOME MESSAGE TEST');
console.log('═══════════════════════════════════════════════════\n');

// ─── Step 1: Get access token ───────────────────────────────

const supabase = getAdminClient();
const { data: profiles } = await supabase.from('user_profiles').select('auth_user_id').eq('handle', SENDER_HANDLE).maybeSingle();
const { data: acct } = await supabase.from('user_google_accounts').select('refresh_token').eq('user_id', profiles!.auth_user_id).eq('google_email', TARGET_EMAIL).maybeSingle();

const refreshResp = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: acct!.refresh_token,
  }),
});
const { access_token: accessToken } = await refreshResp.json();
console.log('✅ Access token obtained\n');

// ─── Step 2: Company inference ──────────────────────────────

console.log('--- Company Inference ---');
const company = await inferCompanyFromDomain('blacklane.com');
console.log(`  Name: ${company?.name}`);
console.log(`  One-liner: ${company?.oneLiner}\n`);

// ─── Step 3: Timezone ───────────────────────────────────────

console.log('--- Timezone ---');
let city: string | null = null;
const settingsTz = await fetchCalendarTimezone(accessToken);
if (settingsTz && settingsTz !== 'UTC') {
  city = timezoneToCity(settingsTz);
} else {
  const now = new Date().toISOString();
  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now}&maxResults=1&singleEvents=true&orderBy=startTime`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (resp.ok) {
    const data = await resp.json();
    const eventsTz = data.timeZone ?? '';
    if (eventsTz && eventsTz !== 'UTC') city = timezoneToCity(eventsTz);
  }
}
console.log(`  City: ${city}\n`);

// ─── Step 4: Generate 10 welcome messages ───────────────────

if (!company) {
  console.error('Company inference failed — cannot test welcome generation');
  Deno.exit(1);
}

console.log('═══════════════════════════════════════════════════');
console.log(` 10 WELCOME MESSAGES for Tom @ ${company.name}, ${city ?? 'unknown city'}`);
console.log(` Company context: "${company.oneLiner}"`);
console.log('═══════════════════════════════════════════════════\n');

for (let i = 1; i <= 10; i++) {
  try {
    const start = Date.now();
    const text = await generateWelcome('Tom', company, city);
    const ms = Date.now() - start;
    const lines = text.split('\n');
    console.log(`  ${i.toString().padStart(2)}. [${ms}ms]`);
    for (const line of lines) {
      console.log(`      ${line}`);
    }
    console.log();
  } catch (e) {
    console.error(`  ${i}. ERROR: ${(e as Error).message}\n`);
  }
}

// ─── Step 5: Test with other companies ──────────────────────

const testDomains = ['canva.com', 'atlassian.com', 'stripe.com', 'airwallex.com', 'culture-amp.com'];

console.log('═══════════════════════════════════════════════════');
console.log(' CROSS-COMPANY TEST (2 samples each)');
console.log('═══════════════════════════════════════════════════\n');

for (const domain of testDomains) {
  const co = await inferCompanyFromDomain(domain);
  if (!co) {
    console.log(`  ${domain}: ❌ inference failed\n`);
    continue;
  }
  console.log(`  ${domain} → ${co.name}: "${co.oneLiner}"`);
  for (let i = 0; i < 2; i++) {
    const text = await generateWelcome('Alex', co, 'Melbourne');
    console.log(`    ${i + 1}. ${text.replace(/\n/g, ' / ')}`);
  }
  console.log();
}

console.log('═══════════════════════════════════════════════════');
console.log(' DONE');
console.log('═══════════════════════════════════════════════════');
Deno.exit(0);
