import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { buildDeputyMutationReferencePrefix, resolveDeputyConnection } from './brand-deputy.ts';
import { geminiGenerateContent, type GeminiTool } from './ai/gemini.ts';
import { MODEL_MAP } from './ai/models.ts';

const PENDING_TTL_MS = 15 * 60 * 1000;
const MUTATION_MODEL = MODEL_MAP.brand_chat;

const DEPUTY_MUTATION_TOOLS: GeminiTool[] = [
  {
    functionDeclarations: [
      {
        name: 'propose_roster_discard',
        description:
          'Queue removal of one roster shift in Deputy. Use roster_id from the reference lines ("Roster id N"). Nothing is deleted until the user sends the exact reply CONFIRM DELETE.',
        parameters: {
          type: 'object' as const,
          properties: {
            roster_id: { type: 'number', description: 'Deputy roster record id (integer).' },
            summary: {
              type: 'string',
              description: 'One short line for the user describing which shift will be discarded.',
            },
          },
          required: ['roster_id', 'summary'],
        },
      },
      {
        name: 'propose_roster_add',
        description:
          'Queue a new shift. Use employee_id and operational_unit_id from the reference lists. start_time_unix and end_time_unix are unix seconds (align with roster times in the reference). The shift is not created until the user sends the exact reply CONFIRM ADD.',
        parameters: {
          type: 'object' as const,
          properties: {
            employee_id: { type: 'number' },
            operational_unit_id: { type: 'number' },
            start_time_unix: { type: 'number' },
            end_time_unix: { type: 'number' },
            mealbreak_minutes: { type: 'number', description: 'Optional; default 0.' },
            comment: { type: 'string', description: 'Optional note stored on the shift.' },
            summary: {
              type: 'string',
              description: 'One short line describing the new shift for the user.',
            },
          },
          required: ['employee_id', 'operational_unit_id', 'start_time_unix', 'end_time_unix', 'summary'],
        },
      },
    ],
  },
];

const MUTATION_CLASSIFIER_PROMPT = [
  'You interpret roster change requests for a business using Deputy (Australia/Melbourne context in the reference).',
  '',
  'Call propose_roster_discard only when the user clearly wants to remove, cancel, or delete an existing shift. You MUST set roster_id to a value that appears in the reference ("Roster id N"). If you cannot match their words to exactly one roster id, answer in plain text with one clarifying question — never guess an id.',
  '',
  'Call propose_roster_add only when they clearly want to schedule a new shift. You MUST use employee_id and operational_unit_id from the reference lists. start_time_unix and end_time_unix must be unix seconds consistent with how times appear in the reference roster.',
  '',
  'If the request is ambiguous, answer in plain text only (no tools).',
  'Never claim the change already happened; the user must confirm separately.',
].join('\n');

export function messageSuggestsRosterMutation(message: string): boolean {
  const t = message.trim();
  if (!t) return false;
  if (/^confirm\s+(add|delete)\b/i.test(t)) return false;
  if (/^(cancel|no|abort|stop)\b/i.test(t)) return false;
  return (
    /\b(delete|remove|discard|cancel)\b[\s\S]{0,96}\b(shift|roster)\b/i.test(t) ||
    /\b(shift|roster)\b[\s\S]{0,96}\b(delete|remove|discard|cancel)\b/i.test(t) ||
    /\b(add|create|schedule)\b[\s\S]{0,140}\b(shift|roster)\b/i.test(t) ||
    /\b(shift|roster)\b[\s\S]{0,96}\b(add|create|schedule)\b/i.test(t)
  );
}

function normaliseConfirmMessage(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isCancelMessage(msg: string): boolean {
  const n = normaliseConfirmMessage(msg);
  return n === 'cancel' || n === 'no' || n === 'abort' || n === 'stop';
}

function isConfirmDeleteMessage(msg: string): boolean {
  const n = normaliseConfirmMessage(msg);
  return n === 'confirm delete' || n.startsWith('confirm delete ');
}

function isConfirmAddMessage(msg: string): boolean {
  const n = normaliseConfirmMessage(msg);
  return n === 'confirm add' || n.startsWith('confirm add ');
}

async function deputySupervisePostRoster(
  apiHost: string,
  token: string,
  body: Record<string, unknown>,
): Promise<void> {
  const url = `https://${apiHost}/api/v1/supervise/roster`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Could not create/update shift (HTTP ${res.status}): ${text.slice(0, 280)}`);
  }
}

async function deputyDiscardRosters(apiHost: string, token: string, ids: number[]): Promise<void> {
  const url = `https://${apiHost}/api/v1/supervise/roster/discard`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ intRosterArray: ids }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Could not discard shift (HTTP ${res.status}): ${text.slice(0, 280)}`);
  }
}

interface PendingRow {
  chat_id: string;
  brand_key: string;
  action: 'roster_discard' | 'roster_add';
  payload: Record<string, unknown>;
  expires_at: string;
}

async function loadPending(supabase: SupabaseClient, chatId: string): Promise<PendingRow | null> {
  const { data, error } = await supabase
    .from('nest_brand_deputy_pending_actions')
    .select('chat_id, brand_key, action, payload, expires_at')
    .eq('chat_id', chatId)
    .maybeSingle();
  if (error || !data) return null;
  return data as PendingRow;
}

async function clearPending(supabase: SupabaseClient, chatId: string): Promise<void> {
  await supabase.from('nest_brand_deputy_pending_actions').delete().eq('chat_id', chatId);
}

async function savePending(
  supabase: SupabaseClient,
  row: {
    chat_id: string;
    brand_key: string;
    action: 'roster_discard' | 'roster_add';
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const expires_at = new Date(Date.now() + PENDING_TTL_MS).toISOString();
  const { error } = await supabase.from('nest_brand_deputy_pending_actions').upsert(
    {
      chat_id: row.chat_id,
      brand_key: row.brand_key,
      action: row.action,
      payload: row.payload,
      expires_at,
    },
    { onConflict: 'chat_id' },
  );
  if (error) throw new Error(error.message);
}

function toInt(v: unknown, label: string): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${label}`);
  return Math.round(n);
}

export interface DeputySideEffectResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * If this chat has a pending roster mutation, handle confirm/cancel or expiry.
 */
export async function tryConsumeDeputyPendingConfirmation(opts: {
  supabase: SupabaseClient;
  chatId: string;
  brandKey: string;
  message: string;
}): Promise<DeputySideEffectResult | null> {
  const pending = await loadPending(opts.supabase, opts.chatId);
  if (!pending) return null;

  if (new Date(pending.expires_at).getTime() < Date.now()) {
    await clearPending(opts.supabase, opts.chatId);
    return null;
  }

  if (pending.brand_key !== opts.brandKey) {
    await clearPending(opts.supabase, opts.chatId);
    return null;
  }

  const msg = opts.message;

  if (isCancelMessage(msg)) {
    await clearPending(opts.supabase, opts.chatId);
    return {
      text: 'Cancelled — we have not changed anything in Deputy.',
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  const wantsDelete = pending.action === 'roster_discard' && isConfirmDeleteMessage(msg);
  const wantsAdd = pending.action === 'roster_add' && isConfirmAddMessage(msg);

  if (wantsDelete || wantsAdd) {
    const resolved = await resolveDeputyConnection(opts.supabase, opts.brandKey);
    if (!resolved.ok) {
      return {
        text:
          'We could not reach Deputy right now, so the pending change was not applied. Please try again after checking your Deputy connection in the portal.',
        inputTokens: 0,
        outputTokens: 0,
      };
    }

    const { apiHost, accessToken } = resolved;

    try {
      if (wantsDelete) {
        const rosterId = toInt(pending.payload.roster_id, 'roster_id');
        await deputyDiscardRosters(apiHost, accessToken, [rosterId]);
        await clearPending(opts.supabase, opts.chatId);
        return {
          text: `Done — we discarded roster shift ${rosterId} in Deputy.`,
          inputTokens: 0,
          outputTokens: 0,
        };
      }

      const body = pending.payload.supervise_body as Record<string, unknown>;
      if (!body || typeof body !== 'object') {
        await clearPending(opts.supabase, opts.chatId);
        return {
          text: 'That pending add was invalid and has been cleared. Please ask again to schedule the shift.',
          inputTokens: 0,
          outputTokens: 0,
        };
      }
      await deputySupervisePostRoster(apiHost, accessToken, body);
      await clearPending(opts.supabase, opts.chatId);
      return {
        text: 'Done — we added that shift in Deputy and published it.',
        inputTokens: 0,
        outputTokens: 0,
      };
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.error('[brand-deputy-mutations] execute failed:', err);
      return {
        text: `We could not apply that change in Deputy: ${err}`,
        inputTokens: 0,
        outputTokens: 0,
      };
    }
  }

  return {
    text:
      'There is still a roster change waiting for confirmation. Reply **CONFIRM DELETE** or **CONFIRM ADD** (whichever we asked for), or **CANCEL** to abort. Phrases must match exactly.',
    inputTokens: 0,
    outputTokens: 0,
  };
}

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const o = JSON.parse(raw) as unknown;
    return typeof o === 'object' && o !== null ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Gemini tool pass: queue add/discard with explicit user confirmation on the next message.
 */
export async function tryPlanDeputyRosterMutation(opts: {
  supabase: SupabaseClient;
  chatId: string;
  brandKey: string;
  message: string;
}): Promise<DeputySideEffectResult | null> {
  if (!messageSuggestsRosterMutation(opts.message)) return null;

  const ref = await buildDeputyMutationReferencePrefix(opts.supabase, opts.brandKey);
  if (!ref.ok) return null;

  const userBlob = `${ref.referencePrefix}User request:\n${opts.message}`;

  const gen = await geminiGenerateContent({
    model: MUTATION_MODEL,
    systemPrompt: MUTATION_CLASSIFIER_PROMPT,
    contents: [{ role: 'user', parts: [{ text: userBlob }] }],
    tools: DEPUTY_MUTATION_TOOLS,
    maxOutputTokens: 768,
  });

  let inTok = gen.usage.inputTokens;
  let outTok = gen.usage.outputTokens;

  if (gen.functionCalls.length === 0) {
    if (gen.outputText.trim()) {
      return { text: gen.outputText.trim(), inputTokens: inTok, outputTokens: outTok };
    }
    return null;
  }

  const fc = gen.functionCalls[0];
  const args = parseToolArgs(fc.arguments);

  try {
    if (fc.name === 'propose_roster_discard') {
      const rosterId = toInt(args.roster_id, 'roster_id');
      const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
      if (!summary) throw new Error('Missing summary');

      await savePending(opts.supabase, {
        chat_id: opts.chatId,
        brand_key: opts.brandKey,
        action: 'roster_discard',
        payload: { roster_id: rosterId, summary },
      });

      return {
        text: [
          `We're ready to **discard** this shift in Deputy:`,
          summary,
          `(Roster id **${rosterId}**)`,
          '',
          'Reply **CONFIRM DELETE** to apply, or **CANCEL** to abort. This expires in about 15 minutes.',
        ].join('\n'),
        inputTokens: inTok,
        outputTokens: outTok,
      };
    }

    if (fc.name === 'propose_roster_add') {
      const employeeId = toInt(args.employee_id, 'employee_id');
      const opUnitId = toInt(args.operational_unit_id, 'operational_unit_id');
      const start = toInt(args.start_time_unix, 'start_time_unix');
      const end = toInt(args.end_time_unix, 'end_time_unix');
      if (end <= start) throw new Error('End time must be after start time');

      const mealRaw = args.mealbreak_minutes;
      const meal = mealRaw === undefined || mealRaw === null
        ? 0
        : Math.max(0, Math.min(180, toInt(mealRaw, 'mealbreak_minutes')));

      const comment = typeof args.comment === 'string' ? args.comment.trim().slice(0, 240) : '';
      const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
      if (!summary) throw new Error('Missing summary');

      const superviseBody: Record<string, unknown> = {
        intStartTimestamp: start,
        intEndTimestamp: end,
        intRosterEmployee: employeeId,
        blnPublish: true,
        intMealbreakMinute: meal,
        intOpunitId: opUnitId,
        blnForceOverwrite: 0,
        blnOpen: 0,
        strComment: comment || 'Added via Nest brand chat',
        intConfirmStatus: 0,
      };

      await savePending(opts.supabase, {
        chat_id: opts.chatId,
        brand_key: opts.brandKey,
        action: 'roster_add',
        payload: { supervise_body: superviseBody, summary },
      });

      return {
        text: [
          `We're ready to **add** this shift in Deputy:`,
          summary,
          '',
          'Reply **CONFIRM ADD** to create and publish it, or **CANCEL** to abort. This expires in about 15 minutes.',
        ].join('\n'),
        inputTokens: inTok,
        outputTokens: outTok,
      };
    }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return {
      text: `We could not queue that roster change: ${err}`,
      inputTokens: inTok,
      outputTokens: outTok,
    };
  }

  return null;
}
