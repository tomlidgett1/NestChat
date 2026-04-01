/** API endpoints for the Costs admin dashboard.
 *  All endpoints query api_cost_logs directly as the single source of truth. */
import type { Request, Response } from 'express';
import { getSupabase } from '../lib/supabase.js';

function getSince(req: Request): string {
  const days = Math.min(parseInt(req.query.days as string) || 30, 365);
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) + 'T00:00:00Z';
}

// ── Summary stats (top cards) ────────────────────────────────────────────────

export async function handleCostsSummary(req: Request, res: Response) {
  const supabase = getSupabase();
  const since = getSince(req);

  const { data, error } = await supabase
    .from('api_cost_logs')
    .select('cost_usd, cost_usd_no_cache, tokens_in, tokens_out, tokens_in_cached, tokens_reasoning, created_at')
    .gte('created_at', since)
    .eq('status', 'success');

  if (error) return res.status(500).json({ error: error.message });

  const rows = data || [];
  const today = new Date().toISOString().slice(0, 10);
  let totalCost = 0, totalCostNoCache = 0, tokensIn = 0, tokensOut = 0;
  let tokensCached = 0, tokensReasoning = 0, requests = 0;
  let todayCost = 0, todayRequests = 0;

  for (const r of rows) {
    const cost = Number(r.cost_usd || 0);
    const costNC = Number(r.cost_usd_no_cache || 0);
    totalCost += cost;
    totalCostNoCache += costNC;
    tokensIn += r.tokens_in || 0;
    tokensOut += r.tokens_out || 0;
    tokensCached += r.tokens_in_cached || 0;
    tokensReasoning += r.tokens_reasoning || 0;
    requests++;
    if (r.created_at && r.created_at.startsWith(today)) {
      todayCost += cost;
      todayRequests++;
    }
  }

  res.json({
    totalCost, totalCostNoCache,
    cacheSavings: totalCostNoCache - totalCost,
    tokensIn, tokensOut, tokensTotal: tokensIn + tokensOut,
    tokensCached, tokensReasoning, requests,
    todayCost, todayRequests,
  });
}

// ── Daily cost time series ───────────────────────────────────────────────────

export async function handleCostsDaily(req: Request, res: Response) {
  const supabase = getSupabase();
  const since = getSince(req);

  const { data, error } = await supabase
    .from('api_cost_logs')
    .select('cost_usd, cost_usd_no_cache, tokens_in, tokens_out, tokens_in_cached, tokens_reasoning, created_at')
    .gte('created_at', since)
    .eq('status', 'success')
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  const byDate = new Map<string, { date: string; cost: number; costNoCache: number; savings: number; tokensIn: number; tokensOut: number; cached: number; reasoning: number; requests: number }>();
  for (const r of (data || [])) {
    const date = r.created_at.slice(0, 10);
    const existing = byDate.get(date) || { date, cost: 0, costNoCache: 0, savings: 0, tokensIn: 0, tokensOut: 0, cached: 0, reasoning: 0, requests: 0 };
    const cost = Number(r.cost_usd || 0);
    const costNC = Number(r.cost_usd_no_cache || 0);
    existing.cost += cost;
    existing.costNoCache += costNC;
    existing.savings += costNC - cost;
    existing.tokensIn += r.tokens_in || 0;
    existing.tokensOut += r.tokens_out || 0;
    existing.cached += r.tokens_in_cached || 0;
    existing.reasoning += r.tokens_reasoning || 0;
    existing.requests++;
    byDate.set(date, existing);
  }

  res.json(Array.from(byDate.values()));
}

// ── By provider breakdown ────────────────────────────────────────────────────

export async function handleCostsByProvider(req: Request, res: Response) {
  const supabase = getSupabase();
  const since = getSince(req);

  const { data, error } = await supabase
    .from('api_cost_logs')
    .select('provider, cost_usd, tokens_in, tokens_out, tokens_in_cached')
    .gte('created_at', since)
    .eq('status', 'success');

  if (error) return res.status(500).json({ error: error.message });

  const byProvider = new Map<string, { provider: string; cost: number; tokensIn: number; tokensOut: number; cached: number; requests: number }>();
  for (const r of (data || [])) {
    const existing = byProvider.get(r.provider) || { provider: r.provider, cost: 0, tokensIn: 0, tokensOut: 0, cached: 0, requests: 0 };
    existing.cost += Number(r.cost_usd || 0);
    existing.tokensIn += r.tokens_in || 0;
    existing.tokensOut += r.tokens_out || 0;
    existing.cached += r.tokens_in_cached || 0;
    existing.requests++;
    byProvider.set(r.provider, existing);
  }

  res.json(Array.from(byProvider.values()));
}

// ── By message type breakdown ────────────────────────────────────────────────

export async function handleCostsByMessageType(req: Request, res: Response) {
  const supabase = getSupabase();
  const since = getSince(req);

  const { data, error } = await supabase
    .from('api_cost_logs')
    .select('message_type, cost_usd, tokens_in, tokens_out')
    .gte('created_at', since)
    .eq('status', 'success');

  if (error) return res.status(500).json({ error: error.message });

  const byType = new Map<string, { messageType: string; cost: number; tokensIn: number; tokensOut: number; requests: number }>();
  for (const r of (data || [])) {
    const key = r.message_type || 'unknown';
    const existing = byType.get(key) || { messageType: key, cost: 0, tokensIn: 0, tokensOut: 0, requests: 0 };
    existing.cost += Number(r.cost_usd || 0);
    existing.tokensIn += r.tokens_in || 0;
    existing.tokensOut += r.tokens_out || 0;
    existing.requests++;
    byType.set(key, existing);
  }

  res.json(Array.from(byType.values()));
}

// ── Recent logs (raw call log table) ─────────────────────────────────────────

export async function handleCostsLogs(req: Request, res: Response) {
  const supabase = getSupabase();
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const provider = req.query.provider as string | undefined;
  const endpoint = req.query.endpoint as string | undefined;
  const model = req.query.model as string | undefined;
  const agentName = req.query.agent as string | undefined;
  const messageType = req.query.message_type as string | undefined;
  const senderHandle = req.query.sender as string | undefined;
  const chatId = req.query.chat_id as string | undefined;

  let query = supabase
    .from('api_cost_logs')
    .select('id, created_at, provider, model, endpoint, description, agent_name, message_type, tokens_in, tokens_out, tokens_in_cached, tokens_reasoning, cost_usd, cost_usd_no_cache, cache_savings_usd, latency_ms, status, sender_handle, chat_id, agent_loop_round, error_message')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (provider) query = query.eq('provider', provider);
  if (endpoint) query = query.eq('endpoint', endpoint);
  if (model) query = query.eq('model', model);
  if (agentName) query = query.eq('agent_name', agentName);
  if (messageType) query = query.eq('message_type', messageType);
  if (senderHandle) query = query.eq('sender_handle', senderHandle);
  if (chatId) query = query.eq('chat_id', chatId);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
}

// ── By model breakdown ───────────────────────────────────────────────────────

export async function handleCostsByModel(req: Request, res: Response) {
  const supabase = getSupabase();
  const since = getSince(req);

  const { data, error } = await supabase
    .from('api_cost_logs')
    .select('model, provider, cost_usd, tokens_in, tokens_out, tokens_in_cached, tokens_reasoning, latency_ms')
    .gte('created_at', since)
    .eq('status', 'success');

  if (error) return res.status(500).json({ error: error.message });

  const byModel = new Map<string, { model: string; provider: string; cost: number; tokensIn: number; tokensOut: number; cached: number; reasoning: number; requests: number; avgLatency: number; totalLatency: number }>();
  for (const r of (data || [])) {
    const existing = byModel.get(r.model) || { model: r.model, provider: r.provider, cost: 0, tokensIn: 0, tokensOut: 0, cached: 0, reasoning: 0, requests: 0, avgLatency: 0, totalLatency: 0 };
    existing.cost += Number(r.cost_usd || 0);
    existing.tokensIn += r.tokens_in || 0;
    existing.tokensOut += r.tokens_out || 0;
    existing.cached += r.tokens_in_cached || 0;
    existing.reasoning += r.tokens_reasoning || 0;
    existing.requests++;
    existing.totalLatency += r.latency_ms || 0;
    existing.avgLatency = Math.round(existing.totalLatency / existing.requests);
    byModel.set(r.model, existing);
  }

  res.json(Array.from(byModel.values()).sort((a, b) => b.cost - a.cost));
}

// ── By agent breakdown ───────────────────────────────────────────────────────

export async function handleCostsByAgent(req: Request, res: Response) {
  const supabase = getSupabase();
  const since = getSince(req);

  const { data, error } = await supabase
    .from('api_cost_logs')
    .select('agent_name, cost_usd, tokens_in, tokens_out, latency_ms')
    .gte('created_at', since)
    .eq('status', 'success')
    .not('agent_name', 'is', null);

  if (error) return res.status(500).json({ error: error.message });

  const byAgent = new Map<string, { agent: string; cost: number; tokensIn: number; tokensOut: number; requests: number; avgLatency: number; totalLatency: number }>();
  for (const r of (data || [])) {
    const key = r.agent_name || 'unknown';
    const existing = byAgent.get(key) || { agent: key, cost: 0, tokensIn: 0, tokensOut: 0, requests: 0, avgLatency: 0, totalLatency: 0 };
    existing.cost += Number(r.cost_usd || 0);
    existing.tokensIn += r.tokens_in || 0;
    existing.tokensOut += r.tokens_out || 0;
    existing.requests++;
    existing.totalLatency += r.latency_ms || 0;
    existing.avgLatency = Math.round(existing.totalLatency / existing.requests);
    byAgent.set(key, existing);
  }

  res.json(Array.from(byAgent.values()).sort((a, b) => b.cost - a.cost));
}

// ── By sender breakdown ──────────────────────────────────────────────────────

export async function handleCostsBySender(req: Request, res: Response) {
  const supabase = getSupabase();
  const since = getSince(req);

  const { data, error } = await supabase
    .from('api_cost_logs')
    .select('sender_handle, cost_usd, tokens_in, tokens_out, latency_ms')
    .gte('created_at', since)
    .eq('status', 'success')
    .not('sender_handle', 'is', null);

  if (error) return res.status(500).json({ error: error.message });

  const bySender = new Map<string, { sender: string; cost: number; tokensIn: number; tokensOut: number; requests: number; avgLatency: number; totalLatency: number }>();
  for (const r of (data || [])) {
    const key = r.sender_handle;
    const existing = bySender.get(key) || { sender: key, cost: 0, tokensIn: 0, tokensOut: 0, requests: 0, avgLatency: 0, totalLatency: 0 };
    existing.cost += Number(r.cost_usd || 0);
    existing.tokensIn += r.tokens_in || 0;
    existing.tokensOut += r.tokens_out || 0;
    existing.requests++;
    existing.totalLatency += r.latency_ms || 0;
    existing.avgLatency = Math.round(existing.totalLatency / existing.requests);
    bySender.set(key, existing);
  }

  res.json(Array.from(bySender.values()).sort((a, b) => b.cost - a.cost));
}
