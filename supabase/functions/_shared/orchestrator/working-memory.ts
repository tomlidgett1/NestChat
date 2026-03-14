import { getOpenAIClient, MODEL_MAP, REASONING_EFFORT } from '../ai/models.ts';
import type { WorkingMemory } from './types.ts';
import type { PendingEmailSendAction } from '../state.ts';

const EXTRACTION_PROMPT = `Extract structured working memory from this conversation turn. Return ONLY valid JSON:
{
  "active_topics": ["topic1", "topic2"],
  "unresolved_references": ["reference1"],
  "pending_actions": [{"type": "email_draft", "description": "Draft email to Sarah about timeline"}],
  "last_entity_mentioned": "entity or null"
}

Rules:
- active_topics: What subjects are being discussed right now (max 3)
- unresolved_references: Things mentioned but not yet resolved (e.g. "the email from Sarah" when we haven't searched yet)
- pending_actions: Actions the user expects or that are in progress (e.g. unsent draft, unanswered question)
- last_entity_mentioned: The most recent person, place, or thing referenced
- Be concise. Each topic/reference should be 2-5 words.
- Return empty arrays if nothing applies.`;

export async function extractWorkingMemory(
  userMessage: string,
  assistantResponse: string | null,
  toolsUsed: Array<{ tool: string; detail?: string }>,
  previousMemory: WorkingMemory,
  pendingEmailSends: PendingEmailSendAction[] = [],
): Promise<WorkingMemory> {
  try {
    const client = getOpenAIClient();

    const turnSummary = [
      `User: ${userMessage.substring(0, 200)}`,
      assistantResponse ? `Assistant: ${assistantResponse.substring(0, 200)}` : '',
      toolsUsed.length > 0 ? `Tools used: ${toolsUsed.map(t => t.tool).join(', ')}` : '',
      previousMemory.activeTopics.length > 0 ? `Previous topics: ${previousMemory.activeTopics.join(', ')}` : '',
      previousMemory.pendingActions.length > 0 ? `Previous pending: ${previousMemory.pendingActions.map(a => a.description).join(', ')}` : '',
    ].filter(Boolean).join('\n');

    const response = await client.responses.create({
      model: MODEL_MAP.orchestration,
      instructions: EXTRACTION_PROMPT,
      input: turnSummary,
      max_output_tokens: 1024,
      store: false,
      reasoning: { effort: REASONING_EFFORT.orchestration },
    } as Parameters<typeof client.responses.create>[0]);

    const text = response.output_text;
    if (!text) return previousMemory;

    const parsed = JSON.parse(text);

    const llmPendingActions = (parsed.pending_actions ?? []).slice(0, 5).map((a: Record<string, string>) => ({
      type: a.type ?? 'unknown',
      description: a.description ?? '',
      createdTurnId: '',
    }));
    const nonEmailPendingActions = llmPendingActions.filter((a) => !/^(email_draft|email_send|draft)$/i.test(a.type));
    const durableEmailPendingActions = pendingEmailSends.map((action) => ({
      type: 'email_send',
      description: `Send draft to ${action.to.join(', ') || 'recipient'}${action.subject ? ` (${action.subject})` : ''}`,
      createdTurnId: action.sourceTurnId ?? '',
    }));

    return {
      activeTopics: (parsed.active_topics ?? []).slice(0, 5),
      unresolvedReferences: (parsed.unresolved_references ?? []).slice(0, 5),
      pendingActions: [...nonEmailPendingActions, ...durableEmailPendingActions].slice(0, 5),
      lastEntityMentioned: parsed.last_entity_mentioned ?? null,
    };
  } catch (err) {
    console.warn('[working-memory] extraction failed:', (err as Error).message);
    return previousMemory;
  }
}

export async function persistWorkingMemory(chatId: string, memory: WorkingMemory): Promise<void> {
  try {
    const { getAdminClient } = await import('../supabase.ts');
    const supabase = getAdminClient();

    await supabase
      .from('conversations')
      .update({ working_memory: memory })
      .eq('chat_id', chatId);
  } catch (err) {
    console.warn('[working-memory] persist failed:', (err as Error).message);
  }
}

export async function loadWorkingMemory(chatId: string): Promise<WorkingMemory | null> {
  try {
    const { getAdminClient } = await import('../supabase.ts');
    const supabase = getAdminClient();

    const { data } = await supabase
      .from('conversations')
      .select('working_memory')
      .eq('chat_id', chatId)
      .maybeSingle();

    if (data?.working_memory) {
      return data.working_memory as WorkingMemory;
    }
    return null;
  } catch (err) {
    console.warn('[working-memory] load failed:', (err as Error).message);
    return null;
  }
}
