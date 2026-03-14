import { handleTurn } from '../orchestrator/handle-turn.ts';
import { ensureNestUser, clearConversation } from '../state.ts';

const SENDER = '+61414187820';
const BOT = '+13466215973';
const chatId = 'TEST#quickcheck#email';

const nestUser = await ensureNestUser(SENDER, BOT);
console.log('authUserId:', nestUser.authUserId);

await clearConversation(chatId).catch(() => {});

const result = await handleTurn({
  chatId,
  userMessage: 'Check my latest emails',
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
console.log('Tools:', result.trace.toolCalls.map(t => t.name).join(', '));
console.log('Response:', result.text);
console.log('Latency:', result.trace.totalMs + 'ms');

Deno.exit(0);
