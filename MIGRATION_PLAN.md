# Nest V3: Anthropic → OpenAI Responses API Migration Plan

## Summary of Changes

The codebase currently uses `@anthropic-ai/sdk` for all LLM calls (agent loop, router, classifier, proactive messages, group chat classification, effect text generation). It also uses `openai` SDK for DALL-E image generation, Whisper transcription, and embeddings — these stay as-is.

**Goal:** Replace all Anthropic `client.messages.create()` calls with OpenAI `client.responses.create()` using the Responses API. Make model selection easy to swap for casual vs agentic use cases.

---

## Phase 0: Model Configuration Layer (new file)

**Create `supabase/functions/_shared/models.ts`**

A single source of truth for model selection, making it trivial to swap models.

```ts
// models.ts — Central model configuration

export type ModelTier = 'fast' | 'standard' | 'reasoning';

export interface ModelConfig {
  id: string;
  tier: ModelTier;
  maxOutputTokens: number;
}

const MODELS: Record<ModelTier, ModelConfig> = {
  fast:      { id: 'gpt-4.1-mini', tier: 'fast', maxOutputTokens: 1024 },
  standard:  { id: 'gpt-4.1',      tier: 'standard', maxOutputTokens: 2048 },
  reasoning: { id: 'o4-mini',      tier: 'reasoning', maxOutputTokens: 4096 },
};

// Override via env vars: MODEL_FAST, MODEL_STANDARD, MODEL_REASONING
export function getModel(tier: ModelTier): ModelConfig {
  const envKey = `MODEL_${tier.toUpperCase()}`;
  const override = Deno.env.get(envKey);
  if (override) return { ...MODELS[tier], id: override };
  return MODELS[tier];
}

// Map old Anthropic model names → tiers for agent configs
export function anthropicModelToTier(model: string): ModelTier {
  if (model.includes('haiku')) return 'fast';
  if (model.includes('sonnet')) return 'standard';
  if (model.includes('opus')) return 'reasoning';
  return 'standard';
}
```

**Agent configs updated to use tiers instead of hardcoded model strings:**
- `casual` → `'fast'`
- `onboard` → `'fast'`
- `recall` → `'fast'`
- `productivity` → `'standard'`
- `research` → `'standard'`
- `operator` → `'standard'`
- `meeting_prep` → `'standard'`

---

## Phase 1: OpenAI Client & Tool Conversion (modify existing files)

### 1a. Update `supabase/functions/_shared/claude.ts` → rename to `llm.ts`

Replace the Anthropic client with OpenAI client for all LLM calls. Keep the OpenAI client for image gen (already there).

**Before:**
```ts
import Anthropic from 'npm:@anthropic-ai/sdk@0.78.0';
const client = new Anthropic({ apiKey: ... });
```

**After:**
```ts
import OpenAI from 'npm:openai@6.16.0';
const client = new OpenAI({ apiKey: Deno.env.get('OPENAI_API_KEY') });
```

**Functions to migrate in this file:**
1. `getTextForEffect()` — simple text generation, trivial mapping
2. `getGroupChatAction()` — classification with system prompt + history

Both use `client.messages.create()` → `client.responses.create()`.

### 1b. Update `supabase/functions/_shared/tools/types.ts`

**Change `ToolContract.inputSchema` type from `Anthropic.Tool['input_schema']` to OpenAI function format.**

Replace `toAnthropicTool()` with `toOpenAITool()`:

```ts
export function toOpenAITool(contract: ToolContract): OpenAI.Responses.Tool {
  if (contract.name === 'web_search') {
    return { type: 'web_search_preview' };
  }
  return {
    type: 'function',
    name: contract.name,
    description: contract.description,
    parameters: contract.inputSchema,   // JSON Schema — same format, just different wrapper
    strict: contract.strict ?? false,
  };
}
```

The `inputSchema` objects are JSON Schema and work identically for both Anthropic and OpenAI — no schema changes needed.

### 1c. Update `supabase/functions/_shared/tools/executor.ts`

Replace Anthropic types with OpenAI equivalents:

| Anthropic Type | OpenAI Responses API Equivalent |
|---|---|
| `Anthropic.ToolResultBlockParam` | `{ type: 'function_call_output', call_id: string, output: string }` |

The executor logic stays the same — just the return shape changes.

---

## Phase 2: Agent Loop Migration (the core change)

### File: `supabase/functions/_shared/orchestrator/run-agent-loop.ts`

This is the heart of the migration. The Anthropic tool-use loop maps cleanly to the OpenAI Responses API.

**Key mapping:**

| Anthropic Messages API | OpenAI Responses API |
|---|---|
| `client.messages.create({ model, system, messages, tools, max_tokens })` | `client.responses.create({ model, instructions, input, tools, max_output_tokens })` |
| `system` (string) | `instructions` (string) |
| `messages` (array of `{role, content}`) | `input` (array of input items) |
| `tools` (Anthropic tool format) | `tools` (OpenAI function/built-in format) |
| `max_tokens` | `max_output_tokens` |
| `tool_choice` | `tool_choice` (same concept) |
| Response: `content` blocks (`text`, `tool_use`) | Response: `output` items (`message` with `output_text`, `function_call`) |
| `stop_reason: 'tool_use'` | Check for `function_call` items in `output` |
| `stop_reason: 'end_turn'` | `status: 'completed'` with no function calls |
| `stop_reason: 'max_tokens'` | `status: 'incomplete'` with `incomplete_details.reason: 'max_output_tokens'` |
| Tool result: `{ type: 'tool_result', tool_use_id, content }` | Tool result: `{ type: 'function_call_output', call_id, output }` |

**Conversation continuation pattern:**

Anthropic requires manually appending assistant content + tool results to the messages array. OpenAI Responses API can do the same — pass the full conversation as `input`:

```ts
// Build input for OpenAI Responses API
const input: OpenAI.Responses.ResponseInput = [];

// System instructions go in `instructions` param, not in input

// History messages
for (const msg of context.formattedHistory) {
  input.push({
    role: msg.role as 'user' | 'assistant',
    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
  });
}

// Current user message
input.push({
  role: 'user',
  content: context.messageContent,  // needs conversion from Anthropic content blocks
});
```

**Tool loop (pseudo-code):**

```ts
for (let round = 0; round <= maxRounds; round++) {
  const response = await client.responses.create({
    model: effectiveModel,
    instructions: systemPrompt,
    input: inputItems,
    tools: openaiTools,
    max_output_tokens: currentMaxTokens,
    ...(useToolChoice ? { tool_choice: useToolChoice } : {}),
  });

  // Extract text outputs and function calls from response.output
  for (const item of response.output) {
    if (item.type === 'message') {
      for (const content of item.content) {
        if (content.type === 'output_text') {
          roundTextParts.push(content.text);
        }
      }
    } else if (item.type === 'function_call') {
      pendingCalls.push({
        id: item.call_id,
        name: item.name,
        input: JSON.parse(item.arguments),
      });
    }
  }

  // If no function calls, we're done
  if (pendingCalls.length === 0) break;

  // Execute tools, then append results to input for next round
  const { toolResults, execResults } = await executePoliciedToolCalls(...);

  // Append assistant output + tool results for next round
  inputItems.push(...response.output);  // assistant's output
  for (const result of toolResults) {
    inputItems.push({
      type: 'function_call_output',
      call_id: result.call_id,
      output: result.output,
    });
  }
}
```

**Web search migration:**
- Anthropic: `{ type: 'web_search_20250305', name: 'web_search' }`
- OpenAI: `{ type: 'web_search_preview' }`

The web search tool is handled natively by both APIs — this is a 1:1 swap.

---

## Phase 3: Router Migration

### File: `supabase/functions/_shared/orchestrator/route-turn.ts`

The LLM router uses `client.messages.create()` for classification. Migrate to Responses API:

```ts
// Before
const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 150,
  system: ROUTER_SYSTEM,
  messages: buildRouterMessages(input, context),
});

// After
const response = await client.responses.create({
  model: getModel('standard').id,
  max_output_tokens: 150,
  instructions: ROUTER_SYSTEM,
  input: buildRouterInput(input, context),   // convert MessageParam[] → ResponseInput
});
```

Also update `buildRouterMessages()` to return OpenAI-compatible input format.

---

## Phase 4: Classifier Migration

### File: `supabase/functions/_shared/classifier.ts`

Simple classification call — straightforward migration:

```ts
// Before
const response = await client.messages.create({
  model: 'claude-haiku-4-5',
  max_tokens: 200,
  system: CLASSIFIER_PROMPT,
  messages: [{ role: 'user', content: userContent }],
});

// After
const response = await client.responses.create({
  model: getModel('fast').id,
  max_output_tokens: 200,
  instructions: CLASSIFIER_PROMPT,
  input: userContent,
});
```

---

## Phase 5: Proactive Messages Migration

### File: `supabase/functions/_shared/proactive.ts`

Four LLM calls to migrate (all simple text generation):
1. `generateRecoveryNudge()`
2. `generateMorningCheckin()`
3. `generateMemoryMomentMessage()`
4. The `client` instance at module level

All follow the same pattern as the classifier — system prompt + single user message.

---

## Phase 6: Context & Type Updates

### 6a. `supabase/functions/_shared/orchestrator/types.ts`

Remove `import type Anthropic` and replace Anthropic-specific types:

| Current (Anthropic) | New (OpenAI) |
|---|---|
| `Anthropic.MessageParam` in `TurnContext.formattedHistory` | `{ role: 'user' \| 'assistant'; content: string }` (simple interface) |
| `Anthropic.ContentBlockParam` in `TurnContext.messageContent` | `Array<{ type: 'input_text'; text: string } \| { type: 'input_image'; image_url: string }>` |

### 6b. `supabase/functions/_shared/orchestrator/build-context.ts`

- Remove `import type Anthropic`
- Update `formatHistoryForClaude()` → `formatHistoryForLLM()` — returns simple `{ role, content }` objects (already compatible)
- Update `buildMessageContent()` to return OpenAI-compatible content blocks:
  - Image: `{ type: 'input_image', image_url: url }` instead of `{ type: 'image', source: { type: 'url', url } }`
  - Text: `{ type: 'input_text', text: '...' }` instead of `{ type: 'text', text: '...' }`

### 6c. `supabase/functions/_shared/agents/prompt-layers.ts`

- Remove `import type Anthropic`
- Update type references to use new simple types

---

## Phase 7: Package & Import Cleanup

### 7a. Remove Anthropic SDK dependency

**`package.json`:** Remove `"@anthropic-ai/sdk": "^0.39.0"` from dependencies.

**All Deno imports:** Remove every `import Anthropic from 'npm:@anthropic-ai/sdk@0.78.0'` and `import type Anthropic from 'npm:@anthropic-ai/sdk@0.78.0'`.

### 7b. Environment variables

**Remove:** `ANTHROPIC_API_KEY` (no longer needed)
**Keep:** `OPENAI_API_KEY` (already exists, now used for LLM calls too)
**Add:** `MODEL_FAST`, `MODEL_STANDARD`, `MODEL_REASONING` (optional overrides)

### 7c. Update `.env.example`

Remove `ANTHROPIC_API_KEY`, add model override vars.

---

## Phase 8: Agent Config Updates

Update each agent file to use model tiers:

| File | Current Model | New Tier |
|---|---|---|
| `agents/casual.ts` | `claude-haiku-4-5` | `'fast'` |
| `agents/onboard.ts` | `claude-haiku-4-5` | `'fast'` |
| `agents/recall.ts` | `claude-haiku-4-5` | `'fast'` |
| `agents/productivity.ts` | `claude-sonnet-4-6` | `'standard'` |
| `agents/research.ts` | `claude-sonnet-4-5-20250929` | `'standard'` |
| `agents/operator.ts` | `claude-sonnet-4-6` | `'standard'` |
| `agents/meeting-prep.ts` | `claude-sonnet-4-6` | `'standard'` |

Update `AgentConfig.model` type from `string` to `ModelTier`.

Update `resolveModel()` in `run-agent-loop.ts` to use the new tier system.

---

## Files Changed (Complete List)

| # | File | Action |
|---|---|---|
| 1 | `_shared/models.ts` | **NEW** — Model tier config |
| 2 | `_shared/claude.ts` → `_shared/llm.ts` | **RENAME + REWRITE** — OpenAI Responses API |
| 3 | `_shared/tools/types.ts` | **EDIT** — Remove Anthropic types, add `toOpenAITool()` |
| 4 | `_shared/tools/executor.ts` | **EDIT** — Swap Anthropic result types for OpenAI |
| 5 | `_shared/tools/web-search.ts` | **EDIT** — Update tool type to `web_search_preview` |
| 6 | `_shared/orchestrator/run-agent-loop.ts` | **REWRITE** — Core loop using Responses API |
| 7 | `_shared/orchestrator/route-turn.ts` | **EDIT** — Swap LLM client + types |
| 8 | `_shared/orchestrator/types.ts` | **EDIT** — Remove Anthropic types, use simple interfaces |
| 9 | `_shared/orchestrator/build-context.ts` | **EDIT** — Update content block formats |
| 10 | `_shared/classifier.ts` | **EDIT** — Swap to Responses API |
| 11 | `_shared/proactive.ts` | **EDIT** — Swap to Responses API |
| 12 | `_shared/agents/casual.ts` | **EDIT** — Use model tier |
| 13 | `_shared/agents/onboard.ts` | **EDIT** — Use model tier |
| 14 | `_shared/agents/recall.ts` | **EDIT** — Use model tier |
| 15 | `_shared/agents/productivity.ts` | **EDIT** — Use model tier |
| 16 | `_shared/agents/research.ts` | **EDIT** — Use model tier |
| 17 | `_shared/agents/operator.ts` | **EDIT** — Use model tier |
| 18 | `_shared/agents/meeting-prep.ts` | **EDIT** — Use model tier |
| 19 | `_shared/agents/prompt-layers.ts` | **EDIT** — Remove Anthropic type imports |
| 20 | `_shared/agents/base-instructions.ts` | No change (pure string, no SDK types) |
| 21 | `package.json` | **EDIT** — Remove `@anthropic-ai/sdk` |
| 22 | `.env.example` | **EDIT** — Update env vars |

**Files NOT changed:**
- `_shared/rag-tools.ts` — Already uses OpenAI embeddings API directly
- `_shared/embedder.ts` — Uses rag-tools, no Anthropic dependency
- `_shared/sendblue.ts` — Messaging, no LLM dependency
- `_shared/state.ts` — Database state, no LLM dependency
- `_shared/supabase.ts` — Database client
- `_shared/memory.ts` — Memory logic, no direct LLM calls
- All edge functions (`sendblue-webhook/`, etc.) — Call `handleTurn()`, no direct LLM use
- `_shared/tools/*.ts` (individual tools) — Tool handlers, no Anthropic types in signatures

---

## Execution Order

1. **Phase 0** — Create `models.ts` (no dependencies, can be done first)
2. **Phase 6** — Update types in `types.ts`, `build-context.ts`, `prompt-layers.ts` (foundation for everything else)
3. **Phase 1b** — Update `tools/types.ts` with `toOpenAITool()`
4. **Phase 1c** — Update `tools/executor.ts` result types
5. **Phase 1a** — Migrate `claude.ts` → `llm.ts`
6. **Phase 2** — Migrate `run-agent-loop.ts` (biggest change)
7. **Phase 3** — Migrate `route-turn.ts`
8. **Phase 4** — Migrate `classifier.ts`
9. **Phase 5** — Migrate `proactive.ts`
10. **Phase 8** — Update all agent configs to use tiers
11. **Phase 7** — Remove Anthropic SDK, update env vars
12. **Phase 1b addendum** — Update `web-search.ts` tool type

---

## Risk Notes

1. **OpenAI tool_choice format** differs slightly — Anthropic uses `{ type: 'any' }`, OpenAI uses `'required'` or `{ type: 'function', name: '...' }`. Need to map in `run-agent-loop.ts`.

2. **Image content blocks** — Anthropic uses `{ type: 'image', source: { type: 'url', url } }`, OpenAI uses `{ type: 'input_image', image_url: url }`. Handled in `build-context.ts`.

3. **Response text extraction** — Anthropic: `response.content[0].text`, OpenAI: `response.output_text` or iterate `response.output` for message items.

4. **Web search** — Both support native web search as a built-in tool. Anthropic uses `web_search_20250305`, OpenAI uses `web_search_preview`. The `server_tool_use` block handling in the agent loop needs to be updated to handle OpenAI's web search result format.

5. **stop_reason mapping** — Anthropic `stop_reason` values vs OpenAI `status` + `incomplete_details`. The `pause_turn` handling may not have a direct equivalent — need to handle via `status: 'incomplete'`.

6. **No `previous_response_id`** — We manage conversation history manually (same as current approach with Anthropic), which maps cleanly to passing full `input` arrays. We do NOT use `previous_response_id` since we manage state in Supabase.
