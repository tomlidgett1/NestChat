import type { ToolContract } from './types.ts';

export const contactsReadTool: ToolContract = {
  name: 'contacts_read',
  description:
    "Search and look up the user's contacts across all connected accounts (Google and Outlook). Use this tool to find someone's email address, phone number, organisation, or other contact details. Supports two actions: 'search' to find contacts matching a name, email, or phone number, and 'get' to retrieve full details for a specific contact by resource name. ALWAYS use this tool to resolve a person's email before drafting an email or creating a calendar event when the user refers to someone by name. Do NOT guess email addresses — look them up here first.",
  namespace: 'contacts.read',
  sideEffect: 'read',
  idempotent: true,
  timeoutMs: 10000,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'get'],
        description: "The action to perform. 'search' finds contacts matching a query. 'get' retrieves full details for a specific contact by resource_name.",
      },
      query: {
        type: 'string',
        description: "Search query — a name, email address, or phone number (required when action is 'search').",
      },
      resource_name: {
        type: 'string',
        description: "The contact's resource name from a previous contacts_read search result (required when action is 'get').",
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of search results to return (default 10, max 30). Only applies to search action.',
      },
      account: {
        type: 'string',
        description: 'Optional: specific account email to target. If omitted, searches across all connected accounts.',
      },
    },
    required: ['action'],
  },
  inputExamples: [
    { action: 'search', query: 'Sarah' },
    { action: 'search', query: 'tom@example.com' },
    { action: 'search', query: 'Sarah', max_results: 5 },
    { action: 'get', resource_name: 'people/c1234567890' },
  ],
  handler: async (input, ctx) => {
    if (!ctx.authUserId) return { content: 'Contacts not available. The user needs to verify their account first.' };

    const action = input.action as string;

    try {
      if (action === 'search') {
        if (!input.query) return { content: "Missing 'query' parameter. Provide a name, email, or phone number to search for." };

        const { searchContactsTool } = await import('../contacts-helpers.ts');
        const results = await searchContactsTool(ctx.authUserId, {
          query: input.query as string,
          account: input.account as string | undefined,
          maxResults: input.max_results as number | undefined,
        });

        if (results.length === 0) {
          return { content: `No contacts found matching '${input.query}'. The user may need to provide the email address directly.` };
        }

        const formatted = results.map((c) => ({
          name: c.name,
          emails: c.emails,
          phones: c.phones,
          organisation: c.organisation,
          title: c.title,
          resource_name: c.resourceName,
          provider: c.provider,
          account: c.account,
        }));

        return { content: JSON.stringify(formatted) };
      }

      if (action === 'get') {
        if (!input.resource_name) return { content: "Missing 'resource_name' parameter. Use contacts_read with action 'search' first to find the contact." };

        const { getContactTool } = await import('../contacts-helpers.ts');
        const contact = await getContactTool(ctx.authUserId, {
          resourceName: input.resource_name as string,
          account: input.account as string | undefined,
        });

        if (!contact) {
          return { content: 'Contact not found. It may have been removed or the resource name is invalid.' };
        }

        return {
          content: JSON.stringify({
            name: contact.name,
            emails: contact.emails,
            phones: contact.phones,
            organisation: contact.organisation,
            title: contact.title,
            biography: contact.biography,
            urls: contact.urls,
            resource_name: contact.resourceName,
            provider: contact.provider,
            account: contact.account,
          }),
        };
      }

      return { content: "Invalid action. Use 'search' to find contacts or 'get' to retrieve a specific contact's details." };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('token') || msg.includes('auth')) {
        return { content: `Contacts access error: ${msg}. The user may need to reconnect their account.` };
      }
      return { content: `Contacts lookup failed: ${msg}. Try a simpler search query.` };
    }
  },
};
