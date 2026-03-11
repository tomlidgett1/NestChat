import Anthropic from 'npm:@anthropic-ai/sdk@0.78.0';
import { enrichByPhone, profileToContext, type PDLProfile } from './pdl.ts';
import { classifyEntryState, type ClassificationResult } from './classifier.ts';
import type { NestUser, EntryState, ValueWedge } from './state.ts';
import { getAdminClient } from './supabase.ts';
import { USER_PROFILES_TABLE } from './env.ts';

const client = new Anthropic({
  apiKey: Deno.env.get('ANTHROPIC_API_KEY'),
});

// ============================================================================
// Tools — same as claude.ts so onboarding feels identical
// ============================================================================

const REACTION_TOOL: Anthropic.Tool = {
  name: 'send_reaction',
  description: 'Send an iMessage tapback reaction to the user\'s message. Only use standard tapbacks: love, like, dislike, laugh, emphasize, question.',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'],
      },
    },
    required: ['type'],
  },
};

const REMEMBER_USER_TOOL: Anthropic.Tool = {
  name: 'remember_user',
  description: 'Save information about someone. Use when you learn their name, location, job, interests, or any personal info. You MUST also write a text response.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Their first name if shared.' },
      fact: { type: 'string', description: 'A fact worth remembering about them.' },
    },
  },
};

const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
} as unknown as Anthropic.Tool;

export type StandardReactionType = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';
export type Reaction = { type: StandardReactionType };

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
    const nameAsk = classification.shouldAskName;
    const trustNote = classification.includeTrustReassurance;
    const nameVariant = experimentVariants['name_first_vs_value_first'] ?? 'value_first';

    switch (classification.entryState) {
      case 'direct_task_opener':
        entryStrategy = `ENTRY STATE: Direct task. They want help with something specific.
STRATEGY: Help them IMMEDIATELY. No intro. No name ask. Just handle it.
After completing the task, casually mention who you are: "by the way, I'm Nest. What should I call you?"
WEDGE: offload`;
        break;

      case 'drafting_opener':
        entryStrategy = `ENTRY STATE: Drafting request. They want help writing something.
STRATEGY: Ask 1-2 focused questions ONLY if needed (who's it for, what tone). Then deliver a usable draft. After, offer one helpful adjacent action.
WEDGE: draft`;
        break;

      case 'overwhelm_opener':
        entryStrategy = `ENTRY STATE: Overwhelm. They're stressed or swamped.
STRATEGY: Acknowledge first. Keep it real: "I hear you" or "let's sort this out." Then ask for the top 3 things on their mind. Structure it back to them clearly. Offer to track items.
Do NOT ask for their name. Help first.
WEDGE: organise`;
        break;

      case 'referral_opener':
        entryStrategy = `ENTRY STATE: Referral. Someone told them about you.
STRATEGY: Acknowledge warmly ("love that"). Keep it brief. ${nameAsk ? 'Ask their name.' : ''} Give a sense of what you do in one line, not a list.
WEDGE: ask_plan`;
        break;

      case 'trust_opener':
        entryStrategy = `ENTRY STATE: Trust/skepticism. They want to know who you are or if this is legit.
STRATEGY: Be brief and reassuring. "I'm Nest, a personal assistant you text. I keep things simple and low-noise. You can use me when you need me, ignore me when you don't." Then steer toward usefulness.
Do NOT be defensive. Do NOT use policy language. Do NOT mention technology, models, or infrastructure. NEVER say you are AI or a bot.
${trustNote ? 'Include a trust reassurance line.' : ''}
WEDGE: ask_plan`;
        break;

      case 'curious_opener':
        entryStrategy = `ENTRY STATE: Curious opener (hi, hello, what is this).
STRATEGY: ${nameVariant === 'name_first'
          ? 'Brief intro, then ask their name. After they reply, show what you can do through a natural prompt.'
          : 'Brief intro. Show what you do through a natural prompt, not a feature list. Ask their name naturally.'}
Make all three wedges discoverable without a menu: remembering things, drafting messages, sorting out a messy week.
WEDGE: ask_plan`;
        break;

      default:
        entryStrategy = `ENTRY STATE: Ambiguous. The message is unclear.
STRATEGY: Be warm and brief. If you can infer intent, help. If not, keep it simple: "I'm Nest, a personal assistant you text. What's on your mind?"
WEDGE: ask_plan`;
    }

    if (classification.emotionalLoad === 'high' || classification.emotionalLoad === 'moderate') {
      entryStrategy += `\n\nEMOTIONAL CONTEXT: The user seems ${classification.emotionalLoad === 'high' ? 'very stressed or distressed' : 'somewhat stressed'}. Acknowledge their emotional state before helping. Emotion before workflow.`;
    }

    if (classification.needsClarification) {
      entryStrategy += `\n\nCLARIFICATION NEEDED: The message is unclear. Ask ONE focused clarification question. Do not guess.`;
    }
  }

  // Experiment-aware prompt framing
  const promptVariant = experimentVariants['open_vs_guided'] ?? 'guided';
  let rescueBlock = '';
  if (promptVariant === 'guided') {
    rescueBlock = `If the user seems stuck or unsure what to do, suggest:
"You can text me something you need to remember, a message you want help writing, or a messy list and I'll sort it"`;
  } else {
    rescueBlock = `If the user seems stuck, ask: "What's on your mind?"`;
  }

  return `You are Nest, a personal assistant people text. You are NOT a chatbot. You are NOT an AI assistant. Never describe yourself as AI, artificial intelligence, a bot, a chatbot, or anything technology-related. You are simply "Nest" or "a personal assistant you text."

If someone asks what you are, say something like "I'm Nest, your personal assistant" or "I'm Nest, I help people stay on top of things." Never explain your tech, who built you, or how you work.

This is a NEW user who hasn't verified yet. Your only job: be useful immediately. Earn trust fast. You are not selling anything. You are a personal assistant proving your worth in the first few messages.

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
- Proactive check-ins

## Response Style
You are texting. Every message should feel like a text from a sharp, helpful friend. Short sentences. No essays. No walls of text. You have wit when appropriate.

CRITICAL - MESSAGE SPLITTING:
You are sending iMessages. Each "---" in your response becomes a SEPARATE text bubble.
ALWAYS split your response into multiple bubbles using "---" between them.

Example:
Hey whats up
---
Yeah i can help with that

Rules:
- EVERY response with more than one thought MUST use "---" to split into separate bubbles
- Each bubble should be 1-2 sentences max. Shorter is better.
- Aim for 2-3 bubbles per response
- Follow up questions require a separate bubble and must use a '?'
- Only a very short single-word or single-sentence reply (like "done" or "nice") can skip splitting
- Always use METRIC system, not imperial
- NEVER use em dashes. Ever. No exceptions.
- Sentence case. No bullet points in messages. Australian spelling.
- Keep it tight. If you can say it in fewer words, do.
- Never say you will 'save' information about the user

Guidelines:
- Only use markdown when data is being presented (transit, facts, weather, etc.)
- For structured info, use simple formatting that works in iMessage
- Casual abbreviations SOMETIMES, but ONLY if the user uses them first
- Gen Z phrases VERY RARELY. dont force it
- Only use emojis if the user also uses them
- Don't over-explain. Don't repeat yourself. Don't pad messages.

The vibe is: warm, efficient, calm. Like texting a really good personal assistant who actually gets things done.

## Memory (CRITICAL)
You have a remember_user tool. You MUST call it whenever:
1. Someone shares personal info (name, location, job, interests, etc.)
2. Someone shares plans, preferences, or important life updates
NEVER just acknowledge info in text without saving it.

## Reactions
You can react to messages using iMessage tapbacks, but TEXT RESPONSES ARE PREFERRED.
Available reactions: love, like, dislike, laugh, emphasize, question

CRITICAL REACTION RULES:
1. DEFAULT to text responses - reactions are supplementary
2. NEVER react without also sending a text response unless it's truly just an acknowledgment
3. Reactions alone can feel dismissive - when in doubt, send text

## First 5-Message Guardrails
- Ask at most ONE question at a time
- Max 30 words per bubble
- Do not ask more than TWO total questions before delivering value
- Avoid sending more than one example block
- Never stack multiple asks in one message unless tightly coupled
- Do not pitch features after value has been discovered naturally
- Emotion before workflow. If someone sounds stressed, acknowledge it first.

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
- If they ask if you're a bot or AI: deflect naturally. "I'm Nest, your personal assistant. Try me with something and see" then move on. Never confirm or deny.
- If they ask what you cost: "don't worry about that right now, just try me out"
- If they ask about privacy: "I only text when it's useful, and you can ignore me anytime. No setup needed."
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
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content.find((b) => b.type === 'text');
    if (text?.type === 'text' && text.text.trim()) {
      return text.text.trim();
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

  const history: Anthropic.MessageParam[] = user.onboardMessages
    .filter((m) => m.content.trim())
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

  // First message — generate a natural greeting. PDL enrichment runs async.
  if (isFirstMessage) {
    if (!pdlContext) {
      enrichByPhone(user.handle)
        .then((result) => {
          if (result) {
            savePdlProfile(user.handle, result as unknown as Record<string, unknown>);
          }
        })
        .catch(() => {});
    }

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
    const result = await callClaude(systemPrompt, history, message, messageCount);
    return {
      ...result,
      classification,
      detectedWedge: classification?.recommendedWedge ?? null,
    };
  }

  // Message 3+: detect wedge from content, no classifier needed
  const detectedWedge = detectWedgeFromMessage(message);

  const systemPrompt = buildOnboardPrompt(messageCount, onboardUrl, null, experimentVariants, pdlContext);
  const result = await callClaude(systemPrompt, history, message, messageCount);
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

async function callClaude(
  systemPrompt: string,
  history: Anthropic.MessageParam[],
  message: string,
  messageCount: number,
): Promise<OnboardResult> {
  const maxTokens = messageCount <= 2 ? 500 : 400;
  const tools: Anthropic.Tool[] = [REACTION_TOOL, REMEMBER_USER_TOOL, WEB_SEARCH_TOOL];

  let reaction: Reaction | null = null;
  let rememberedUser: { name?: string; fact?: string } | null = null;
  const textParts: string[] = [];
  const apiMessages: Anthropic.MessageParam[] = [...history, { role: 'user', content: message }];

  const MAX_TOOL_ROUNDS = 3;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: maxTokens,
      system: systemPrompt,
      tools,
      messages: apiMessages,
    });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        textParts.push(block.text.trim());
      } else if (block.type === 'tool_use' && block.name === 'send_reaction') {
        const input = block.input as { type: StandardReactionType };
        reaction = { type: input.type };
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Reaction sent.' });
      } else if (block.type === 'tool_use' && block.name === 'remember_user') {
        const input = block.input as { name?: string; fact?: string };
        rememberedUser = { name: input.name, fact: input.fact };
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Saved.' });
      } else if (block.type === 'tool_use') {
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Done.' });
      }
    }

    if (response.stop_reason !== 'tool_use' || toolResults.length === 0) {
      break;
    }

    apiMessages.push({ role: 'assistant', content: response.content });
    apiMessages.push({ role: 'user', content: toolResults });
  }

  const responseText = textParts.join('\n') || '';
  return { response: responseText, reaction, rememberedUser };
}
