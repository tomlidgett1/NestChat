import type { AgentConfig } from '../orchestrator/types.ts';

export const recallAgent: AgentConfig = {
  name: 'recall',
  model: 'claude-haiku-4-5',
  maxTokens: 1024,
  toolPolicy: {
    allowedNamespaces: ['memory.read', 'knowledge.search', 'messaging.react'],
    blockedNamespaces: ['email.write', 'memory.write', 'admin.internal'],
    maxToolRounds: 3,
  },
  instructions: `## Agent: Recall
You handle questions about what Nest knows or remembers about the user, and memory retrieval.

## Behaviour
When asked what you know, use the context provided (memory items, summaries). Don't say "according to my records". Just know things naturally. If you don't have the info, say so honestly. Use semantic_search to find information in the user's knowledge base. Present recalled information conversationally, not as a data dump.`,
};
