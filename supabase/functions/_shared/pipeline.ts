import { generateImage, getGroupChatAction, getTextForEffect } from './claude.ts';
import { handleTurn } from './orchestrator/handle-turn.ts';
import type { TurnInput, OnboardingContext } from './orchestrator/types.ts';
import {
  logOutboundMessage,
  markWebhookEventStatus,
  addMessage,
  ensureNestUser,
  updateOnboardState,
  setUserName,
  addUserFact,
  emitOnboardingEvent,
  transitionOnboardState,
  assignExperiment,
  getUserExperiments,
  markProactiveReplied,
  getUserTimezone,
} from './state.ts';
import type { WebhookEventRow } from './state.ts';
import * as sendblueApi from './sendblue.ts';
import * as linqApi from './linq.ts';
import type { NormalisedIncomingMessage, Reaction, MessageEffect, MediaAttachment } from './sendblue.ts';
import { MEMORY_V2_ENABLED } from './env.ts';
import type { ValueWedge } from './state.ts';

const _BOLD_UPPER: Record<string, string> = {};
const _BOLD_LOWER: Record<string, string> = {};
const _BOLD_DIGIT: Record<string, string> = {};
for (let c = 65; c <= 90; c++) _BOLD_UPPER[String.fromCharCode(c)] = String.fromCodePoint(0x1D5D4 + (c - 65));
for (let c = 97; c <= 122; c++) _BOLD_LOWER[String.fromCharCode(c)] = String.fromCodePoint(0x1D5EE + (c - 97));
for (let c = 48; c <= 57; c++) _BOLD_DIGIT[String.fromCharCode(c)] = String.fromCodePoint(0x1D7EC + (c - 48));
const _BOLD_MAP: Record<string, string> = { ..._BOLD_UPPER, ..._BOLD_LOWER, ..._BOLD_DIGIT };

function toUnicodeBold(text: string): string {
  return [...text].map(c => _BOLD_MAP[c] ?? c).join('');
}

function cleanResponse(text: string): string {
  return text
    .replace(/<cite[^>]*>|<\/cite>/g, '')
    .replace(/\*\*(.+?)\*\*/g, (_m, p1) => toUnicodeBold(p1))
    .replace(/\n[ \t]+\n/g, '\n\n')
    .replace(/\n([,.:;!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/  +/g, ' ')
    .trim();
}

const SEPARATOR_RE = /\n---\n|\n---$|^---\n|\s+---\s+|\s+---$|^---\s+|\.---\s*|\.---$|---\n/;
const MAX_BUBBLE_LENGTH = 2000;

function splitByParagraphs(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of text.split('\n\n')) {
    if (current && current.length + paragraph.length + 2 > MAX_BUBBLE_LENGTH) {
      chunks.push(current.trim());
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current.trim()) {
    const remaining = current.trim();
    if (remaining.length <= MAX_BUBBLE_LENGTH) {
      chunks.push(remaining);
    } else {
      for (let i = 0; i < remaining.length; i += MAX_BUBBLE_LENGTH) {
        chunks.push(remaining.slice(i, i + MAX_BUBBLE_LENGTH));
      }
    }
  }
  return chunks.length > 0 ? chunks : [text.slice(0, MAX_BUBBLE_LENGTH)];
}

function splitBubbles(text: string): string[] {
  const hasSeparator = text.includes('---');
  const parts = hasSeparator
    ? text.split(SEPARATOR_RE)
    : text.includes('\n\n')
      ? text.split(/\n\n+/)
      : [text];

  const chunks: string[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (part.length <= MAX_BUBBLE_LENGTH) {
      chunks.push(part);
    } else {
      chunks.push(...splitByParagraphs(part));
    }
  }
  return chunks.length > 0 ? chunks : [text.trim().slice(0, MAX_BUBBLE_LENGTH)];
}

function fireAndForget(promise: Promise<unknown>): void {
  promise.catch((err) => console.warn('[pipeline] fire-and-forget error:', err));
}

// ─── Provider-aware wrappers ─────────────────────────────────────────────────

async function pSendMessage(
  msg: NormalisedIncomingMessage,
  text: string,
  effect?: MessageEffect,
  media?: MediaAttachment[],
): Promise<string | null> {
  if (msg.provider === 'linq') {
    const resp = await linqApi.sendMessage(msg.chatId, text, effect, media?.map((m) => ({ url: m.url })));
    return resp.message?.id ?? null;
  }
  const resp = await sendblueApi.sendMessage(msg.conversation, text, effect, media);
  return resp.message_handle ?? null;
}

async function pSendReaction(msg: NormalisedIncomingMessage, reaction: Reaction): Promise<void> {
  if (msg.provider === 'linq') {
    await linqApi.sendReaction(msg.messageId, reaction);
  } else {
    await sendblueApi.sendReaction(msg.messageId, msg.conversation.fromNumber, reaction);
  }
}

async function pStartTyping(msg: NormalisedIncomingMessage): Promise<void> {
  if (msg.provider === 'linq') {
    await linqApi.startTyping(msg.chatId);
  } else {
    await sendblueApi.startTyping(msg.conversation);
  }
}

// ─── Delivery: split bubbles, send reactions, effects, images ────────────────

async function deliverResponse(
  message: NormalisedIncomingMessage,
  result: { text: string | null; reaction: Reaction | null; effect: MessageEffect | null; generatedImage: { url: string; prompt: string } | null },
): Promise<void> {
  // Send reaction
  if (result.reaction) {
    const display = result.reaction.type === 'custom'
      ? (result.reaction as { type: 'custom'; emoji: string }).emoji
      : result.reaction.type;
    await pSendReaction(message, result.reaction);
    fireAndForget(logOutboundMessage(message.chatId, 'reaction', { reaction: display, message_id: message.messageId }, 'sent', message.messageId));
  }

  // Generate effect text if no response text
  let finalText = result.text;
  if (!finalText && result.effect) {
    finalText = await getTextForEffect(result.effect.name);
  }

  // Send text bubbles
  if (finalText || result.generatedImage) {
    const bubbles = finalText
      ? splitBubbles(finalText).map((part) => cleanResponse(part)).filter(Boolean)
      : [];

    for (let i = 0; i < bubbles.length; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
      const isLast = i === bubbles.length - 1;
      const messageEffect = isLast && !result.generatedImage ? result.effect ?? undefined : undefined;
      const handle = await pSendMessage(message, bubbles[i], messageEffect);
      fireAndForget(logOutboundMessage(
        message.chatId,
        'text',
        { text: bubbles[i], effect: messageEffect ?? null },
        'sent',
        handle,
      ));
    }

    // Send generated image
    if (result.generatedImage) {
      await pStartTyping(message);
      const imageUrl = await generateImage(result.generatedImage.prompt);
      if (imageUrl) {
        const handle = await pSendMessage(message, '', result.effect ?? undefined, [{ url: imageUrl }]);
        fireAndForget(addMessage(message.chatId, 'assistant', `[generated an image: ${result.generatedImage.prompt.substring(0, 50)}...]`));
        fireAndForget(logOutboundMessage(
          message.chatId,
          'image',
          { prompt: result.generatedImage.prompt, image_url: imageUrl },
          'sent',
          handle,
        ));
      } else {
        const handle = await pSendMessage(message, 'sorry the image didnt work, try again?');
        fireAndForget(logOutboundMessage(
          message.chatId,
          'text',
          { text: 'sorry the image didnt work, try again?' },
          'sent',
          handle,
        ));
      }
    }
  }
}

// ─── Onboarding state machine events ─────────────────────────────────────────

async function emitOnboardingEvents(
  message: NormalisedIncomingMessage,
  nestUser: Awaited<ReturnType<typeof ensureNestUser>>,
  result: { rememberedUser: { name?: string; fact?: string; isForSender?: boolean } | null },
): Promise<void> {
  if (result.rememberedUser) {
    if (result.rememberedUser.name) {
      fireAndForget(setUserName(message.from, result.rememberedUser.name));
    }
    if (result.rememberedUser.fact) {
      fireAndForget(addUserFact(message.from, result.rememberedUser.fact));
    }

    if (MEMORY_V2_ENABLED) {
      import('./memory.ts').then(({ processRealtimeMemory }) => {
        fireAndForget(processRealtimeMemory(
          message.from,
          result.rememberedUser!.fact || '',
          result.rememberedUser!.name,
          message.chatId,
        ));
      }).catch((err) => console.warn('[pipeline] onboard memory v2 failed:', err));
    }

    if (result.rememberedUser.name) {
      fireAndForget(emitOnboardingEvent({
        handle: message.from,
        chatId: message.chatId,
        eventType: 'new_user_name_captured',
        messageTurnIndex: nestUser.onboardCount + 1,
        currentState: nestUser.onboardState,
      }));
    }
  }

  if (nestUser.onboardCount >= 2 && !nestUser.secondEngagementAt) {
    fireAndForget(transitionOnboardState({
      handle: message.from,
      newState: 'second_engagement_observed',
      secondEngagement: true,
    }));

    fireAndForget(emitOnboardingEvent({
      handle: message.from,
      chatId: message.chatId,
      eventType: 'second_engagement_observed',
      messageTurnIndex: nestUser.onboardCount + 1,
      currentState: 'second_engagement_observed',
    }));
  }
}

// ─── Wedge detection ─────────────────────────────────────────────────────────

function detectWedgeFromMessage(msg: string): ValueWedge | null {
  const lower = msg.toLowerCase();

  if (/\b(remind|reminder|remember|nudge|follow.?up|track|don'?t forget|set.?a?.?timer|schedule|appointment|pickup|call)\b/.test(lower)) return 'offload';
  if (/\b(write|draft|compose|help.?me.?(write|say|reply|respond)|message.?for|email.?to|text.?to|birthday.?message|thank.?you.?note)\b/.test(lower)) return 'draft';
  if (/\b(too.?much|overwhelm|chaos|messy|sort|organis|prioriti|plan.?my|help.?me.?sort|million.?things|so.?much.?to.?do|stressed|swamped)\b/.test(lower)) return 'organise';

  return null;
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

export async function processWebhookEvent(event: WebhookEventRow): Promise<void> {
  return processMessage(event.normalized_payload, event.id);
}

export async function processMessage(message: NormalisedIncomingMessage, eventId?: number): Promise<void> {
  if (eventId) fireAndForget(markWebhookEventStatus(eventId, 'processing'));

  let authUserId: string | null = null;
  let isOnboarding = false;
  let onboardingContext: OnboardingContext | undefined;
  let isProactiveReply = false;
  let userTimezone: string | null = null;

  if (!message.isGroupChat) {
    const nestUser = await ensureNestUser(message.from, message.conversation.fromNumber);
    authUserId = nestUser.authUserId ?? null;
    userTimezone = nestUser.timezone ?? null;

    if (!userTimezone) {
      userTimezone = await getUserTimezone(message.from).catch(() => null);
    }

    if (nestUser.status !== 'active') {
      isOnboarding = true;

      const onboardUrl = `https://nest.expert/?token=${nestUser.onboardingToken}`;
      const isFirstMessage = nestUser.onboardCount === 0;

      let experimentVariants: Record<string, string> = {};
      if (isFirstMessage) {
        const [nameVariant, promptVariant] = await Promise.all([
          assignExperiment(message.from, 'name_first_vs_value_first', ['name_first', 'value_first']),
          assignExperiment(message.from, 'open_vs_guided', ['open', 'guided']),
        ]);
        experimentVariants = {
          name_first_vs_value_first: nameVariant,
          open_vs_guided: promptVariant,
        };

        fireAndForget(emitOnboardingEvent({
          handle: message.from,
          chatId: message.chatId,
          eventType: 'new_user_first_inbound_received',
          messageTurnIndex: 1,
          currentState: nestUser.onboardState,
          experimentVariantIds: Object.values(experimentVariants),
        }));

        fireAndForget(transitionOnboardState({
          handle: message.from,
          newState: 'new_user_intro_started',
        }));
      } else {
        experimentVariants = await getUserExperiments(message.from);

        if (nestUser.lastProactiveSentAt) {
          fireAndForget(markProactiveReplied(message.from));
        }
      }

      // Build PDL context if available
      let pdlContextStr: string | undefined;
      if (nestUser.pdlProfile) {
        try {
          const { profileToContext } = await import('./pdl.ts');
          pdlContextStr = profileToContext(nestUser.pdlProfile as any);
        } catch (err) {
          console.warn('[pipeline] PDL context build failed:', (err as Error).message);
        }
      }

      onboardingContext = {
        nestUser,
        onboardUrl,
        experimentVariants,
        pdlContext: pdlContextStr,
      };

      try {
        // Entry state classification (second message only) — run before handleTurn so we can inject into context
        const isSecondMessage = nestUser.onboardCount === 1;
        if (isSecondMessage) {
          try {
            const { classifyEntryState } = await import('./classifier.ts');
            const classification = await classifyEntryState(message.text, pdlContextStr);
            if (classification) {
              onboardingContext.classification = {
                entryState: classification.entryState,
                confidence: classification.confidence,
                recommendedWedge: classification.recommendedWedge,
                shouldAskName: classification.shouldAskName,
                includeTrustReassurance: classification.includeTrustReassurance,
                needsClarification: classification.needsClarification,
                emotionalLoad: classification.emotionalLoad,
              };
              onboardingContext.detectedWedge = classification.recommendedWedge;

              const turnIndex = nestUser.onboardCount + 1;
              fireAndForget(emitOnboardingEvent({
                handle: message.from,
                chatId: message.chatId,
                eventType: 'new_user_entry_state_classified',
                messageTurnIndex: turnIndex,
                entryState: classification.entryState,
                valueWedge: classification.recommendedWedge,
                currentState: 'new_user_intro_started',
                confidenceScores: { classification: classification.confidence },
              }));

              fireAndForget(transitionOnboardState({
                handle: message.from,
                newState: 'first_value_pending',
                entryState: classification.entryState,
                firstValueWedge: classification.recommendedWedge,
              }));

              if (classification.includeTrustReassurance) {
                fireAndForget(emitOnboardingEvent({
                  handle: message.from,
                  chatId: message.chatId,
                  eventType: 'trust_hesitation_detected',
                  messageTurnIndex: turnIndex,
                  entryState: classification.entryState,
                  currentState: 'first_value_pending',
                }));
              }
            }
          } catch (err) {
            console.warn('[pipeline] entry state classification failed:', (err as Error).message);
          }
        }

        const turnInput: TurnInput = {
          chatId: message.chatId,
          userMessage: message.text,
          images: message.images,
          audio: message.audio,
          senderHandle: message.from,
          isGroupChat: false,
          participantNames: [],
          chatName: null,
          service: message.service,
          incomingEffect: message.incomingEffect,
          authUserId,
          isOnboarding: true,
          onboardingContext,
          timezone: userTimezone,
        };

        // Wedge detection for messages 3+
        if (!isSecondMessage && nestUser.onboardCount >= 2) {
          const detectedWedge = detectWedgeFromMessage(message.text);
          if (detectedWedge) {
            fireAndForget(emitOnboardingEvent({
              handle: message.from,
              chatId: message.chatId,
              eventType: 'new_user_first_value_wedge_selected',
              messageTurnIndex: nestUser.onboardCount + 1,
              valueWedge: detectedWedge,
              currentState: nestUser.onboardState,
            }));

            fireAndForget(transitionOnboardState({
              handle: message.from,
              newState: 'first_value_delivered',
              firstValueDelivered: true,
              capabilityCategory: detectedWedge,
            }));
          }
        }

        const result = await handleTurn(turnInput);

        // Onboarding state machine events
        await emitOnboardingEvents(message, nestUser, result);

        // Update onboard state
        const historyText = result.text
          ? splitBubbles(result.text).join(' ')
          : '';
        const updatedMessages = [
          ...nestUser.onboardMessages,
          { role: 'user', content: message.text },
          { role: 'assistant', content: historyText },
        ];
        await updateOnboardState(message.from, updatedMessages, nestUser.onboardCount + 1);

        // Deliver response
        await deliverResponse(message, result);
      } catch (e) {
        console.error('[pipeline] onboarding failed, sending fallback:', e instanceof Error ? e.message : e);
        const onboardUrl = `https://nest.expert/?token=${nestUser.onboardingToken}`;
        const fallback = `Hey, I'm Nest. Quick verification and then we're off.\n${onboardUrl}`;
        const handle = await pSendMessage(message, fallback);
        fireAndForget(logOutboundMessage(message.chatId, 'text', { text: fallback }, 'sent', handle));
      }

      if (eventId) fireAndForget(markWebhookEventStatus(eventId, 'completed'));
      return;
    }

    if (nestUser.lastProactiveSentAt) {
      isProactiveReply = true;
      fireAndForget(markProactiveReplied(message.from));
    }
  }

  // ─── Group chat action classification ────────────────────────────────────
  if (message.isGroupChat && message.audio.length === 0 && message.images.length === 0) {
    const { action, reaction: quickReaction } = await getGroupChatAction(message.text, message.from, message.chatId);

    if (action === 'ignore') {
      if (eventId) fireAndForget(markWebhookEventStatus(eventId, 'completed'));
      return;
    }

    if (action === 'react' && quickReaction) {
      await pSendReaction(message, quickReaction);
      await addMessage(message.chatId, 'user', message.text, message.from, {
        isGroupChat: true,
        chatName: message.chatName,
        participantNames: message.participantNames,
        service: message.service,
      });
      const reactionDisplay = quickReaction.type === 'custom' ? quickReaction.emoji : quickReaction.type;
      await addMessage(message.chatId, 'assistant', `[reacted with ${reactionDisplay}]`);
      fireAndForget(logOutboundMessage(message.chatId, 'reaction', { reaction: reactionDisplay, message_id: message.messageId }, 'sent', message.messageId));
      if (eventId) fireAndForget(markWebhookEventStatus(eventId, 'completed'));
      return;
    }
  }

  // ─── Active user flow — through the orchestrator ─────────────────────────
  const turnInput: TurnInput = {
    chatId: message.chatId,
    userMessage: message.text,
    images: message.images,
    audio: message.audio,
    senderHandle: message.from,
    isGroupChat: message.isGroupChat,
    participantNames: message.participantNames,
    chatName: message.chatName,
    service: message.service,
    incomingEffect: message.incomingEffect,
    authUserId,
    isOnboarding: false,
    isProactiveReply,
    timezone: userTimezone,
  };

  const result = await handleTurn(turnInput);

  await deliverResponse(message, result);

  if (eventId) fireAndForget(markWebhookEventStatus(eventId, 'completed'));
}
