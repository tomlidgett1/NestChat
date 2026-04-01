// cost-tracker.ts — Multi-provider API cost logging helper.
//
// Tracks every LLM / AI API call across OpenAI, Gemini, and Anthropic.
// Captures full usage breakdown per call:
//   - Fresh vs cached input tokens
//   - Reasoning tokens (billed at output rate for OpenAI)
//   - Actual cost vs counterfactual cost without caching
//   - Cache savings in USD
//
// Always awaited — DB row lands before caller continues.

import { SupabaseClient } from "npm:@supabase/supabase-js@2";

// ── Pricing (USD per 1M tokens) ───────────────────────────────────────────────
// Sources:
//   OpenAI:    https://openai.com/api/pricing
//   Google:    https://ai.google.dev/pricing
//   Anthropic: https://docs.anthropic.com/en/docs/about-claude/models

interface ModelPricing {
  input: number;        // fresh input tokens / 1M
  inputCached: number;  // cached input tokens / 1M
  output: number;       // output + reasoning tokens / 1M
}

// ── OpenAI pricing ───────────────────────────────────────────────────────────

const OPENAI_PRICING: Record<string, ModelPricing> = {
  // GPT-4.1 family
  "gpt-4.1":                { input: 2.00,  inputCached: 0.50,   output: 8.00   },
  "gpt-4.1-mini":           { input: 0.40,  inputCached: 0.10,   output: 1.60   },
  "gpt-4.1-nano":           { input: 0.10,  inputCached: 0.025,  output: 0.40   },
  // GPT-4o family
  "gpt-4o":                 { input: 2.50,  inputCached: 1.25,   output: 10.00  },
  "gpt-4o-2024-05-13":      { input: 5.00,  inputCached: 5.00,   output: 15.00  },
  "gpt-4o-mini":            { input: 0.15,  inputCached: 0.075,  output: 0.60   },
  // GPT-5 family
  "gpt-5.4":                { input: 1.75,  inputCached: 0.175,  output: 14.00  },
  "gpt-5.4-nano":           { input: 0.05,  inputCached: 0.005,  output: 0.40   },
  "gpt-5.3":                { input: 1.75,  inputCached: 0.175,  output: 14.00  },
  "gpt-5.3-codex":          { input: 1.75,  inputCached: 0.175,  output: 14.00  },
  "gpt-5.2":                { input: 1.75,  inputCached: 0.175,  output: 14.00  },
  "gpt-5.2-chat-latest":    { input: 1.75,  inputCached: 0.175,  output: 14.00  },
  "gpt-5.2-codex":          { input: 1.75,  inputCached: 0.175,  output: 14.00  },
  "gpt-5.2-pro":            { input: 21.00, inputCached: 21.00,  output: 168.00 },
  "gpt-5.1":                { input: 1.25,  inputCached: 0.125,  output: 10.00  },
  "gpt-5.1-chat-latest":    { input: 1.25,  inputCached: 0.125,  output: 10.00  },
  "gpt-5.1-codex":          { input: 1.25,  inputCached: 0.125,  output: 10.00  },
  "gpt-5.1-codex-max":      { input: 1.25,  inputCached: 0.125,  output: 10.00  },
  "gpt-5":                  { input: 1.25,  inputCached: 0.125,  output: 10.00  },
  "gpt-5-chat-latest":      { input: 1.25,  inputCached: 0.125,  output: 10.00  },
  "gpt-5-codex":            { input: 1.25,  inputCached: 0.125,  output: 10.00  },
  "gpt-5-pro":              { input: 15.00, inputCached: 15.00,  output: 120.00 },
  "gpt-5-mini":             { input: 0.25,  inputCached: 0.025,  output: 2.00   },
  "gpt-5-nano":             { input: 0.05,  inputCached: 0.005,  output: 0.40   },
  // Realtime / Audio
  "gpt-realtime":           { input: 4.00,  inputCached: 0.40,   output: 16.00  },
  "gpt-realtime-1.5":       { input: 4.00,  inputCached: 0.40,   output: 16.00  },
  "gpt-realtime-mini":      { input: 0.60,  inputCached: 0.06,   output: 2.40   },
  "gpt-audio":              { input: 2.50,  inputCached: 2.50,   output: 10.00  },
  // Embeddings
  "text-embedding-3-large": { input: 0.13,  inputCached: 0.13,   output: 0.00   },
  "text-embedding-3-small": { input: 0.02,  inputCached: 0.02,   output: 0.00   },
  "text-embedding-ada-002": { input: 0.10,  inputCached: 0.10,   output: 0.00   },
  // Image generation (DALL-E) — priced per image, not tokens.
  // We log a single "token" per image and set cost directly.
  // Whisper transcription — priced per minute ($0.006/min).
  // We log audio_seconds in metadata and set cost directly.
};

// ── Google Gemini pricing ────────────────────────────────────────────────────

const GEMINI_PRICING: Record<string, ModelPricing> = {
  // Gemini 2.5 family
  "gemini-2.5-pro":                 { input: 1.25,  inputCached: 0.3125, output: 10.00  },
  "gemini-2.5-pro-preview-05-06":   { input: 1.25,  inputCached: 0.3125, output: 10.00  },
  "gemini-2.5-flash":               { input: 0.15,  inputCached: 0.0375, output: 0.60   },
  "gemini-2.5-flash-preview-04-17": { input: 0.15,  inputCached: 0.0375, output: 0.60   },
  // Gemini 2.0 family
  "gemini-2.0-flash":               { input: 0.10,  inputCached: 0.025,  output: 0.40   },
  "gemini-2.0-flash-lite":          { input: 0.075, inputCached: 0.019,  output: 0.30   },
  // Gemini 3 family (preview)
  "gemini-3-flash-preview":         { input: 0.15,  inputCached: 0.0375, output: 0.60   },
  "gemini-3.1-flash-lite-preview":  { input: 0.075, inputCached: 0.019,  output: 0.30   },
  // Gemini 1.5 family
  "gemini-1.5-pro":                 { input: 1.25,  inputCached: 0.3125, output: 5.00   },
  "gemini-1.5-flash":               { input: 0.075, inputCached: 0.019,  output: 0.30   },
  "gemini-1.5-flash-8b":            { input: 0.0375,inputCached: 0.01,   output: 0.15   },
  // Embeddings (text-embedding-004 is free up to a limit, then $0.00 effectively)
  "text-embedding-004":             { input: 0.00,  inputCached: 0.00,   output: 0.00   },
};

// ── Anthropic Claude pricing ─────────────────────────────────────────────────

const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  // Claude 4 family
  "claude-opus-4-20250514":       { input: 15.00, inputCached: 1.875,  output: 75.00  },
  "claude-sonnet-4-20250514":     { input: 3.00,  inputCached: 0.375,  output: 15.00  },
  // Claude 3.7
  "claude-3-7-sonnet-20250219":   { input: 3.00,  inputCached: 0.375,  output: 15.00  },
  // Claude 3.5 family
  "claude-3-5-sonnet-20241022":   { input: 3.00,  inputCached: 0.375,  output: 15.00  },
  "claude-3-5-sonnet-20240620":   { input: 3.00,  inputCached: 0.375,  output: 15.00  },
  "claude-3-5-haiku-20241022":    { input: 0.80,  inputCached: 0.10,   output: 4.00   },
  // Claude 3 family
  "claude-3-opus-20240229":       { input: 15.00, inputCached: 1.875,  output: 75.00  },
  "claude-3-sonnet-20240229":     { input: 3.00,  inputCached: 0.375,  output: 15.00  },
  "claude-3-haiku-20240307":      { input: 0.25,  inputCached: 0.03,   output: 1.25   },
};

// ── Fixed-price items (per unit, not per token) ──────────────────────────────

export const FIXED_PRICES = {
  // DALL-E 3 image generation
  "dall-e-3-standard-1024":  0.040,   // $0.040 per image (standard, 1024x1024)
  "dall-e-3-standard-1792":  0.080,   // $0.080 per image (standard, 1024x1792 or 1792x1024)
  "dall-e-3-hd-1024":        0.080,   // $0.080 per image (HD, 1024x1024)
  "dall-e-3-hd-1792":        0.120,   // $0.120 per image (HD, 1024x1792 or 1792x1024)
  "dall-e-2-1024":           0.020,   // $0.020 per image
  "dall-e-2-512":            0.018,   // $0.018 per image
  "dall-e-2-256":            0.016,   // $0.016 per image
  // OpenAI Whisper transcription
  "whisper-per-minute":      0.006,   // $0.006 per minute of audio
  // OpenAI TTS
  "tts-1-per-1m-chars":      15.00,   // $15.00 per 1M characters
  "tts-1-hd-per-1m-chars":   30.00,   // $30.00 per 1M characters
  // ElevenLabs TTS (approximate)
  "elevenlabs-per-1k-chars": 0.30,    // ~$0.30 per 1K characters (scale plan)
} as const;

// ── Prefix fallback tables ───────────────────────────────────────────────────

const OPENAI_PREFIX_PRICING: Array<[string, ModelPricing]> = [
  ["gpt-5.4-nano",  { input: 0.05,  inputCached: 0.005,  output: 0.40   }],
  ["gpt-5.4",       { input: 1.75,  inputCached: 0.175,  output: 14.00  }],
  ["gpt-5.3",       { input: 1.75,  inputCached: 0.175,  output: 14.00  }],
  ["gpt-5.2-pro",   { input: 21.00, inputCached: 21.00,  output: 168.00 }],
  ["gpt-5.2",       { input: 1.75,  inputCached: 0.175,  output: 14.00  }],
  ["gpt-5.1",       { input: 1.25,  inputCached: 0.125,  output: 10.00  }],
  ["gpt-5-pro",     { input: 15.00, inputCached: 15.00,  output: 120.00 }],
  ["gpt-5-nano",    { input: 0.05,  inputCached: 0.005,  output: 0.40   }],
  ["gpt-5-mini",    { input: 0.25,  inputCached: 0.025,  output: 2.00   }],
  ["gpt-5",         { input: 1.25,  inputCached: 0.125,  output: 10.00  }],
  ["gpt-4.1-nano",  { input: 0.10,  inputCached: 0.025,  output: 0.40   }],
  ["gpt-4.1-mini",  { input: 0.40,  inputCached: 0.10,   output: 1.60   }],
  ["gpt-4.1",       { input: 2.00,  inputCached: 0.50,   output: 8.00   }],
  ["gpt-4o-mini",   { input: 0.15,  inputCached: 0.075,  output: 0.60   }],
  ["gpt-4o",        { input: 2.50,  inputCached: 1.25,   output: 10.00  }],
  ["gpt-4",         { input: 2.00,  inputCached: 1.00,   output: 8.00   }],
  ["gpt-3.5",       { input: 0.50,  inputCached: 0.25,   output: 1.50   }],
];

const GEMINI_PREFIX_PRICING: Array<[string, ModelPricing]> = [
  ["gemini-3.1",    { input: 0.075, inputCached: 0.019,  output: 0.30   }],
  ["gemini-3",      { input: 0.15,  inputCached: 0.0375, output: 0.60   }],
  ["gemini-2.5-pro",{ input: 1.25,  inputCached: 0.3125, output: 10.00  }],
  ["gemini-2.5",    { input: 0.15,  inputCached: 0.0375, output: 0.60   }],
  ["gemini-2.0-flash-lite", { input: 0.075, inputCached: 0.019, output: 0.30 }],
  ["gemini-2.0",    { input: 0.10,  inputCached: 0.025,  output: 0.40   }],
  ["gemini-1.5-pro",{ input: 1.25,  inputCached: 0.3125, output: 5.00   }],
  ["gemini-1.5",    { input: 0.075, inputCached: 0.019,  output: 0.30   }],
];

const ANTHROPIC_PREFIX_PRICING: Array<[string, ModelPricing]> = [
  ["claude-opus-4",     { input: 15.00, inputCached: 1.875,  output: 75.00  }],
  ["claude-sonnet-4",   { input: 3.00,  inputCached: 0.375,  output: 15.00  }],
  ["claude-3-7",        { input: 3.00,  inputCached: 0.375,  output: 15.00  }],
  ["claude-3-5-sonnet", { input: 3.00,  inputCached: 0.375,  output: 15.00  }],
  ["claude-3-5-haiku",  { input: 0.80,  inputCached: 0.10,   output: 4.00   }],
  ["claude-3-opus",     { input: 15.00, inputCached: 1.875,  output: 75.00  }],
  ["claude-3-sonnet",   { input: 3.00,  inputCached: 0.375,  output: 15.00  }],
  ["claude-3-haiku",    { input: 0.25,  inputCached: 0.03,   output: 1.25   }],
];

// ── Provider detection ───────────────────────────────────────────────────────

export type Provider = "openai" | "gemini" | "anthropic";

export function detectProvider(model: string): Provider {
  if (model.startsWith("gemini-") || model.startsWith("text-embedding-004")) return "gemini";
  if (model.startsWith("claude-")) return "anthropic";
  return "openai";
}

// ── Pricing lookup ───────────────────────────────────────────────────────────

function findPricing(model: string): ModelPricing {
  const provider = detectProvider(model);

  // Exact match first
  if (provider === "openai" && OPENAI_PRICING[model]) return OPENAI_PRICING[model];
  if (provider === "gemini" && GEMINI_PRICING[model]) return GEMINI_PRICING[model];
  if (provider === "anthropic" && ANTHROPIC_PRICING[model]) return ANTHROPIC_PRICING[model];

  // Prefix fallback
  const prefixTable =
    provider === "openai" ? OPENAI_PREFIX_PRICING :
    provider === "gemini" ? GEMINI_PREFIX_PRICING :
    ANTHROPIC_PREFIX_PRICING;

  for (const [prefix, pricing] of prefixTable) {
    if (model.startsWith(prefix)) return pricing;
  }

  // Unknown model — warn and use a conservative fallback
  const fallback = provider === "gemini"
    ? { input: 0.15, inputCached: 0.0375, output: 0.60 }
    : provider === "anthropic"
    ? { input: 3.00, inputCached: 0.375, output: 15.00 }
    : { input: 2.00, inputCached: 1.00, output: 8.00 };

  console.warn(`[cost-tracker] Unknown model "${model}" (${provider}) — using fallback pricing`);
  return fallback;
}

// ── Cost calculation ─────────────────────────────────────────────────────────

export interface CostBreakdown {
  costUsd: number;
  costUsdNoCache: number;
  cacheSavingsUsd: number;
}

export function calculateCostBreakdown(
  model: string,
  tokensIn: number,
  tokensOut: number,
  tokensInCached: number = 0,
  tokensReasoning: number = 0,
): CostBreakdown {
  const p = findPricing(model);
  const tokensInFresh = tokensIn - tokensInCached;

  const costUsd =
    (tokensInFresh   / 1_000_000) * p.input        +
    (tokensInCached  / 1_000_000) * p.inputCached   +
    (tokensOut       / 1_000_000) * p.output        +
    (tokensReasoning / 1_000_000) * p.output;

  const costUsdNoCache =
    (tokensIn        / 1_000_000) * p.input         +
    (tokensOut       / 1_000_000) * p.output        +
    (tokensReasoning / 1_000_000) * p.output;

  const round8 = (n: number) => Math.round(n * 1e8) / 1e8;

  return {
    costUsd:         round8(costUsd),
    costUsdNoCache:  round8(costUsdNoCache),
    cacheSavingsUsd: round8(costUsdNoCache - costUsd),
  };
}

export function calculateFixedCost(
  priceKey: keyof typeof FIXED_PRICES,
  quantity: number = 1,
): number {
  return Math.round(FIXED_PRICES[priceKey] * quantity * 1e8) / 1e8;
}

// ── Log interface ────────────────────────────────────────────────────────────

export interface ApiCostLog {
  userId: string | null;
  chatId?: string | null;
  senderHandle?: string | null;
  provider?: Provider;              // auto-detected from model if not provided
  model: string;
  endpoint: string;                 // 'chat' | 'embeddings' | 'image_gen' | 'transcription' | 'tts'
  description?: string;
  agentName?: string | null;
  messageType?: string;             // 'text' | 'voice' | 'image' | 'group_text' | 'group_voice' | 'proactive'
  tokensIn: number;
  tokensOut: number;
  tokensInCached?: number;
  tokensReasoning?: number;
  costUsdOverride?: number;         // for fixed-price items (DALL-E, Whisper)
  latencyMs?: number;
  agentLoopRound?: number;
  status?: "success" | "error";
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

// ── Logger ───────────────────────────────────────────────────────────────────

export async function logApiCost(
  supabase: SupabaseClient,
  log: ApiCostLog,
): Promise<void> {
  const tokensInCached  = log.tokensInCached  ?? 0;
  const tokensReasoning = log.tokensReasoning ?? 0;
  const provider        = log.provider ?? detectProvider(log.model);

  let costUsd: number;
  let costUsdNoCache: number;

  if (log.costUsdOverride !== undefined) {
    // Fixed-price items (DALL-E images, Whisper minutes, etc.)
    costUsd = log.costUsdOverride;
    costUsdNoCache = log.costUsdOverride;
  } else {
    const breakdown = calculateCostBreakdown(
      log.model,
      log.tokensIn,
      log.tokensOut,
      tokensInCached,
      tokensReasoning,
    );
    costUsd = breakdown.costUsd;
    costUsdNoCache = breakdown.costUsdNoCache;
  }

  const { error } = await supabase
    .from("api_cost_logs")
    .insert({
      user_id:           log.userId,
      chat_id:           log.chatId          ?? null,
      sender_handle:     log.senderHandle    ?? null,
      provider,
      model:             log.model,
      endpoint:          log.endpoint,
      description:       log.description     ?? null,
      agent_name:        log.agentName       ?? null,
      message_type:      log.messageType     ?? "text",
      tokens_in:         log.tokensIn,
      tokens_out:        log.tokensOut,
      tokens_in_cached:  tokensInCached,
      tokens_reasoning:  tokensReasoning,
      cost_usd:          costUsd,
      cost_usd_no_cache: costUsdNoCache,
      latency_ms:        log.latencyMs       ?? null,
      agent_loop_round:  log.agentLoopRound  ?? null,
      status:            log.status          ?? "success",
      error_message:     log.errorMessage    ?? null,
      metadata:          log.metadata        ?? null,
    });

  if (error) {
    console.warn("[cost-tracker] Failed to log API cost:", error.message);
  }
}

// ── Convenience: log a full agent turn (all rounds summed) ───────────────────

export interface AgentTurnCostLog {
  userId: string | null;
  chatId: string;
  senderHandle: string;
  agentName: string;
  model: string;
  messageType: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalInputTokensCached?: number;
  totalReasoningTokens?: number;
  totalLatencyMs: number;
  rounds: number;
  toolsUsed: string[];
  description?: string;
}

export async function logAgentTurnCost(
  supabase: SupabaseClient,
  log: AgentTurnCostLog,
): Promise<void> {
  const toolNames = log.toolsUsed.length > 0
    ? `Agent called: ${log.toolsUsed.join(", ")}`
    : "Agent final response";

  await logApiCost(supabase, {
    userId:         log.userId,
    chatId:         log.chatId,
    senderHandle:   log.senderHandle,
    model:          log.model,
    endpoint:       "chat",
    description:    log.description ?? toolNames,
    agentName:      log.agentName,
    messageType:    log.messageType,
    tokensIn:       log.totalInputTokens,
    tokensOut:      log.totalOutputTokens,
    tokensInCached: log.totalInputTokensCached ?? 0,
    tokensReasoning: log.totalReasoningTokens ?? 0,
    latencyMs:      log.totalLatencyMs,
    metadata: {
      rounds: log.rounds,
      tools_used: log.toolsUsed,
    },
  });
}
