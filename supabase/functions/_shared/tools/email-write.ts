import type { ToolContract } from './types.ts';

export const emailDraftTool: ToolContract = {
  name: 'email_draft',
  description:
    "Create an email draft. Use this tool whenever the user wants to compose or draft an email. This does NOT send the email — it creates a draft that the user can review. After creating a draft, show it to the user and wait for their explicit confirmation before sending with email_send. Do NOT use this tool to search or read emails — use email_read for that.",
  namespace: 'email.write',
  sideEffect: 'draft',
  idempotent: false,
  requiresConfirmation: false,
  timeoutMs: 12000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: {
        type: 'array',
        items: { type: 'string' },
        description: 'Recipient email addresses. Must be valid email addresses.',
      },
      subject: {
        type: 'string',
        description: 'Email subject line.',
      },
      body: {
        type: 'string',
        description: 'Email body. Can be plain text or simple HTML (<p>, <br>, <ul><li>). Include greeting and sign-off appropriate to the context.',
      },
      cc: {
        type: 'array',
        items: { type: 'string' },
        description: 'CC recipients (optional).',
      },
      bcc: {
        type: 'array',
        items: { type: 'string' },
        description: 'BCC recipients (optional).',
      },
      reply_to_thread_id: {
        type: 'string',
        description: 'Thread ID to reply to, from a previous email_read result (optional).',
      },
      reply_all: {
        type: 'boolean',
        description: 'Whether to reply-all when replying to a thread (default false).',
      },
      account: {
        type: 'string',
        description: 'Optional: which connected account to use.',
      },
    },
    required: ['to', 'subject', 'body'],
  },
  inputExamples: [
    { to: ['colleague@example.com'], subject: 'Meeting reschedule', body: '<p>Hi,</p><p>Could we move our Friday meeting to Monday?</p><p>Thanks</p>' },
  ],
  handler: async (input, ctx) => {
    if (!ctx.authUserId) return { content: 'Email not connected. The user needs to verify their account first to access email.' };

    try {
      const { sendDraftTool } = await import('../gmail-helpers.ts');
      const result = await sendDraftTool(ctx.authUserId, {
        to: input.to,
        subject: input.subject,
        body: input.body,
        cc: input.cc,
        bcc: input.bcc,
        reply_to_thread_id: input.reply_to_thread_id,
        reply_all: input.reply_all,
        account: input.account,
      });
      return {
        content: JSON.stringify(result),
        structuredData: { action: 'draft', draftId: (result as Record<string, unknown>)?.draft_id },
      };
    } catch (err) {
      return { content: `Draft creation failed: ${(err as Error).message}. Check that recipient email addresses are valid and the account is connected.` };
    }
  },
};

export const emailSendTool: ToolContract = {
  name: 'email_send',
  description:
    "Send a previously created email draft. Requires the draft_id returned by email_draft. ONLY call this after the user has explicitly confirmed they want to send the draft (e.g. 'yes', 'send it', 'go ahead'). Never call this without user confirmation.",
  namespace: 'email.write',
  sideEffect: 'commit',
  idempotent: false,
  requiresConfirmation: true,
  timeoutMs: 12000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      draft_id: {
        type: 'string',
        description: 'The draft ID returned by a previous email_draft call.',
      },
      account: {
        type: 'string',
        description: 'Optional: which connected account to use (must match the account used for the draft).',
      },
    },
    required: ['draft_id'],
  },
  inputExamples: [
    { draft_id: 'r-1234567890' },
  ],
  handler: async (input, ctx) => {
    if (!ctx.authUserId) return { content: 'Email not connected. The user needs to verify their account first to access email.' };

    try {
      const { sendEmailTool } = await import('../gmail-helpers.ts');
      const result = await sendEmailTool(ctx.authUserId, {
        draft_id: input.draft_id,
        account: input.account,
      });
      const r = result as Record<string, unknown>;
      return {
        content: JSON.stringify(result),
        structuredData: { action: 'send', sent: true, messageId: r.message_id },
      };
    } catch (err) {
      return {
        content: `Send failed: ${(err as Error).message}. The draft_id may be invalid or expired. Try creating a new draft.`,
        structuredData: { action: 'send', sent: false, error: (err as Error).message },
      };
    }
  },
};
