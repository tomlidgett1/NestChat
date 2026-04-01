import type { ToolContract } from './types.ts';

export const editImageTool: ToolContract = {
  name: 'edit_image',
  description:
    "Edit or transform an image the user has sent using AI (Nano Banana Pro 2). Use this when the user sends you an image AND asks you to change, edit, transform, remix, restyle, or modify it — e.g. 'make this cartoon', 'add sunglasses', 'turn this into a watercolour'. You MUST have received an image from the user in this message to use this tool. Expand the user's request into a clear, descriptive editing prompt. You MUST also write a short text reply alongside (e.g. 'here's your edit!'). The edited image will be sent after your text reply.",
  namespace: 'media.generate',
  sideEffect: 'commit',
  idempotent: false,
  timeoutMs: 30000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: "A clear description of how to edit the image. Be specific about the desired changes. E.g. 'Transform this photo into a Studio Ghibli anime style illustration' or 'Add a party hat and confetti to this photo'.",
      },
    },
    required: ['prompt'],
  },
  inputExamples: [
    { prompt: 'Transform this photo into a vibrant pop art style with bold colours and halftone dots' },
    { prompt: 'Make this look like a watercolour painting with soft washes and visible brush strokes' },
    { prompt: 'Add dramatic sunset lighting and lens flare to this outdoor photo' },
  ],
  handler: async (input) => {
    const prompt = (input as Record<string, unknown>).prompt as string;
    return {
      content: 'Image edit queued. The edited image will be sent after your text reply.',
      structuredData: { prompt, isEdit: true },
    };
  },
};
