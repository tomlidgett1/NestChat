import 'dotenv/config';
import express from 'express';
import { verifySupabaseSetup, getSupabase } from './lib/supabase.js';
import { createWebhookHandler } from './webhook/handler.js';
import { sendMessage, markAsRead, startTyping, sendReaction } from './sendblue/client.js';
import { chat, getGroupChatAction, getTextForEffect, generateImage } from './claude-local-dev/client.js';
import { getUserProfile, addMessage } from './state/conversation.js';
import { debugDashboardHtml } from './debug/dashboard.js';

// Clean up LLM response formatting quirks before sending
function cleanResponse(text: string): string {
  return text
    // Turn newline-dash into inline dash (e.g., "foo\n - bar" → "foo - bar")
    .replace(/\n\s*-\s*/g, ' - ')
    // Remove markdown underlines/italics (_text_ → text)
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    // Remove markdown bold (**text** → text)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // Remove stray asterisks used for emphasis
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1')
    // Clean up multiple spaces
    .replace(/  +/g, ' ')
    // Clean up extra newlines (but preserve intentional double-newlines for --- splits)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON bodies
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Debug dashboard
app.get('/debug', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(debugDashboardHtml);
});

app.get('/debug/api/traces', async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 100;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('turn_traces')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/debug/api/trace/:id', async (req, res) => {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('turn_traces')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/debug/api/thread/:chatId', async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 40;
  const before = req.query.before as string | undefined;
  const supabase = getSupabase();

  let query = supabase
    .from('conversation_messages')
    .select('role, content, handle, metadata, created_at')
    .eq('chat_id', req.params.chatId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (before) {
    query = query.lt('created_at', before);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).reverse());
});

// Webhook endpoint for Sendblue
app.post(
  '/webhook',
  createWebhookHandler(async (message) => {
    const start = Date.now();
    console.log(`[main] Processing message from ${message.from}`);

    const [, , senderProfile] = await Promise.all([
      markAsRead(message.conversation),
      startTyping(message.conversation),
      getUserProfile(message.from),
    ]);
    console.log(`[timing] markAsRead+startTyping+getProfile: ${Date.now() - start}ms`);
    if (senderProfile?.name) {
      console.log(`[main] Known user: ${senderProfile.name} (${senderProfile.facts.length} facts)`);
    }

    const isGroupChat = message.isGroupChat;
    const participantNames = message.participantNames;

    // In group chats, check if Claude should respond, react, or ignore
    // Always respond to voice memos/images - someone sending media is clearly trying to communicate
    if (isGroupChat && message.audio.length === 0 && message.images.length === 0) {
      const { action, reaction: quickReaction } = await getGroupChatAction(message.text, message.from, message.chatId);

      if (action === 'ignore') {
        console.log(`[main] Ignoring group chat message`);
        return;
      }

      if (action === 'react') {
        // Just send a reaction, no full response needed
        if (quickReaction) {
          await sendReaction(message.messageId, message.conversation.fromNumber, quickReaction);
          console.log(`[timing] quick reaction: ${Date.now() - start}ms`);

          // Save to conversation history so Claude knows what happened (include sender for group chats)
          await addMessage(message.chatId, 'user', message.text, message.from);
          const reactionDisplay = quickReaction.type === 'custom' ? (quickReaction as { type: 'custom'; emoji: string }).emoji : quickReaction.type;
          await addMessage(message.chatId, 'assistant', `[reacted with ${reactionDisplay}]`);

          console.log(`[main] Reacted to ${message.from} with ${reactionDisplay}`);
        }
        return;
      }

      console.log(`[main] Claude should respond to this group message`);
    } else if (isGroupChat) {
      console.log(`[main] Responding to group media (skipping classifier)`);
    }

    // Get Claude's response (typing indicator shows while this runs)
    const { text: responseText, reaction, effect, rememberedUser, generatedImage } = await chat(message.chatId, message.text, message.images, message.audio, {
      isGroupChat,
      participantNames,
      chatName: message.chatName,
      incomingEffect: message.incomingEffect,
      senderHandle: message.from,
      senderProfile,
      service: message.service,
    });
    console.log(`[timing] claude: ${Date.now() - start}ms`);
    console.log(`[debug] responseText: ${responseText ? `"${responseText.substring(0, 50)}..."` : 'null'}, effect: ${effect ? JSON.stringify(effect) : 'null'}, generatedImage: ${generatedImage ? 'yes' : 'null'}`);

    // Send reaction if Claude wants to
    if (reaction) {
      await sendReaction(message.messageId, message.conversation.fromNumber, reaction);
      console.log(`[timing] reaction: ${Date.now() - start}ms`);
    }

    // Send text response if there is one (with optional effect)
    // If Claude chose an effect but no text, get text from Haiku
    let finalText = responseText;
    if (!finalText && effect) {
      console.log(`[main] Claude sent effect without text, getting message from Haiku...`);
      finalText = await getTextForEffect(effect.name);
      console.log(`[timing] effect text followup: ${Date.now() - start}ms`);
    }

    // If Claude used remember_user without text, just log it - no automatic acknowledgments
    // Claude should write its own response if it wants to acknowledge learning something
    if (!finalText && rememberedUser) {
      console.log(`[main] Claude saved user info without text response (no auto-ack)`);
    }

    if (finalText || generatedImage) {
      // Split into multiple messages first, then clean each one
      // (must split before cleaning, or the --- delimiter gets mangled)
      const messages = finalText ? finalText.split('---').map(m => cleanResponse(m)).filter(m => m.length > 0) : [];

      // Send text messages first (before generating image)
      if (messages.length > 0) {
        for (let i = 0; i < messages.length; i++) {
          const isLastMessage = i === messages.length - 1;
          // Only apply effect to the last text message (if no image coming)
          const messageEffect = (isLastMessage && !generatedImage) ? effect ?? undefined : undefined;
          await sendMessage(message.conversation, messages[i], messageEffect);

          // Add a natural delay between messages (except after the last one)
          if (!isLastMessage) {
            const delay = 400 + Math.random() * 400; // 400-800ms feels natural
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
        console.log(`[timing] sendMessage (${messages.length} text msg${messages.length !== 1 ? 's' : ''}): ${Date.now() - start}ms`);
      }

      // Now generate and send image if requested
      if (generatedImage) {
        // Show typing indicator while generating (takes ~15 seconds)
        await startTyping(message.conversation);
        console.log(`[main] Generating image after sending text...`);
        const imageUrl = await generateImage(generatedImage.prompt);
        if (imageUrl) {
          // Small delay before sending image
          await new Promise(resolve => setTimeout(resolve, 300));
          await sendMessage(message.conversation, '', effect ?? undefined, [{ url: imageUrl }]);
          // Save to conversation history
          await addMessage(message.chatId, 'assistant', `[generated an image: ${generatedImage.prompt.substring(0, 50)}...]`);
          console.log(`[timing] generateImage + sendImage: ${Date.now() - start}ms`);
        } else {
          // Image generation failed - let user know
          await sendMessage(message.conversation, 'sorry the image didnt work, try again?');
          console.log(`[main] Image generation failed`);
        }
      }

      const extras = [effect && 'effect', generatedImage && 'image'].filter(Boolean).join(', ');
      console.log(`[timing] total: ${Date.now() - start}ms (${extras || 'text only'})`);
    } else if (reaction) {
      // Reaction-only response - already saved to conversation history by chat()
      console.log(`[main] Reaction-only response (saved to history for context)`);
    }

    console.log(`[main] Reply sent to ${message.from}`);
  })
);

// Start server
app.listen(PORT, () => {
  void verifySupabaseSetup();
  console.log(`
╔═══════════════════════════════════════════════════════╗
║          Sendblue <-> Claude Bridge                   ║
╠═══════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}              ║
║                                                       ║
║  Endpoints:                                           ║
║    POST /webhook  - Sendblue webhook receiver         ║
║    GET  /health   - Health check                      ║
║    GET  /debug    - Decision tree inspector            ║
║                                                       ║
║  Next steps:                                          ║
║    1. Run: ngrok http ${PORT}                            ║
║    2. Configure webhook URL in Sendblue               ║
║    3. Text your Sendblue number!                      ║
╚═══════════════════════════════════════════════════════╝
  `);
});
