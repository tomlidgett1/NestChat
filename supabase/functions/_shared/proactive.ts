import Anthropic from 'npm:@anthropic-ai/sdk@0.78.0';
import {
  type ProactiveEligibleUser,
  transitionOnboardState,
  emitOnboardingEvent,
  recordProactiveMessage,
  getActiveMemoryItems,
  type MemoryItem,
} from './state.ts';

const client = new Anthropic({
  apiKey: Deno.env.get('ANTHROPIC_API_KEY'),
});

// ============================================================================
// Proactive action types
// ============================================================================

export type ProactiveAction =
  | { type: 'hold'; reason: string }
  | { type: 'wait' }
  | { type: 'recovery_nudge'; message: string }
  | { type: 'checkin_permission'; message: string }
  | { type: 'morning_checkin'; message: string }
  | { type: 'memory_moment'; message: string }
  | { type: 'mark_at_risk' }
  | { type: 'mark_activated' };

// ============================================================================
// Core orchestrator — evaluates what proactive action to take for a user
// ============================================================================

export async function evaluateProactiveAction(user: ProactiveEligibleUser): Promise<ProactiveAction> {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const userAgeHours = (nowEpoch - user.firstSeen) / 3600;
  const hoursSinceLastSeen = (nowEpoch - user.lastSeen) / 3600;
  const hoursSinceLastProactive = user.lastProactiveSentAt
    ? (Date.now() - new Date(user.lastProactiveSentAt).getTime()) / 3600000
    : Infinity;

  // Spam hold: if last proactive was ignored and within 72 hours
  if (user.lastProactiveIgnored && hoursSinceLastProactive < 72) {
    return { type: 'hold', reason: 'proactive_ignored_within_72h' };
  }

  // If user has been active for 48+ hours and activation score >= 2, mark activated
  if (userAgeHours >= 48 && user.activationScore >= 2) {
    return { type: 'mark_activated' };
  }

  // If user has been active for 48+ hours and activation score < 2, mark at risk
  if (userAgeHours >= 48 && user.activationScore < 2) {
    return { type: 'mark_at_risk' };
  }

  // Recovery nudge: user opened but never got value, 6-18 hours since last seen
  if (
    !user.firstValueDeliveredAt &&
    hoursSinceLastSeen >= 6 &&
    hoursSinceLastSeen <= 18 &&
    !user.recoveryNudgeSentAt &&
    user.onboardCount >= 1
  ) {
    const message = await generateRecoveryNudge(user);
    return { type: 'recovery_nudge', message };
  }

  // Check-in permission: eligible if value delivered + second engagement + no prior ask
  if (
    user.firstValueDeliveredAt &&
    user.secondEngagementAt &&
    user.checkinOptIn === null &&
    !user.checkinDeclineAt &&
    user.onboardCount >= 3
  ) {
    return {
      type: 'checkin_permission',
      message: generateCheckinPermissionAsk(user),
    };
  }

  // Morning check-in: if opted in and it's been 20+ hours since last proactive
  if (user.checkinOptIn === true && hoursSinceLastProactive >= 20) {
    const message = await generateMorningCheckin(user);
    return { type: 'morning_checkin', message };
  }

  // Memory moment: if value delivered + second engagement + high-confidence memories exist
  if (
    user.firstValueDeliveredAt &&
    user.secondEngagementAt &&
    !user.memoryMomentDeliveredAt &&
    hoursSinceLastSeen >= 12
  ) {
    const memoryMessage = await evaluateMemoryMoment(user);
    if (memoryMessage) {
      return { type: 'memory_moment', message: memoryMessage };
    }
  }

  return { type: 'wait' };
}

// ============================================================================
// Message generators
// ============================================================================

async function generateRecoveryNudge(user: ProactiveEligibleUser): Promise<string> {
  const name = user.name ? ` ${user.name}` : '';

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 150,
      system: `You are Nest, a personal assistant people text. Never mention AI, bots, or technology. Generate a brief, warm recovery nudge for a user who opened a conversation but never got to value. Keep it to 1-2 short sentences. Be casual and low-pressure. Australian spelling.

The user's name is${name || ' unknown'}.

Frame it around easy first uses. Do NOT be generic. Do NOT sound like a notification. Sound like a helpful friend checking in.

Good examples:
- "Hey${name}, quick one. Text me something you need to remember, a message you want help writing, or a messy list and I'll sort it"
- "Quick thought for your week: if there's one thing you don't want to forget, send it my way"

Bad examples:
- "Hey! Just checking in!" (generic)
- "Don't forget about Nest!" (desperate)
- "I'm here to help!" (spammy)`,
      messages: [{ role: 'user', content: 'Generate the recovery nudge.' }],
    });

    const text = response.content.find((b) => b.type === 'text');
    return text?.type === 'text' ? text.text.trim() : `Hey${name}, you can text me something you need to remember, a message you want help writing, or a messy list and I'll sort it`;
  } catch {
    return `Hey${name}, you can text me something you need to remember, a message you want help writing, or a messy list and I'll sort it`;
  }
}

function generateCheckinPermissionAsk(user: ProactiveEligibleUser): string {
  const name = user.name ? `${user.name}, w` : 'W';
  return `By the way ${name.toLowerCase()}ould you like a quick morning check-in from me? Just a simple "what's on today?" Totally fine if you'd rather just text me when you need me`;
}

async function generateMorningCheckin(user: ProactiveEligibleUser): Promise<string> {
  const name = user.name ? ` ${user.name}` : '';

  try {
    const memories = await getActiveMemoryItems(user.handle, 5);
    const memoryContext = memories.length > 0
      ? `\nYou know these things about them:\n${memories.map((m) => `- ${m.valueText}`).join('\n')}`
      : '';

    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 100,
      system: `You are Nest, a personal assistant. Generate a brief morning check-in message. Keep it to 1 short sentence. Be warm but not over-the-top. Australian spelling. Never mention AI or bots.

The user's name is${name || ' unknown'}.${memoryContext}

Good: "Morning${name}. Anything on today that you want me to keep track of?"
Bad: "Good morning! How are you doing today? I hope you're having a great day!" (too much)`,
      messages: [{ role: 'user', content: 'Generate the morning check-in.' }],
    });

    const text = response.content.find((b) => b.type === 'text');
    return text?.type === 'text' ? text.text.trim() : `Morning${name}. Anything on today you want me to keep track of?`;
  } catch {
    return `Morning${name}. Anything on today you want me to keep track of?`;
  }
}

// ============================================================================
// Memory moment evaluation
// ============================================================================

async function evaluateMemoryMoment(user: ProactiveEligibleUser): Promise<string | null> {
  const memories = await getActiveMemoryItems(user.handle, 10);
  if (memories.length === 0) return null;

  const highConfidence = memories.filter((m) => m.confidence >= 0.7);
  if (highConfidence.length === 0) return null;

  const scored = highConfidence.map((m) => ({
    memory: m,
    score: scoreMemoryForMoment(m, user),
  }));

  const best = scored.sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < 0.5) return null;

  return await generateMemoryMomentMessage(user, best.memory);
}

function scoreMemoryForMoment(memory: MemoryItem, user: ProactiveEligibleUser): number {
  let score = 0;

  // Confidence
  score += memory.confidence * 0.3;

  // Utility: task-related memories are more useful
  if (['task_commitment', 'plan'].includes(memory.memoryType)) score += 0.3;
  if (['preference', 'bio_fact'].includes(memory.memoryType)) score += 0.1;

  // Timeliness: recent memories are better
  const ageHours = (Date.now() - new Date(memory.lastSeenAt).getTime()) / 3600000;
  if (ageHours < 24) score += 0.2;
  else if (ageHours < 48) score += 0.1;

  // Sensitivity: personal/emotional categories get penalised
  if (['relationship', 'emotional_context', 'health'].includes(memory.memoryType)) score -= 0.3;

  // Creep risk: very personal details too early
  const userAgeHours = (Date.now() / 1000 - user.firstSeen) / 3600;
  if (userAgeHours < 24 && ['relationship', 'health'].includes(memory.memoryType)) score -= 0.5;

  return Math.max(0, Math.min(1, score));
}

async function generateMemoryMomentMessage(user: ProactiveEligibleUser, memory: MemoryItem): Promise<string> {
  const name = user.name ? ` ${user.name}` : '';

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 100,
      system: `You are Nest, a personal assistant. Generate a brief, helpful follow-up message that references something you remember about the user. Keep it to 1-2 short sentences. Be warm and useful, not creepy. Australian spelling. Never mention AI or bots.

The user's name is${name || ' unknown'}.
The memory to reference: "${memory.valueText}" (category: ${memory.category})

The goal is to make the user feel supported, not surveilled. Reference the memory in a way that reduces their cognitive load or shows follow-through.

Good: "Morning${name}. Hope the prescription pickup went smoothly yesterday. Do you still want to send that email to the school today?"
Bad: "I remember you mentioned your mum's birthday is coming up!" (just showing off memory)`,
      messages: [{ role: 'user', content: 'Generate the memory moment message.' }],
    });

    const text = response.content.find((b) => b.type === 'text');
    return text?.type === 'text' ? text.text.trim() : null as unknown as string;
  } catch {
    return null as unknown as string;
  }
}

// ============================================================================
// Execute a proactive action (called by the orchestrator edge function)
// ============================================================================

export async function executeProactiveAction(
  user: ProactiveEligibleUser,
  action: ProactiveAction,
): Promise<{ sent: boolean; message?: string }> {
  switch (action.type) {
    case 'hold':
      await emitOnboardingEvent({
        handle: user.handle,
        eventType: 'proactive_hold_due_to_spam_rule',
        currentState: user.onboardState,
        payload: { reason: action.reason },
      });
      return { sent: false };

    case 'wait':
      return { sent: false };

    case 'mark_activated':
      await transitionOnboardState({
        handle: user.handle,
        newState: 'activated',
        activated: true,
      });
      await emitOnboardingEvent({
        handle: user.handle,
        eventType: 'activated_composite',
        currentState: 'activated',
        payload: { activationScore: user.activationScore },
      });
      return { sent: false };

    case 'mark_at_risk':
      await transitionOnboardState({
        handle: user.handle,
        newState: 'at_risk',
        atRisk: true,
      });
      await emitOnboardingEvent({
        handle: user.handle,
        eventType: 'at_risk_48h',
        currentState: 'at_risk',
        payload: { activationScore: user.activationScore },
      });
      return { sent: false };

    case 'recovery_nudge':
      await recordProactiveMessage(user.handle, `DM#${user.botNumber}#${user.handle}`, 'recovery_nudge', action.message);
      await emitOnboardingEvent({
        handle: user.handle,
        eventType: 'recovery_nudge_sent',
        currentState: user.onboardState,
      });
      return { sent: true, message: action.message };

    case 'checkin_permission':
      await recordProactiveMessage(user.handle, `DM#${user.botNumber}#${user.handle}`, 'checkin_permission', action.message);
      await emitOnboardingEvent({
        handle: user.handle,
        eventType: 'checkin_permission_offered',
        currentState: user.onboardState,
      });
      return { sent: true, message: action.message };

    case 'morning_checkin':
      await recordProactiveMessage(user.handle, `DM#${user.botNumber}#${user.handle}`, 'morning_checkin', action.message);
      await emitOnboardingEvent({
        handle: user.handle,
        eventType: 'morning_checkin_sent',
        currentState: user.onboardState,
      });
      return { sent: true, message: action.message };

    case 'memory_moment':
      await recordProactiveMessage(user.handle, `DM#${user.botNumber}#${user.handle}`, 'memory_moment', action.message);
      await transitionOnboardState({
        handle: user.handle,
        newState: 'memory_moment_delivered',
        memoryMomentDelivered: true,
      });
      await emitOnboardingEvent({
        handle: user.handle,
        eventType: 'memory_moment_sent',
        currentState: 'memory_moment_delivered',
      });
      return { sent: true, message: action.message };
  }
}
