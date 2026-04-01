import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import {
  loadActiveMoments,
  loadGlobalConfig,
  getCandidates,
  evaluateCandidate,
  recordExecution,
  dualWriteAutomationRun,
  buildIdempotencyKey,
  type Moment,
  type MomentCandidate,
} from '../_shared/moments.ts';
import { executeMomentAction } from '../_shared/moment-templates.ts';
import {
  getDueUserAutomations,
  advanceUserAutomation,
  generateUserAutomationMessage,
} from '../_shared/user-automations.ts';
import { recordAutomationRun } from '../_shared/automations.ts';
import { addMessage } from '../_shared/state.ts';
import { sendMessage, createChat } from '../_shared/linq.ts';
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

    let body: {
      limit?: number;
      moment_id?: string;
      handle?: string;
      manual?: boolean;
    } = {};
    try {
      body = await req.json();
    } catch {
      // empty body is fine for cron
    }

    // ── Manual trigger mode ──────────────────────────────────
    if (body.moment_id && body.handle && body.manual) {
      return await handleManualTrigger(body.moment_id, body.handle);
    }

    // ── Scheduled mode ───────────────────────────────────────
    const globalConfig = await loadGlobalConfig();

    if (globalConfig.kill_switch) {
      console.log('[moment-engine] Kill switch is ON — aborting');
      return jsonResponse({ message: 'Kill switch enabled', sent: 0 });
    }

    const moments = await loadActiveMoments();
    if (moments.length === 0) {
      return jsonResponse({ message: 'No active moments', sent: 0 });
    }

    const limit = Math.max(1, Math.min(body.limit ?? 30, 100));
    let totalSent = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    const actions: Array<{ moment: string; handle: string; status: string; reason?: string }> = [];
    const sentThisCycle = new Set<string>();

    for (const moment of moments) {
      const startMs = Date.now();
      let momentSent = 0;

      try {
        const candidates = await getCandidates(moment, limit);

        for (const candidate of candidates) {
          // Respect overall time budget (~50s to stay under Edge Function limits)
          if (Date.now() - startMs > 45000) {
            console.warn(`[moment-engine] Time budget exhausted for ${moment.name}`);
            break;
          }

          try {
            const idempotencyKey = buildIdempotencyKey(moment, candidate);
            const evalResult = await evaluateCandidate(moment, candidate, globalConfig, sentThisCycle);

            if (evalResult.status !== 'pass') {
              // Log non-pass statuses
              await recordExecution(moment, candidate.handle, null, evalResult.status, {
                skipReason: evalResult.skipReason,
                idempotencyKey,
              });

              if (evalResult.status !== 'skipped') {
                actions.push({
                  moment: moment.name,
                  handle: candidate.handle,
                  status: evalResult.status,
                  reason: evalResult.skipReason,
                });
              }
              totalSkipped++;

              // Dry run: still generate the message for logging
              if (evalResult.status === 'dry_run') {
                const actionResult = await executeMomentAction(moment, candidate);
                if (actionResult) {
                  await recordExecution(moment, candidate.handle, null, 'dry_run', {
                    renderedContent: actionResult.message,
                    promptUsed: actionResult.promptUsed,
                    metadata: actionResult.metadata,
                    idempotencyKey,
                  });
                }
              }

              continue;
            }

            // All checks passed — execute the action
            const execStart = Date.now();
            const actionResult = await executeMomentAction(moment, candidate);

            if (!actionResult) {
              await recordExecution(moment, candidate.handle, null, 'failed', {
                errorMessage: 'Action returned null (LLM generation failed, no fallback)',
                executionMs: Date.now() - execStart,
                idempotencyKey,
              });
              totalErrors++;
              continue;
            }

            // Send the message
            if (!candidate.bot_number) {
              await recordExecution(moment, candidate.handle, null, 'failed', {
                errorMessage: 'No bot number',
                executionMs: Date.now() - execStart,
                idempotencyKey,
              });
              totalErrors++;
              continue;
            }

            let chatId = await resolveChatId(candidate.handle);

            // Record execution BEFORE sending (idempotency)
            const execId = await recordExecution(moment, candidate.handle, chatId ?? `DM#${candidate.bot_number}#${candidate.handle}`, 'sent', {
              renderedContent: actionResult.message,
              promptUsed: actionResult.promptUsed,
              metadata: actionResult.metadata,
              executionMs: Date.now() - execStart,
              idempotencyKey,
            });

            if (execId === null) {
              // Idempotency conflict — already recorded
              totalSkipped++;
              continue;
            }

            // Send via Linq
            try {
              if (chatId) {
                await sendMessage(chatId, actionResult.message);
              } else {
                const chatResult = await createChat(candidate.bot_number, [candidate.handle], actionResult.message);
                chatId = chatResult.chat.id;
              }
            } catch (sendErr) {
              console.error(`[moment-engine] Send failed for ${candidate.handle}:`, (sendErr as Error).message);
              totalErrors++;
              continue;
            }

            // Store in conversation history
            try {
              if (chatId) {
                await addMessage(chatId, 'assistant', actionResult.message);
              }
            } catch {
              // non-fatal
            }

            // Dual-write to automation_runs for backwards compatibility
            await dualWriteAutomationRun(
              candidate.handle,
              chatId ?? `DM#${candidate.bot_number}#${candidate.handle}`,
              moment.name,
              actionResult.message,
              actionResult.metadata,
            );

            sentThisCycle.add(candidate.handle);
            momentSent++;
            totalSent++;

            actions.push({
              moment: moment.name,
              handle: candidate.handle,
              status: 'sent',
            });

            console.log(`[moment-engine] Sent "${moment.name}" to ${candidate.handle}`);
          } catch (candidateErr) {
            const msg = candidateErr instanceof Error ? candidateErr.message : String(candidateErr);
            console.error(`[moment-engine] Error processing ${candidate.handle} for ${moment.name}:`, msg);
            totalErrors++;
          }
        }
      } catch (momentErr) {
        const msg = momentErr instanceof Error ? momentErr.message : String(momentErr);
        console.error(`[moment-engine] Error processing moment ${moment.name}:`, msg);
        totalErrors++;
      }

      if (momentSent > 0) {
        console.log(`[moment-engine] "${moment.name}": sent ${momentSent}`);
      }
    }

    // ── User-configured automations (from website dashboard) ────
    // Schedule-based: user picks a time on the Automations page, we execute when due.
    let userAutoSent = 0;
    let userAutoSkipped = 0;

    try {
      const dueAutomations = await getDueUserAutomations(20);

      for (const auto of dueAutomations) {
        // Time budget check (~50s total for the whole function)
        if (Date.now() - (Date.now() - 50000) < 5000) break; // leave 5s margin

        try {
          const result = await generateUserAutomationMessage(auto);

          if (!result) {
            userAutoSkipped++;
            await advanceUserAutomation(auto.automationId);
            continue;
          }

          let chatId = await resolveChatId(auto.handle);

          // Record in automation_runs for unified history
          await recordAutomationRun(
            auto.handle,
            chatId ?? `DM#${auto.botNumber}#${auto.handle}`,
            auto.automationType,
            result.message,
            { ...result.metadata, source: 'user_dashboard', automation_id: auto.automationId },
          );

          // Split on --- into separate iMessage bubbles
          const bubbles = result.message.split(/\n---\n|^---$/m).map((b: string) => b.trim()).filter(Boolean);

          // Send via Linq
          if (chatId) {
            for (const bubble of bubbles) {
              await sendMessage(chatId, bubble);
            }
          } else {
            const chatResult = await createChat(auto.botNumber, [auto.handle], bubbles[0]);
            chatId = chatResult.chat.id;
            for (let i = 1; i < bubbles.length; i++) {
              await sendMessage(chatId, bubbles[i]);
            }
          }

          // Store in conversation history
          try {
            if (chatId) await addMessage(chatId, 'assistant', result.message);
          } catch { /* non-fatal */ }

          await advanceUserAutomation(auto.automationId);
          sentThisCycle.add(auto.handle);
          userAutoSent++;
          totalSent++;

          actions.push({
            moment: `user:${auto.automationType}`,
            handle: auto.handle,
            status: 'sent',
          });

          console.log(`[moment-engine] Sent user automation ${auto.automationType} to ${auto.handle}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[moment-engine] User automation error ${auto.handle}/${auto.automationType}:`, msg);
          totalErrors++;
          try { await advanceUserAutomation(auto.automationId); } catch { /* best-effort */ }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[moment-engine] Failed to process user automations:', msg);
    }

    return jsonResponse({
      message: `Processed ${moments.length} moment(s) + ${userAutoSent + userAutoSkipped} user automation(s)`,
      moments_evaluated: moments.length,
      sent: totalSent,
      skipped: totalSkipped,
      errors: totalErrors,
      user_automations_sent: userAutoSent,
      user_automations_skipped: userAutoSkipped,
      actions: actions.length > 0 ? actions.slice(0, 50) : undefined,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[moment-engine] Fatal error:', error);
    return jsonResponse({ error: msg }, 500);
  }
});

// ============================================================================
// Manual trigger — fires a specific moment for a specific user
// ============================================================================

async function handleManualTrigger(momentId: string, handle: string): Promise<Response> {
  const supabase = (await import('../_shared/supabase.ts')).getAdminClient();

  // Load the moment
  const { data: momentData, error: momentError } = await supabase
    .from('moments')
    .select('*')
    .eq('id', momentId)
    .maybeSingle();

  if (momentError || !momentData) {
    return jsonResponse({ error: `Moment not found: ${momentId}` }, 404);
  }

  const moment = momentData as unknown as Moment;

  // Load the user
  const { data: userData, error: userError } = await supabase
    .from('user_profiles')
    .select('handle, name, timezone, first_seen, last_seen, onboard_count, bot_number, auth_user_id, activation_score, last_proactive_sent_at, last_proactive_ignored, proactive_ignore_count, status')
    .eq('handle', handle)
    .maybeSingle();

  if (userError || !userData) {
    return jsonResponse({ error: `User not found: ${handle}` }, 404);
  }

  const candidate = userData as unknown as MomentCandidate;

  if (!candidate.bot_number) {
    return jsonResponse({ error: 'User has no bot number' }, 400);
  }

  // Execute the action (bypass all guardrails for manual trigger)
  const execStart = Date.now();
  const actionResult = await executeMomentAction(moment, candidate);

  if (!actionResult) {
    return jsonResponse({ error: 'Action generation failed (LLM returned empty)' }, 400);
  }

  // Record with manual idempotency key (allows re-triggering)
  const manualIdempKey = `${moment.id}:${handle}:manual:${Date.now()}`;

  let chatId = await resolveChatId(handle);
  const recordChatId = chatId ?? `DM#${candidate.bot_number}#${handle}`;

  await recordExecution(moment, handle, recordChatId, 'sent', {
    renderedContent: actionResult.message,
    promptUsed: actionResult.promptUsed,
    metadata: { ...actionResult.metadata, manual: true },
    executionMs: Date.now() - execStart,
    idempotencyKey: manualIdempKey,
  });

  // Send via Linq
  try {
    if (chatId) {
      await sendMessage(chatId, actionResult.message);
    } else {
      const chatResult = await createChat(candidate.bot_number, [handle], actionResult.message);
      chatId = chatResult.chat.id;
    }
  } catch (sendErr) {
    return jsonResponse({
      success: true,
      warning: `Recorded but send failed: ${(sendErr as Error).message}`,
      moment_name: moment.name,
      message: actionResult.message,
      handle,
    });
  }

  // Store in conversation history
  try {
    if (chatId) {
      await addMessage(chatId, 'assistant', actionResult.message);
    }
  } catch {
    // non-fatal
  }

  // Dual-write
  await dualWriteAutomationRun(handle, recordChatId, moment.name, actionResult.message, {
    ...actionResult.metadata,
    manual: true,
  });

  return jsonResponse({
    success: true,
    moment_name: moment.name,
    message: actionResult.message,
    handle,
  });
}
