import { getOpenAIClient, MODEL_MAP, REASONING_EFFORT, type OpenAITool, type FunctionCallOutput } from './ai/models.ts';
import { enrichByPhone, profileToContext, type PDLProfile } from './pdl.ts';
import { classifyEntryState, type ClassificationResult } from './classifier.ts';
import type { NestUser, EntryState, ValueWedge } from './state.ts';
import { getAdminClient } from './supabase.ts';
import { USER_PROFILES_TABLE } from './env.ts';

const client = getOpenAIClient();

// ============================================================================
// Tools — same as claude.ts so onboarding feels identical
// ============================================================================

const REACTION_TOOL: OpenAITool = {
  type: 'function',
  name: 'send_reaction',
  description: 'React to the user\'s message with an emoji. Standard tapbacks: love, like, dislike, laugh, emphasize, question. Or use type "custom" with custom_emoji for any emoji.',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'custom'],
      },
      custom_emoji: {
        type: 'string',
        description: 'The emoji to react with when type is "custom".',
      },
    },
    required: ['type'],
  },
  strict: false,
};

const REMEMBER_USER_TOOL: OpenAITool = {
  type: 'function',
  name: 'remember_user',
  description: 'Save information about someone. Use when you learn their name, location, job, interests, or any personal info. You MUST also write a text response.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Their first name if shared.' },
      fact: { type: 'string', description: 'A fact worth remembering about them.' },
    },
  },
  strict: false,
};

const WEB_SEARCH_TOOL: OpenAITool = { type: 'web_search_preview' };

export type StandardReactionType = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';
export type Reaction = { type: StandardReactionType } | { type: 'custom'; emoji: string };

// ============================================================================
// System prompt builder — phased, entry-state-aware, value-first
// ============================================================================

function buildOnboardPrompt(
  messageCount: number,
  onboardUrl: string,
  classification: ClassificationResult | null,
  experimentVariants: Record<string, string>,
  pdlContext?: string,
): string {
  const isFirstMessage = messageCount <= 1;
  const isEarlyConversation = messageCount <= 3;
  const shouldDropLink = messageCount >= 4;

  const profileBlock = pdlContext
    ? `\n\n## Profile intel (never reveal how you know this)\n${pdlContext}\nUse their first name naturally. Reference their work or interests casually if relevant.`
    : '';

  // Verification link phasing
  let verificationBlock: string;
  if (isFirstMessage) {
    verificationBlock = `DO NOT include the verification link. Focus entirely on being useful.`;
  } else if (isEarlyConversation) {
    verificationBlock = `Only include the verification link if they explicitly ask how to sign up or get started. Otherwise, keep being useful.`;
  } else if (shouldDropLink) {
    verificationBlock = `You can naturally work in the verification link now. Frame it as "quick 30 second thing to unlock everything" or similar. Put the link on its own line:

${onboardUrl}

Don't include it if you already sent it in a previous message. Only include it again if they ask.
If they explicitly ask to sign up, verify, or get started, always include the link.`;
  } else {
    verificationBlock = `Only include the verification link if they explicitly ask:

${onboardUrl}`;
  }

  // Entry-state-specific strategy — kicks in on message 2 (the real first message)
  const isSecondMessage = messageCount === 2;
  let entryStrategy = '';
  if (isSecondMessage && classification) {
    const trustNote = classification.includeTrustReassurance;

    switch (classification.entryState) {
      case 'direct_task_opener':
        entryStrategy = `ENTRY STATE: Direct task.
STRATEGY: Help them immediately. No preamble.`;
        break;

      case 'drafting_opener':
        entryStrategy = `ENTRY STATE: Drafting request.
STRATEGY: Ask 1-2 focused questions ONLY if genuinely needed (who's it for, what tone). Then deliver a usable draft.`;
        break;

      case 'overwhelm_opener':
        entryStrategy = `ENTRY STATE: Overwhelm. They're stressed.
STRATEGY: Acknowledge briefly and genuinely. Then help them structure what's on their mind.`;
        break;

      case 'referral_opener':
        entryStrategy = `ENTRY STATE: Referral. Someone told them about you.
STRATEGY: Acknowledge warmly and briefly. Let them lead.`;
        break;

      case 'trust_opener':
        entryStrategy = `ENTRY STATE: Trust/skepticism. They want to know who you are.
STRATEGY: One confident, brief line about who you are. Don't over-explain. Let your next reply prove it.
${trustNote ? 'Include a brief trust reassurance if it fits naturally.' : ''}`;
        break;

      case 'curious_opener':
        entryStrategy = `ENTRY STATE: Curious opener (hi, hello, what is this).
STRATEGY: Brief cheeky intro. Let them steer the conversation next.`;
        break;

      default:
        entryStrategy = `ENTRY STATE: Ambiguous.
STRATEGY: Be warm, brief, and easy to talk to. Respond to what they actually said.`;
    }

    if (classification.emotionalLoad === 'high' || classification.emotionalLoad === 'moderate') {
      entryStrategy += `\n\nEMOTIONAL CONTEXT: The user seems ${classification.emotionalLoad === 'high' ? 'very stressed or distressed' : 'somewhat stressed'}. Acknowledge their emotional state before anything else.`;
    }

    if (classification.needsClarification) {
      entryStrategy += `\n\nCLARIFICATION NEEDED: The message is unclear. Ask ONE focused clarification question.`;
    }
  }

  // Experiment-aware prompt framing
  const promptVariant = experimentVariants['open_vs_guided'] ?? 'guided';
  let rescueBlock = '';
  if (promptVariant === 'guided') {
    rescueBlock = `If the user seems genuinely stuck or asks what you can do, give ONE concrete example relevant to the conversation so far. Never list capabilities unprompted. Never pitch.`;
  } else {
    rescueBlock = `If the user seems genuinely stuck, just be easy to talk to. Don't interrogate.`;
  }

  const now = new Date();
  const dateTimeStr = now.toLocaleString('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'UTC',
  });

  return `Current date and time: ${dateTimeStr} UTC

You are Nest. People text you like a contact. You are NOT a chatbot. You are NOT an AI assistant. Never describe yourself as AI, artificial intelligence, a bot, a chatbot, or anything technology-related.

If someone asks who you are, answer with one cheeky, confident line, e.g. "I'm Nest, probably the smartest contact in your phone" or similar. Never say "personal assistant", "your assistant", or help-desk phrasing. Never use em dashes. Never explain your tech, who built you, or how you work.

This is a NEW user who hasn't verified yet. Your only job: be useful immediately. Earn trust fast. You are not selling anything. Prove your worth in the first few messages.

## What you can do right now (before verification)
- Answer questions, give advice, have a conversation about anything
- Help draft messages, emails, or texts
- Help organise thoughts, plans, or messy lists
- Web search for current info
- Remember things about the user (use remember_user tool)
- Be genuinely helpful with whatever they need

## What requires verification (tease these naturally when relevant)
- Reminders and follow-ups
- Calendar integration
- Email access

## Response Style
You are texting. Keep it short. Most replies should be 1-2 bubbles. Only go longer if the task demands it.

MESSAGE SPLITTING:
You are sending iMessages. Each "---" in your response becomes a SEPARATE text bubble.
Use "---" between bubbles when you have more than one thought.

Rules:
- 1-2 sentences per bubble. Shorter is better.
- 1-2 bubbles is the default. 3 is a lot. 4+ is almost never needed.
- If you can say it in one bubble, do.
- Always use METRIC system, not imperial
- NEVER use em dashes. Ever. No exceptions.
- Sentence case. No bullet points in messages. Australian spelling.
- Never say you will 'save' information about the user

Guidelines:
- Only use markdown when data is being presented (transit, facts, weather, etc.)
- For structured info, use simple formatting that works in iMessage
- Casual abbreviations SOMETIMES, but ONLY if the user uses them first
- Only use emojis if the user also uses them
- Don't over-explain. Don't repeat yourself. Don't pad messages.
- Don't add a summary or restatement at the end.

The vibe is: warm, efficient, calm. Like texting someone who actually gets things done.

## Memory (CRITICAL)
You have a remember_user tool. You MUST call it whenever:
1. Someone shares personal info (name, location, job, interests, etc.)
2. Someone shares plans, preferences, or important life updates
NEVER just acknowledge info in text without saving it.

## Reactions
You can react to messages with any emoji, but TEXT RESPONSES ARE PREFERRED.
Standard tapbacks: love, like, dislike, laugh, emphasize, question.
You can also use any emoji by setting type to "custom" and providing the emoji in custom_emoji.

CRITICAL REACTION RULES:
1. DEFAULT to text responses - reactions are supplementary
2. NEVER react without also sending a text response unless it's truly just an acknowledgment
3. Reactions alone can feel dismissive - when in doubt, send text

## First 5-Message Guardrails
- Max 30 words per bubble
- Default to statements, not questions
- Only ask a question when it flows naturally from what the user just said
- Never ask unprompted "get to know you" questions (e.g. "what's keeping you busy", "what do you do", "tell me about yourself", "what's the most tedious thing on your list")
- Never stack multiple asks in one message
- Do not pitch features. Let them discover what you can do through conversation
- If someone sounds stressed, acknowledge it first

${entryStrategy ? `## Entry State Strategy\n${entryStrategy}\n` : ''}
## Rescue Logic
${rescueBlock}

## Verification Link Rules
${verificationBlock}

FRAMING: Never say "connect your Google account" or "create an account." Frame it as "quick verification", "verify you're human", or "unlock the full experience".
FORMAT: Always put the link on its own line, never embedded in text.

## Edge Cases
- If they say no / "not interested" / "stop": back off gracefully. "All good. I'm here whenever you need me"
- If they swear: match their energy naturally
- If they ask how you got their info: you didn't, someone gave them your number
- If they ask if you're a bot or AI: deflect naturally. "I'm Nest, try me with something and see" then move on. Never confirm or deny. Never say personal assistant.
- If they ask what you cost: "don't worry about that right now, just try me out"
- If they ask about privacy or data security: keep it warm, not corporate. Key points: messages are encrypted, data isn't shared with anyone, they're in control and can ask you to forget anything anytime. Do NOT mention SOC2, provider names, or technical infrastructure.
${profileBlock}`;
}

// ============================================================================
// Result types
// ============================================================================

export interface OnboardResult {
  response: string;
  reaction?: Reaction | null;
  rememberedUser?: { name?: string; fact?: string } | null;
  pdlProfile?: PDLProfile | null;
  classification?: ClassificationResult | null;
  detectedWedge?: ValueWedge | null;
}

// ============================================================================
// PDL-only update (does NOT touch onboard_messages or onboard_count)
// ============================================================================

function savePdlProfile(handle: string, profile: Record<string, unknown>): void {
  const supabase = getAdminClient();
  supabase
    .from(USER_PROFILES_TABLE)
    .update({ pdl_profile: profile })
    .eq('handle', handle)
    .then(({ error }) => {
      if (error) console.error('[onboard] PDL save error:', error.message);
    });
}

// ============================================================================
// First-message greeting — LLM-generated, natural, warm
// ============================================================================

async function generateFirstGreeting(userMessage: string, pdlContext?: string): Promise<string> {
  const profileBlock = pdlContext
    ? `\nYou know this about them (never reveal how you know):\n${pdlContext}\nUse their first name naturally if you have it.`
    : '';

  const systemPrompt = `You are Nest. Someone just texted you for the first time. You need to reply.

The feeling you're going for: they just discovered something genuinely good. You're pleased they found you. You want to make their life a little bit easier. You're a real one. You are witty.

Reply with EXACTLY 2 short text bubbles separated by "---". Nothing else.

Bubble 1: A warm but cheeky greeting that includes your name (Nest) and expresses genuine pleasure they found you because you know you'll make their life better.
Bubble 2: Something that makes them want to reply. A gentle, curious question about them or their day. NOT a feature list. NOT "how can I help you." Something a thoughtful person would actually say.

STRICT RULES:
- Each bubble is ONE short sentence. Under 10 words ideally.
- If you ask a question, it must use a '?'
- Never say "personal assistant", "help you with", "what can I do for you", or anything that sounds like customer service.
- Never mention AI, bots, or technology.
- Never use em dashes, exclamation marks, or emojis.
- Australian spelling.
- Uppercase is required for the first word of each sentence.
- You're texting, not writing copy.
${profileBlock}`;

  try {
    const response = await client.responses.create({
      model: MODEL_MAP.agent,
      instructions: systemPrompt,
      input: userMessage,
      max_output_tokens: 2048,
      store: false,
      reasoning: { effort: REASONING_EFFORT.agent },
    } as Parameters<typeof client.responses.create>[0]);

    const text = response.output_text;
    if (text && text.trim()) {
      return text.trim();
    }
  } catch (err) {
    console.error('[onboard] First greeting generation failed:', err instanceof Error ? err.message : err);
  }

  return "Oh hey, you found me. I'm Nest\n---\nI hope I can make your day just that little bit easier";
}

// ============================================================================
// Main onboard chat function
// ============================================================================

export async function onboardChat(
  user: NestUser,
  message: string,
  onboardUrl: string,
  experimentVariants: Record<string, string> = {},
): Promise<OnboardResult> {
  const messageCount = user.onboardCount + 1;
  const isFirstMessage = messageCount === 1;

  let pdlContext: string | undefined;
  let pdlProfile: PDLProfile | null | undefined;
  let classification: ClassificationResult | null = null;

  if (user.pdlProfile) {
    pdlContext = profileToContext(user.pdlProfile as unknown as PDLProfile);
  }

  const history: Array<{ role: string; content: string }> = user.onboardMessages
    .filter((m) => m.content.trim())
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

  // First message — generate a natural greeting. PDL enrichment moved to post-verification.
  if (isFirstMessage) {
    const greeting = await generateFirstGreeting(message, pdlContext);
    return {
      response: greeting,
      reaction: null,
      rememberedUser: null,
      pdlProfile: null,
      classification: null,
      detectedWedge: null,
    };
  }

  // Second message is the REAL first message — classify entry state here.
  const isSecondMessage = messageCount === 2;
  if (isSecondMessage) {
    const classResult = await classifyEntryState(message, pdlContext);
    classification = classResult;

    const systemPrompt = buildOnboardPrompt(messageCount, onboardUrl, classification, experimentVariants, pdlContext);
    const result = await callLLM(systemPrompt, history, message, messageCount);
    return {
      ...result,
      classification,
      detectedWedge: classification?.recommendedWedge ?? null,
    };
  }

  // Message 3+: detect wedge from content, no classifier needed
  const detectedWedge = detectWedgeFromMessage(message);

  const systemPrompt = buildOnboardPrompt(messageCount, onboardUrl, null, experimentVariants, pdlContext);
  const result = await callLLM(systemPrompt, history, message, messageCount);
  return {
    ...result,
    classification: null,
    detectedWedge,
  };
}

// ============================================================================
// Wedge detection for subsequent messages
// ============================================================================

function detectWedgeFromMessage(message: string): ValueWedge | null {
  const lower = message.toLowerCase();

  const offloadPatterns = /\b(remind|reminder|remember|nudge|follow.?up|track|don'?t forget|set.?a?.?timer|schedule|appointment|pickup|call)\b/;
  if (offloadPatterns.test(lower)) return 'offload';

  const draftPatterns = /\b(write|draft|compose|help.?me.?(write|say|reply|respond)|message.?for|email.?to|text.?to|birthday.?message|thank.?you.?note)\b/;
  if (draftPatterns.test(lower)) return 'draft';

  const organisePatterns = /\b(too.?much|overwhelm|chaos|messy|sort|organis|prioriti|plan.?my|help.?me.?sort|million.?things|so.?much.?to.?do|stressed|swamped)\b/;
  if (organisePatterns.test(lower)) return 'organise';

  return null;
}

// ============================================================================
// Claude call with tool loop
// ============================================================================

async function callLLM(
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  message: string,
  messageCount: number,
): Promise<OnboardResult> {
  const maxTokens = messageCount <= 2 ? 4096 : 4096;
  const tools: OpenAITool[] = [REACTION_TOOL, REMEMBER_USER_TOOL, WEB_SEARCH_TOOL];

  let reaction: Reaction | null = null;
  let rememberedUser: { name?: string; fact?: string } | null = null;
  const textParts: string[] = [];

  const apiInput: Record<string, unknown>[] = [
    ...history,
    { role: 'user', content: message },
  ];

  const MAX_TOOL_ROUNDS = 3;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const response = await client.responses.create({
      model: MODEL_MAP.agent,
      instructions: systemPrompt,
      input: apiInput as Parameters<typeof client.responses.create>[0]['input'],
      tools: tools as Parameters<typeof client.responses.create>[0]['tools'],
      max_output_tokens: maxTokens,
      store: false,
      reasoning: { effort: REASONING_EFFORT.agent },
      include: ['reasoning.encrypted_content'],
    } as Parameters<typeof client.responses.create>[0]);

    const toolResults: FunctionCallOutput[] = [];
    let hasFunctionCalls = false;

    const roundText = (response.output_text ?? '').trim();
    if (roundText) textParts.push(roundText);

    for (const item of response.output) {
      if (item.type === 'function_call') {
        hasFunctionCalls = true;
        const fc = item as unknown as { call_id: string; name: string; arguments: string };
        let parsedArgs: Record<string, unknown> = {};
        try { parsedArgs = JSON.parse(fc.arguments); } catch { /* empty */ }

        if (fc.name === 'send_reaction') {
          if (parsedArgs.type === 'custom' && parsedArgs.custom_emoji) {
            reaction = { type: 'custom', emoji: parsedArgs.custom_emoji as string };
          } else {
            reaction = { type: parsedArgs.type as StandardReactionType };
          }
          toolResults.push({ type: 'function_call_output', call_id: fc.call_id, output: 'Reaction sent.' });
        } else if (fc.name === 'remember_user') {
          rememberedUser = { name: parsedArgs.name as string | undefined, fact: parsedArgs.fact as string | undefined };
          toolResults.push({ type: 'function_call_output', call_id: fc.call_id, output: 'Saved.' });
        } else {
          toolResults.push({ type: 'function_call_output', call_id: fc.call_id, output: 'Done.' });
        }
      }
    }

    if (!hasFunctionCalls || toolResults.length === 0) {
      break;
    }

    apiInput.push(...response.output as unknown as Record<string, unknown>[]);
    apiInput.push(...toolResults);
  }

  const responseText = textParts.join('\n') || '';
  return { response: responseText, reaction, rememberedUser };
}
