import { handleTurn } from '../orchestrator/handle-turn.ts';
import { ensureNestUser, clearConversation } from '../state.ts';

const SENDER = '+61414187820';
const BOT = '+13466215973';
const chatId = 'TEST#deepprofile#1';

const nestUser = await ensureNestUser(SENDER, BOT);
console.log('authUserId:', nestUser.authUserId);

await clearConversation(chatId).catch(() => {});

const testMessage = Deno.args[0] ?? 'What do you know about me?';
console.log(`\n--- Testing: ${testMessage} ---`);
const result = await handleTurn({
  chatId,
  userMessage: testMessage,
  images: [],
  audio: [],
  senderHandle: SENDER,
  isGroupChat: false,
  participantNames: [],
  chatName: null,
  authUserId: nestUser.authUserId ?? null,
  isOnboarding: false,
  timezone: 'Australia/Melbourne',
});

console.log('\n=== RESULT ===');
console.log('Agent:', result.trace.agentName);
console.log('Route Layer:', result.trace.routeLayer);
console.log('Domain:', result.trace.routeDecision.primaryDomain);
console.log('Reasoning Override:', result.trace.routeDecision.reasoningEffortOverride ?? 'none');
console.log('Memory Depth:', result.trace.routeDecision.memoryDepth);
console.log('Forced Tool Choice:', result.trace.routeDecision.forcedToolChoice ?? 'none');
console.log('Tools Used:', result.trace.toolCalls.map(t => t.name).join(', '));
console.log('Tool Count:', result.trace.toolCallCount);
console.log('Model:', result.trace.modelUsed);
console.log('Rounds:', result.trace.agentLoopRounds);
console.log('Response Length:', result.trace.responseLength);
console.log('\nResponse:');
console.log(result.text);
console.log('\nLatency:', result.trace.totalLatencyMs, 'ms');

const caps = result.trace.classifierResult?.requiredCapabilities ?? [];
const hasDeepProfile = caps.includes('deep_profile');
console.log('\nClassifier caps:', caps.join(', '));
console.log('Deep profile detected:', hasDeepProfile);

if (hasDeepProfile) {
  console.log('\n✅ Deep profile capability was correctly detected');
} else {
  console.log('\n⚠️  Deep profile capability was NOT detected — classifier may need tuning');
}

if (result.trace.toolCallCount >= 3) {
  console.log('✅ Multiple tool calls made (', result.trace.toolCallCount, ')');
} else {
  console.log('⚠️  Only', result.trace.toolCallCount, 'tool calls — expected 5-7 for deep profile');
}

if (result.trace.responseLength > 50) {
  console.log('✅ Response is substantive (', result.trace.responseLength, 'chars)');
} else {
  console.log('⚠️  Response seems too short (', result.trace.responseLength, 'chars)');
}
