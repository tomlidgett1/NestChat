import type { AgentName, AgentConfig } from './types.ts';
import { casualAgent } from '../agents/casual.ts';
import { productivityAgent } from '../agents/productivity.ts';
import { researchAgent } from '../agents/research.ts';
import { recallAgent } from '../agents/recall.ts';
import { operatorAgent } from '../agents/operator.ts';
import { onboardAgent } from '../agents/onboard.ts';
import { meetingPrepAgent } from '../agents/meeting-prep.ts';

const AGENTS: Record<AgentName, AgentConfig> = {
  casual: casualAgent,
  productivity: productivityAgent,
  research: researchAgent,
  recall: recallAgent,
  operator: operatorAgent,
  onboard: onboardAgent,
  meeting_prep: meetingPrepAgent,
};

export function selectAgent(name: AgentName): AgentConfig {
  return AGENTS[name] ?? AGENTS.casual;
}
