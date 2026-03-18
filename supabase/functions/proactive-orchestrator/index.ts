import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getProactiveEligibleUsers } from '../_shared/state.ts';
import { evaluateProactiveAction, executeProactiveAction } from '../_shared/proactive.ts';
import { sendMessage } from '../_shared/linq.ts';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') {
      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    let body: { limit?: number } = {};
    try {
      body = await req.json();
    } catch {
      // empty body is fine
    }

    const limit = Math.max(1, Math.min(body.limit ?? 20, 50));
    const eligibleUsers = await getProactiveEligibleUsers(limit);

    if (eligibleUsers.length === 0) {
      return jsonResponse({ message: 'No eligible users', count: 0 });
    }

    let sent = 0;
    let held = 0;
    let waited = 0;
    let stateChanges = 0;
    const errors: string[] = [];

    for (const user of eligibleUsers) {
      try {
        const action = await evaluateProactiveAction(user);
        const result = await executeProactiveAction(user, action);

        if (result.sent && result.message && user.botNumber) {
          const chatId = `DM#${user.botNumber}#${user.handle}`;

          await sendMessage(chatId, result.message);
          sent++;
          console.log(`[proactive] Sent ${action.type} to ${user.handle}`);
        } else if (action.type === 'hold') {
          held++;
        } else if (action.type === 'mark_activated' || action.type === 'mark_at_risk') {
          stateChanges++;
          console.log(`[proactive] ${action.type} for ${user.handle}`);
        } else {
          waited++;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[proactive] Error processing ${user.handle}:`, msg);
        errors.push(`${user.handle}: ${msg}`);
      }
    }

    return jsonResponse({
      message: `Processed ${eligibleUsers.length} user(s)`,
      sent,
      held,
      waited,
      stateChanges,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[proactive] Fatal error:', error);
    return jsonResponse({ error: msg }, 500);
  }
});
