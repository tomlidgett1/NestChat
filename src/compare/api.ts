import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import type { Request, Response } from 'express';

// Nest's actual prompt layers for chat mode
import { CORE_IDENTITY_LAYER } from './nest-prompts.js';

const openai = new OpenAI();
const anthropic = new Anthropic();

function getGeminiClient(): GoogleGenAI | null {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  if (!key) return null;
  return new GoogleGenAI({ apiKey: key });
}

// ═══════════════════════════════════════════════════════════════
// In-memory conversation store (per-session, per-provider)
// ═══════════════════════════════════════════════════════════════

interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const conversations = new Map<string, ConversationMessage[]>();

function getConversationKey(sessionId: string, columnId: string): string {
  return `${sessionId}:${columnId}`;
}

function getHistory(sessionId: string, columnId: string): ConversationMessage[] {
  return conversations.get(getConversationKey(sessionId, columnId)) ?? [];
}

function appendToHistory(sessionId: string, columnId: string, messages: ConversationMessage[]) {
  const key = getConversationKey(sessionId, columnId);
  const existing = conversations.get(key) ?? [];
  existing.push(...messages);
  conversations.set(key, existing);
}

function clearConversation(sessionId: string) {
  for (const [key] of conversations) {
    if (key.startsWith(sessionId + ':')) {
      conversations.delete(key);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// OpenAI — Responses API (client.responses.create)
// ═══════════════════════════════════════════════════════════════

async function callOpenAI(
  model: string,
  prompt: string,
  systemPrompt: string,
  history: ConversationMessage[],
): Promise<{ text: string; tokens?: number }> {
  const input: Array<{ role: string; content: string }> = [];

  for (const msg of history) {
    input.push({ role: msg.role, content: msg.content });
  }
  input.push({ role: 'user', content: prompt });

  const response = await openai.responses.create({
    model,
    instructions: systemPrompt,
    input: input as Parameters<typeof openai.responses.create>[0]['input'],
    max_output_tokens: 4096,
    store: false,
  } as Parameters<typeof openai.responses.create>[0]);

  const body = response as unknown as {
    output_text?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = body.output_text ?? '';
  const tokens = body.usage
    ? (body.usage.input_tokens ?? 0) + (body.usage.output_tokens ?? 0)
    : undefined;
  return { text, tokens };
}

// ═══════════════════════════════════════════════════════════════
// Anthropic — Messages API (client.messages.create)
// ═══════════════════════════════════════════════════════════════

async function callAnthropic(
  model: string,
  prompt: string,
  systemPrompt: string,
  history: ConversationMessage[],
): Promise<{ text: string; tokens?: number }> {
  const messages: Anthropic.MessageParam[] = [];

  for (const msg of history) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      messages.push({ role: msg.role, content: msg.content });
    }
  }
  messages.push({ role: 'user', content: prompt });

  const response = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  });

  const textBlocks = response.content.filter(
    (b): b is Anthropic.TextBlock => b.type === 'text',
  );
  const text = textBlocks.map((b) => b.text).join('\n');
  const tokens = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
  return { text, tokens };
}

// ═══════════════════════════════════════════════════════════════
// Google Gemini — @google/genai SDK (ai.models.generateContent)
// ═══════════════════════════════════════════════════════════════

async function callGemini(
  model: string,
  prompt: string,
  systemPrompt: string,
  history: ConversationMessage[],
): Promise<{ text: string; tokens?: number }> {
  const client = getGeminiClient();
  if (!client) throw new Error('Gemini API key not configured. Set GEMINI_API_KEY in .env');

  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

  for (const msg of history) {
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    });
  }
  contents.push({ role: 'user', parts: [{ text: prompt }] });

  const response = await client.models.generateContent({
    model,
    contents,
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: 4096,
    },
  });

  const text = response.text ?? '';
  const usage = response.usageMetadata;
  const tokens = usage
    ? (usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0)
    : undefined;
  return { text, tokens };
}

// ═══════════════════════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Production — calls the real handleTurn pipeline via debug-dashboard edge function
// ═══════════════════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function callProduction(
  _model: string,
  prompt: string,
  _systemPrompt: string,
  _history: ConversationMessage[],
): Promise<{ text: string; tokens?: number; meta?: Record<string, unknown> }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured');
  }

  const url = `${SUPABASE_URL}/functions/v1/debug-dashboard?api=run-single`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({ message: prompt, keepHistory: true }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Production pipeline error (${resp.status}): ${errText}`);
  }

  const result = await resp.json() as Record<string, unknown>;
  const tokens = ((result.inputTokens as number) || 0) + ((result.outputTokens as number) || 0);

  return {
    text: (result.responseText as string) || (result.responsePreview as string) || '[no response]',
    tokens,
    meta: {
      agent: result.agent,
      model: result.model,
      routeLayer: result.routeLayer,
      isOnboarding: result.isOnboarding,
      tools: result.tools,
      toolCount: result.toolCount,
      toolNames: result.toolNames,
      rounds: result.rounds,
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      // Full trace object from the pipeline (mirrors debug dashboard)
      trace: result.trace,
    },
  };
}

type Provider = 'openai' | 'anthropic' | 'gemini' | 'production';

const CALLERS: Record<
  Provider,
  (model: string, prompt: string, systemPrompt: string, history: ConversationMessage[]) => Promise<{ text: string; tokens?: number; meta?: Record<string, unknown> }>
> = {
  openai: callOpenAI,
  anthropic: callAnthropic,
  gemini: callGemini,
  production: callProduction,
};

export async function handleCompareChat(req: Request, res: Response) {
  const { prompt, systemPrompt, provider, model, sessionId, columnId } = req.body as {
    prompt?: string;
    systemPrompt?: string;
    provider?: string;
    model?: string;
    sessionId?: string;
    columnId?: string;
  };

  if (!prompt || !provider || !model || !sessionId) {
    return res.status(400).json({ error: 'Missing prompt, provider, model, or sessionId' });
  }

  if (!CALLERS[provider as Provider]) {
    return res.status(400).json({ error: `Unknown provider: ${provider}` });
  }

  const historyKey = columnId || provider;
  const effectiveSystemPrompt = systemPrompt || CORE_IDENTITY_LAYER;
  const history = getHistory(sessionId, historyKey);

  const start = Date.now();
  try {
    const caller = CALLERS[provider as Provider];
    const result = await caller(model, prompt, effectiveSystemPrompt, history);
    const latencyMs = Date.now() - start;

    appendToHistory(sessionId, historyKey, [
      { role: 'user', content: prompt },
      { role: 'assistant', content: result.text },
    ]);

    console.log(`[compare] ${provider}/${model} (col:${historyKey}): ${latencyMs}ms, ${result.tokens ?? '?'} tokens, history=${history.length} msgs`);

    return res.json({
      text: result.text,
      latencyMs,
      tokens: result.tokens,
      provider,
      model,
      columnId: historyKey,
      historyLength: history.length + 2,
      // Production pipeline metadata (agent, tools, routing info)
      ...(result as { meta?: Record<string, unknown> }).meta ? { production: (result as { meta?: Record<string, unknown> }).meta } : {},
    });
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[compare] ${provider}/${model} error (${latencyMs}ms):`, message);
    return res.status(500).json({ error: message });
  }
}

export async function handleCompareClear(req: Request, res: Response) {
  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  clearConversation(sessionId);

  // Also clear the production-side DBG# conversation history
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      await fetch(`${SUPABASE_URL}/functions/v1/debug-dashboard?api=clear-history`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
        body: '{}',
      });
    } catch (e) {
      console.warn('[compare] failed to clear production history:', e);
    }
  }

  console.log(`[compare] cleared conversation: ${sessionId}`);
  return res.json({ ok: true });
}

export async function handleCompareGetPrompt(_req: Request, res: Response) {
  return res.json({ systemPrompt: CORE_IDENTITY_LAYER });
}

export async function handleCompareUsers(_req: Request, res: Response) {
  try {
    const { getSupabase } = await import('../lib/supabase.js');
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('user_profiles')
      .select('handle, name, status, timezone, auth_user_id')
      .eq('status', 'active')
      .order('last_seen', { ascending: false })
      .limit(50);

    if (error) return res.status(500).json({ error: error.message });
    return res.json(data || []);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
}

// Scope labels matching production prompt-layers.ts
const SCOPE_LABELS: Record<string, string> = {
  'https://www.googleapis.com/auth/calendar.events': 'calendar',
  'https://www.googleapis.com/auth/gmail.modify': 'email',
  'https://www.googleapis.com/auth/gmail.readonly': 'email',
  'https://www.googleapis.com/auth/contacts.readonly': 'contacts',
  'https://www.googleapis.com/auth/contacts.other.readonly': 'contacts',
  'https://www.googleapis.com/auth/drive.readonly': 'drive',
};

function humaniseScopes(scopes: string[]): string[] {
  const labels = new Set<string>();
  for (const s of scopes) {
    const label = SCOPE_LABELS[s];
    if (label) labels.add(label);
  }
  return [...labels];
}

interface ConnectedAccount {
  provider: string;
  email: string;
  name: string | null;
  isPrimary: boolean;
  scopes: string[];
}

async function loadConnectedAccounts(supabase: any, authUserId: string): Promise<ConnectedAccount[]> {
  const accounts: ConnectedAccount[] = [];

  const [googleRes, msRes, granolaRes] = await Promise.all([
    supabase.from('user_google_accounts').select('google_email, google_name, is_primary, scopes').eq('user_id', authUserId),
    supabase.from('user_microsoft_accounts').select('microsoft_email, microsoft_name, is_primary').eq('user_id', authUserId),
    supabase.from('user_granola_accounts').select('granola_email, granola_name, is_primary').eq('user_id', authUserId),
  ]);

  if (!googleRes.error && googleRes.data) {
    for (const row of googleRes.data) {
      accounts.push({ provider: 'google', email: row.google_email, name: row.google_name ?? null, isPrimary: row.is_primary ?? false, scopes: row.scopes ?? [] });
    }
  }
  if (!msRes.error && msRes.data) {
    for (const row of msRes.data) {
      accounts.push({ provider: 'microsoft', email: row.microsoft_email, name: row.microsoft_name ?? null, isPrimary: row.is_primary ?? false, scopes: [] });
    }
  }
  if (!granolaRes.error && granolaRes.data) {
    for (const row of granolaRes.data) {
      accounts.push({ provider: 'granola', email: row.granola_email, name: row.granola_name ?? null, isPrimary: row.is_primary ?? false, scopes: ['meetings'] });
    }
  }

  return accounts;
}

interface MemoryItemRow {
  memory_type: string;
  category: string;
  value_text: string;
  confidence: number;
  last_confirmed_at: string | null;
}

const MEMORY_TYPE_LABELS: Record<string, string> = {
  identity: 'Identity',
  preference: 'Preferences',
  plan: 'Plans',
  task_commitment: 'Task Commitments',
  relationship: 'Relationships',
  emotional_context: 'Emotional Context',
  bio_fact: 'Facts',
  contextual_note: 'Notes',
};

function formatMemoryForPrompt(items: MemoryItemRow[]): string {
  if (items.length === 0) return '';

  const grouped = new Map<string, MemoryItemRow[]>();
  for (const item of items) {
    const group = grouped.get(item.memory_type) ?? [];
    group.push(item);
    grouped.set(item.memory_type, group);
  }

  const sections: string[] = [];
  for (const [type, memories] of grouped) {
    const label = MEMORY_TYPE_LABELS[type] || type;
    const lines = memories.map(m => {
      const parts: string[] = [];
      if (m.confidence < 0.6) parts.push('uncertain');
      const qualifier = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      return `- ${m.category}: ${m.value_text}${qualifier}`;
    });
    sections.push(`${label}\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}

export async function handleCompareUserContext(req: Request, res: Response) {
  const handle = req.query.handle as string;
  if (!handle) return res.status(400).json({ error: 'Missing handle' });

  try {
    const { getSupabase } = await import('../lib/supabase.js');
    const supabase = getSupabase();

    // Load profile with all relevant fields (matching production state.ts)
    const profileRes = await supabase
      .from('user_profiles')
      .select('handle, name, facts, auth_user_id, timezone, status, use_linq')
      .eq('handle', handle)
      .single();

    const profile = profileRes.data;
    if (!profile) return res.status(404).json({ error: 'User not found' });

    // Load connected accounts via auth_user_id (matching production state.ts)
    let accounts: ConnectedAccount[] = [];
    if (profile.auth_user_id) {
      accounts = await loadConnectedAccounts(supabase, profile.auth_user_id);
    }

    // Load memory items via RPC (matching production state.ts)
    let memoryItems: MemoryItemRow[] = [];
    const memoryRes = await supabase.rpc('get_active_memory_items', { p_handle: handle, p_limit: 30 });
    if (!memoryRes.error && memoryRes.data) {
      memoryItems = memoryRes.data;
    }

    // Build context block exactly like production prompt-layers.ts buildContextLayer()
    const sections: string[] = [];

    // Person / profile block
    const hasMemory = memoryItems.length > 0;
    if (hasMemory) {
      const nameItem = memoryItems.find(m => m.memory_type === 'identity' && m.category === 'name');
      let personBlock = 'Known user context';
      personBlock += `\nHandle: ${handle}`;
      if (nameItem) personBlock += `\nName: ${nameItem.value_text}`;
      personBlock += '\n' + formatMemoryForPrompt(memoryItems);
      personBlock += '\n\nUse this naturally. Only write genuinely new durable details to memory, or correct details that are wrong.';
      sections.push(personBlock);
    } else if (profile.name || (profile.facts && profile.facts.length > 0)) {
      let personBlock = 'Known user profile';
      personBlock += `\nHandle: ${handle}`;
      if (profile.name) personBlock += `\nName: ${profile.name}`;
      const facts = Array.isArray(profile.facts) ? profile.facts.filter((f: any) => typeof f === 'string' && f.trim()) : [];
      if (facts.length > 0) {
        personBlock += `\nProfile anchors:\n${facts.join('\n')}`;
      }
      personBlock += '\n\nUse this naturally. Only write new durable details or corrections to memory.';
      sections.push(personBlock);
    } else {
      sections.push(`Known user profile\nHandle: ${handle}\nYou do not know their name yet. If they share it or it comes up naturally, use remember_user to save it.`);
    }

    // Connected accounts block
    if (accounts.length > 0) {
      let acctBlock = 'Connected accounts';
      for (const acct of accounts) {
        const label = acct.provider.charAt(0).toUpperCase() + acct.provider.slice(1);
        const primaryTag = acct.isPrimary ? ' (primary)' : '';
        const nameTag = acct.name ? `, ${acct.name}` : '';
        const scopeLabels = acct.scopes.length > 0
          ? humaniseScopes(acct.scopes)
          : acct.provider === 'microsoft' ? ['email', 'calendar', 'contacts'] : [];
        const scopeSummary = scopeLabels.length > 0 ? ` [${scopeLabels.join(', ')}]` : '';
        acctBlock += `\n${label}${primaryTag}: ${acct.email}${nameTag}${scopeSummary}`;
      }
      acctBlock += '\nYou already know which accounts are connected. Answer naturally if asked.';
      sections.push(acctBlock);
    }

    // Timezone
    const tz = profile.timezone || null;

    return res.json({
      profile: {
        handle: profile.handle,
        name: profile.name,
        facts: profile.facts,
        timezone: tz,
        status: profile.status,
      },
      accounts,
      memoryItems: memoryItems.length,
      contextBlock: sections.join('\n\n'),
      timezone: tz,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
}
