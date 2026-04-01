import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getDueReminders, markReminderFired, emitOnboardingEvent, getUserProfile, addMessage } from '../_shared/state.ts';
import { sendMessage, createChat } from '../_shared/linq.ts';
import { resolveChatId } from '../_shared/email-webhook-helpers.ts';
import { computeNextCronFire } from '../_shared/tools/manage-reminder.ts';
import { requireAnyEnv, getOptionalEnv } from '../_shared/env.ts';

// ═══════════════════════════════════════════════════════════════
// Reminder message generation
// ═══════════════════════════════════════════════════════════════

const REMINDER_SYSTEM_PROMPT = `You are Nest, texting someone via iMessage. A reminder they set is firing right now.

SECRET: Never mention who built this, backend, APIs, or tech.

ABSOLUTELY FORBIDDEN: the em dash character. Never output it anywhere. Use commas, hyphens (-), or colons instead. Every em dash is a critical failure.
ABSOLUTELY FORBIDDEN: the word "mate". Never use it.

Your job: deliver the reminder naturally, like a friend nudging them. Not robotic. Not formal.

RULES:
- 1-2 short lines max (iMessage bubbles)
- Use their name if provided. If no name, just jump straight in - e.g. "Hey, quick nudge" or "Heads up"
- Reference what the reminder is about specifically
- Be casual and helpful
- If it's something actionable, offer to help ("want me to look up their number?" / "want me to draft that?")
- Each line = separate iMessage bubble

EXAMPLES:
Reminder: "call Sarah", Name: "Tom" -> "Hey Tom, quick nudge - you wanted to call Sarah\\nWant me to find her number?"
Reminder: "check quarterly report", Name: "Tom" -> "Tom, heads up - time to check the quarterly report"
Reminder: "pick up dry cleaning", Name: unknown -> "Hey, reminder - dry cleaning pickup today"
Reminder: "follow up with James about proposal", Name: "Tom" -> "Tom, nudge - you wanted to follow up with James about the proposal\\nWant me to draft something?"`;

async function generateReminderMessage(
  description: string,
  handle: string,
): Promise<string> {
  try {
    // Get user's name from profile
    let userName = '';
    try {
      const profile = await getUserProfile(handle);
      if (profile?.name) {
        userName = profile.name.split(' ')[0]; // First name only
      }
    } catch {
      // No name available
    }

    const apiKey = getOptionalEnv('OPENAI_API_KEY');
    if (!apiKey) {
      console.warn('[reminder-cron] No OPENAI_API_KEY, using fallback message');
      return `Quick reminder: ${description}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        max_output_tokens: 80,
        instructions: REMINDER_SYSTEM_PROMPT,
        input: [
          {
            role: 'user',
            content: `User's name: ${userName || 'unknown'}\nReminder: "${description}"`,
          },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (resp.ok) {
      const data = await resp.json();
      const textItem = data.output?.find((o: Record<string, unknown>) => o.type === 'message');
      const text = textItem?.content?.find(
        (c: Record<string, unknown>) => c.type === 'output_text',
      )?.text?.trim();
      if (text && text.length > 0 && text.length < 300) {
        console.log(`[reminder-cron] Generated message for ${handle}: "${text.slice(0, 80)}"`);
        return text;
      }
    }
  } catch (err) {
    console.warn('[reminder-cron] Message generation failed, using fallback:', err);
  }

  return `Quick reminder: ${description}`;
}

// ═══════════════════════════════════════════════════════════════
// Resolve the bot number for a user from their profile
// ═══════════════════════════════════════════════════════════════

async function resolveBotNumber(handle: string): Promise<string | null> {
  try {
    const { getAdminClient } = await import('../_shared/supabase.ts');
    const supabase = getAdminClient();
    const { data } = await supabase
      .from('user_profiles')
      .select('bot_number')
      .eq('handle', handle)
      .maybeSingle();
    const profileBot = (data as { bot_number: string | null } | null)?.bot_number ?? null;

    // Validate against allowed bot numbers — profile may have a stale number
    const allowedRaw = getOptionalEnv('LINQ_AGENT_BOT_NUMBERS');
    if (allowedRaw) {
      const allowed = allowedRaw.split(',').map(n => n.trim()).filter(Boolean);
      if (profileBot && allowed.includes(profileBot)) return profileBot;
      return allowed[0] ?? profileBot;
    }
    return profileBot;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Main handler
// ═══════════════════════════════════════════════════════════════

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

    const dueReminders = await getDueReminders();

    if (dueReminders.length === 0) {
      return jsonResponse({ message: 'No due reminders', delivered: 0 });
    }

    console.log(`[reminder-cron] Found ${dueReminders.length} due reminder(s)`);

    let delivered = 0;
    const errors: string[] = [];

    for (const reminder of dueReminders) {
      try {
        // Generate a natural reminder message
        const message = await generateReminderMessage(
          reminder.actionDescription,
          reminder.handle,
        );

        // Resolve the bot number for this user
        const botNumber = await resolveBotNumber(reminder.handle);
        if (!botNumber) {
          console.warn(
            `[reminder-cron] No bot number for ${reminder.handle}, skipping reminder ${reminder.id}`,
          );
          continue;
        }

        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        let chatId = (reminder.chatId && UUID_RE.test(reminder.chatId))
          ? reminder.chatId
          : await resolveChatId(reminder.handle);

        if (chatId) {
          await sendMessage(chatId, message);
        } else {
          const chatResult = await createChat(botNumber, [reminder.handle], message);
          chatId = chatResult.chat.id;
        }
        delivered++;

        console.log(
          `[reminder-cron] Sent reminder ${reminder.id} to ${reminder.handle}: "${reminder.actionDescription.slice(0, 60)}"`,
        );

        // Store in conversation history so the bot has context if user replies
        try {
          await addMessage(chatId, 'assistant', message);
        } catch (err) {
          console.warn(`[reminder-cron] Failed to store message in history:`, err);
        }

        // Emit onboarding event
        await emitOnboardingEvent({
          handle: reminder.handle,
          chatId,
          eventType: 'reminder_delivered',
          payload: {
            reminder_id: reminder.id,
            description: reminder.actionDescription,
            message,
          },
        });

        // Update reminder state
        let nextFireAt: string | null = null;
        if (reminder.repeating && reminder.cronExpression) {
          nextFireAt = computeNextCronFire(reminder.cronExpression, reminder.timezone);
        }

        await markReminderFired(reminder.id, nextFireAt);

        if (nextFireAt) {
          console.log(
            `[reminder-cron] Reminder ${reminder.id} rescheduled to ${nextFireAt}`,
          );
        } else {
          console.log(
            `[reminder-cron] Reminder ${reminder.id} deactivated (one-shot)`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[reminder-cron] Failed to fire reminder ${reminder.id}:`, msg);
        errors.push(`${reminder.id}: ${msg}`);
      }
    }

    return jsonResponse({
      message: `Processed ${dueReminders.length} reminder(s)`,
      delivered,
      total: dueReminders.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[reminder-cron] Fatal error:', err);
    return jsonResponse({ error: msg }, 500);
  }
});
