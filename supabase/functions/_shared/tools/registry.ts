import type { ToolContract } from './types.ts';
import { sendReactionTool } from './send-reaction.ts';
import { sendEffectTool } from './send-effect.ts';
import { rememberUserTool } from './remember-user.ts';
import { generateImageTool } from './generate-image.ts';
import { webSearchTool } from './web-search.ts';
import { semanticSearchTool } from './semantic-search.ts';
import { emailReadTool } from './email-read.ts';
import { emailDraftTool, emailSendTool } from './email-write.ts';
import { planStepsTool } from './plan-steps.ts';
import { calendarReadTool } from './calendar-read.ts';
import { calendarWriteTool } from './calendar-write.ts';
import { contactsReadTool } from './contacts-read.ts';

const REGISTRY = new Map<string, ToolContract>();

function register(tool: ToolContract): void {
  if (REGISTRY.has(tool.name)) {
    throw new Error(`Duplicate tool registration: ${tool.name}`);
  }
  REGISTRY.set(tool.name, tool);
}

register(sendReactionTool);
register(sendEffectTool);
register(rememberUserTool);
register(generateImageTool);
register(webSearchTool);
register(semanticSearchTool);
register(emailReadTool);
register(emailDraftTool);
register(emailSendTool);
register(planStepsTool);
register(calendarReadTool);
register(calendarWriteTool);
register(contactsReadTool);

export function getTool(name: string): ToolContract | undefined {
  return REGISTRY.get(name);
}

export function getAllTools(): ToolContract[] {
  return [...REGISTRY.values()];
}

export function getToolNames(): string[] {
  return [...REGISTRY.keys()];
}
