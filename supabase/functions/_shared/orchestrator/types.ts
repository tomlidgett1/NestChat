import type {
  ExtractedMedia,
  MessageEffect,
  MessageService,
  Reaction,
} from "../sendblue.ts";
import type {
  ConnectedAccount,
  ConversationSummary,
  MemoryItem,
  NestUser,
  PendingEmailSendAction,
  StoredMessage,
  ToolTrace,
  UserProfile,
} from "../state.ts";
import type {
  InputContentPart,
  InputMessage,
  ModelTier,
} from "../ai/models.ts";

// ═══════════════════════════════════════════════════════════════
// Agent taxonomy
// ═══════════════════════════════════════════════════════════════

export type AgentName =
  | "casual"
  | "productivity"
  | "research"
  | "recall"
  | "operator"
  | "onboard"
  | "meeting_prep"
  | "chat"
  | "smart";

// ═══════════════════════════════════════════════════════════════
// Tool namespaces & side-effect classification
// ═══════════════════════════════════════════════════════════════

export type ToolNamespace =
  | "memory.read"
  | "memory.write"
  | "email.read"
  | "email.write"
  | "calendar.read"
  | "calendar.write"
  | "contacts.read"
  | "granola.read"
  | "web.search"
  | "knowledge.search"
  | "messaging.react"
  | "messaging.effect"
  | "media.generate"
  | "travel.search"
  | "admin.internal";

export type SideEffect = "read" | "draft" | "commit";

// ═══════════════════════════════════════════════════════════════
// Option A: Domain classification & capability-based routing
// ═══════════════════════════════════════════════════════════════

export type DomainTag =
  | "email"
  | "calendar"
  | "meeting_prep"
  | "research"
  | "recall"
  | "contacts"
  | "general";

export type Capability =
  | "email.read"
  | "email.write"
  | "calendar.read"
  | "calendar.write"
  | "contacts.read"
  | "granola.read"
  | "web.search"
  | "knowledge.search"
  | "memory.read"
  | "memory.write"
  | "travel.search"
  | "deep_profile";

export type MemoryDepth = "none" | "light" | "full";

export interface ClassifierResult {
  mode: "chat" | "smart";
  primaryDomain: DomainTag;
  secondaryDomains?: DomainTag[];
  confidence: number;
  requiredCapabilities: Capability[];
  preferredCapabilities?: Capability[];
  memoryDepth: MemoryDepth;
  requiresToolUse: boolean;
  isConfirmation: boolean;
  pendingActionId?: string | null;
  style: UserStyle;
}

// ═══════════════════════════════════════════════════════════════
// Prompt composition
// ═══════════════════════════════════════════════════════════════

export type PromptLayer =
  | "identity"
  | "conversation_behavior"
  | "memory_continuity"
  | "message_shaping"
  | "agent"
  | "context"
  | "turn";

// ═══════════════════════════════════════════════════════════════
// Routing
// ═══════════════════════════════════════════════════════════════

export type RouteMode = "direct" | "single_agent" | "onboard";

export type UserStyle = "brief" | "normal" | "deep";

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
  modelTierOverride?: import("../ai/models.ts").ModelTier;
  confirmationState?: "confirmed" | "not_confirmation" | "not_checked";
  // Option A fields (backwards-compatible)
  primaryDomain?: DomainTag;
  secondaryDomains?: DomainTag[];
  classifierResult?: ClassifierResult;
  memoryDepth?: MemoryDepth;
  forcedToolChoice?: string;
  routeLayer?: "0A" | "0B-casual" | "0B-knowledge" | "0C";
  routeReason?: string;
  matchedDisqualifierBucket?: string | null;
  hadPendingState?: boolean;
  reasoningEffortOverride?: import("../ai/models.ts").ReasoningEffort;
  modelOverride?: string;
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
  awaitingConfirmation?: boolean;
  awaitingChoice?: boolean;
  awaitingMissingParameter?: boolean;
}

export function emptyWorkingMemory(): WorkingMemory {
  return {
    activeTopics: [],
    unresolvedReferences: [],
    pendingActions: [],
    lastEntityMentioned: null,
    awaitingConfirmation: false,
    awaitingChoice: false,
    awaitingMissingParameter: false,
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
  emotionalLoad: "none" | "low" | "moderate" | "high";
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
  formattedHistory: InputMessage[];
  messageContent: InputContentPart[];
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
  pendingEmailSend: PendingEmailSendAction | null;
  pendingEmailSends: PendingEmailSendAction[];
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
  modelTier: ModelTier;
  maxOutputTokens: number;
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

export interface RoundTrace {
  round: number;
  apiLatencyMs: number;
  toolExecLatencyMs: number;
  totalRoundMs: number;
  inputTokens: number;
  outputTokens: number;
  status: string;
  functionCallCount: number;
  webSearchCalled: boolean;
  textLength: number;
  wasRetry: boolean;
  retryReason?: string;
  maxOutputTokens: number;
  reasoningEffort?: string;
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
  effectiveModel: string;
  roundTraces: RoundTrace[];
  promptComposeMs: number;
  toolFilterMs: number;
}

// ═══════════════════════════════════════════════════════════════
// Turn trace — structured observability for every turn
// ═══════════════════════════════════════════════════════════════

export interface ToolCallTrace {
  name: string;
  namespace: ToolNamespace;
  sideEffect: SideEffect;
  latencyMs: number;
  outcome: "success" | "error" | "timeout";
  inputSummary?: string;
  approvalGranted?: boolean;
  approvalMethod?: "explicit" | "implicit" | "exempt";
  pendingActionId?: number;
  sendResolutionSource?:
    | "model_input"
    | "pending_action"
    | "pending_action_validated"
    | "none";
  pendingActionFailureReason?: string;
}

export interface ToolCallBlockedTrace {
  name: string;
  namespace: ToolNamespace;
  reason: "namespace_denied" | "side_effect_denied" | "rate_limited";
  detail?: string;
  pendingActionId?: number;
}

export interface PendingActionDebug {
  pendingEmailSendCount: number;
  pendingEmailSendId: number | null;
  pendingEmailSendStatus: string | null;
  draftIdPresent: boolean;
  accountPresent: boolean;
  confirmationResult: "confirmed" | "not_confirmation" | "not_checked";
}

export interface ContextSubTimings {
  historyMs: number;
  memoryMs: number;
  summariesMs: number;
  toolTracesMs: number;
  profileMs: number;
  accountsMs: number;
  messageContentMs: number;
  ragMs: number;
  workingMemoryMs: number;
  formatHistoryMs: number;
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
  // Option A observability
  classifierResult?: ClassifierResult;
  routeLayer?: "0A" | "0B-casual" | "0B-knowledge" | "0C";
  routeReason?: string;
  matchedDisqualifierBucket?: string | null;
  hadPendingState?: boolean;
  classifierLatencyMs?: number;

  // Context
  systemPromptLength: number;
  systemPromptHash: string;
  memoryItemsLoaded: number;
  ragEvidenceBlocks: number;
  summariesLoaded: number;
  connectedAccountsCount: number;
  historyMessagesCount: number;
  contextBuildLatencyMs: number;
  contextSubTimings: ContextSubTimings | null;

  // Agent
  agentName: AgentName;
  modelUsed: string;
  agentLoopRounds: number;
  agentLoopLatencyMs: number;

  // Per-round detail
  roundTraces: RoundTrace[];
  promptComposeMs: number;
  toolFilterMs: number;

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
  routerContextMs: number;
  contextPath: "full" | "light" | "memory-light";
  pendingActionDebug: PendingActionDebug;

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
export type { ExtractedMedia, MessageEffect, MessageService, Reaction };
export type {
  ConnectedAccount,
  ConversationSummary,
  MemoryItem,
  NestUser,
  StoredMessage,
  ToolTrace,
  UserProfile,
};
