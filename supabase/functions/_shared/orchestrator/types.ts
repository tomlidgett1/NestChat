import type { Reaction, MessageEffect, MessageService, ExtractedMedia } from '../sendblue.ts';
import type {
  StoredMessage,
  MemoryItem,
  ConversationSummary,
  ToolTrace,
  UserProfile,
  ConnectedAccount,
  NestUser,
} from '../state.ts';
import type Anthropic from 'npm:@anthropic-ai/sdk@0.78.0';

// ═══════════════════════════════════════════════════════════════
// Agent taxonomy
// ═══════════════════════════════════════════════════════════════

export type AgentName =
  | 'casual'
  | 'productivity'
  | 'research'
  | 'recall'
  | 'operator'
  | 'onboard'
  | 'meeting_prep';

// ═══════════════════════════════════════════════════════════════
// Tool namespaces & side-effect classification
// ═══════════════════════════════════════════════════════════════

export type ToolNamespace =
  | 'memory.read'
  | 'memory.write'
  | 'email.read'
  | 'email.write'
  | 'calendar.read'
  | 'calendar.write'
  | 'contacts.read'
  | 'web.search'
  | 'knowledge.search'
  | 'messaging.react'
  | 'messaging.effect'
  | 'media.generate'
  | 'admin.internal';

export type SideEffect = 'read' | 'draft' | 'commit';

// ═══════════════════════════════════════════════════════════════
// Prompt composition
// ═══════════════════════════════════════════════════════════════

export type PromptLayer = 'identity' | 'agent' | 'context' | 'turn';

// ═══════════════════════════════════════════════════════════════
// Routing
// ═══════════════════════════════════════════════════════════════

export type RouteMode = 'direct' | 'single_agent' | 'onboard';

export type UserStyle = 'brief' | 'normal' | 'deep';

export interface RouteDecision {
  mode: RouteMode;
  agent: AgentName;
  allowedNamespaces: ToolNamespace[];
  needsMemoryRead: boolean;
  needsMemoryWriteCandidate: boolean;
  needsWebFreshness: boolean;
  userStyle: UserStyle;
  confidence: number;
  fastPathUsed: boolean;
  routerLatencyMs: number;
}

// ═══════════════════════════════════════════════════════════════
// Working memory (Phase 2 stub)
// ═══════════════════════════════════════════════════════════════

export interface WorkingMemory {
  activeTopics: string[];
  unresolvedReferences: string[];
  pendingActions: Array<{
    type: string;
    description: string;
    createdTurnId: string;
  }>;
  lastEntityMentioned: string | null;
}

export function emptyWorkingMemory(): WorkingMemory {
  return {
    activeTopics: [],
    unresolvedReferences: [],
    pendingActions: [],
    lastEntityMentioned: null,
  };
}

// ═══════════════════════════════════════════════════════════════
// Onboarding context (passed through when isOnboarding = true)
// ═══════════════════════════════════════════════════════════════

export interface OnboardingClassification {
  entryState: string;
  confidence: number;
  recommendedWedge: string;
  shouldAskName: boolean;
  includeTrustReassurance: boolean;
  needsClarification: boolean;
  emotionalLoad: 'none' | 'low' | 'moderate' | 'high';
}

export interface OnboardingContext {
  nestUser: NestUser;
  onboardUrl: string;
  experimentVariants: Record<string, string>;
  classification?: OnboardingClassification;
  detectedWedge?: string;
  pdlContext?: string;
}

// ═══════════════════════════════════════════════════════════════
// Turn input — everything the orchestrator needs from the caller
// ═══════════════════════════════════════════════════════════════

export interface TurnInput {
  chatId: string;
  userMessage: string;
  images: ExtractedMedia[];
  audio: ExtractedMedia[];
  senderHandle: string;
  isGroupChat: boolean;
  participantNames: string[];
  chatName: string | null;
  service?: MessageService;
  incomingEffect?: MessageEffect;
  authUserId: string | null;
  isOnboarding: boolean;
  onboardingContext?: OnboardingContext;
  isProactiveReply?: boolean;
  timezone?: string | null;
}

// ═══════════════════════════════════════════════════════════════
// Turn context — hydrated state available during the turn
// ═══════════════════════════════════════════════════════════════

export interface TurnContext {
  history: StoredMessage[];
  formattedHistory: Anthropic.MessageParam[];
  messageContent: Anthropic.ContentBlockParam[];
  recentTurns: Array<{ role: string; content: string }>;
  memoryItems: MemoryItem[];
  summaries: ConversationSummary[];
  toolTraces: ToolTrace[];
  ragEvidence: string;
  ragEvidenceBlockCount: number;
  senderProfile: UserProfile | null;
  connectedAccounts: ConnectedAccount[];
  transcriptions: string[];
  transcriptionFailed: boolean;
  workingMemory: WorkingMemory;
}

// ═══════════════════════════════════════════════════════════════
// Agent configuration
// ═══════════════════════════════════════════════════════════════

export interface ToolPolicy {
  allowedNamespaces: ToolNamespace[];
  blockedNamespaces: ToolNamespace[];
  maxToolRounds: number;
}

export interface AgentConfig {
  name: AgentName;
  instructions: string;
  toolPolicy: ToolPolicy;
  model: string;
  maxTokens: number;
}

// ═══════════════════════════════════════════════════════════════
// Agent loop result
// ═══════════════════════════════════════════════════════════════

export interface RememberedUser {
  name?: string;
  fact?: string;
  isForSender?: boolean;
}

export interface GeneratedImage {
  url: string;
  prompt: string;
}

export interface AgentLoopResult {
  text: string | null;
  reaction: Reaction | null;
  effect: MessageEffect | null;
  rememberedUser: RememberedUser | null;
  generatedImage: GeneratedImage | null;
  toolCallTraces: ToolCallTrace[];
  toolCallsBlocked: ToolCallBlockedTrace[];
  rounds: number;
  toolsUsed: Array<{ tool: string; detail?: string }>;
  inputTokens: number;
  outputTokens: number;
  systemPromptLength: number;
  systemPrompt: string;
  initialMessages: Array<{ role: string; content: unknown }>;
  availableToolNames: string[];
}

// ═══════════════════════════════════════════════════════════════
// Turn trace — structured observability for every turn
// ═══════════════════════════════════════════════════════════════

export interface ToolCallTrace {
  name: string;
  namespace: ToolNamespace;
  sideEffect: SideEffect;
  latencyMs: number;
  outcome: 'success' | 'error' | 'timeout';
  inputSummary?: string;
  approvalGranted?: boolean;
  approvalMethod?: 'explicit' | 'implicit' | 'exempt';
}

export interface ToolCallBlockedTrace {
  name: string;
  namespace: ToolNamespace;
  reason: 'namespace_denied' | 'side_effect_denied' | 'rate_limited';
}

export interface TurnTrace {
  turnId: string;
  chatId: string;
  senderHandle: string;
  timestamp: string;

  // Input
  userMessage: string;
  timezoneResolved: string | null;

  // Routing
  routeDecision: RouteDecision;

  // Context
  systemPromptLength: number;
  systemPromptHash: string;
  memoryItemsLoaded: number;
  ragEvidenceBlocks: number;
  summariesLoaded: number;
  connectedAccountsCount: number;
  historyMessagesCount: number;
  contextBuildLatencyMs: number;

  // Agent
  agentName: AgentName;
  modelUsed: string;
  agentLoopRounds: number;
  agentLoopLatencyMs: number;

  // Tools
  toolCalls: ToolCallTrace[];
  toolCallsBlocked: ToolCallBlockedTrace[];
  toolCallCount: number;
  toolTotalLatencyMs: number;

  // Model usage
  inputTokens: number;
  outputTokens: number;

  // Response
  responseText: string | null;
  responseLength: number;

  // Overall
  totalLatencyMs: number;

  // Full prompt context (for debug dashboard)
  systemPrompt: string | null;
  initialMessages: Array<{ role: string; content: unknown }> | null;
  availableToolNames: string[];

  // Error
  errorMessage?: string;
  errorStage?: string;
}

// ═══════════════════════════════════════════════════════════════
// Turn result — final output from handleTurn()
// ═══════════════════════════════════════════════════════════════

export interface TurnResult {
  text: string | null;
  reaction: Reaction | null;
  effect: MessageEffect | null;
  rememberedUser: RememberedUser | null;
  generatedImage: GeneratedImage | null;
  trace: TurnTrace;
}

// Re-export commonly used types from dependencies
export type { Reaction, MessageEffect, MessageService, ExtractedMedia };
export type { StoredMessage, MemoryItem, ConversationSummary, ToolTrace, UserProfile, ConnectedAccount, NestUser };
