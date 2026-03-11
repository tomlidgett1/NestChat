import type { ToolContract } from './types.ts';

export const generateImageTool: ToolContract = {
  name: 'generate_image',
  description:
    "Generate an image using DALL-E based on a text prompt. Use this when the user asks you to create, draw, generate, or make an image, picture, illustration, or artwork. Expand the user's request into a detailed, descriptive prompt that will produce a high-quality image — include style, composition, colours, and mood. You MUST also write a short text reply alongside the image (e.g. 'here you go!' or a brief description). The image will be sent after your text reply. Do NOT use this for text-heavy content like charts or documents — it's best for creative and visual content.",
  namespace: 'media.generate',
  sideEffect: 'commit',
  idempotent: false,
  timeoutMs: 15000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: "A detailed image generation prompt. Be specific about style, subject, composition, lighting, and mood. E.g. 'A cosy Australian cafe at sunset, watercolour style, warm golden tones, with a flat white on a wooden table'.",
      },
    },
    required: ['prompt'],
  },
  inputExamples: [
    { prompt: 'A golden retriever puppy playing in autumn leaves, soft natural lighting, candid photography style' },
    { prompt: 'Minimalist logo design for a tech startup called Nest, clean lines, blue and white colour palette, modern sans-serif' },
  ],
  handler: async (input) => {
    const prompt = (input as Record<string, unknown>).prompt as string;
    return {
      content: 'Image generation queued. It will be sent after your text reply.',
      structuredData: { prompt },
    };
  },
};
