/**
 * GPT-5.4 helper: revise compare system/column prompts from natural language (full replacement text).
 */
import OpenAI from 'openai';
import type { Request, Response } from 'express';

const openai = new OpenAI();

export async function handleCompareRefinePrompt(req: Request, res: Response): Promise<void> {
  try {
    const { currentText, instruction, refineMode } = req.body as {
      currentText?: string;
      instruction?: string;
      /** Compare page: merged Anthropic global + column fragment */
      refineMode?: string;
    };

    const instr = typeof instruction === 'string' ? instruction.trim() : '';
    if (!instr) {
      res.status(400).json({ error: 'instruction is required' });
      return;
    }

    const current = typeof currentText === 'string' ? currentText : '';

    const systemInstructions =
      'You help Nest engineers revise prompts for an iMessage AI (Nest). ' +
      'You receive the CURRENT FULL TEXT of one field (either the entire global system prompt or an entire per-column instruction block) plus a natural-language request. ' +
      'You must return the COMPLETE replacement for that entire field: one coherent document that is the new value end-to-end. ' +
      'Integrate the request into the existing text — edit, reorder, tighten, or remove sections as needed. ' +
      'Do NOT only append a new heading or paragraph at the bottom; do NOT output a patch, diff, or "add this section" snippet. ' +
      'The output must be the whole updated prompt so it can replace the previous content in one paste. ' +
      'Keep existing material that still applies unless the user asked to drop or rewrite it. ' +
      'Output ONLY that full revised text: clear, imperative where appropriate, ready to paste. ' +
      'No preamble, no markdown fences, no commentary. Use Australian English spelling. ' +
      'If the current text is empty, write a complete prompt from their request.';

    let userContent =
      'Return the full updated text for this field (entire replacement, not an extra section only).\n\n' +
      'Current full text:\n---\n' +
      (current.trim() ? current.trim() : '(empty — write a complete prompt from the request below)') +
      '\n---\n\nRequested change:\n' +
      instr;

    if (refineMode === 'anthropic_merged') {
      userContent +=
        '\n\nStructure: shared base and column-specific text are separated by a blank line, the exact line --- Column-specific testing ---, and another blank line (same as production). ' +
        'Preserve that delimiter and surrounding newlines in your output unless the user explicitly asked to merge into a single block without it.';
    }

    const response = await openai.responses.create({
      model: 'gpt-5.4',
      instructions: systemInstructions,
      input: userContent,
      max_output_tokens: 8192,
      store: false,
    } as Parameters<typeof openai.responses.create>[0]);

    const body = response as unknown as { output_text?: string };
    const text = (body.output_text ?? '').trim();
    if (!text) {
      res.status(502).json({ error: 'Model returned an empty response' });
      return;
    }

    res.json({ prompt: text });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[compare-refine]', message);
    res.status(500).json({ error: message });
  }
}
