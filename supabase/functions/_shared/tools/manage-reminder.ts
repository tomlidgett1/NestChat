import type { ToolContract, ToolContext, ToolOutput } from './types.ts';
import {
  insertReminder,
  getUserReminders,
  deleteReminder,
  editReminder,
  getUserTimezone,
  emitOnboardingEvent,
} from '../state.ts';

// ═══════════════════════════════════════════════════════════════
// Timezone helpers (ported from TapMeeting)
// ═══════════════════════════════════════════════════════════════

const DEFAULT_TZ = 'Australia/Melbourne';

function nowInTimezone(tz: string): {
  localHour: number;
  localMinute: number;
  localDate: number;
  localMonth: number;
  localDow: number;
  utcNow: Date;
} {
  const utcNow = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: 'numeric',
    day: 'numeric',
    month: 'numeric',
    weekday: 'short',
    hour12: false,
  }).formatToParts(utcNow);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  const localHour = parseInt(get('hour'), 10) % 24;
  const localMinute = parseInt(get('minute'), 10);
  const localDate = parseInt(get('day'), 10);
  const localMonth = parseInt(get('month'), 10);
  const dowMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const localDow = dowMap[get('weekday')] ?? 0;

  return { localHour, localMinute, localDate, localMonth, localDow, utcNow };
}

function localTimeToUtc(
  hour: number,
  minute: number,
  tz: string,
  dateOverride?: { date: number; month: number },
): Date {
  const { utcNow } = nowInTimezone(tz);

  const offsetMs = (() => {
    const utcStr = utcNow.toLocaleString('en-US', { timeZone: 'UTC', hour12: false });
    const localStr = utcNow.toLocaleString('en-US', { timeZone: tz, hour12: false });
    return new Date(localStr).getTime() - new Date(utcStr).getTime();
  })();

  const target = new Date(utcNow);
  if (dateOverride) {
    target.setUTCMonth(dateOverride.month - 1, dateOverride.date);
  }
  target.setUTCHours(hour, minute, 0, 0);
  const utcTarget = new Date(target.getTime() - offsetMs);

  if (!dateOverride && utcTarget <= utcNow) {
    utcTarget.setUTCDate(utcTarget.getUTCDate() + 1);
  }

  return utcTarget;
}

function extractTime(str: string, defaultHour = 9): { hour: number; minute: number } {
  const match = str.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!match) return { hour: defaultHour, minute: 0 };
  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  if (match[3] === 'pm' && hour < 12) hour += 12;
  if (match[3] === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

function isRepeating(schedule: string): boolean {
  const lower = (schedule ?? '').toLowerCase();
  return lower.includes('every') || lower.includes('daily') || lower.includes('weekly');
}

function parseSchedule(
  schedule: string,
  tz = DEFAULT_TZ,
): { type: string; condition: string; nextFireAt?: string } {
  const lower = (schedule ?? '').toLowerCase().trim();

  // "every Monday at 9am" etc.
  if (lower.startsWith('every ')) {
    const days: Record<string, string> = {
      monday: '1',
      tuesday: '2',
      wednesday: '3',
      thursday: '4',
      friday: '5',
      saturday: '6',
      sunday: '0',
    };
    for (const [day, num] of Object.entries(days)) {
      if (lower.includes(day)) {
        const time = extractTime(lower);
        return { type: 'cron', condition: `${time.minute} ${time.hour} * * ${num}` };
      }
    }
    if (lower.includes('day') || lower.includes('morning') || lower.includes('evening')) {
      const hour = lower.includes('morning') ? 8 : lower.includes('evening') ? 18 : 9;
      const time = extractTime(lower, hour);
      return { type: 'cron', condition: `${time.minute} ${time.hour} * * *` };
    }
    // "every weekday" pattern
    if (lower.includes('weekday')) {
      const time = extractTime(lower);
      return { type: 'cron', condition: `${time.minute} ${time.hour} * * 1-5` };
    }
  }

  // "in X hours/minutes" — compute absolute UTC fire time
  const inMatch = lower.match(/in\s+(\d+)\s+(hour|minute|min)/);
  if (inMatch) {
    const target = new Date();
    if (inMatch[2].startsWith('hour')) {
      target.setTime(target.getTime() + parseInt(inMatch[1], 10) * 3600000);
    } else {
      target.setTime(target.getTime() + parseInt(inMatch[1], 10) * 60000);
    }
    return {
      type: 'cron',
      condition: `${target.getUTCMinutes()} ${target.getUTCHours()} ${target.getUTCDate()} ${target.getUTCMonth() + 1} *`,
      nextFireAt: target.toISOString(),
    };
  }

  // One-shot: "tomorrow at 3pm", "at 5pm", "today at noon", etc.
  const isTomorrow = lower.includes('tomorrow');
  const time = extractTime(lower);
  const utcFire = localTimeToUtc(time.hour, time.minute, tz);
  if (isTomorrow && utcFire.getTime() - Date.now() < 12 * 3600000) {
    utcFire.setUTCDate(utcFire.getUTCDate() + 1);
  }

  return {
    type: 'cron',
    condition: `${utcFire.getUTCMinutes()} ${utcFire.getUTCHours()} ${utcFire.getUTCDate()} ${utcFire.getUTCMonth() + 1} *`,
    nextFireAt: utcFire.toISOString(),
  };
}

export function computeNextCronFire(cronExpression: string, tz = DEFAULT_TZ): string | null {
  try {
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length < 5) return null;
    const [minuteStr, hourStr, dayStr, monthStr, dowStr] = parts;

    // One-shot (specific day/month) — don't reschedule
    if (dayStr !== '*' && monthStr !== '*') return null;

    const targetHour = hourStr === '*' ? 9 : parseInt(hourStr, 10);
    const targetMinute = minuteStr === '*' ? 0 : parseInt(minuteStr, 10);
    let utcFire = localTimeToUtc(targetHour, targetMinute, tz);

    // Handle day-of-week constraints
    if (dowStr && dowStr !== '*') {
      const targetDow = parseInt(dowStr, 10);
      if (!isNaN(targetDow) && targetDow >= 0 && targetDow <= 6) {
        const fireParts = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          weekday: 'short',
        }).formatToParts(utcFire);
        const dowMap: Record<string, number> = {
          Sun: 0,
          Mon: 1,
          Tue: 2,
          Wed: 3,
          Thu: 4,
          Fri: 5,
          Sat: 6,
        };
        const fireDow =
          dowMap[fireParts.find((p) => p.type === 'weekday')?.value ?? ''] ?? -1;

        if (fireDow !== targetDow) {
          let daysAhead = targetDow - fireDow;
          if (daysAhead <= 0) daysAhead += 7;
          utcFire = new Date(utcFire.getTime() + daysAhead * 24 * 60 * 60 * 1000);
        }
      }
    }

    return utcFire.toISOString();
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Tool handler
// ═══════════════════════════════════════════════════════════════

async function handleManageReminder(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutput> {
  const action = input.action as string;
  const handle = ctx.senderHandle;

  // Resolve timezone: use provided, context, user profile, or default
  let tz = (input.time_zone as string) ?? ctx.timezone ?? null;
  if (!tz) {
    tz = (await getUserTimezone(handle)) ?? DEFAULT_TZ;
  }

  switch (action) {
    case 'create': {
      let cronExpression = input.cron_expression as string | undefined;
      let parsedNextFire: string | undefined;

      if (!cronExpression && input.schedule) {
        const parsed = parseSchedule(input.schedule as string, tz);
        cronExpression = parsed.condition;
        parsedNextFire = parsed.nextFireAt;
      }

      let nextFireAt: string | null = parsedNextFire ?? null;
      if (!nextFireAt && cronExpression) {
        nextFireAt = computeNextCronFire(cronExpression, tz);
      }

      const repeating = input.schedule ? isRepeating(input.schedule as string) : false;

      const reminderId = await insertReminder({
        handle,
        chatId: ctx.chatId,
        actionDescription: input.description as string,
        cronExpression: cronExpression ?? null,
        repeating,
        nextFireAt,
        timezone: tz,
      });

      if (!reminderId) {
        return { content: JSON.stringify({ error: 'Failed to create reminder' }) };
      }

      // Emit onboarding event
      await emitOnboardingEvent({
        handle,
        chatId: ctx.chatId,
        eventType: 'reminder_created',
        payload: {
          reminder_id: reminderId,
          description: input.description,
          schedule: input.schedule ?? input.cron_expression,
          repeating,
          next_fire_at: nextFireAt,
        },
      });

      const confirmTime = nextFireAt
        ? new Date(nextFireAt).toLocaleString('en-AU', {
            timeZone: tz,
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
            weekday: 'short',
            day: 'numeric',
            month: 'short',
          })
        : (input.schedule as string) ?? 'scheduled';

      console.log(
        `[manage_reminder] Created reminder ${reminderId} for ${handle}: "${(input.description as string).slice(0, 80)}" fires at ${confirmTime}`,
      );

      return {
        content: JSON.stringify({
          reminder_id: reminderId,
          status: 'created',
          fires_at: confirmTime,
          repeating,
          _confirmation: 'Reminder created. Confirm the time to the user.',
        }),
        structuredData: { reminder_id: reminderId },
      };
    }

    case 'list': {
      const reminders = await getUserReminders(handle);

      if (reminders.length === 0) {
        return { content: JSON.stringify({ reminders: [], count: 0, message: 'No active reminders.' }) };
      }

      return {
        content: JSON.stringify({
          reminders: reminders.map((r) => ({
            reminder_id: r.id,
            description: r.actionDescription,
            repeating: r.repeating,
            next_fire_at: r.nextFireAt
              ? new Date(r.nextFireAt).toLocaleString('en-AU', {
                  timeZone: r.timezone || tz,
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                })
              : null,
            last_fired_at: r.lastFiredAt,
          })),
          count: reminders.length,
        }),
      };
    }

    case 'edit': {
      const reminderId = input.reminder_id as number;
      const updates: Record<string, unknown> = {};

      if (input.description) updates.actionDescription = input.description as string;
      if (input.active !== undefined) updates.active = input.active as boolean;

      if (input.schedule || input.cron_expression) {
        const cronExpr =
          (input.cron_expression as string) ??
          parseSchedule(input.schedule as string, tz).condition;
        updates.cronExpression = cronExpr;
        updates.nextFireAt = computeNextCronFire(cronExpr, tz);
        if (input.schedule) {
          updates.repeating = isRepeating(input.schedule as string);
        }
      }

      const success = await editReminder({
        id: reminderId,
        handle,
        ...updates,
      });

      if (!success) {
        return { content: JSON.stringify({ error: 'Failed to edit reminder' }) };
      }

      console.log(`[manage_reminder] Edited reminder ${reminderId} for ${handle}`);
      return { content: JSON.stringify({ reminder_id: reminderId, status: 'updated' }) };
    }

    case 'delete': {
      const reminderId = input.reminder_id as number;
      const success = await deleteReminder(reminderId, handle);

      if (!success) {
        return { content: JSON.stringify({ error: 'Reminder not found or already deleted' }) };
      }

      console.log(`[manage_reminder] Deleted reminder ${reminderId} for ${handle}`);
      return { content: JSON.stringify({ reminder_id: reminderId, status: 'deleted' }) };
    }

    default:
      return { content: JSON.stringify({ error: `Unknown reminder action: ${action}` }) };
  }
}

// ═══════════════════════════════════════════════════════════════
// Tool contract
// ═══════════════════════════════════════════════════════════════

export const manageReminderTool: ToolContract = {
  name: 'manage_reminder',
  description:
    'Create, list, edit, or delete reminders. Reminders are delivered via iMessage/SMS at the scheduled time.',
  namespace: 'reminders.manage',
  sideEffect: 'commit',
  idempotent: false,
  timeoutMs: 10_000,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'edit', 'delete'],
        description: 'The reminder action to perform.',
      },
      description: {
        type: 'string',
        description: 'What the reminder is about (required for create).',
      },
      schedule: {
        type: 'string',
        description:
          'Natural language schedule: "every Monday at 9am", "tomorrow at 3pm", "in 30 minutes", "every day at 8am", "every weekday at 9am". Required for create if cron_expression is not provided.',
      },
      cron_expression: {
        type: 'string',
        description:
          'Standard 5-field cron expression (minute hour dayOfMonth month dayOfWeek). Alternative to schedule.',
      },
      time_zone: {
        type: 'string',
        description:
          'IANA timezone string (e.g. "Australia/Melbourne"). Defaults to user profile timezone.',
      },
      reminder_id: {
        type: 'number',
        description: 'The reminder ID (required for edit and delete).',
      },
      active: {
        type: 'boolean',
        description: 'Set to false to pause a reminder (for edit action).',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  handler: handleManageReminder,
};
