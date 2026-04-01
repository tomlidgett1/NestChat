import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { runMorningBriefAudio, synthesizeAndUpload, VOICE_MODE_TTS_INSTRUCTIONS } from '../_shared/morning-brief-audio.ts';
import { authorizeInternalRequest } from '../_shared/internal-auth.ts';

function jsonResp(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type',
      },
    });
  }

  if (req.method !== 'POST') {
    return jsonResp({ error: 'method_not_allowed' }, 405);
  }

  if (!authorizeInternalRequest(req)) {
    const token = (req.headers.get('x-internal-secret') ?? req.headers.get('Authorization') ?? '').trim();
    console.error(`[morning-brief-audio] auth failed. Token length: ${token.length}`);
    return jsonResp({ error: 'unauthorized' }, 401);
  }

  try {
    const body = (await req.json()) as {
      handle?: string;
      dry_run?: boolean;
      action?: string;
      text?: string;
      chat_id?: string;
      instructions?: string;
    };

    // ── Voice TTS action: synthesise text → upload → return signed URL ──
    if (body.action === 'voice-tts') {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const chatId = typeof body.chat_id === 'string' ? body.chat_id.trim() : '';
      if (!text || !chatId) {
        return jsonResp({ error: 'missing text or chat_id' }, 400);
      }
      const instructions = typeof body.instructions === 'string'
        ? body.instructions
        : VOICE_MODE_TTS_INSTRUCTIONS;

      const result = await synthesizeAndUpload(text, chatId, instructions);
      return jsonResp({ ok: true, signed_url: result.signedUrl, storage_path: result.storagePath });
    }

    // ── Default: morning brief ──
    const handle = typeof body.handle === 'string' ? body.handle.trim() : '';
    if (!handle) {
      return jsonResp({ error: 'missing handle' }, 400);
    }
    const dryRun = body.dry_run === true;

    const result = await runMorningBriefAudio({ handle, dryRun: dryRun });

    if (!result.ok) {
      return jsonResp(
        {
          ok: false,
          error: result.error,
          script: result.script,
          gathered: result.gathered,
        },
        400,
      );
    }

    return jsonResp({
      ok: true,
      dry_run: result.dry_run ?? false,
      script: result.script,
      gathered: result.gathered,
      signed_audio_url: result.signed_audio_url,
      storage_path: result.storage_path,
      linq_message_id: result.linq_message_id,
      chat_id: result.chat_id,
    });
  } catch (e) {
    console.error('[morning-brief-audio]', (e as Error).message);
    return jsonResp({ error: 'internal', detail: (e as Error).message }, 500);
  }
});
