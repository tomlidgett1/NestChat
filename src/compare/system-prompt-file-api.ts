/**
 * Read/write the local chat system prompt text file (Admin → System prompt).
 * Writes only to `nest-chat-system-prompt.txt` beside nest-prompts.ts — no arbitrary paths.
 */
import fs from 'node:fs';
import type { Request, Response } from 'express';
import {
  CHAT_SYSTEM_PROMPT_PATH,
  chatPromptFileExistsOnDisk,
  getCoreIdentityLayer,
} from './nest-prompts.js';

export function handleGetChatSystemPromptFile(_req: Request, res: Response): void {
  if (process.env.NEST_DISABLE_PROMPT_FILE_WRITE === '1') {
    res.status(403).json({ error: 'Prompt file API disabled (NEST_DISABLE_PROMPT_FILE_WRITE).' });
    return;
  }
  const persisted = chatPromptFileExistsOnDisk();
  const content = getCoreIdentityLayer();
  res.json({
    path: CHAT_SYSTEM_PROMPT_PATH,
    content,
    persistedToDisk: persisted,
  });
}

export function handlePostChatSystemPromptFile(req: Request, res: Response): void {
  if (process.env.NEST_DISABLE_PROMPT_FILE_WRITE === '1') {
    res.status(403).json({ error: 'Prompt file API disabled (NEST_DISABLE_PROMPT_FILE_WRITE).' });
    return;
  }
  const { content } = req.body as { content?: unknown };
  if (typeof content !== 'string') {
    res.status(400).json({ error: 'Body must be JSON with a string "content" field.' });
    return;
  }
  try {
    fs.writeFileSync(CHAT_SYSTEM_PROMPT_PATH, content, 'utf8');
    res.json({
      ok: true,
      path: CHAT_SYSTEM_PROMPT_PATH,
      bytes: Buffer.byteLength(content, 'utf8'),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
}
