import { getOpenAIClient } from './ai/models.ts';
import type { OpenAIWebSearchTool } from './ai/models.ts';

const TAG = '[brand-prompt-gen]';

const WEB_SEARCH_TOOL: OpenAIWebSearchTool = { type: 'web_search_preview' };

const GPT52_INPUT_PER_M  = 1.75;
const GPT52_OUTPUT_PER_M = 14.00;
const GPT52_CACHED_PER_M = 0.175;
const WEB_SEARCH_PER_CALL = 0.01;

export interface PromptCost {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  web_searches: number;
  input_cost_usd: number;
  output_cost_usd: number;
  cached_cost_usd: number;
  search_cost_usd: number;
  total_cost_usd: number;
}

export interface GenerateResult {
  prompt: string;
  cost: PromptCost;
}

const META_PROMPT = `You are an elite business analyst and chatbot prompt engineer.

Your task: Given a scraped website (in markdown) for a business, plus any additional information you can find by searching the internet, produce a **world-class iMessage chatbot system prompt** for that business.

The output must be a single, self-contained system prompt that a chatbot will use to answer customer questions via iMessage / SMS text conversation.

## Research Phase (use web search)

Before writing the prompt, search the internet for:
1. The business name + reviews (Google, Yelp, TripAdvisor, etc.)
2. The business name + social media presence
3. The business name + news or press
4. The business name + competitors / industry context
5. Any additional public information about the business (awards, certifications, team, history)

Incorporate all verified public facts you find into the prompt. Do NOT invent facts that cannot be verified.

## Output Structure

The system prompt you generate MUST follow this exact section structure. Every section is mandatory. Adapt the content to the specific business.

SECTION 1: HEADER & IDENTITY
- System label, version, channel (iMessage), bot name (derive from business name — short, memorable, 1-2 syllables)
- "You are [BotName], the text-based customer service, sales, and booking/enquiry assistant for [Business Name]..."
- First-person voice: "we", "us", "our"
- Must sound like a real team member, not generic AI

SECTION 2: PRIMARY ROLE
- What the bot helps customers with (understand the business, find the right service/product, answer questions, handle objections, collect enquiry details, push toward conversion, reduce friction)

SECTION 3: BRAND IDENTITY
- Business name, positioning, core promise, mission, tagline, market positioning
- All derived from the scraped website + internet research

SECTION 4: FOUNDER / BUSINESS BACKGROUND
- Only include publicly verifiable information
- Founder names, history, background — only if found

SECTION 5: VOICE, TONE, AND STYLE
- Energetic / warm / local / conversational / playful / confident / clear / non-corporate / human
- Adapt the tone to the business type (e.g., a law firm should be professional+calm, a party business should be energetic+fun)
- Good phrases, phrases to avoid
- Language style rules
- Emoji rules: only use emojis if the customer uses them first and the tone clearly suits it. 0-1 emoji maximum per reply. Default is no emojis. Never overuse emojis — the brand should feel professional and human, not spammy.
- No em dashes

SECTION 6: IMESSAGE-SPECIFIC BEHAVIOUR
- Short to medium replies, 1-4 bubbles, one idea per bubble
- 1-2 questions max at a time
- Default structure: acknowledge → answer → guide next step
- Examples of good multi-bubble responses
- Use Australian English spelling (analyse, colour, organised, etc.)

SECTION 7: CORE BUSINESS FACTS
- Business name, primary market, what they do
- Contact details (phone, email, address)
- Opening hours
- Navigation / service areas

SECTION 8-10: SERVICES / PRODUCTS / PACKAGES
- All services and products found on the website, with actual pricing if available
- Package tiers, what's included, pricing
- Custom quote categories (where pricing is not public)

SECTION 11: LOCATION / SETUP / DELIVERY RULES
- Where they operate, service area, delivery rules, travel fees if applicable

SECTION 12-13: POLICIES
- Returns, refunds, weather, cancellation, warranty, etc.
- Safety, insurance, certifications, qualifications

SECTION 14: SESSION / PRODUCT DETAILS
- Duration, capacity, specifications — whatever is relevant to the business

SECTION 15: WHAT CUSTOMERS GET vs WHAT THEY PROVIDE

SECTION 16: BOOKING / PURCHASE PROCESS
- Step-by-step booking or purchase flow
- Payment terms, deposits, etc.

SECTION 17: REVIEWS / SOCIAL PROOF
- Real review quotes and themes found on the website or via internet search
- How to use social proof naturally

SECTION 18: GALLERY / CASE STUDIES
- Real examples, past projects, client stories — from website or internet

SECTION 19: FAQ ANSWERING RULES
- Common questions with canonical answers
- Derived from the website FAQ section + common sense for this industry

SECTION 20: SALES / RECOMMENDATION LOGIC
- Heuristics for recommending the right service/product based on customer signals
- Decision tree for guiding customers

SECTION 21: ENQUIRY / BOOKING DATA COLLECTION
- What to ask for when moving toward conversion
- Natural collection flow

SECTION 22: PRICING QUESTION HANDLING
- Answer directly when public pricing exists
- How to handle custom quotes
- Never hide or invent prices

SECTION 23: EDGE CASE HANDLING
- How to handle questions outside the known facts
- "I'd rather not guess" wording

SECTION 24: HUMAN-LIKE CONVERSATIONAL RULES
- React naturally, mirror customer energy, be enthusiastic / reassuring / practical as needed
- Example exchanges

SECTION 25: CONVERSION GOAL
- Preferred actions (booking, enquiry, call, email, narrowing options)
- Gentle closing lines

SECTION 26: STRICT DO-NOT-INVENT RULES
- Comprehensive list of things the bot must not fabricate
- Wording for "I don't know"

SECTION 27: DEFAULT OPENERS / TEMPLATES
- New lead, specific service enquiry, FAQ templates

SECTION 28: INTERNAL RESPONSE CHECKLIST
- Pre-send validation checklist

## Rules

- Use Australian English (analyse, colour, organised, etc.)
- The output must be ONLY the system prompt text. No preamble, no explanation, no markdown code fences around it.
- Use "==========" section dividers like the reference structure.
- Be extremely thorough. The prompt should be 800-1500 lines.
- Every fact must come from the scraped website or verified internet search. Flag where you could not find information rather than inventing it.
- Include actual pricing, actual contact details, actual hours — never placeholder text.`;

export async function generateBrandPrompt(
  scrapedContent: string,
  businessName: string,
): Promise<GenerateResult> {
  const client = getOpenAIClient();

  console.log(`${TAG} ════════════════════════════════════════════`);
  console.log(`${TAG} Starting prompt generation`);
  console.log(`${TAG}   Business:       ${businessName}`);
  console.log(`${TAG}   Scraped input:  ${(scrapedContent.length / 1024).toFixed(1)}KB`);
  console.log(`${TAG}   Model:          gpt-5.2`);
  console.log(`${TAG}   Reasoning:      medium`);
  console.log(`${TAG}   Tools:          web_search_preview (server-side)`);
  console.log(`${TAG}   Max tokens:     65536`);
  console.log(`${TAG} ════════════════════════════════════════════`);

  const userMessage = `## Business Name\n${businessName}\n\n## Scraped Website Content\n\n${scrapedContent}`;
  console.log(`${TAG} User message size: ${(userMessage.length / 1024).toFixed(1)}KB`);

  const callStart = Date.now();

  const response = await client.responses.create({
    model: 'gpt-5.2',
    instructions: META_PROMPT,
    input: [{ role: 'user', content: userMessage }] as Parameters<typeof client.responses.create>[0]['input'],
    tools: [WEB_SEARCH_TOOL] as Parameters<typeof client.responses.create>[0]['tools'],
    max_output_tokens: 65536,
    store: true,
    reasoning: { effort: 'medium' },
  } as Parameters<typeof client.responses.create>[0]);

  const callMs = Date.now() - callStart;
  const prompt = (response.output_text ?? '').trim();
  const outputItems = response.output ?? [];
  const respStatus = (response as any).status;
  const incompleteDetails = (response as any).incomplete_details;

  console.log(`${TAG} ────────────────────────────────────────────`);
  console.log(`${TAG} API call completed in ${(callMs / 1000).toFixed(1)}s`);
  console.log(`${TAG}   Response status: ${respStatus}`);
  console.log(`${TAG}   Output items:  ${outputItems.length}`);
  console.log(`${TAG}   Output text:   ${prompt.length} chars`);

  const usage = (response as any).usage;
  if (usage) {
    console.log(`${TAG}   Tokens in:     ${usage.input_tokens ?? usage.prompt_tokens ?? '?'}`);
    console.log(`${TAG}   Tokens out:    ${usage.output_tokens ?? usage.completion_tokens ?? '?'}`);
    if (usage.input_tokens_details?.cached_tokens) {
      console.log(`${TAG}   Cached tokens: ${usage.input_tokens_details.cached_tokens}`);
    }
  }

  if (incompleteDetails) {
    console.log(`${TAG}   ⚠️ INCOMPLETE: ${JSON.stringify(incompleteDetails)}`);
  }

  for (const item of outputItems) {
    const t = (item as any).type;
    if (t === 'web_search_call') {
      const query = (item as any).query || (item as any).action?.query || '';
      console.log(`${TAG}   🔍 Web search: "${query}"`);
    }
  }

  console.log(`${TAG} ════════════════════════════════════════════`);
  console.log(`${TAG}   Prompt length:  ${prompt.length} chars (${(prompt.length / 1024).toFixed(1)}KB)`);
  console.log(`${TAG}   Prompt lines:   ${prompt.split('\n').length}`);

  if (prompt.length > 0) {
    const firstLine = prompt.split('\n')[0] || '';
    const lastLine = prompt.split('\n').slice(-1)[0] || '';
    console.log(`${TAG}   First line:     ${firstLine.substring(0, 120)}`);
    console.log(`${TAG}   Last line:      ${lastLine.substring(0, 120)}`);
  }

  console.log(`${TAG} ════════════════════════════════════════════`);

  if (!prompt || prompt.length < 500) {
    const diagInfo = `status=${respStatus}, incomplete=${JSON.stringify(incompleteDetails)}, outTokens=${usage?.output_tokens ?? '?'}`;
    console.error(`${TAG} ✗ FAILED: prompt too short (${prompt.length} chars, need >=500). Diag: ${diagInfo}`);
    throw new Error(`Prompt generation returned insufficient content (${prompt.length} chars). [${diagInfo}]`);
  }

  const inputTokens  = usage?.input_tokens  ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const cachedTokens = usage?.input_tokens_details?.cached_tokens ?? 0;
  const freshInputTokens = inputTokens - cachedTokens;

  let webSearches = 0;
  for (const item of outputItems) {
    if ((item as any).type === 'web_search_call') webSearches++;
  }

  const inputCost  = (freshInputTokens / 1_000_000) * GPT52_INPUT_PER_M;
  const cachedCost = (cachedTokens / 1_000_000) * GPT52_CACHED_PER_M;
  const outputCost = (outputTokens / 1_000_000) * GPT52_OUTPUT_PER_M;
  const searchCost = webSearches * WEB_SEARCH_PER_CALL;
  const totalCost  = inputCost + cachedCost + outputCost + searchCost;

  const cost: PromptCost = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_tokens: cachedTokens,
    web_searches: webSearches,
    input_cost_usd: Math.round(inputCost * 1_000_000) / 1_000_000,
    output_cost_usd: Math.round(outputCost * 1_000_000) / 1_000_000,
    cached_cost_usd: Math.round(cachedCost * 1_000_000) / 1_000_000,
    search_cost_usd: Math.round(searchCost * 1_000_000) / 1_000_000,
    total_cost_usd: Math.round(totalCost * 1_000_000) / 1_000_000,
  };

  console.log(`${TAG}   Cost breakdown:`);
  console.log(`${TAG}     Input:   ${inputTokens} tokens ($${cost.input_cost_usd.toFixed(4)})`);
  console.log(`${TAG}     Cached:  ${cachedTokens} tokens ($${cost.cached_cost_usd.toFixed(4)})`);
  console.log(`${TAG}     Output:  ${outputTokens} tokens ($${cost.output_cost_usd.toFixed(4)})`);
  console.log(`${TAG}     Search:  ${webSearches} calls ($${cost.search_cost_usd.toFixed(4)})`);
  console.log(`${TAG}     TOTAL:   $${cost.total_cost_usd.toFixed(4)}`);

  return { prompt, cost };
}
