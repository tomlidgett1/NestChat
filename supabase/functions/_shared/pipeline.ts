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
  updateUserTimezone,
  getConversation,
  reportBug,
} from './state.ts';
import type { WebhookEventRow } from './state.ts';
import * as linqApi from './linq.ts';
import type { NormalisedIncomingMessage, Reaction, MessageEffect, MediaAttachment } from './linq.ts';
import { MEMORY_V2_ENABLED } from './env.ts';
import type { ValueWedge } from './state.ts';
import { parseHeyBrand, activateBrandSession, getBrandSession, deactivateBrandSession } from './brand-sessions.ts';
import { isBrandKeyword } from './brand-registry.ts';
import { handleBrandChat } from './brand-chat-handler.ts';
import { fetchCalendarTimezone, fetchOutlookTimezone } from './calendar-helpers.ts';
import { resolveToken } from './gmail-helpers.ts';
import { syncGroupFromLinq, recordGroupActivity, detectGroupVibe, updateGroupVibe } from './group.ts';
import type { GroupContext } from './group.ts';

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

function uppercaseFirst(s: string): string {
  if (!s) return s;
  const i = s.search(/[a-zA-Z]/);
  if (i < 0) return s;
  return s.slice(0, i) + s[i].toUpperCase() + s.slice(i + 1);
}

function cleanResponse(text: string): string {
  const cleaned = text
    .replace(/<cite[^>]*>|<\/cite>/g, '')
    .replace(/\*\*(.+?)\*\*/g, (_m, p1) => toUnicodeBold(p1))
    .replace(/\u2014/g, '-')
    .replace(/\u2013/g, '-')
    .replace(/\n[ \t]+\n/g, '\n\n')
    .replace(/\n([,.:;!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/  +/g, ' ')
    .trim();
  return uppercaseFirst(cleaned);
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

function enforceOnboardingVerificationBubble(
  text: string | null,
  onboardUrl: string,
  userTurnNumber: number,
  alreadySentVerification: boolean,
): string | null {
  if (alreadySentVerification) return text;

  // Inject verification link on the very first reply (turn 1) or turn 2 as fallback
  if (userTurnNumber > 2) return text;

  if (!text || !text.trim()) return onboardUrl;

  // Strip any verification link the model already included to avoid duplicates
  let cleaned = text.replace(/https:\/\/nest\.expert\/\?token=[a-f0-9-]+/gi, '').trim();
  cleaned = cleaned.replace(/\n---\s*\n?$/, '').replace(/\n{3,}/g, '\n\n').trim();

  if (!cleaned) return onboardUrl;

  return `${cleaned}\n---\n${onboardUrl}`;
}

function fireAndForget(promise: Promise<unknown>): void {
  promise.catch((err) => console.warn('[pipeline] fire-and-forget error:', err));
}

function isFormatTestRequest(text: string): boolean {
  return text.trim().toLowerCase() === 'format test';
}

async function handleFormatTestRequest(message: NormalisedIncomingMessage): Promise<void> {
  const bubbles = [
    [
      'Formatting test matrix for iMessage.',
      'Each line is a different render attempt.',
      '---',
      'Reply with what actually rendered on your phone.',
    ].join('\n'),
    [
      'ASTERISK / UNDERSCORE',
      '*italic*',
      '_italic_',
      '**bold**',
      '__bold__',
      '***bold italic***',
      '___bold italic___',
      '**_bold italic_**',
      '__*bold italic*__',
    ].join('\n'),
    [
      'ALT MARKUP',
      '~~strikethrough~~',
      '~strikethrough~',
      '++underline++',
      '__underline?__',
      '`inline code`',
      '```code block```',
      '||spoiler||',
    ].join('\n'),
    [
      'HTML STYLE ATTEMPTS',
      '<b>bold</b>',
      '<strong>strong</strong>',
      '<i>italic</i>',
      '<em>emphasis</em>',
      '<u>underline</u>',
      '<s>strike</s>',
      '<del>delete</del>',
    ].join('\n'),
    [
      'UNICODE STYLE ATTEMPTS',
      '𝐁𝐨𝐥𝐝 𝐮𝐧𝐢𝐜𝐨𝐝𝐞',
      '𝘪𝘵𝘢𝘭𝘪𝘤 𝘶𝘯𝘪𝘤𝘰𝘥𝘦',
      '𝘽𝙤𝙡𝙙 𝙞𝙩𝙖𝙡𝙞𝙘 𝙪𝙣𝙞𝙘𝙤𝙙𝙚',
      '𝖒𝖔𝖓𝖔𝖘𝖕𝖆𝖈𝖊 𝖘𝖙𝖞𝖑𝖊',
      'S̲i̲n̲g̲l̲e̲ ̲u̲n̲d̲e̲r̲l̲i̲n̲e̲ ̲c̲o̲m̲b̲i̲n̲i̲n̲g̲',
      'S̶t̶r̶i̶k̶e̶ ̶c̶o̶m̶b̶i̶n̶i̶n̶g̶',
      'BIG ATTEMPT: ＢＩＧ  ＴＥＸＴ',
    ].join('\n'),
    [
      'UNICODE - EXTRA FONT FAMILIES',
      '𝗕𝗢𝗟𝗗 𝗦𝗔𝗡𝗦',
      '𝘉𝘰𝘭𝘥 𝘐𝘵𝘢𝘭𝘪𝘤 𝘚𝘢𝘯𝘴',
      '𝙼𝚘𝚗𝚘 𝚂𝚊𝚗𝚜 / 𝚃𝚢𝚙𝚎𝚠𝚛𝚒𝚝𝚎𝚛',
      '𝒮𝒸𝓇𝒾𝓅𝓉 𝓈𝓉𝓎𝓁𝑒',
      '𝓑𝓸𝓵𝓭 𝓼𝓬𝓻𝓲𝓹𝓽',
      '𝔽𝕦𝕝𝕝 𝕕𝕠𝕦𝕓𝕝𝕖-𝕤𝕥𝕣𝕦𝕔𝕜',
      '𝔊𝔬𝔱𝔥𝔦𝔠 𝔣𝔯𝔞𝔨𝔱𝔲𝔯',
      '𝕭𝖔𝖑𝖉 𝖋𝖗𝖆𝖐𝖙𝖚𝖗',
      '𝓈𝓂𝒶𝓁𝓁 𝒸𝒶𝓅𝓈 𝒶𝓉𝓉𝑒𝓂𝓅𝓉',
    ].join('\n'),
    [
      'UNICODE - SYMBOL/DECORATIVE',
      'Ⓒⓘⓡⓒⓛⓔⓓ ⓣⓔⓧⓣ',
      '🄱🄻🄾🄲🄺 🅃🄴🅇🅃',
      'Ⓢⓠⓤⓐⓡⓔⓓ ⓐⓛⓣ',
      '🅱🆄🅱🅱🅻🅴 🆂🆃🆈🅻🅴',
      'ₛᵤbₛcᵣᵢₚₜ ᵐᶦˣ',
      'ˢᵘᵖᵉʳˢᶜʳⁱᵖᵗ ᵐⁱˣ',
      '①②③ numbered symbols',
      '◆◇○● decorative separators ○●◇◆',
    ].join('\n'),
    [
      'UNICODE - COMBINING MARKS',
      'D̶o̶u̶b̶l̶e̶ ̶s̶t̶r̶i̶k̶e̶ ̶a̶t̶t̶e̶m̶p̶t̶',
      'D̳o̳u̳b̳l̳e̳ ̳u̳n̳d̳e̳r̳l̳i̳n̳e̳ ̳a̳t̳t̳e̳m̳p̳t̳',
      'O̅v̅e̅r̅l̅i̅n̅e̅ ̅a̅t̅t̅e̅m̅p̅t̅',
      'S̷l̷a̷s̷h̷ ̷o̷v̷e̷r̷l̷a̷y̷',
      'N̴o̴i̴s̴y̴ ̴g̴l̴i̴t̴c̴h̴ ̴m̴a̴r̴k̴s̴',
      'A͟l͟t͟ ͟u͟n͟d͟e͟r͟l͟i͟n͟e͟',
    ].join('\n'),
    [
      'UNICODE - SIZE / WIDTH TESTS',
      'Normal width text',
      'Ｆｕｌｌｗｉｄｔｈ ｔｅｘｔ',
      'H a i r s p a c e d',
      'WIDE    GAP    TEST',
      '〚bracketed unicode〛',
      '《angled unicode quotes》',
      '「CJK quote style」',
      '— em dash / – en dash / ‑ non-breaking hyphen',
    ].join('\n'),
  ];

  await addMessage(message.chatId, 'user', message.text, message.from, {
    isGroupChat: message.isGroupChat,
    chatName: message.chatName,
    participantNames: message.participantNames,
    service: message.service,
  });

  for (const bubble of bubbles) {
    const formattedBubble = cleanResponse(bubble);
    const handle = await pSendMessage(message, formattedBubble);
    fireAndForget(logOutboundMessage(
      message.chatId,
      'text',
      { text: formattedBubble },
      'sent',
      handle,
    ));
    await addMessage(message.chatId, 'assistant', formattedBubble);
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
}

function parseBugReport(text: string): { bugText: string; rawMessage: string } | null {
  const rawMessage = text.trim();
  const match = rawMessage.match(/^bug:\s*(.*)$/i);
  if (!match) return null;
  const bugText = (match[1] || '').trim() || '[no details provided]';
  return { bugText, rawMessage };
}

async function logBugReportIfNeeded(
  message: NormalisedIncomingMessage,
  authUserId: string | null,
): Promise<void> {
  const parsed = parseBugReport(message.text);
  if (!parsed) return;

  try {
    const priorMessages = await getConversation(message.chatId, 10);
    await reportBug({
      chatId: message.chatId,
      senderHandle: message.from,
      authUserId,
      provider: message.provider,
      service: message.service,
      messageText: parsed.rawMessage,
      bugText: parsed.bugText,
      priorMessages,
      metadata: {
        message_id: message.messageId,
        is_group_chat: message.isGroupChat,
        chat_name: message.chatName,
        participant_names: message.participantNames,
      },
    });
  } catch (err) {
    console.error('[pipeline] failed to log bug report:', err);
  }
}

// ─── Messaging wrappers (LINQ) ───────────────────────────────────────────────

async function pSendMessage(
  msg: NormalisedIncomingMessage,
  text: string,
  effect?: MessageEffect,
  media?: MediaAttachment[],
  replyToMessageId?: string,
): Promise<string | null> {
  const replyTo = replyToMessageId ? { message_id: replyToMessageId } : undefined;
  const resp = await linqApi.sendMessage(msg.chatId, text, effect, media?.map((m) => ({ url: m.url })), replyTo);
  return resp.message?.id ?? null;
}

async function pSendReaction(msg: NormalisedIncomingMessage, reaction: Reaction): Promise<void> {
  await linqApi.sendReaction(msg.messageId, reaction);
}

async function pStartTyping(msg: NormalisedIncomingMessage): Promise<void> {
  await linqApi.startTyping(msg.chatId);
}

// ─── Reply-to decision (deterministic, no LLM) ──────────────────────────────

async function shouldReplyTo(
  message: NormalisedIncomingMessage,
): Promise<string | undefined> {
  const recent = await getConversation(message.chatId, 6);

  if (message.isGroupChat) {
    // Thread only when multiple different people have spoken recently —
    // i.e. the chat is actively busy and attribution matters.
    const recentUserHandles = new Set(
      recent
        .filter((m) => m.role === 'user' && m.handle)
        .map((m) => m.handle),
    );
    if (recentUserHandles.size >= 2) return message.messageId;
    return undefined;
  }

  // 1:1 chats: thread when there's a burst of user messages in a row
  // (3+ consecutive user messages with no assistant reply between them).
  let consecutiveUser = 0;
  for (const m of recent.reverse()) {
    if (m.role === 'user') consecutiveUser++;
    else break;
  }
  if (consecutiveUser >= 3) return message.messageId;

  return undefined;
}

// ─── Delivery: split bubbles, send reactions, effects, images ────────────────

async function deliverResponse(
  message: NormalisedIncomingMessage,
  result: { text: string | null; reaction: Reaction | null; effect: MessageEffect | null; generatedImage: { url: string; prompt: string } | null },
  replyToMessageId?: string,
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
      const replyTo = i === 0 ? replyToMessageId : undefined;
      const handle = await pSendMessage(message, bubbles[i], messageEffect, undefined, replyTo);
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

  if (isFormatTestRequest(message.text)) {
    await handleFormatTestRequest(message);
    if (eventId) fireAndForget(markWebhookEventStatus(eventId, 'completed'));
    return;
  }

  // ─── "Hey [Brand]" interception ────────────────────────────────────────────
  const heyKeyword = parseHeyBrand(message.text);
  if (heyKeyword) {
    if (heyKeyword === 'nest') {
      const activeBrand = await getBrandSession(message.chatId);
      if (activeBrand) {
        await deactivateBrandSession(message.chatId);
        const text = "welcome back to nest";
        const handle = await pSendMessage(message, text);
        fireAndForget(logOutboundMessage(message.chatId, 'text', { text }, 'sent', handle));
        fireAndForget(addMessage(message.chatId, 'user', message.text, message.from));
        fireAndForget(addMessage(message.chatId, 'assistant', text));
        if (eventId) fireAndForget(markWebhookEventStatus(eventId, 'completed'));
        return;
      }
      // No active brand session — fall through to normal Nest processing
    }

    if (isBrandKeyword(heyKeyword)) {
      const session = await activateBrandSession(message.chatId, heyKeyword);
      if (session) {
        const activationMessages: Record<string, string> = {
          ash: 'Hey, welcome to Ashburton Cycles. What can we help you with today?',
          ipsec: 'Hey, welcome to IPSec. What can we help you with today?',
          ruby: "Hi, I'm Ruby. I'm the practice's messaging assistant (AI-enabled). Before we go further: are you safe right now?",
          raider: 'Hey, welcome to LaserRaiders. What can we help you with today?',
        };
        const text = activationMessages[session.brandKey] ?? `Hey, welcome to ${session.brand.name}. What can we help you with today?`;
        const handle = await pSendMessage(message, text);
        fireAndForget(logOutboundMessage(message.chatId, 'text', { text }, 'sent', handle));
        fireAndForget(addMessage(message.chatId, 'user', message.text, message.from));
        fireAndForget(addMessage(message.chatId, 'assistant', text));
        if (eventId) fireAndForget(markWebhookEventStatus(eventId, 'completed'));
        return;
      }
    }
  }

  // ─── Active brand session — bypass normal Nest flow ────────────────────────
  const brandSession = await getBrandSession(message.chatId);
  if (brandSession) {
    try {
      console.log(`[pipeline] brand session active: ${brandSession.brand.name} for ${message.chatId}`);
      const result = await handleBrandChat({
        chatId: message.chatId,
        senderHandle: message.from,
        brandKey: brandSession.brandKey,
        message: message.text,
        sessionStartedAt: new Date(brandSession.activatedAt).toISOString(),
      });

      await addMessage(message.chatId, 'user', message.text, message.from);
      await addMessage(message.chatId, 'assistant', result.text);

      const cleaned = cleanResponse(result.text);
      const bubbles = splitBubbles(cleaned).filter(Boolean);
      for (let i = 0; i < bubbles.length; i++) {
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
        const handle = await pSendMessage(message, bubbles[i]);
        fireAndForget(logOutboundMessage(message.chatId, 'text', { text: bubbles[i] }, 'sent', handle));
      }
    } catch (err) {
      console.error('[pipeline] brand chat failed:', err);
      const fallback = 'sorry, something went wrong. say "hey nest" to switch back';
      const handle = await pSendMessage(message, fallback);
      fireAndForget(logOutboundMessage(message.chatId, 'text', { text: fallback }, 'sent', handle));
    }

    if (eventId) fireAndForget(markWebhookEventStatus(eventId, 'completed'));
    return;
  }

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

    if (!userTimezone && authUserId) {
      try {
        const resolved = await resolveToken(authUserId);
        if (resolved.accessToken) {
          const isMicrosoft = resolved.provider === 'microsoft';
          const tz = isMicrosoft
            ? await fetchOutlookTimezone(resolved.accessToken)
            : await fetchCalendarTimezone(resolved.accessToken);
          if (tz && tz !== 'UTC') {
            userTimezone = tz;
            updateUserTimezone(message.from, tz).catch(() => {});
            console.log(`[pipeline] Backfilled timezone for ${message.from.slice(0, 6)}***: ${tz}`);
          }
        }
      } catch (e) {
        console.warn('[pipeline] Timezone backfill failed:', (e as Error).message);
      }
    }

    if (!userTimezone) {
      userTimezone = 'Australia/Melbourne';
    }

    if (nestUser.status !== 'active') {
      isOnboarding = true;

      const onboardUrl = `https://nest.expert/?token=${nestUser.onboardingToken}`;

      // ─── Hard verification gate at 20 Nest replies ──────────────────────
      // After 20 messages, generate a contextual verification nudge and
      // append the link as a separate bubble. The model CANNOT skip this.
      const HARD_GATE_THRESHOLD = 20;
      if (nestUser.onboardCount >= HARD_GATE_THRESHOLD) {
        await addMessage(message.chatId, 'user', message.text, message.from, {
          isGroupChat: false,
          service: message.service,
        });

        let gateText: string;
        try {
          const { geminiSimpleText } = await import('./ai/gemini.ts');
          const { MODEL_MAP } = await import('./ai/models.ts');
          const recentMessages = nestUser.onboardMessages.slice(-6).map(
            (m) => `${m.role}: ${m.content.substring(0, 100)}`
          ).join('\n');
          const result = await geminiSimpleText({
            model: MODEL_MAP.fast,
            systemPrompt: `You are Nest, a casual personal assistant people text. The user hasn't verified yet and you need them to before you can keep helping. Write a single message (2-3 sentences, max 50 words) that:
1. Actually engages with what they said — give them a taste of the answer or a genuine reaction that shows you know what you're talking about. Don't just say "great question" or "i hear you". Start with real substance.
2. Then naturally pivot to needing them to verify before you can keep going.
The first sentence should feel like you're genuinely responding to their topic. Then the verification ask flows out of that naturally.
Start with an uppercase letter. Keep it casual, warm, and direct — like a mate. No emojis. Don't mention a link (it will be sent separately). Vary it every time.

Example flow (do NOT copy, just the vibe):
User: "tell me about japan" → "Japan is unreal — the food alone is worth the trip. Before I go deeper though, I need you to do a quick verify so I can keep helping."
User: "can you draft an email" → "Yeah drafting emails is one of my favourite things to do. Just need you to verify first and I'll get straight into it."`,
            userMessage: `Recent conversation:\n${recentMessages}\n\nUser just said: "${message.text}"\n\nGenerate the response:`,
            maxOutputTokens: 150,
          });
          gateText = cleanResponse(result.text);
        } catch (err) {
          console.warn('[pipeline] gate message generation failed, using fallback:', err);
          gateText = `I hear you - before I can help with anything else though, I need you to do a quick verify. Takes 30 seconds`;
        }

        // Only include the link every 3rd Nest message in the gate stage
        const LINK_FREQUENCY = 3;
        let nestMessagesSinceLastLink = 0;
        for (let i = nestUser.onboardMessages.length - 1; i >= 0; i--) {
          const m = nestUser.onboardMessages[i];
          if (m.role === 'assistant' && m.content.includes('https://nest.expert/')) break;
          if (m.role === 'assistant') nestMessagesSinceLastLink++;
        }
        const includeLink = nestMessagesSinceLastLink >= LINK_FREQUENCY - 1;

        const bubbles = includeLink ? [gateText, onboardUrl] : [gateText];

        for (let i = 0; i < bubbles.length; i++) {
          if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1500));
          const handle = await pSendMessage(message, bubbles[i]);
          fireAndForget(logOutboundMessage(message.chatId, 'text', { text: bubbles[i] }, 'sent', handle));
        }
        const historyText = includeLink ? `${gateText} ${onboardUrl}` : gateText;
        await addMessage(message.chatId, 'assistant', historyText);

        const updatedMessages = [
          ...nestUser.onboardMessages,
          { role: 'user', content: message.text },
          { role: 'assistant', content: historyText },
        ];
        await updateOnboardState(message.from, updatedMessages, nestUser.onboardCount + 1);

        if (eventId) fireAndForget(markWebhookEventStatus(eventId, 'completed'));
        return;
      }

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

        fireAndForget(
          linqApi.shareContactCard(message.chatId)
            .then(() => console.log(`[pipeline] vCard sent on first inbound from ${message.from.slice(0, 6)}***`)),
        );
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

        const userTurnNumber = nestUser.onboardCount + 1;
        const alreadySentVerification = nestUser.onboardMessages.some((m) =>
          m.role === 'assistant' && m.content.includes('https://nest.expert/')
        );
        result.text = enforceOnboardingVerificationBubble(
          result.text,
          onboardUrl,
          userTurnNumber,
          alreadySentVerification,
        );

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

        if (isFirstMessage) {
          fireAndForget(
            new Promise((resolve) => setTimeout(resolve, 2000))
              .then(() => linqApi.shareContactCard(message.chatId))
              .then(() => console.log(`[pipeline] vCard sent to new user ${message.from.slice(0, 6)}***`)),
          );
        }
      } catch (e) {
        console.error('[pipeline] onboarding failed, sending fallback:', e instanceof Error ? e.message : e);
        const onboardUrl = `https://nest.expert/?token=${nestUser.onboardingToken}`;

        let fallbackText: string;
        try {
          const { geminiSimpleText } = await import('./ai/gemini.ts');
          const { MODEL_MAP } = await import('./ai/models.ts');
          const result = await geminiSimpleText({
            model: MODEL_MAP.fast,
            systemPrompt: `You are Nest, a casual personal assistant. Something went wrong processing the user's message. Write a brief, natural reply (max 30 words) that:
1. Apologises casually for the hiccup
2. Asks them to try again or rephrase
Start with an uppercase letter. Keep it warm and casual. No emojis.`,
            userMessage: `User said: "${message.text.substring(0, 200)}"`,
            maxOutputTokens: 80,
          });
          fallbackText = cleanResponse(result.text);
        } catch {
          fallbackText = `Something tripped me up there. Mind trying that again?`;
        }

        const handle = await pSendMessage(message, fallbackText);
        fireAndForget(logOutboundMessage(message.chatId, 'text', { text: fallbackText }, 'sent', handle));
      }

      if (eventId) fireAndForget(markWebhookEventStatus(eventId, 'completed'));
      return;
    }

    if (nestUser.lastProactiveSentAt) {
      isProactiveReply = true;
      fireAndForget(markProactiveReplied(message.from));
    }
  }

  await logBugReportIfNeeded(message, authUserId);

  // ─── Group chat: sync, classify action, enrich context ──────────────────
  let groupCtx: GroupContext | null = null;
  if (message.isGroupChat) {
    groupCtx = await syncGroupFromLinq(message.chatId).catch((err) => {
      console.warn('[pipeline] group sync failed:', (err as Error).message);
      return null;
    });

    if (groupCtx) {
      message.participantNames = groupCtx.participantNames;
      message.chatName = groupCtx.group.displayName;

      fireAndForget(recordGroupActivity(message.chatId));

      // Detect vibe after a few messages if still default
      if (groupCtx.group.groupVibe === 'mixed') {
        fireAndForget(
          detectGroupVibe(message.chatId).then((vibe) => {
            if (vibe !== 'mixed') {
              return updateGroupVibe(message.chatId, vibe);
            }
          }),
        );
      }
    }

    // Action classification (text-only messages)
    if (message.audio.length === 0 && message.images.length === 0) {
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
  }

  // ─── Active user / group flow — through the orchestrator ────────────────
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

  const replyToMessageId = await shouldReplyTo(message);
  await deliverResponse(message, result, replyToMessageId);

  if (message.isGroupChat) {
    fireAndForget(
      linqApi.shareContactCard(message.chatId)
        .then(() => console.log(`[pipeline] vCard sent to group ${message.chatId.slice(0, 8)}***`)),
    );
  }

  if (eventId) fireAndForget(markWebhookEventStatus(eventId, 'completed'));
}
