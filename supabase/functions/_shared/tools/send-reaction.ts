import type { ToolContract } from './types.ts';

export const sendReactionTool: ToolContract = {
  name: 'send_reaction',
  description:
    "Send an iMessage tapback reaction to the user's most recent message. Use this to acknowledge messages with a quick visual response — for example, 'love' for something heartfelt, 'laugh' for something funny, 'emphasize' to highlight importance, or 'like' as a general acknowledgement. Only use standard iMessage tapback types. Do NOT use this as a substitute for a text reply — always pair it with a text response when the user expects a conversational answer. Avoid overusing reactions in group chats as it can feel spammy.",
  namespace: 'messaging.react',
  sideEffect: 'commit',
  idempotent: true,
  timeoutMs: 3000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'],
        description: "The tapback reaction type. 'love' = heart, 'like' = thumbs up, 'dislike' = thumbs down, 'laugh' = ha ha, 'emphasize' = double exclamation, 'question' = question mark.",
      },
    },
    required: ['type'],
  },
  handler: async (input) => {
    return {
      content: 'Reaction sent.',
      structuredData: { type: (input as Record<string, unknown>).type },
    };
  },
};
