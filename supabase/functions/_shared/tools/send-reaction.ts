import type { ToolContract } from './types.ts';

export const sendReactionTool: ToolContract = {
  name: 'send_reaction',
  description:
    "React to the user's most recent message with an emoji. Standard iMessage tapbacks are 'love' (❤️), 'like' (👍), 'dislike' (👎), 'laugh' (😂), 'emphasize' (‼️), and 'question' (❓). You can also react with any emoji by setting type to 'custom' and providing the emoji in custom_emoji. Do NOT use this as a substitute for a text reply — always pair it with a text response when the user expects a conversational answer. Avoid overusing reactions in group chats as it can feel spammy.",
  namespace: 'messaging.react',
  sideEffect: 'commit',
  idempotent: true,
  timeoutMs: 3000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'custom'],
        description: "The reaction type. Standard tapbacks: 'love' = ❤️, 'like' = 👍, 'dislike' = 👎, 'laugh' = 😂, 'emphasize' = ‼️, 'question' = ❓. Use 'custom' for any other emoji.",
      },
      custom_emoji: {
        type: 'string',
        description: "The emoji to react with when type is 'custom'. Must be a single emoji character (e.g. 🔥, 🎉, 💯).",
      },
    },
    required: ['type'],
  },
  handler: async (input) => {
    const args = input as Record<string, unknown>;
    const data: Record<string, unknown> = { type: args.type };
    if (args.type === 'custom' && args.custom_emoji) {
      data.custom_emoji = args.custom_emoji;
    }
    return {
      content: 'Reaction sent.',
      structuredData: data,
    };
  },
};
