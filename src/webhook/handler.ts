import { Request, Response } from 'express';
import {
  SendblueWebhookEvent,
  NormalisedIncomingMessage,
  isInboundReceiveWebhook,
  normaliseIncomingMessage,
} from './types.js';

export interface MessageHandler {
  (message: NormalisedIncomingMessage): Promise<void>;
}

export function createWebhookHandler(onMessage: MessageHandler) {
  const botNumbers = (process.env.LINQ_AGENT_BOT_NUMBERS || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
  const ignoredSenders = process.env.IGNORED_SENDERS?.split(',').map(p => p.trim()).filter(Boolean) || [];
  const allowedSenders = process.env.ALLOWED_SENDERS?.split(',').map(p => p.trim()).filter(Boolean) || [];
  const webhookSecret = process.env.LINQ_WEBHOOK_SECRET;
  const webhookSecretHeader = (process.env.LINQ_WEBHOOK_SECRET_HEADER || 'x-webhook-secret').toLowerCase();
  const processedMessages = new Map<string, number>();

  function pruneProcessedMessages() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [messageId, timestamp] of processedMessages.entries()) {
      if (timestamp < cutoff) {
        processedMessages.delete(messageId);
      }
    }
  }

  return async (req: Request, res: Response) => {
    if (webhookSecret) {
      const providedSecret = req.header(webhookSecretHeader);
      if (providedSecret !== webhookSecret) {
        console.warn('[webhook] Invalid webhook secret');
        res.status(401).json({ error: 'invalid webhook secret' });
        return;
      }
    }

    const event = req.body as SendblueWebhookEvent;
    const messageId = event.message_handle || 'unknown';
    console.log(`[webhook] Incoming payload ${messageId}`);

    res.status(200).json({ received: true });

    if (!isInboundReceiveWebhook(event)) {
      console.log('[webhook] Ignoring non-inbound event');
      return;
    }

    if (process.env.NODE_ENV !== 'production') {
      console.log('[webhook] Full payload:', JSON.stringify(event, null, 2));
    }

    pruneProcessedMessages();
    if (processedMessages.has(messageId)) {
      console.log(`[webhook] Duplicate message skipped: ${messageId}`);
      return;
    }

    const message = normaliseIncomingMessage(event);
    if (!message) {
      console.log('[webhook] Failed to normalise incoming message');
      return;
    }

    if (botNumbers.length > 0 && !botNumbers.includes(message.conversation.fromNumber)) {
      console.log(`[webhook] Skipping message to ${message.conversation.fromNumber} (not this bot's number)`);
      return;
    }

    if (allowedSenders.length > 0 && !allowedSenders.includes(message.from)) {
      console.log(`[webhook] Skipping ${message.from} (not in allowed senders)`);
      return;
    }

    if (ignoredSenders.includes(message.from)) {
      console.log(`[webhook] Skipping ${message.from} (ignored sender)`);
      return;
    }

    if (!message.text.trim() && message.images.length === 0 && message.audio.length === 0) {
      console.log('[webhook] Skipping empty message');
      return;
    }

    processedMessages.set(message.messageId, Date.now());

    const effectInfo = message.incomingEffect ? ` [effect: ${message.incomingEffect.type}/${message.incomingEffect.name}]` : '';
    const mediaInfo = [
      message.images.length > 0 ? `${message.images.length} image(s)` : '',
      message.audio.length > 0 ? `${message.audio.length} audio` : '',
    ].filter(Boolean).join(', ');
    console.log(`[webhook] Message from ${message.from}: "${message.text.substring(0, 50)}..."${mediaInfo ? ` [${mediaInfo}]` : ''}${effectInfo}`);

    try {
      await onMessage(message);
    } catch (error) {
      console.error('[webhook] Error handling message:', error);
    }
  };
}
