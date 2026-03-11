export interface EvalTask {
  id: string;
  description: string;
  message: string;
  expectedAgent: string;
  expectedTools?: string[];
  mustNotRoute?: string[];
  expectNonEmpty: boolean;
  maxLatencyMs?: number;
  isOnboarding?: boolean;
  onboardCount?: number;
  tags: string[];
}

export const EVAL_TASKS: EvalTask[] = [
  // Casual agent
  {
    id: 'casual-greeting',
    description: 'Simple greeting should route to casual',
    message: 'hey whats up',
    expectedAgent: 'casual',
    expectNonEmpty: true,
    tags: ['casual', 'routing'],
  },
  {
    id: 'casual-advice',
    description: 'Life advice request should route to casual',
    message: "I'm feeling really stressed about work lately, any advice?",
    expectedAgent: 'casual',
    expectNonEmpty: true,
    tags: ['casual', 'emotional'],
  },

  // Research agent
  {
    id: 'research-factual',
    description: 'Factual question should route to research',
    message: 'What is the population of Melbourne?',
    expectedAgent: 'research',
    expectNonEmpty: true,
    tags: ['research', 'routing'],
  },
  {
    id: 'research-current-events',
    description: 'Current events should route to research with web search',
    message: 'What happened in the news today?',
    expectedAgent: 'research',
    expectedTools: ['web_search'],
    expectNonEmpty: true,
    tags: ['research', 'web_search'],
  },

  // Recall agent
  {
    id: 'recall-memory',
    description: 'Memory recall should route to recall',
    message: 'What do you know about me?',
    expectedAgent: 'recall',
    expectNonEmpty: true,
    tags: ['recall', 'routing'],
  },
  {
    id: 'recall-specific',
    description: 'Specific memory question should route to recall',
    message: 'Do you remember where I work?',
    expectedAgent: 'recall',
    expectNonEmpty: true,
    tags: ['recall', 'routing'],
  },

  // Productivity agent
  {
    id: 'productivity-email-search',
    description: 'Email search should route to productivity and use email_read',
    message: 'Search my email for the latest message from Sarah about the project timeline',
    expectedAgent: 'productivity',
    expectedTools: ['email_read'],
    expectNonEmpty: true,
    tags: ['productivity', 'email'],
  },
  {
    id: 'productivity-draft',
    description: 'Draft email should route to productivity and use email_draft',
    message: 'Draft an email to tom@example.com about rescheduling our Friday meeting to Monday',
    expectedAgent: 'productivity',
    expectedTools: ['email_draft'],
    expectNonEmpty: true,
    tags: ['productivity', 'email', 'draft'],
  },

  // Memory save
  {
    id: 'memory-save',
    description: 'Personal info should trigger remember_user',
    message: "I'm allergic to shellfish and I live in Melbourne",
    expectedAgent: 'casual',
    expectedTools: ['remember_user'],
    expectNonEmpty: true,
    tags: ['memory', 'remember_user'],
  },

  // Slash commands
  {
    id: 'slash-help',
    description: '/help should return help text without LLM',
    message: '/help',
    expectedAgent: 'casual',
    expectNonEmpty: true,
    maxLatencyMs: 500,
    tags: ['slash', 'deterministic'],
  },
  {
    id: 'slash-memory',
    description: '/memory should return memory list without LLM',
    message: '/memory',
    expectedAgent: 'casual',
    expectNonEmpty: true,
    maxLatencyMs: 2000,
    tags: ['slash', 'deterministic'],
  },

  // Onboarding
  {
    id: 'onboard-first-message',
    description: 'First onboarding message should be warm and brief',
    message: 'Hey, what is this?',
    expectedAgent: 'onboard',
    expectNonEmpty: true,
    isOnboarding: true,
    onboardCount: 0,
    tags: ['onboarding', 'first_message'],
  },
  {
    id: 'onboard-second-message-task',
    description: 'Second message with task should trigger entry state classification',
    message: 'Can you help me draft an email to my boss about taking Friday off?',
    expectedAgent: 'onboard',
    expectNonEmpty: true,
    isOnboarding: true,
    onboardCount: 1,
    tags: ['onboarding', 'entry_state', 'drafting'],
  },
  {
    id: 'onboard-fifth-message',
    description: 'Fifth message should include verification link',
    message: 'This is really helpful, how do I sign up properly?',
    expectedAgent: 'onboard',
    expectNonEmpty: true,
    isOnboarding: true,
    onboardCount: 5,
    tags: ['onboarding', 'verification'],
  },

  // Operator agent
  {
    id: 'operator-complex',
    description: 'Complex multi-step request should route to operator',
    message: 'Find my latest email from Sarah, summarise it, and draft a reply saying I agree with her timeline',
    expectedAgent: 'operator',
    expectedTools: ['email_read', 'email_draft'],
    expectNonEmpty: true,
    tags: ['operator', 'multi_step'],
  },
];
