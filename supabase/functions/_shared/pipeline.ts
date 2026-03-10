import { chat, generateImage, getGroupChatAction, getTextForEffect } from './claude.ts';
import {
  logOutboundMessage,
  markWebhookEventStatus,
  getUserProfile,
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
} from './state.ts';
import type { WebhookEventRow } from './state.ts';
import { sendMessage, sendReaction, startTyping } from './sendblue.ts';
import type { NormalisedIncomingMessage } from './sendblue.ts';
import { onboardChat } from './onboard.ts';


function cleanResponse(text: string): string {
  return text
    .replace(/\n\s*-\s*/g, ' - ')
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(?<!\n)\n(?!\n)/g, ' ')
    .replace(/  +/g, ' ')
    .trim();
}

function fireAndForget(promise: Promise<unknown>): void {
  promise.catch((err) => console.warn('[pipeline] fire-and-forget error:', err));
}

export async function processWebhookEvent(event: WebhookEventRow): Promise<void> {
  return processMessage(event.normalized_payload, event.id);
}

export async function processMessage(message: NormalisedIncomingMessage, eventId?: number): Promise<void> {
  if (eventId) fireAndForget(markWebhookEventStatus(eventId, 'processing'));

  if (!message.isGroupChat) {
    const nestUser = await ensureNestUser(message.from, message.conversation.fromNumber);

    if (nestUser.status !== 'active') {

      const onboardUrl = `https://nest.expert/?token=${nestUser.onboardingToken}`;
      const isFirstMessage = nestUser.onboardCount === 0;

      try {
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

        const { response, reaction, rememberedUser, pdlProfile, classification, detectedWedge } =
          await onboardChat(nestUser, message.text, onboardUrl, experimentVariants);

        if (rememberedUser) {
          if (rememberedUser.name) fireAndForget(setUserName(message.from, rememberedUser.name));
          if (rememberedUser.fact) fireAndForget(addUserFact(message.from, rememberedUser.fact));

          if (rememberedUser.name) {
            fireAndForget(emitOnboardingEvent({
              handle: message.from,
              chatId: message.chatId,
              eventType: 'new_user_name_captured',
              messageTurnIndex: nestUser.onboardCount + 1,
              currentState: nestUser.onboardState,
            }));
          }
        }

        if (classification) {
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

        if (reaction) {
          await sendReaction(message.messageId, message.conversation.fromNumber, reaction);
          fireAndForget(logOutboundMessage(message.chatId, 'reaction', { reaction: reaction.type, message_id: message.messageId }, 'sent', message.messageId));
        }

        const historyText = response.split('---').map((p) => p.trim()).filter(Boolean).join(' ');
        const updatedMessages = [
          ...nestUser.onboardMessages,
          { role: 'user', content: message.text },
          { role: 'assistant', content: historyText },
        ];
        await updateOnboardState(message.from, updatedMessages, nestUser.onboardCount + 1, pdlProfile as Record<string, unknown> | null | undefined);

        const bubbles = response.split('---').map((part) => cleanResponse(part)).filter(Boolean);
        for (let i = 0; i < bubbles.length; i++) {
          if (i > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
          const sent = await sendMessage(message.conversation, bubbles[i]);
          fireAndForget(logOutboundMessage(message.chatId, 'text', { text: bubbles[i] }, 'sent', sent.message_handle ?? null));
        }
      } catch (e) {
        console.error('[pipeline] onboarding failed, sending fallback:', e instanceof Error ? e.message : e);
        const fallback = `Hey, I'm Nest. Quick verification and then we're off.\n${onboardUrl}`;
        const sent = await sendMessage(message.conversation, fallback);
        fireAndForget(logOutboundMessage(message.chatId, 'text', { text: fallback }, 'sent', sent.message_handle ?? null));
      }

      if (eventId) fireAndForget(markWebhookEventStatus(eventId, 'completed'));
      return;
    }

    if (nestUser.lastProactiveSentAt) {
      fireAndForget(markProactiveReplied(message.from));
    }
  }

  const senderProfile = await getUserProfile(message.from);

  const isGroupChat = message.isGroupChat;
  const participantNames = message.participantNames;

  if (isGroupChat && message.audio.length === 0 && message.images.length === 0) {
    const { action, reaction: quickReaction } = await getGroupChatAction(message.text, message.from, message.chatId);

    if (action === 'ignore') {
      if (eventId) fireAndForget(markWebhookEventStatus(eventId, 'completed'));
      return;
    }

    if (action === 'react' && quickReaction) {
      await sendReaction(message.messageId, message.conversation.fromNumber, quickReaction);
      await addMessage(message.chatId, 'user', message.text, message.from, {
        isGroupChat,
        chatName: message.chatName,
        participantNames,
        service: message.service,
      });
      const reactionDisplay = quickReaction.type === 'custom' ? quickReaction.emoji : quickReaction.type;
      await addMessage(message.chatId, 'assistant', `[reacted with ${reactionDisplay}]`);
      fireAndForget(logOutboundMessage(message.chatId, 'reaction', { reaction: reactionDisplay, message_id: message.messageId }, 'sent', message.messageId));
      if (eventId) fireAndForget(markWebhookEventStatus(eventId, 'completed'));
      return;
    }
  }

  const { text: responseText, reaction, effect, rememberedUser, generatedImage } = await chat(
    message.chatId,
    message.text,
    message.images,
    message.audio,
    {
      isGroupChat,
      participantNames,
      chatName: message.chatName,
      incomingEffect: message.incomingEffect,
      senderHandle: message.from,
      senderProfile,
      service: message.service,
    },
  );

  if (reaction) {
    const reactionDisplay = reaction.type === 'custom' ? reaction.emoji : reaction.type;
    await sendReaction(message.messageId, message.conversation.fromNumber, reaction);
    fireAndForget(logOutboundMessage(message.chatId, 'reaction', { reaction: reactionDisplay, message_id: message.messageId }, 'sent', message.messageId));
  }

  let finalText = responseText;
  if (!finalText && effect) {
    finalText = await getTextForEffect(effect.name);
  }

  if (!finalText && rememberedUser) {
    console.log('[pipeline] remembered user without direct text response');
  }

  if (finalText || generatedImage) {
    const messages = finalText ? finalText.split('---').map((part) => cleanResponse(part)).filter(Boolean) : [];

    if (messages.length > 0) {
      for (let index = 0; index < messages.length; index += 1) {
        if (index > 0) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        const isLastMessage = index === messages.length - 1;
        const messageEffect = isLastMessage && !generatedImage ? effect ?? undefined : undefined;
        const response = await sendMessage(message.conversation, messages[index], messageEffect);
        fireAndForget(logOutboundMessage(
          message.chatId,
          'text',
          { text: messages[index], effect: messageEffect ?? null },
          'sent',
          response.message_handle ?? null,
        ));
      }
    }

    if (generatedImage) {
      await startTyping(message.conversation);
      const imageUrl = await generateImage(generatedImage.prompt);
      if (imageUrl) {
        const response = await sendMessage(message.conversation, '', effect ?? undefined, [{ url: imageUrl }]);
        fireAndForget(addMessage(message.chatId, 'assistant', `[generated an image: ${generatedImage.prompt.substring(0, 50)}...]`));
        fireAndForget(logOutboundMessage(
          message.chatId,
          'image',
          { prompt: generatedImage.prompt, image_url: imageUrl },
          'sent',
          response.message_handle ?? null,
        ));
      } else {
        const response = await sendMessage(message.conversation, 'sorry the image didnt work, try again?');
        fireAndForget(logOutboundMessage(
          message.chatId,
          'text',
          { text: 'sorry the image didnt work, try again?' },
          'sent',
          response.message_handle ?? null,
        ));
      }
    }
  }

  if (eventId) fireAndForget(markWebhookEventStatus(eventId, 'completed'));
}
