import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import {
  evaluateAutomations,
  getAutomationEligibleUsers,
  recordAutomationRun,
} from '../_shared/automations.ts';
import {
  getDueUserAutomations,
  advanceUserAutomation,
  generateUserAutomationMessage,
} from '../_shared/user-automations.ts';
import { addMessage } from '../_shared/state.ts';
import { sendMessage, createChat } from '../_shared/linq.ts';
import { cleanResponse } from '../_shared/imessage-text-format.ts';
import { resolveChatId } from '../_shared/email-webhook-helpers.ts';

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

    let body: { limit?: number; handle?: string; automation_type?: string; manual?: boolean } = {};
    try {
      body = await req.json();
    } catch {
      // empty body is fine
    }

    // ── Manual trigger mode ──────────────────────────────────
    // If handle + automation_type are provided, this is a manual trigger from the dashboard
    if (body.handle && body.automation_type && body.manual) {
      return await handleManualTrigger(body.handle, body.automation_type);
    }

    // ── Scheduled mode ───────────────────────────────────────
    const limit = Math.max(1, Math.min(body.limit ?? 30, 100));
    const eligibleUsers = await getAutomationEligibleUsers(limit);

    let sent = 0;
    let held = 0;
    let skipped = 0;
    const actions: Array<{ handle: string; type: string; reason?: string }> = [];
    const errors: string[] = [];

    for (const user of eligibleUsers) {  // may be empty — that's fine, user automations run below
      try {
        const result = await evaluateAutomations(user);

        if (result.type === 'hold') {
          held++;
          actions.push({ handle: user.handle, type: 'hold', reason: result.reason });
          continue;
        }

        if (result.type === 'skip') {
          skipped++;
          continue;
        }

        // It's an action — send the message
        if (!user.botNumber) {
          console.warn(`[automation-engine] No bot number for ${user.handle}`);
          skipped++;
          continue;
        }

        // Resolve the Linq chat UUID; fall back to createChat if not found
        let chatId = await resolveChatId(user.handle);

        // Record the run BEFORE sending (so we don't double-send on retry)
        await recordAutomationRun(
          user.handle,
          chatId ?? `DM#${user.botNumber}#${user.handle}`,
          result.type,
          result.message,
          result.metadata,
        );

        // Send the message
        if (chatId) {
          await sendMessage(chatId, result.message);
        } else {
          const chatResult = await createChat(user.botNumber, [user.handle], result.message);
          chatId = chatResult.chat.id;
        }
        sent++;

        // Store in conversation history for context
        try {
          await addMessage(chatId, 'assistant', result.message);
        } catch (err) {
          console.warn(`[automation-engine] Failed to store message in history:`, err);
        }

        actions.push({ handle: user.handle, type: result.type });
        console.log(`[automation-engine] Sent ${result.type} to ${user.handle}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[automation-engine] Error processing ${user.handle}:`, msg);
        errors.push(`${user.handle}: ${msg}`);
      }
    }

    // ── User-configured automations (from website dashboard) ────
    // These are schedule-based: user picks a time, we execute when next_run_at <= now()
    let userAutoSent = 0;
    let userAutoSkipped = 0;
    const userAutoErrors: string[] = [];

    try {
      const dueAutomations = await getDueUserAutomations(30);

      for (const auto of dueAutomations) {
        try {
          const result = await generateUserAutomationMessage(auto);

          if (!result) {
            userAutoSkipped++;
            // Still advance so we don't retry the same slot endlessly
            await advanceUserAutomation(auto.automationId);
            continue;
          }

          // Resolve chat ID
          let chatId = await resolveChatId(auto.handle);

          // Record in automation_runs for unified history
          await recordAutomationRun(
            auto.handle,
            chatId ?? `DM#${auto.botNumber}#${auto.handle}`,
            auto.automationType,
            result.message,
            { ...result.metadata, source: 'user_dashboard', automation_id: auto.automationId },
          );

          // Split on --- into separate iMessage bubbles (same **bold** → Unicode as main Nest replies)
          const bubbles = result.message.split(/\n---\n|^---$/m).map((b: string) => b.trim()).filter(Boolean);
          const cleanedBubbles = bubbles.map((b) => cleanResponse(b));

          // Send the message(s)
          if (chatId) {
            for (const bubble of cleanedBubbles) {
              await sendMessage(chatId, bubble);
            }
          } else {
            const chatResult = await createChat(auto.botNumber, [auto.handle], cleanedBubbles[0]);
            chatId = chatResult.chat.id;
            for (let i = 1; i < cleanedBubbles.length; i++) {
              await sendMessage(chatId, cleanedBubbles[i]);
            }
          }

          const recordedAssistantText = cleanedBubbles.join('\n---\n');

          // Store in conversation history
          try {
            await addMessage(chatId, 'assistant', recordedAssistantText);
          } catch (err) {
            console.warn(`[automation-engine] Failed to store user-auto message in history:`, err);
          }

          // Advance to next scheduled run
          await advanceUserAutomation(auto.automationId);

          userAutoSent++;
          actions.push({ handle: auto.handle, type: `user:${auto.automationType}` });
          console.log(`[automation-engine] Sent user automation ${auto.automationType} to ${auto.handle}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[automation-engine] User automation error for ${auto.handle}/${auto.automationType}:`, msg);
          userAutoErrors.push(`${auto.handle}/${auto.automationType}: ${msg}`);
          // Still advance to prevent infinite retry
          try { await advanceUserAutomation(auto.automationId); } catch { /* best-effort */ }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[automation-engine] Failed to process user automations:', msg);
      userAutoErrors.push(`global: ${msg}`);
    }

    const allErrors = [...errors, ...userAutoErrors];

    return jsonResponse({
      message: `Processed ${eligibleUsers.length} rule-based user(s) + ${userAutoSent + userAutoSkipped} scheduled automation(s)`,
      sent: sent + userAutoSent,
      held,
      skipped: skipped + userAutoSkipped,
      actions: actions.length > 0 ? actions : undefined,
      errors: allErrors.length > 0 ? allErrors : undefined,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[automation-engine] Fatal error:', error);
    return jsonResponse({ error: msg }, 500);
  }
});

// ============================================================================
// Manual trigger — fires a specific automation for a specific user
// ============================================================================

async function handleManualTrigger(handle: string, automationType: string): Promise<Response> {
  const { getAdminClient } = await import('../_shared/supabase.ts');
  const supabase = getAdminClient();

  // Load the user
  const { data: userData, error: userError } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('handle', handle)
    .maybeSingle();

  if (userError || !userData) {
    return jsonResponse({ error: `User not found: ${handle}` }, 404);
  }

  const user = userData as Record<string, unknown>;
  if (!user.bot_number) {
    return jsonResponse({ error: 'User has no bot number' }, 400);
  }

  let chatId = await resolveChatId(handle);
  const recordChatId = chatId ?? `DM#${user.bot_number}#${handle}`;

  // Import the specific rule and generate the message
  const { AUTOMATION_RULES } = await import('../_shared/automations.ts');
  const rule = AUTOMATION_RULES.find(r => r.type === automationType);

  if (!rule) {
    return jsonResponse({ error: `Unknown automation type: ${automationType}` }, 400);
  }

  // Build a minimal AutomationUser
  const automationUser = {
    handle: user.handle as string,
    name: user.name as string | null,
    onboardState: (user.onboard_state as string) || 'new_user_unclassified',
    entryState: user.entry_state as string | null,
    firstValueWedge: user.first_value_wedge as string | null,
    firstValueDeliveredAt: user.first_value_delivered_at as string | null,
    followThroughDeliveredAt: user.follow_through_delivered_at as string | null,
    secondEngagementAt: user.second_engagement_at as string | null,
    memoryMomentDeliveredAt: user.memory_moment_delivered_at as string | null,
    activatedAt: user.activated_at as string | null,
    atRiskAt: user.at_risk_at as string | null,
    lastProactiveSentAt: user.last_proactive_sent_at as string | null,
    lastProactiveIgnored: (user.last_proactive_ignored as boolean) ?? false,
    proactiveIgnoreCount: (user.proactive_ignore_count as number) ?? 0,
    activationScore: (user.activation_score as number) ?? 0,
    capabilityCategoriesUsed: (user.capability_categories_used as string[]) ?? [],
    botNumber: user.bot_number as string,
    firstSeen: user.first_seen as number,
    lastSeen: user.last_seen as number,
    onboardCount: (user.onboard_count as number) ?? 0,
    timezone: user.timezone as string | null,
    authUserId: user.auth_user_id as string | null,
    status: user.status as string,
    deepProfileSnapshot: user.deep_profile_snapshot as Record<string, unknown> | null,
  };

  // Force-evaluate the rule (bypass timing checks for manual triggers)
  const nowEpoch = Math.floor(Date.now() / 1000);
  const tz = automationUser.timezone || 'Australia/Sydney';
  let userLocalHour: number;
  try {
    const fmt = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', hour12: false });
    userLocalHour = parseInt(fmt.format(new Date()));
  } catch {
    userLocalHour = new Date().getUTCHours() + 10;
  }

  // For manual triggers, we call the rule's evaluate directly
  const result = await rule.evaluate(automationUser, {
    nowEpoch,
    userLocalHour,
    userLocalDay: new Date().getDay(),
    hoursSinceLastSeen: (nowEpoch - automationUser.lastSeen) / 3600,
    daysSinceFirstSeen: (nowEpoch - automationUser.firstSeen) / 86400,
    lastAutomationOfType: null, // Bypass for manual
    automationsToday: 0,       // Bypass for manual
    preferences: null,
    hasConnectedAccounts: !!automationUser.authUserId,
  });

  if (result.type === 'skip' || result.type === 'hold') {
    // For manual triggers, try a generic message if the rule can't generate one
    return jsonResponse({
      error: `Automation ${automationType} returned ${result.type}`,
      reason: 'reason' in result ? result.reason : undefined,
    }, 400);
  }

  // Record and send
  await recordAutomationRun(
    handle,
    recordChatId,
    result.type,
    result.message,
    { ...result.metadata, manual: true },
    true,
    'dashboard',
  );

  if (chatId) {
    await sendMessage(chatId, result.message);
  } else {
    const chatResult = await createChat(user.bot_number as string, [handle], result.message);
    chatId = chatResult.chat.id;
  }

  try {
    await addMessage(chatId, 'assistant', result.message);
  } catch {
    // Non-fatal
  }

  return jsonResponse({
    success: true,
    automation_type: result.type,
    message: result.message,
    handle,
  });
}
