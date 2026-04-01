import type { ToolContract } from './types.ts';

export const rememberUserTool: ToolContract = {
  name: 'remember_user',
  description:
    "Save or update information about someone in Nest's memory. Use this when you learn genuinely NEW information about the user (name, location, job, preferences, interests, relationships, etc.) or when someone CORRECTS previously saved information (e.g. 'actually I live in Sydney not Melbourne'). For location facts, prefer precise phrasing like 'Lives in Melbourne', 'Currently in London this week', or 'Often works from Southbank' so Nest can tell home, current, and frequent locations apart. Do NOT re-save information that is already in the context — check the memory items provided before calling this tool. You MUST also write a text response alongside this tool call. Include a semantic category when possible to help organise memories. This tool persists data permanently until the user deletes it.",
  namespace: 'memory.write',
  sideEffect: 'commit',
  idempotent: false,
  timeoutMs: 8000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      handle: {
        type: 'string',
        description: "The handle of the person to remember info about. Omit this to save info about the current sender (most common case). Only provide if saving info about someone other than the sender.",
      },
      name: {
        type: 'string',
        description: "The person's name, if they've shared it or you've learned it. This updates their display name in the system.",
      },
      fact: {
        type: 'string',
        description: "A concise factual statement about the person. Write it as a standalone fact, e.g. 'Lives in Melbourne', 'Works at Anthropic as an engineer', 'Allergic to shellfish', 'Supports Manchester United'.",
      },
      category: {
        type: 'string',
        description: "Semantic category for the fact. Use one of: location, employment, education, age, birthday, relationship_status, nationality, native_language, sport_team, music, food, pet, hobby, interest, skill, travel, health, preference, language, or general.",
      },
    },
    required: ['fact'],
  },
  inputExamples: [
    { fact: 'Lives in Melbourne, Australia', category: 'location' },
    { fact: 'Currently in London this week', category: 'location' },
    { fact: 'Often works from Southbank', category: 'location' },
    { name: 'Sarah', fact: 'Works at Google as a product manager', category: 'employment' },
    { fact: 'Allergic to shellfish', category: 'health' },
    { handle: '+61400000000', name: 'Tom', fact: 'Prefers morning meetings', category: 'preference' },
  ],
  handler: async (input, ctx) => {
    const targetHandle = (input.handle as string) || ctx.senderHandle;
    let nameChanged = false;
    let factChanged = false;

    if (input.name) {
      const { setUserName } = await import('../state.ts');
      nameChanged = await setUserName(targetHandle, input.name as string);
    }
    if (input.fact) {
      const { addUserFact } = await import('../state.ts');
      factChanged = await addUserFact(targetHandle, input.fact as string);
    }

    try {
      const { processRealtimeMemory } = await import('../memory.ts');
      await processRealtimeMemory(
        targetHandle,
        (input.fact as string) || '',
        input.name as string | undefined,
        ctx.chatId,
        input.category as string | undefined,
      );
    } catch (err) {
      console.error('[remember-user] Memory v2 write failed:', err);
    }

    const resultMsg = (nameChanged || factChanged)
      ? 'Saved successfully.'
      : 'Already known, no update needed.';

    return {
      content: resultMsg,
      structuredData: {
        nameChanged,
        factChanged,
        name: nameChanged ? input.name : undefined,
        fact: factChanged ? input.fact : undefined,
        isForSender: !input.handle || input.handle === ctx.senderHandle,
      },
    };
  },
};
