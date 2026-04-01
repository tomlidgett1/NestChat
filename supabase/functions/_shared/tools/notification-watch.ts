import type { ToolContract, ToolContext, ToolOutput } from './types.ts';
import { getAdminClient } from '../supabase.ts';
import { provisionNotificationWebhookSubscriptions } from '../ensure-notification-webhooks.ts';

// ═══════════════════════════════════════════════════════════════
// Notification Watch Tool
// Create, list, and delete notification watch triggers for
// email and calendar events. Auto-provisions webhook subscriptions.
// ═══════════════════════════════════════════════════════════════

async function handleNotificationWatch(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutput> {
  const action = input.action as string;
  const handle = ctx.senderHandle;

  switch (action) {
    case 'create': {
      const supabase = getAdminClient();

      const sourceType = (input.source_type as string) || 'email';
      const triggerType = (input.trigger_type as string) || 'custom';
      const name = input.name as string;
      const description = input.description as string;

      if (!name || !description) {
        return { content: JSON.stringify({ error: 'name and description are required' }) };
      }

      // Insert trigger via RPC
      const { data: triggerId, error: insertErr } = await supabase.rpc(
        'insert_notification_watch_trigger',
        {
          p_handle: handle,
          p_name: name,
          p_description: description,
          p_trigger_type: triggerType,
          p_source_type: sourceType,
          p_account_email: (input.account_email as string) || null,
          p_provider: (input.provider as string) || null,
          p_match_sender: (input.match_sender as string) || null,
          p_match_subject_pattern: (input.match_subject_pattern as string) || null,
          p_match_labels: (input.match_labels as string[]) || null,
          p_use_ai_matching: input.use_ai_matching !== false,
          p_ai_prompt: (input.ai_prompt as string) || description,
          p_delivery_method: 'message',
          p_time_constraint: input.time_constraint ? JSON.stringify(input.time_constraint) : null,
        },
      );

      if (insertErr) {
        console.error(`[notification_watch] Insert failed: ${insertErr.message}`);
        return { content: JSON.stringify({ error: `Failed to create trigger: ${insertErr.message}` }) };
      }

      console.log(`[notification_watch] Created trigger ${triggerId} for ${handle}: "${name}"`);

      // Auto-provision webhook subscriptions for connected accounts
      const scope =
        sourceType === 'calendar' ? 'calendar' : sourceType === 'any' ? 'any' : 'email';
      const provisionResults = ctx.authUserId
        ? await provisionNotificationWebhookSubscriptions(ctx.authUserId, handle, scope)
        : [];

      return {
        content: JSON.stringify({
          trigger_id: triggerId,
          status: 'created',
          name,
          source_type: sourceType,
          subscriptions_ensured: provisionResults.filter((r) => r.status === 'ok').length,
          _confirmation: `Notification watch created: "${name}". You will be alerted when matching ${sourceType === 'calendar' ? 'calendar events' : 'emails'} arrive.`,
        }),
        structuredData: { trigger_id: triggerId },
      };
    }

    case 'list': {
      const supabase = getAdminClient();
      const { data: triggers, error } = await supabase.rpc(
        'get_user_notification_watch_triggers',
        { p_handle: handle },
      );

      if (error) {
        return { content: JSON.stringify({ error: `Failed to list triggers: ${error.message}` }) };
      }

      const list = (triggers as Array<Record<string, unknown>>) ?? [];

      if (list.length === 0) {
        return {
          content: JSON.stringify({
            triggers: [],
            count: 0,
            message: 'No active notification watches.',
          }),
        };
      }

      const formatted = list.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        source_type: t.source_type,
        trigger_type: t.trigger_type,
        match_sender: t.match_sender,
        fire_count: t.fire_count,
        last_fired_at: t.last_fired_at,
        created_at: t.created_at,
      }));

      return {
        content: JSON.stringify({ triggers: formatted, count: formatted.length }),
      };
    }

    case 'delete': {
      const triggerId = input.trigger_id as number;
      if (!triggerId) {
        return { content: JSON.stringify({ error: 'trigger_id is required for delete' }) };
      }

      const supabase = getAdminClient();
      const { data: deleted, error } = await supabase.rpc(
        'delete_notification_watch_trigger',
        { p_id: triggerId, p_handle: handle },
      );

      if (error) {
        return { content: JSON.stringify({ error: `Failed to delete: ${error.message}` }) };
      }

      if (!deleted) {
        return { content: JSON.stringify({ error: 'Trigger not found or already deleted' }) };
      }

      console.log(`[notification_watch] Deleted trigger ${triggerId} for ${handle}`);

      return {
        content: JSON.stringify({
          trigger_id: triggerId,
          status: 'deleted',
          _confirmation: 'Notification watch removed. You will no longer receive alerts for this.',
        }),
      };
    }

    default:
      return { content: JSON.stringify({ error: `Unknown action: ${action}` }) };
  }
}

// ═══════════════════════════════════════════════════════════════
// Tool contract
// ═══════════════════════════════════════════════════════════════

export const manageNotificationWatchTool: ToolContract = {
  name: 'manage_notification_watch',
  description:
    'Create, list, or delete notification watches for email and calendar events. ' +
    'Users can say things like "let me know when Tom emails me", "notify me about ' +
    'overdue invoices", "alert me if a meeting gets cancelled". This tool creates ' +
    'persistent triggers that monitor incoming emails and calendar events, alerting ' +
    'the user when matching content arrives.',
  namespace: 'notifications.watch',
  sideEffect: 'commit',
  idempotent: false,
  timeoutMs: 15000,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'delete'],
        description: 'Action to perform',
      },
      source_type: {
        type: 'string',
        enum: ['email', 'calendar', 'any'],
        description: 'What to watch: email, calendar events, or both. Default: email',
      },
      name: {
        type: 'string',
        description: 'Short label for the watch, e.g. "Emails from Tom", "Meeting cancellations"',
      },
      description: {
        type: 'string',
        description: 'Human-readable description of what to watch for',
      },
      trigger_type: {
        type: 'string',
        enum: [
          'sender', 'subject', 'content', 'importance', 'custom',
          'new_invite', 'cancellation', 'reschedule', 'calendar_custom', 'bill_reminder',
        ],
        description:
          'Type of trigger. Use "sender" for specific sender, "custom" for AI-evaluated criteria. ' +
          '"bill_reminder" for bills or payment-due emails. ' +
          'For calendar: "new_invite", "cancellation", "reschedule", or "calendar_custom"',
      },
      match_sender: {
        type: 'string',
        description: 'Sender name or email substring to fast-match (case-insensitive)',
      },
      match_subject_pattern: {
        type: 'string',
        description: 'Regex pattern to match against email subject or calendar event title',
      },
      ai_prompt: {
        type: 'string',
        description:
          'Semantic matching prompt for AI evaluation. Describe what emails/events to match. ' +
          'Be specific: "Email from Tom that is urgent" or "Calendar invite with more than 5 attendees"',
      },
      time_constraint: {
        type: 'object',
        description: 'Time-based constraint: only fire during certain hours or days',
        properties: {
          after_hour: {
            type: 'number',
            description: 'Only fire after this hour (0-23 in user timezone)',
          },
          before_hour: {
            type: 'number',
            description: 'Only fire before this hour (0-23 in user timezone)',
          },
          days_of_week: {
            type: 'array',
            items: { type: 'number' },
            description: 'Days of week to fire (0=Sun, 1=Mon, ..., 6=Sat)',
          },
        },
      },
      account_email: {
        type: 'string',
        description: 'Specific email account to watch (null = all connected accounts)',
      },
      provider: {
        type: 'string',
        enum: ['google', 'microsoft'],
        description: 'Specific provider (null = all providers)',
      },
      trigger_id: {
        type: 'number',
        description: 'Trigger ID (required for delete action)',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  handler: handleNotificationWatch,
};
