import 'dotenv/config';
import path from 'node:path';
import express from 'express';

/** Static assets; server is expected to run with cwd at the app root (local dev and Docker WORKDIR). */
const publicDir = path.join(process.cwd(), 'public');
import { verifySupabaseSetup, getSupabase } from './lib/supabase.js';
import { createWebhookHandler } from './webhook/handler.js';
// Local dev messaging stubs — production uses LINQ edge functions
const sendMessage = async (..._args: unknown[]) => { console.warn('[local-dev] sendMessage is a no-op — use LINQ in production'); };
const markAsRead = async (..._args: unknown[]) => {};
const startTyping = async (..._args: unknown[]) => {};
const sendReaction = async (..._args: unknown[]) => {};
import { chat, getGroupChatAction, getTextForEffect, generateImage } from './claude-local-dev/client.js';
import { getUserProfile, addMessage } from './state/conversation.js';
import { debugDashboardHtml } from './debug/dashboard.js';
import { comparePageHtml } from './debug/compare.js';
import { automationsDashboardHtml } from './debug/automations.js';
import { morningBriefDashboardHtml } from './debug/morning-brief.js';
import { handleMorningBriefRun } from './debug/morning-brief-api.js';
import { getAdminPanelHtml } from './debug/admin-panel.js';
import { activityDashboardHtml } from './debug/activity-dashboard.js';
import { usersDashboardHtml } from './debug/users-dashboard.js';
import { retentionDashboardHtml } from './debug/retention-dashboard.js';
import { messagesDashboardHtml } from './debug/messages-dashboard.js';
import { brandsAdminHtml } from './debug/brands-dashboard.js';
import { costsDashboardHtml } from './debug/costs-dashboard.js';
import { systemPromptEditorHtml } from './debug/system-prompt-editor.js';
import { handleAdminBrands } from './debug/admin-brands-api.js';
import { handleAdminMomentsV2 } from './debug/admin-moments-v2-api.js';
import {
  handleActivitySummary,
  handleAdminUsersList,
  handleAdminUserDetail,
  handleUserVerificationStats,
} from './debug/admin-insights-api.js';
import { handleAdminUserPatch, handleAdminUserDelete } from './debug/admin-user-mutations.js';
import { handleRetentionMetrics } from './debug/admin-retention-api.js';
import {
  handleCostsSummary,
  handleCostsDaily,
  handleCostsByProvider,
  handleCostsByMessageType,
  handleCostsLogs,
  handleCostsByModel,
  handleCostsByAgent,
  handleCostsBySender,
} from './debug/admin-costs-api.js';
import { handleMessagesChatsList, handleMessagesConversation } from './debug/admin-messages-api.js';
import {
  handleCompareChat,
  handleCompareClear,
  handleCompareGetPrompt,
  handleCompareUsers,
  handleCompareUserContext,
} from './compare/api.js';
import { handleCompareRefinePrompt } from './compare/compare-refine-prompt.js';
import { handleGetChatSystemPromptFile, handlePostChatSystemPromptFile } from './compare/system-prompt-file-api.js';
import { handleOnboardNew, handleOnboardChat, handleOnboardState, handleOnboardAgentChat } from './compare/onboard-api.js';
import { handleAutomationUsers, handleAutomationHistory, handleAutomationUserDetail, handleAutomationTrigger, handleAutomationEligibility } from './automations/api.js';
import { handleListMoments, handleCreateMoment, handleUpdateMoment, handleActivateMoment, handlePauseMoment, handleArchiveMoment, handleDuplicateMoment, handleGetExecutions, handleAudiencePreview, handleManualTrigger as handleMomentManualTrigger, handleGetGlobalConfig, handleUpdateGlobalConfig, handleGetStats, handleGetVersions } from './moments/api.js';
import { getNestWebsiteOrigin } from './lib/nest-website-origin.js';

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

const SEPARATOR_RE = /\n---\n|\n---$|^---\n|\s+---\s+|\s+---$|^---\s+/;
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

const NEST_WEBSITE_ORIGIN = getNestWebsiteOrigin();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(publicDir));

// Parse JSON bodies (generous limit for admin system prompt saves)
app.use(express.json({ limit: '5mb' }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Admin shell (sidebar + Compare / Debug / Automations)
app.get('/admin', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getAdminPanelHtml());
});

app.get('/admin/system-prompt', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(systemPromptEditorHtml);
});

app.get('/admin/api/chat-system-prompt-file', handleGetChatSystemPromptFile);
app.post('/admin/api/chat-system-prompt-file', handlePostChatSystemPromptFile);

// Debug dashboard
app.get('/debug', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(debugDashboardHtml);
});

// Model comparison page
app.get('/compare', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(comparePageHtml);
});

// Automation dashboard
app.get('/automations', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(automationsDashboardHtml);
});

app.get('/morning-brief', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(morningBriefDashboardHtml);
});

app.post('/morning-brief/api/run', handleMorningBriefRun);

// Admin activity + user directory (also linked from /admin shell)
app.get('/activity', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(activityDashboardHtml);
});

app.get('/users', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(usersDashboardHtml);
});

app.get('/messages', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(messagesDashboardHtml);
});

app.get('/retention', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(retentionDashboardHtml);
});

app.get('/costs', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(costsDashboardHtml);
});

// Costs API endpoints
app.get('/costs/api/summary', handleCostsSummary);
app.get('/costs/api/daily', handleCostsDaily);
app.get('/costs/api/by-provider', handleCostsByProvider);
app.get('/costs/api/by-message-type', handleCostsByMessageType);
app.get('/costs/api/by-model', handleCostsByModel);
app.get('/costs/api/by-agent', handleCostsByAgent);
app.get('/costs/api/by-sender', handleCostsBySender);
app.get('/costs/api/logs', handleCostsLogs);

app.get('/admin/brands', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(brandsAdminHtml);
});

app.get('/admin/moment-v2', (_req, res) => {
  res.redirect(302, `${NEST_WEBSITE_ORIGIN}/admin/moment-v2`);
});

// Automation API endpoints
app.get('/automations/api/users', handleAutomationUsers);
app.get('/automations/api/history', handleAutomationHistory);
app.get('/automations/api/user-detail', handleAutomationUserDetail);
app.post('/automations/api/trigger', handleAutomationTrigger);
app.get('/automations/api/eligibility', handleAutomationEligibility);

// Moments admin API endpoints
app.get('/api/admin-moments/global-config', handleGetGlobalConfig);
app.patch('/api/admin-moments/global-config', handleUpdateGlobalConfig);
app.get('/api/admin-moments/stats', handleGetStats);
app.get('/api/admin-moments', handleListMoments);
app.post('/api/admin-moments', handleCreateMoment);
app.patch('/api/admin-moments/:id', handleUpdateMoment);
app.post('/api/admin-moments/:id/activate', handleActivateMoment);
app.post('/api/admin-moments/:id/pause', handlePauseMoment);
app.post('/api/admin-moments/:id/archive', handleArchiveMoment);
app.post('/api/admin-moments/:id/duplicate', handleDuplicateMoment);
app.get('/api/admin-moments/:id/executions', handleGetExecutions);
app.get('/api/admin-moments/:id/audience-preview', handleAudiencePreview);
app.post('/api/admin-moments/:id/manual-trigger', handleMomentManualTrigger);
app.get('/api/admin-moments/:id/versions', handleGetVersions);

app.all('/api/admin-moments-v2', handleAdminMomentsV2);

app.post('/compare/api/chat', handleCompareChat);
app.post('/compare/api/clear', handleCompareClear);
app.get('/compare/api/prompt', handleCompareGetPrompt);
app.get('/compare/api/users', handleCompareUsers);
app.get('/compare/api/user-context', handleCompareUserContext);
app.post('/compare/api/refine-prompt', handleCompareRefinePrompt);

// Onboarding test endpoints
app.post('/compare/api/onboard/new', handleOnboardNew);
app.post('/compare/api/onboard/chat', handleOnboardChat);
app.post('/compare/api/onboard/agent-chat', handleOnboardAgentChat);
app.get('/compare/api/onboard/state', handleOnboardState);

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

app.get('/debug/api/activity-summary', handleActivitySummary);
app.get('/debug/api/retention-metrics', handleRetentionMetrics);
app.get('/debug/api/user-verification-stats', handleUserVerificationStats);
app.get('/debug/api/admin-users', handleAdminUsersList);
app.get('/debug/api/admin-user-detail', handleAdminUserDetail);

app.get('/messages/api/chats', handleMessagesChatsList);
app.get('/messages/api/conversation', handleMessagesConversation);
app.all('/api/admin-brands', (req, res) => {
  void handleAdminBrands(req, res);
});
app.patch('/debug/api/admin-user', handleAdminUserPatch);
app.delete('/debug/api/admin-user', handleAdminUserDelete);

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

// Webhook endpoint (local dev)
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
      const messages = finalText ? splitBubbles(finalText).map(m => cleanResponse(m)).filter(m => m.length > 0) : [];

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
║          Nest Local Dev Server                        ║
╠═══════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}              ║
║                                                       ║
║  Endpoints:                                           ║
║    POST /webhook      - Webhook receiver (local dev)  ║
║    GET  /health       - Health check                  ║
║    GET  /admin        - Admin panel (all tools)        ║
║    GET  /admin/system-prompt - Edit chat prompt file   ║
║    GET  /debug        - Decision tree inspector        ║
║    GET  /compare      - Model comparison tool          ║
║    GET  /automations  - Automation dashboard           ║
║    GET  /morning-brief - Morning audio brief (admin)   ║
║    GET  /activity     - Activity overview              ║
║    GET  /messages     - User↔Nest conversation viewer ║
║    GET  /users        - User directory + profiles      ║
║    GET  /retention    - Retention & frequency charts   ║
║    GET  /admin/brands - Brand config & onboarding      ║
║    GET  /admin/moment-v2 → website Moment V2 admin    ║
╚═══════════════════════════════════════════════════════╝
  `);
});
