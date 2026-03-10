import { chat, generateImage, getGroupChatAction, getTextForEffect } from './claude.ts';
import { logOutboundMessage, markWebhookEventStatus, getUserProfile, addMessage, ensureNestUser, updateOnboardState } from './state.ts';
import type { WebhookEventRow } from './state.ts';
import { markAsRead, sendMessage, sendReaction, startTyping } from './sendblue.ts';
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
      await Promise.all([markAsRead(message.conversation), startTyping(message.conversation)]);

      const onboardUrl = `https://nest.expert/?token=${nestUser.onboardingToken}`;

      try {
        const { response, pdlProfile } = await onboardChat(nestUser, message.text, onboardUrl);
        const updatedMessages = [
          ...nestUser.onboardMessages,
          { role: 'user', content: message.text },
          { role: 'assistant', content: response },
        ];
        await updateOnboardState(message.from, updatedMessages, nestUser.onboardCount + 1, pdlProfile ?? undefined);

        const sent = await sendMessage(message.conversation, response);
        fireAndForget(logOutboundMessage(message.chatId, 'text', { text: response }, 'sent', sent.message_handle ?? null));
      } catch (e) {
        console.error('[pipeline] onboarding failed, sending fallback:', e instanceof Error ? e.message : e);
        const fallback = `Hey, I'm Nest. Quick verification and then we're off.\n${onboardUrl}`;
        const sent = await sendMessage(message.conversation, fallback);
        fireAndForget(logOutboundMessage(message.chatId, 'text', { text: fallback }, 'sent', sent.message_handle ?? null));
      }

      if (eventId) fireAndForget(markWebhookEventStatus(eventId, 'completed'));
      return;
    }
  }

  const [, , senderProfile] = await Promise.all([
    markAsRead(message.conversation),
    startTyping(message.conversation),
    getUserProfile(message.from),
  ]);

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
