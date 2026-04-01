// Provisions Gmail Pub/Sub watch + Outlook subscriptions via manage-email-webhooks.
// Used when users link Google/Microsoft accounts and when creating notification watches.

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

import { getAdminClient } from './supabase.ts';
import { requireAnyEnv } from './env.ts';
import { internalJsonHeaders } from './internal-auth.ts';
import { getConnectedAccounts, type ConnectedAccount } from './state.ts';
import { GOOGLE_SCOPES, hasScope } from './google-scopes.ts';

export type WebhookSourceScope = 'email' | 'calendar' | 'any';

function resourceTypesForAccount(
  account: ConnectedAccount,
  sourceScope: WebhookSourceScope,
): Array<'email' | 'calendar'> {
  const out: Array<'email' | 'calendar'> = [];
  const wantEmail = sourceScope === 'email' || sourceScope === 'any';
  const wantCal = sourceScope === 'calendar' || sourceScope === 'any';

  if (account.provider === 'granola') return out;

  if (account.provider === 'microsoft') {
    if (wantEmail) out.push('email');
    if (wantCal) out.push('calendar');
    return out;
  }

  // If scopes were never persisted (legacy row), still try provisioning — Gmail API will fail safely if unauthorised.
  const scopesUnknown = account.scopes.length === 0;
  if (wantEmail && (scopesUnknown || hasScope(account.scopes, GOOGLE_SCOPES.GMAIL_MODIFY))) {
    out.push('email');
  }
  if (wantCal && (scopesUnknown || hasScope(account.scopes, GOOGLE_SCOPES.CALENDAR_EVENTS))) {
    out.push('calendar');
  }
  return out;
}

async function resolveHandle(authUserId: string, handleHint: string | null): Promise<string | null> {
  if (handleHint) return handleHint;
  const supabase = getAdminClient();
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('handle')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  return profile?.handle ?? null;
}

/**
 * Calls manage-email-webhooks with action "ensure" for each connected account and
 * resource type implied by sourceScope and OAuth scopes.
 */
export async function provisionNotificationWebhookSubscriptions(
  authUserId: string,
  handleHint: string | null,
  sourceScope: WebhookSourceScope,
): Promise<Array<{ provider: string; email: string; resource_type: string; status: string }>> {
  const results: Array<{ provider: string; email: string; resource_type: string; status: string }> = [];

  const handle = await resolveHandle(authUserId, handleHint);
  if (!handle) {
    console.warn(
      `[ensure-notification-webhooks] No handle for auth_user_id=${authUserId.slice(0, 8)}…; skipping provisioning (user_profiles.auth_user_id may be unset)`,
    );
    return results;
  }

  const accounts = await getConnectedAccounts(authUserId);
  if (!accounts.length) return results;

  const supabaseUrl = requireAnyEnv('SUPABASE_URL');

  for (const account of accounts) {
    if (account.provider !== 'google' && account.provider !== 'microsoft') continue;

    const provider = account.provider;
    const resourceTypes = resourceTypesForAccount(account, sourceScope);

    for (const rt of resourceTypes) {
      try {
        const resp = await fetch(`${supabaseUrl}/functions/v1/manage-email-webhooks`, {
          method: 'POST',
          headers: internalJsonHeaders(),
          body: JSON.stringify({
            action: 'ensure',
            provider,
            handle,
            account_email: account.email,
            user_id: authUserId,
            resource_type: rt,
          }),
        });

        const status = resp.ok ? 'ok' : `failed:${resp.status}`;
        results.push({ provider, email: account.email, resource_type: rt, status });

        if (resp.ok) {
          console.log(`[ensure-notification-webhooks] Ensured ${provider} ${rt} for ${account.email}`);
        } else {
          const errText = await resp.text();
          console.warn(
            `[ensure-notification-webhooks] ensure failed ${provider}/${account.email}/${rt}: ${errText}`,
          );
        }
      } catch (err) {
        console.warn(`[ensure-notification-webhooks] ${provider}/${account.email}/${rt}:`, err);
        results.push({ provider, email: account.email, resource_type: rt, status: 'error' });
      }
    }
  }

  return results;
}

/**
 * After linking Google or Microsoft, register inbox/calendar push so notification watches work immediately.
 * Uses EdgeRuntime.waitUntil on Supabase Edge so work is not dropped when the HTTP response is sent.
 */
export function scheduleEnsureNotificationWebhooksAfterAccountLink(
  authUserId: string,
  handleHint: string | null,
): void {
  const work = provisionNotificationWebhookSubscriptions(authUserId, handleHint, 'any').catch((err) =>
    console.warn(`[ensure-notification-webhooks] After account link: ${(err as Error).message}`),
  );

  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
    EdgeRuntime.waitUntil(work);
  }
}
