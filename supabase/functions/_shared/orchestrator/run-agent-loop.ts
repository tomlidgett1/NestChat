import Anthropic from 'npm:@anthropic-ai/sdk@0.78.0';
import type {
  AgentConfig,
  TurnContext,
  TurnInput,
  AgentLoopResult,
  ToolCallTrace,
  ToolCallBlockedTrace,
  ToolNamespace,
  Reaction,
  MessageEffect,
  RememberedUser,
  GeneratedImage,
} from './types.ts';
import type { PendingToolCall, ToolContext, ToolExecutionResult } from '../tools/types.ts';
import { toAnthropicTool } from '../tools/types.ts';
import { filterToolsByNamespace } from '../tools/namespace-filter.ts';
import { executePoliciedToolCalls } from '../tools/executor.ts';
import { composePrompt } from '../agents/prompt-layers.ts';

type StandardReactionType = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';

// ═══════════════════════════════════════════════════════════════
// Side-effect extraction from executor structuredData
// ═══════════════════════════════════════════════════════════════

interface SideEffects {
  reaction: Reaction | null;
  effect: MessageEffect | null;
  rememberedUser: RememberedUser | null;
  generatedImage: GeneratedImage | null;
}

function extractSideEffectsFromExecutor(execResults: ToolExecutionResult[]): SideEffects {
  let reaction: Reaction | null = null;
  let effect: MessageEffect | null = null;
  let rememberedUser: RememberedUser | null = null;
  let generatedImage: GeneratedImage | null = null;

  for (const r of execResults) {
    if (!r.structuredData) continue;

    if (r.toolName === 'send_reaction') {
      reaction = { type: r.structuredData.type as StandardReactionType };
    } else if (r.toolName === 'send_effect') {
      effect = {
        type: r.structuredData.effect_type as 'screen' | 'bubble',
        name: r.structuredData.effect as string,
      };
    } else if (r.toolName === 'remember_user' && r.outcome === 'success') {
      rememberedUser = {
        name: r.structuredData.name as string | undefined,
        fact: r.structuredData.fact as string | undefined,
        isForSender: r.structuredData.isForSender as boolean | undefined,
      };
    } else if (r.toolName === 'generate_image') {
      generatedImage = { url: '', prompt: r.structuredData.prompt as string };
    }
  }

  return { reaction, effect, rememberedUser, generatedImage };
}

// ═══════════════════════════════════════════════════════════════
// Main agent loop — handles pause_turn, max_tokens, parallel tools
// ═══════════════════════════════════════════════════════════════

export async function runAgentLoop(
  agent: AgentConfig,
  context: TurnContext,
  input: TurnInput,
  allowedNamespaces: ToolNamespace[],
): Promise<AgentLoopResult> {
  const client = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });

  const systemPrompt = composePrompt(agent, context, input);

  const availableTools = filterToolsByNamespace(allowedNamespaces);
  const anthropicTools: Anthropic.Tool[] = availableTools.map(toAnthropicTool);

  const apiMessages: Anthropic.MessageParam[] = [
    ...context.formattedHistory,
    { role: 'user', content: context.messageContent },
  ];

  const toolCtx: ToolContext = {
    chatId: input.chatId,
    senderHandle: input.senderHandle,
    authUserId: input.authUserId,
  };

  let finalTextParts: string[] = [];
  const allToolTraces: ToolCallTrace[] = [];
  const allBlocked: ToolCallBlockedTrace[] = [];
  const allExecResults: ToolExecutionResult[] = [];
  const toolsUsed: Array<{ tool: string; detail?: string }> = [];
  let roundCount = 0;
  let currentMaxTokens = agent.maxTokens;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const maxRounds = agent.toolPolicy.maxToolRounds;

  console.log(`[agent-loop] starting: agent=${agent.name}, model=${agent.model}, tools=${availableTools.length}, maxRounds=${maxRounds}, promptLen=${systemPrompt.length}`);

  for (let round = 0; round <= maxRounds; round++) {
    roundCount++;
    const roundStart = Date.now();

    const response = await client.messages.create({
      model: agent.model,
      max_tokens: currentMaxTokens,
      system: systemPrompt,
      tools: anthropicTools,
      messages: apiMessages,
    });

    const roundLatency = Date.now() - roundStart;
    totalInputTokens += response.usage?.input_tokens ?? 0;
    totalOutputTokens += response.usage?.output_tokens ?? 0;

    console.log(`[agent-loop] round ${roundCount}/${maxRounds + 1}: stop=${response.stop_reason}, blocks=${response.content.length}, tokens=${response.usage?.input_tokens ?? 0}in/${response.usage?.output_tokens ?? 0}out, ${roundLatency}ms`);

    const roundTextParts: string[] = [];
    const pendingCalls: PendingToolCall[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        roundTextParts.push(block.text);
      } else if (block.type === 'tool_use') {
        pendingCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
        const detail = summariseToolDetail(block.name, block.input as Record<string, unknown>);
        toolsUsed.push({ tool: block.name, ...(detail ? { detail } : {}) });
        console.log(`[agent-loop] tool_use: ${block.name} ${JSON.stringify(block.input).substring(0, 200)}`);
      }
    }

    // Handle max_tokens truncation: if last block is incomplete tool_use, retry with higher limit
    if (response.stop_reason === 'max_tokens') {
      const lastBlock = response.content[response.content.length - 1];
      if (lastBlock?.type === 'tool_use') {
        currentMaxTokens = Math.min(currentMaxTokens * 2, 8192);
        continue;
      }
      finalTextParts = roundTextParts;
      break;
    }

    // Handle pause_turn: append assistant content and continue the loop
    if (response.stop_reason === 'pause_turn') {
      apiMessages.push({ role: 'assistant', content: response.content });
      continue;
    }

    if (response.stop_reason !== 'tool_use' || pendingCalls.length === 0) {
      finalTextParts = roundTextParts;
      break;
    }

    const conversationHistory = context.recentTurns.map(t => ({
      role: t.role,
      content: t.content,
    }));
    conversationHistory.push({ role: 'user', content: input.userMessage });

    const { toolResults, execResults } = await executePoliciedToolCalls(
      pendingCalls,
      toolCtx,
      allowedNamespaces,
      allToolTraces,
      allBlocked,
      conversationHistory,
    );
    allExecResults.push(...execResults);

    apiMessages.push({ role: 'assistant', content: response.content });
    apiMessages.push({ role: 'user', content: toolResults });
  }

  const sideEffects = extractSideEffectsFromExecutor(allExecResults);
  let text = finalTextParts.length > 0 ? finalTextParts.join('\n') : null;

  const commitToolNames = new Set(['email_send', 'calendar_write']);
  for (const exec of allExecResults) {
    if (commitToolNames.has(exec.toolName) && exec.outcome !== 'success') {
      const reason = exec.structuredData?.error ?? exec.outcome;
      console.warn(`[agent-loop] commit tool ${exec.toolName} did not succeed (${exec.outcome}), overriding response`);
      text = `That didn't go through — ${reason}. Want me to try again?`;
      break;
    }
  }

  return {
    text,
    reaction: sideEffects.reaction,
    effect: sideEffects.effect,
    rememberedUser: sideEffects.rememberedUser,
    generatedImage: sideEffects.generatedImage,
    toolCallTraces: allToolTraces,
    toolCallsBlocked: allBlocked,
    rounds: roundCount,
    toolsUsed,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    systemPromptLength: systemPrompt.length,
    systemPrompt,
    initialMessages: [
      ...context.formattedHistory,
      { role: 'user', content: context.messageContent },
    ],
    availableToolNames: availableTools.map(t => t.name),
  };
}

// ═══════════════════════════════════════════════════════════════
// Tool detail summariser for toolsUsed metadata
// ═══════════════════════════════════════════════════════════════

function summariseToolDetail(name: string, input: Record<string, unknown>): string | undefined {
  switch (name) {
    case 'send_reaction':
      return input.type as string;
    case 'send_effect':
      return input.effect as string;
    case 'remember_user': {
      const parts = [
        input.name ? `name: ${input.name}` : '',
        input.fact ? String(input.fact).substring(0, 50) : '',
      ].filter(Boolean);
      return parts.join(', ') || undefined;
    }
    case 'generate_image':
      return (input.prompt as string)?.substring(0, 60);
    case 'semantic_search':
      return (input.query as string)?.substring(0, 60);
    case 'email_read':
      return (input.query as string)?.substring(0, 60) ?? (input.message_id as string)?.substring(0, 30);
    case 'email_draft': {
      const to = Array.isArray(input.to) ? (input.to as string[]).join(', ') : String(input.to ?? '');
      return `draft to: ${to.substring(0, 40)}`;
    }
    case 'email_send':
      return (input.draft_id as string)?.substring(0, 30);
    case 'web_search':
      return undefined;
    default:
      return undefined;
  }
}
