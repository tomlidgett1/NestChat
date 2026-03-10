import Anthropic from 'npm:@anthropic-ai/sdk@0.39.0';
import type { EntryState, ValueWedge } from './state.ts';

const client = new Anthropic({
  apiKey: Deno.env.get('ANTHROPIC_API_KEY'),
});

export interface ClassificationResult {
  entryState: EntryState;
  confidence: number;
  recommendedWedge: ValueWedge;
  shouldAskName: boolean;
  includeTrustReassurance: boolean;
  needsClarification: boolean;
  emotionalLoad: 'none' | 'low' | 'moderate' | 'high';
}

const CLASSIFIER_PROMPT = `You are a message classifier for a personal assistant called Nest. Given a user's first message, classify it.

Respond with ONLY valid JSON:
{
  "entry_state": "curious_opener" | "direct_task_opener" | "drafting_opener" | "overwhelm_opener" | "referral_opener" | "trust_opener" | "ambiguous_opener",
  "confidence": 0.0 to 1.0,
  "recommended_wedge": "offload" | "draft" | "organise" | "ask_plan",
  "should_ask_name": true | false,
  "include_trust_reassurance": true | false,
  "needs_clarification": true | false,
  "emotional_load": "none" | "low" | "moderate" | "high"
}

Classification rules (priority order):
1. Distress/emotional overload → "overwhelm_opener", emotional_load "high", wedge "organise"
2. Direct actionable task (remind me, set timer, book, schedule) → "direct_task_opener", wedge "offload"
3. Drafting request (help me write, draft, compose) → "drafting_opener", wedge "draft"
4. Referral mention (friend told me, someone recommended) → "referral_opener", wedge "ask_plan"
5. Trust/privacy concern (are you real, are you a bot, are you AI, who reads this, is this safe, is this a person) → "trust_opener", include_trust_reassurance true
6. Clear curiosity (hi, hello, what is this, what can you do) → "curious_opener", wedge "ask_plan"
7. Anything else → "ambiguous_opener"

Name rules:
- should_ask_name = true ONLY for: curious_opener, referral_opener, ambiguous_opener
- should_ask_name = false for: direct_task_opener, drafting_opener, overwhelm_opener, trust_opener

Trust reassurance:
- include_trust_reassurance = true for: trust_opener, or if message shows skepticism/concern
- include_trust_reassurance = false otherwise

Clarification:
- needs_clarification = true ONLY if the message is genuinely unintelligible or contradictory`;

export async function classifyEntryState(message: string, pdlContext?: string): Promise<ClassificationResult> {
  const userContent = pdlContext
    ? `Profile context: ${pdlContext}\n\nUser message: "${message}"`
    : `User message: "${message}"`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: CLASSIFIER_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });

    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') {
      return defaultClassification();
    }

    let rawText = text.text.trim();
    const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) rawText = fenceMatch[1].trim();

    const parsed = JSON.parse(rawText);
    return {
      entryState: parsed.entry_state || 'curious_opener',
      confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
      recommendedWedge: parsed.recommended_wedge || 'ask_plan',
      shouldAskName: parsed.should_ask_name ?? true,
      includeTrustReassurance: parsed.include_trust_reassurance ?? false,
      needsClarification: parsed.needs_clarification ?? false,
      emotionalLoad: parsed.emotional_load || 'none',
    };
  } catch (err) {
    console.error('[classifier] Classification failed:', err instanceof Error ? err.message : err);
    return defaultClassification();
  }
}

function defaultClassification(): ClassificationResult {
  return {
    entryState: 'curious_opener',
    confidence: 0.3,
    recommendedWedge: 'ask_plan',
    shouldAskName: true,
    includeTrustReassurance: false,
    needsClarification: false,
    emotionalLoad: 'none',
  };
}
