import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { handleBrandChat, type BrandChatInput } from '../_shared/brand-chat-handler.ts';
import { addMessage } from '../_shared/state.ts';

// ═══════════════════════════════════════════════════════════════
// brand-chat — HTTP endpoint for brand-mode conversations.
//
// The core logic lives in _shared/brand-chat-handler.ts and is
// also used inline by the pipeline for active brand sessions.
//
// POST /brand-chat
// {
//   "chatId":       "DM#...",
//   "senderHandle": "+1234567890",
//   "brandKey":     "hotel",
//   "message":      "I'd like to book a room"
// }
// ═══════════════════════════════════════════════════════════════

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405);
  }

  let payload: BrandChatInput;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid json' }, 400);
  }

  if (!payload.chatId || !payload.brandKey || !payload.message) {
    return jsonResponse({ error: 'missing required fields: chatId, brandKey, message' }, 400);
  }

  try {
    const result = await handleBrandChat(payload);

    if (payload.chatId && payload.senderHandle) {
      await addMessage(payload.chatId, 'user', payload.message, payload.senderHandle);
      await addMessage(payload.chatId, 'assistant', result.text);
    }

    return jsonResponse({
      ok: true,
      text: result.text,
      brand: result.brandName,
      model: result.model,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
    });
  } catch (err) {
    console.error('[brand-chat] error:', err);
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});
