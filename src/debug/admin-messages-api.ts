import type { Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';

/** GET /messages/api/chats — non-expired conversations, newest activity first. */
export async function handleMessagesChatsList(req: Request, res: Response) {
  try {
    const supabase = getSupabase();
    const nowIso = new Date().toISOString();
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const scanLimit = Math.min(Math.max(parseInt(String(req.query.scanLimit), 10) || 5000, 500), 15000);

    const { data: rows, error } = await supabase
      .from('conversation_messages')
      .select('chat_id, role, content, created_at')
      .gt('expires_at', nowIso)
      .order('created_at', { ascending: false })
      .limit(scanLimit);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const byChat = new Map<
      string,
      { chat_id: string; lastMessageAt: string; previewRole: string; preview: string; sampledCount: number }
    >();

    for (const row of rows || []) {
      const chatId = row.chat_id as string;
      if (!chatId) continue;
      const existing = byChat.get(chatId);
      if (!existing) {
        byChat.set(chatId, {
          chat_id: chatId,
          lastMessageAt: row.created_at as string,
          previewRole: row.role as string,
          preview: String(row.content ?? '').slice(0, 160),
          sampledCount: 1,
        });
      } else {
        existing.sampledCount += 1;
      }
    }

    let chats = [...byChat.values()].sort(
      (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime(),
    );

    if (q) {
      const needle = q.toLowerCase();
      chats = chats.filter(
        (c) =>
          c.chat_id.toLowerCase().includes(needle) || c.preview.toLowerCase().includes(needle),
      );
    }

    const handles = chats.map((c) => c.chat_id);
    const nameByHandle = new Map<string, string | null>();

    if (handles.length > 0) {
      const chunkSize = 100;
      for (let i = 0; i < handles.length; i += chunkSize) {
        const chunk = handles.slice(i, i + chunkSize);
        const { data: profiles, error: pErr } = await supabase
          .from('user_profiles')
          .select('handle, name')
          .in('handle', chunk);
        if (pErr) {
          console.warn('[messages-api] user_profiles batch:', pErr.message);
          continue;
        }
        for (const p of profiles || []) {
          nameByHandle.set(p.handle as string, (p.name as string) || null);
        }
      }
    }

    res.json({
      generatedAt: nowIso,
      chats: chats.map((c) => ({
        ...c,
        displayName: nameByHandle.get(c.chat_id) ?? null,
      })),
      scanLimit,
      note:
        'Chats are derived from the most recent non-expired conversation_messages rows (scan window). Preview is the latest message per chat_id.',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
}

/** GET /messages/api/conversation?handle= — full non-expired thread for a chat_id (handle). */
export async function handleMessagesConversation(req: Request, res: Response) {
  try {
    const handle = typeof req.query.handle === 'string' ? req.query.handle.trim() : '';
    if (!handle) {
      return res.status(400).json({ error: 'handle is required (chat_id)' });
    }

    const supabase = getSupabase();
    const nowIso = new Date().toISOString();
    const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 400, 1), 800);

    const [{ data: messages, error: msgErr }, { data: profile, error: profErr }] = await Promise.all([
      supabase
        .from('conversation_messages')
        .select('id, role, content, handle, metadata, created_at')
        .eq('chat_id', handle)
        .gt('expires_at', nowIso)
        .order('created_at', { ascending: true })
        .limit(limit),
      supabase.from('user_profiles').select('handle, name, status, last_seen').eq('handle', handle).maybeSingle(),
    ]);

    if (msgErr) {
      return res.status(500).json({ error: msgErr.message });
    }
    if (profErr) {
      console.warn('[messages-api] profile:', profErr.message);
    }

    res.json({
      handle,
      profile: profile ?? null,
      messages: messages ?? [],
      truncated: (messages?.length ?? 0) >= limit,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
}
