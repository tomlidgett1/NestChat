import type { ToolContract } from './types.ts';

export const sendEffectTool: ToolContract = {
  name: 'send_effect',
  description:
    "Add an expressive iMessage effect to your text response. This attaches a visual animation to the message you send — either a full-screen effect (celebration, fireworks, lasers, etc.) or a bubble effect (slam, loud, gentle, etc.). ONLY use when the moment genuinely calls for it or the user explicitly requests an effect. You MUST also write a text message alongside the effect — the effect enhances the message, it does not replace it. Screen effects fill the entire screen; bubble effects animate just the message bubble. Do NOT use effects on every message — reserve them for celebrations, emphasis, or playful moments.",
  namespace: 'messaging.effect',
  sideEffect: 'commit',
  idempotent: true,
  timeoutMs: 3000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      effect_type: {
        type: 'string',
        enum: ['screen', 'bubble'],
        description: "'screen' fills the entire screen with an animation. 'bubble' animates just the message bubble.",
      },
      effect: {
        type: 'string',
        enum: ['celebration', 'shooting_star', 'fireworks', 'lasers', 'love', 'confetti', 'balloons', 'spotlight', 'echo', 'slam', 'loud', 'gentle', 'invisible'],
        description: "The specific effect. Screen effects: celebration, shooting_star, fireworks, lasers, love, confetti, balloons, spotlight, echo. Bubble effects: slam (big impact), loud (large text), gentle (small fading text), invisible (hidden until tapped).",
      },
    },
    required: ['effect_type', 'effect'],
  },
  handler: async (input) => {
    const inp = input as Record<string, unknown>;
    return {
      content: 'Effect queued.',
      structuredData: {
        effect_type: inp.effect_type,
        effect: inp.effect,
      },
    };
  },
};
