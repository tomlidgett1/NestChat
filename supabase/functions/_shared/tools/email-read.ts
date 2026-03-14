import type { ToolContract } from './types.ts';

export const emailReadTool: ToolContract = {
  name: 'email_read',
  description:
    "Read the user's email across all connected accounts (Gmail and Outlook). Use this tool whenever the user asks about their email, inbox, or a specific message. Supports two actions: 'search' to find emails matching a query, and 'get' to retrieve the full content of a specific email by its message ID. When searching, use Gmail-style search syntax — it works for both Gmail and Outlook (queries are translated automatically). Examples: 'from:someone@example.com', 'subject:invoice', 'newer_than:7d', 'is:unread'. When getting a specific email, you must have the message_id from a previous search result. Do NOT use this tool to send, draft, or modify emails — use email_draft and email_send for that. Returns email metadata and content; use response_format to control verbosity.",
  namespace: 'email.read',
  sideEffect: 'read',
  idempotent: true,
  timeoutMs: 12000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'get'],
        description: "The action to perform. 'search' finds emails matching a query. 'get' retrieves the full content of a specific email by message_id.",
      },
      query: {
        type: 'string',
        description: "Search query (required when action is 'search'). Use Gmail-style operators (works for both Gmail and Outlook): from:, to:, subject:, newer_than:, older_than:, is:unread, has:attachment, label:, in:sent, etc.",
      },
      message_id: {
        type: 'string',
        description: "The message ID from a previous email_read search result (required when action is 'get').",
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of search results to return (default 10, max 20). Only applies to search action.',
      },
      account: {
        type: 'string',
        description: 'Optional: specific account email to target. If omitted, searches/reads from all connected accounts.',
      },
      response_format: {
        type: 'string',
        enum: ['concise', 'detailed'],
        description: "Controls response verbosity. 'concise' (default) returns sender, subject, date, snippet. 'detailed' returns full headers, body, and IDs for downstream actions.",
      },
    },
    required: ['action'],
  },
  inputExamples: [
    { action: 'search', query: 'from:sarah@example.com newer_than:7d', max_results: 5 },
    { action: 'search', query: 'subject:invoice is:unread', response_format: 'detailed' },
    { action: 'get', message_id: '18f1a2b3c4d5e6f7', response_format: 'detailed' },
  ],
  handler: async (input, ctx) => {
    if (!ctx.authUserId) return { content: 'Email not connected. The user needs to verify their account first to access email.' };

    const action = input.action as string;
    const format = (input.response_format as string) || 'concise';

    try {
      if (action === 'search') {
        if (!input.query) return { content: "Missing 'query' parameter. Provide a search query like 'from:name subject:topic newer_than:7d'." };
        const { gmailSearchTool } = await import('../gmail-helpers.ts');
        const result = await gmailSearchTool(ctx.authUserId, {
          query: input.query,
          max_results: input.max_results,
          account: input.account,
        });
        if (format === 'concise' && Array.isArray(result)) {
          const concise = result.map((email: Record<string, unknown>) => ({
            message_id: email.message_id ?? email.id,
            from: email.from,
            subject: email.subject,
            date: email.date,
            snippet: email.snippet,
          }));
          return { content: JSON.stringify(concise) };
        }
        return { content: JSON.stringify(result) };
      }

      if (action === 'get') {
        if (!input.message_id) return { content: "Missing 'message_id' parameter. Use email_read with action 'search' first to find the message ID." };
        const { getEmailTool } = await import('../gmail-helpers.ts');
        const result = await getEmailTool(ctx.authUserId, {
          message_id: input.message_id,
          account: input.account,
        });
        if (format === 'concise' && typeof result === 'object' && result !== null) {
          const r = result as Record<string, unknown>;
          const concise = {
            message_id: r.message_id ?? r.id,
            from: r.from,
            to: r.to,
            subject: r.subject,
            date: r.date,
            body: r.body ?? r.text ?? r.snippet,
            thread_id: r.thread_id,
          };
          return { content: JSON.stringify(concise) };
        }
        return { content: JSON.stringify(result) };
      }

      return { content: "Invalid action. Use 'search' to find emails or 'get' to read a specific email." };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('token') || msg.includes('auth')) {
        return { content: `Email access error: ${msg}. The user may need to reconnect their email account.` };
      }
      return { content: `Email read failed: ${msg}. Try a simpler query (e.g. "from:name subject:topic newer_than:7d").` };
    }
  },
};
