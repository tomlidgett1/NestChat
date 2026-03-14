import type { ToolContract } from './types.ts';

export const emailDraftTool: ToolContract = {
  name: 'email_draft',
  description:
    "Create an email draft. Stores the draft locally for the user to review. Does NOT send the email. After creating a draft, show it to the user and wait for explicit confirmation before sending with email_send.",
  namespace: 'email.write',
  sideEffect: 'draft',
  idempotent: false,
  requiresConfirmation: false,
  timeoutMs: 5000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: {
        type: 'array',
        items: { type: 'string' },
        description: 'Recipient email addresses.',
      },
      subject: {
        type: 'string',
        description: 'Email subject line.',
      },
      body: {
        type: 'string',
        description: 'Email body text. Include greeting and sign-off.',
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
        description: 'Thread ID to reply to (optional).',
      },
      reply_all: {
        type: 'boolean',
        description: 'Whether to reply-all (default false).',
      },
      account: {
        type: 'string',
        description: 'Optional: which connected account to use.',
      },
    },
    required: ['to', 'subject', 'body'],
  },
  handler: async (input, ctx) => {
    if (!ctx.authUserId) return { content: 'Email not connected. The user needs to verify their account first to access email.' };

    const { createPendingEmailSend } = await import('../state.ts');
    const to = Array.isArray(input.to) ? input.to.filter((v): v is string => typeof v === 'string' && v.includes('@')) : [];
    if (to.length === 0) {
      return { content: 'Cannot create draft: no valid recipient email addresses provided. Please provide at least one recipient.' };
    }
    const subject = typeof input.subject === 'string' ? input.subject : null;
    const bodyText = typeof input.body === 'string' ? input.body : null;
    const cc = Array.isArray(input.cc) ? input.cc.filter((v): v is string => typeof v === 'string') : [];
    const bcc = Array.isArray(input.bcc) ? input.bcc.filter((v): v is string => typeof v === 'string') : [];
    const replyToThreadId = typeof input.reply_to_thread_id === 'string' ? input.reply_to_thread_id : null;
    const replyAll = typeof input.reply_all === 'boolean' ? input.reply_all : false;
    const account = typeof input.account === 'string' ? input.account : null;

    const pendingAction = await createPendingEmailSend({
      chatId: ctx.chatId,
      account,
      to,
      subject,
      bodyText,
      cc,
      bcc,
      replyToThreadId,
      replyAll,
      metadata: {},
    });

    if (!pendingAction) {
      return {
        content: 'Failed to create draft. Please try again.',
        structuredData: { action: 'draft', draftId: null },
      };
    }

    console.log(`[email-write] draft stored locally: pending_action_id=${pendingAction.id}, to=${to.join(',')}, subject=${subject}`);

    return {
      content: JSON.stringify({
        draft_id: String(pendingAction.id),
        status: 'awaiting_user_approval',
        preview: { to, subject, bodyText: bodyText?.substring(0, 500) },
      }),
      structuredData: {
        action: 'draft',
        draftId: String(pendingAction.id),
        to,
        subject,
        pendingActionId: pendingAction.id,
      },
    };
  },
};

export const emailUpdateDraftTool: ToolContract = {
  name: 'email_update_draft',
  description:
    "Update an existing pending email draft. Use when the user asks to revise the email before sending. Only works on drafts with status 'awaiting_user_approval'.",
  namespace: 'email.write',
  sideEffect: 'draft',
  idempotent: false,
  requiresConfirmation: false,
  timeoutMs: 5000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      draft_id: {
        type: 'string',
        description: 'The draft ID to update. Optional if there is exactly one pending draft.',
      },
      to: {
        type: 'array',
        items: { type: 'string' },
        description: 'Updated recipient list (optional).',
      },
      subject: {
        type: 'string',
        description: 'Updated subject (optional).',
      },
      body: {
        type: 'string',
        description: 'Updated body text (optional).',
      },
      cc: {
        type: 'array',
        items: { type: 'string' },
        description: 'Updated CC recipients (optional).',
      },
      bcc: {
        type: 'array',
        items: { type: 'string' },
        description: 'Updated BCC recipients (optional).',
      },
    },
    required: [],
  },
  handler: async (input, ctx) => {
    if (!ctx.authUserId) return { content: 'Email not connected.' };

    const { updatePendingEmailDraft } = await import('../state.ts');

    const draftIdStr = typeof input.draft_id === 'string' ? input.draft_id : null;
    const draftId = draftIdStr ? parseInt(draftIdStr, 10) : (ctx.pendingEmailSend?.id ?? null);

    if (!draftId || isNaN(draftId)) {
      return { content: 'No pending draft to update. Create a draft first.' };
    }

    const updates: Record<string, unknown> = {};
    if (Array.isArray(input.to)) updates.to = input.to.filter((v: unknown): v is string => typeof v === 'string');
    if (typeof input.subject === 'string') updates.subject = input.subject;
    if (typeof input.body === 'string') updates.bodyText = input.body;
    if (Array.isArray(input.cc)) updates.cc = input.cc.filter((v: unknown): v is string => typeof v === 'string');
    if (Array.isArray(input.bcc)) updates.bcc = input.bcc.filter((v: unknown): v is string => typeof v === 'string');

    const updated = await updatePendingEmailDraft(draftId, updates as Parameters<typeof updatePendingEmailDraft>[1]);

    if (!updated) {
      return { content: 'Could not update draft. It may have already been sent or cancelled.' };
    }

    console.log(`[email-write] draft updated: pending_action_id=${updated.id}`);

    return {
      content: JSON.stringify({
        draft_id: String(updated.id),
        status: updated.status,
        preview: {
          to: updated.to,
          subject: updated.subject,
          bodyText: updated.bodyText?.substring(0, 500),
        },
      }),
      structuredData: {
        action: 'update_draft',
        draftId: String(updated.id),
        to: updated.to,
        subject: updated.subject,
        pendingActionId: updated.id,
      },
    };
  },
};

export const emailSendTool: ToolContract = {
  name: 'email_send',
  description:
    "Send a previously created email draft. Reads the draft from the draft store, creates it in Gmail/Outlook, and sends it in one step. ONLY call after explicit user confirmation.",
  namespace: 'email.write',
  sideEffect: 'commit',
  idempotent: false,
  requiresConfirmation: true,
  timeoutMs: 20000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      draft_id: {
        type: 'string',
        description: 'The draft ID to send. Optional if there is exactly one pending draft.',
      },
    },
    required: [],
  },
  handler: async (input, ctx) => {
    if (!ctx.authUserId) return { content: 'Email not connected. The user needs to verify their account first to access email.' };

    const { getLatestPendingEmailSend, completePendingEmailSend, failPendingEmailSend } = await import('../state.ts');

    const draftIdStr = typeof input.draft_id === 'string' ? input.draft_id : null;
    const draftId = draftIdStr ? parseInt(draftIdStr, 10) : null;

    let draft = ctx.pendingEmailSend;
    if (draftId && draft?.id !== draftId) {
      draft = await getLatestPendingEmailSend(ctx.chatId);
    }
    if (!draft) {
      draft = await getLatestPendingEmailSend(ctx.chatId);
    }

    if (!draft) {
      return {
        content: 'No pending draft to send. Create a draft first with email_draft.',
        structuredData: { action: 'send', sent: false, error: 'no_pending_draft' },
      };
    }

    if (draft.status !== 'awaiting_confirmation') {
      return {
        content: `This draft has already been ${draft.status}. Create a new draft if needed.`,
        structuredData: { action: 'send', sent: false, error: `draft_status_${draft.status}` },
      };
    }

    if (!draft.bodyText || draft.to.length === 0) {
      return {
        content: 'Draft is incomplete (missing body or recipients). Please update the draft first.',
        structuredData: { action: 'send', sent: false, error: 'incomplete_draft' },
      };
    }

    try {
      const { sendDraftTool: gmailCreateDraft, sendEmailTool: gmailSendEmail } = await import('../gmail-helpers.ts');

      const draftResult = await gmailCreateDraft(ctx.authUserId, {
        to: draft.to,
        subject: draft.subject,
        body: draft.bodyText,
        cc: draft.cc.length > 0 ? draft.cc : undefined,
        bcc: draft.bcc.length > 0 ? draft.bcc : undefined,
        reply_to_thread_id: draft.replyToThreadId ?? undefined,
        reply_all: draft.replyAll,
        account: draft.account ?? undefined,
      });

      const dr = draftResult as Record<string, unknown>;
      const gmailDraftId = typeof dr.draft_id === 'string' ? dr.draft_id : null;
      const account = typeof dr.account === 'string' ? dr.account : (draft.account ?? undefined);

      if (!gmailDraftId) {
        await failPendingEmailSend(draft.id, 'draft_creation_failed');
        return {
          content: 'Could not create the email. The account may not be connected properly.',
          structuredData: { action: 'send', sent: false, error: 'draft_creation_failed', pendingActionId: draft.id },
        };
      }

      const sendResult = await gmailSendEmail(ctx.authUserId, {
        draft_id: gmailDraftId,
        account,
      });

      const sr = sendResult as Record<string, unknown>;
      const messageId = typeof sr.message_id === 'string' ? sr.message_id : null;
      const provider = typeof sr.provider === 'string' ? sr.provider : 'google';

      let verified = false;
      let verifyReason: string | undefined;

      if (messageId) {
        const { resolveToken, verifyGmailMessageSent, verifyOutlookMessageSent } = await import('../gmail-helpers.ts');
        try {
          const { accessToken, provider: resolvedProvider } = await resolveToken(ctx.authUserId, account as string | undefined);
          const verification = resolvedProvider === 'microsoft'
            ? await verifyOutlookMessageSent(accessToken, messageId)
            : await verifyGmailMessageSent(accessToken, messageId);
          verified = verification.verified;
          verifyReason = verification.reason;
          console.log(`[email-write] verification: verified=${verified}${verifyReason ? `, reason=${verifyReason}` : ''}`);
        } catch (verifyErr) {
          console.warn(`[email-write] verification failed (non-fatal): ${(verifyErr as Error).message}`);
          verifyReason = `verification exception: ${(verifyErr as Error).message}`;
        }
      }

      await completePendingEmailSend(draft.id, messageId ?? undefined, verified);

      const status = verified ? 'verified_sent' : 'sent_unverified';
      console.log(`[email-write] email ${status}: pending_action_id=${draft.id}, message_id=${messageId}`);

      return {
        content: JSON.stringify({
          status,
          verified,
          message_id: messageId,
          to: draft.to,
          subject: draft.subject,
        }),
        structuredData: {
          action: 'send',
          sent: true,
          verified,
          messageId,
          to: draft.to,
          subject: draft.subject,
          pendingActionId: draft.id,
        },
      };
    } catch (err) {
      await failPendingEmailSend(draft.id, (err as Error).message);
      return {
        content: `Send failed: ${(err as Error).message}. Would you like me to try again?`,
        structuredData: {
          action: 'send',
          sent: false,
          error: (err as Error).message,
          pendingActionId: draft.id,
        },
      };
    }
  },
};

export const emailCancelDraftTool: ToolContract = {
  name: 'email_cancel_draft',
  description:
    "Cancel a pending email draft. Use when the user says they don't want to send it.",
  namespace: 'email.write',
  sideEffect: 'draft',
  idempotent: true,
  requiresConfirmation: false,
  timeoutMs: 5000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      draft_id: {
        type: 'string',
        description: 'The draft ID to cancel. Optional if there is exactly one pending draft.',
      },
    },
    required: [],
  },
  handler: async (input, ctx) => {
    const { cancelPendingEmailSends } = await import('../state.ts');

    const draftIdStr = typeof input.draft_id === 'string' ? input.draft_id : null;

    if (draftIdStr) {
      const { getAdminClient } = await import('../supabase.ts');
      const { PENDING_ACTIONS_TABLE } = await import('../env.ts');
      const supabase = getAdminClient();
      await supabase
        .from(PENDING_ACTIONS_TABLE)
        .update({ status: 'cancelled', failure_reason: 'user_cancelled' })
        .eq('id', parseInt(draftIdStr, 10));
    } else {
      await cancelPendingEmailSends(ctx.chatId, 'user_cancelled');
    }

    return {
      content: JSON.stringify({ ok: true, status: 'cancelled' }),
      structuredData: { action: 'cancel_draft', cancelled: true },
    };
  },
};
