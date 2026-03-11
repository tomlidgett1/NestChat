import type { ToolContract } from './types.ts';

export const planStepsTool: ToolContract = {
  name: 'plan_steps',
  description:
    "Decompose a complex multi-step request into an ordered plan of discrete steps. Use this tool BEFORE executing a complex workflow that involves multiple tools or actions (e.g. 'find my latest email from Sarah, summarise it, and draft a reply'). This helps you stay organised, gives the user visibility into what you're about to do, and ensures you don't miss steps. Each step should describe a single action. After creating the plan, execute each step in order, updating the user on progress. Do NOT use this for simple single-tool requests — only for workflows with 3+ steps or cross-domain actions.",
  namespace: 'memory.read',
  sideEffect: 'read',
  idempotent: true,
  timeoutMs: 3000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      goal: {
        type: 'string',
        description: "The user's overall goal or request, in your own words.",
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            step_number: { type: 'number', description: 'Step order (1, 2, 3...)' },
            action: { type: 'string', description: 'What this step does (e.g. "Search email for latest from Sarah")' },
            tool: { type: 'string', description: 'Which tool to use (e.g. "email_read", "email_draft", "email_send", "semantic_search")' },
            depends_on: { type: 'number', description: 'Step number this depends on (0 if independent)' },
          },
          required: ['step_number', 'action', 'tool'],
        },
        description: 'Ordered list of steps to execute.',
      },
    },
    required: ['goal', 'steps'],
  },
  inputExamples: [
    {
      goal: "Find Sarah's latest email about the timeline, summarise it, and draft a reply agreeing",
      steps: [
        { step_number: 1, action: 'Search email for latest from Sarah about timeline', tool: 'email_read', depends_on: 0 },
        { step_number: 2, action: 'Get full email content', tool: 'email_read', depends_on: 1 },
        { step_number: 3, action: 'Draft reply agreeing with timeline', tool: 'email_draft', depends_on: 2 },
      ],
    },
  ],
  handler: async (input) => {
    const goal = input.goal as string;
    const steps = input.steps as Array<{ step_number: number; action: string; tool: string; depends_on?: number }>;

    const planSummary = steps
      .map(s => `${s.step_number}. ${s.action} (${s.tool})`)
      .join('\n');

    return {
      content: `Plan created for: ${goal}\n\n${planSummary}\n\nExecuting steps now.`,
      structuredData: {
        goal,
        steps,
        stepCount: steps.length,
      },
    };
  },
};
