import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getAdminClient } from '../_shared/supabase.ts';
import {
  fetchCalendarTimezone,
  fetchOutlookTimezone,
} from '../_shared/calendar-helpers.ts';
import {
  getGoogleAccessToken,
  getMicrosoftAccessToken,
} from '../_shared/token-broker.ts';
import { authorizeInternalRequest } from '../_shared/internal-auth.ts';
import { updateUserTimezone, emitOnboardingEvent, addMessage } from '../_shared/state.ts';
import { sendMessage, createChat } from '../_shared/linq.ts';
import { resolveChatId, resolveBotNumber } from '../_shared/email-webhook-helpers.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function tzLabel(tz: string): string {
  if (!tz || !tz.includes('/')) return tz;
  const tail = tz.split('/').pop();
  return tail ? tail.replace(/_/g, ' ') : tz;
}

// ── Per-account types ───────────────────────────────────────────

interface LinkedAccount {
  accountId: string;
  email: string;
  provider: 'google' | 'microsoft';
  isPrimary: boolean;
  storedAccountTz: string | null;
  userId: string;
}

interface UserBundle {
  handle: string;
  authUserId: string;
  profileTz: string | null;
  accounts: LinkedAccount[];
}

// ── Load all users with their linked accounts ───────────────────

async function loadUserBundles(): Promise<UserBundle[]> {
  const supabase = getAdminClient();

  const [{ data: gAccounts }, { data: msAccounts }] = await Promise.all([
    supabase
      .from('user_google_accounts')
      .select('id, user_id, google_email, is_primary, timezone'),
    supabase
      .from('user_microsoft_accounts')
      .select('id, user_id, microsoft_email, is_primary, timezone'),
  ]);

  const userMap = new Map<string, LinkedAccount[]>();

  for (const row of gAccounts ?? []) {
    const uid = row.user_id as string;
    if (!uid) continue;
    const list = userMap.get(uid) ?? [];
    list.push({
      accountId: row.id as string,
      email: row.google_email as string,
      provider: 'google',
      isPrimary: Boolean(row.is_primary),
      storedAccountTz: (row.timezone as string | null) ?? null,
      userId: uid,
    });
    userMap.set(uid, list);
  }

  for (const row of msAccounts ?? []) {
    const uid = row.user_id as string;
    if (!uid) continue;
    const list = userMap.get(uid) ?? [];
    list.push({
      accountId: row.id as string,
      email: row.microsoft_email as string,
      provider: 'microsoft',
      isPrimary: Boolean(row.is_primary),
      storedAccountTz: (row.timezone as string | null) ?? null,
      userId: uid,
    });
    userMap.set(uid, list);
  }

  const userIds = [...userMap.keys()];
  if (userIds.length === 0) return [];

  const bundles: UserBundle[] = [];
  const chunkSize = 150;

  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize);
    const { data: profiles, error } = await supabase
      .from('user_profiles')
      .select('handle, auth_user_id, timezone')
      .in('auth_user_id', chunk);

    if (error) {
      console.warn('[calendar-timezone-cron] profile chunk load failed:', error.message);
      continue;
    }
    for (const row of profiles ?? []) {
      const handle = row.handle as string;
      const authUserId = row.auth_user_id as string | null;
      if (!handle || !authUserId) continue;
      const accounts = userMap.get(authUserId);
      if (!accounts || accounts.length === 0) continue;
      bundles.push({
        handle,
        authUserId,
        profileTz: (row.timezone as string | null) ?? null,
        accounts,
      });
    }
  }

  return bundles;
}

// ── Fetch live timezone for a single account ────────────────────

async function fetchLiveTz(account: LinkedAccount): Promise<string> {
  if (account.provider === 'microsoft') {
    const token = await getMicrosoftAccessToken(account.userId, { email: account.email });
    return fetchOutlookTimezone(token.accessToken);
  }
  const token = await getGoogleAccessToken(account.userId, { email: account.email });
  return fetchCalendarTimezone(token.accessToken);
}

// ── Persist account-level timezone ──────────────────────────────

async function updateAccountTimezone(account: LinkedAccount, tz: string): Promise<void> {
  const supabase = getAdminClient();
  const table = account.provider === 'google' ? 'user_google_accounts' : 'user_microsoft_accounts';
  await supabase
    .from(table)
    .update({ timezone: tz, updated_at: new Date().toISOString() })
    .eq('id', account.accountId);
}

// ── Messaging helpers ───────────────────────────────────────────

async function sendTzMessage(
  handle: string,
  message: string,
): Promise<string | null> {
  const botNumber = await resolveBotNumber(handle);
  if (!botNumber) return null;

  let chatId = await resolveChatId(handle);
  if (chatId && UUID_RE.test(chatId)) {
    await sendMessage(chatId, message);
  } else {
    const chatResult = await createChat(botNumber, [handle], message);
    chatId = chatResult.chat.id;
  }

  try {
    await addMessage(chatId, 'assistant', message);
  } catch (err) {
    console.warn('[calendar-timezone-cron] addMessage failed:', err);
  }

  return chatId;
}

// ── Main handler ────────────────────────────────────────────────

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') {
      return jsonResponse({ error: 'method not allowed' }, 405);
    }
    if (!authorizeInternalRequest(req)) {
      return jsonResponse({ error: 'unauthorised' }, 401);
    }

    const bundles = await loadUserBundles();
    if (bundles.length === 0) {
      return jsonResponse({ message: 'No linked accounts to check', checked: 0, notified: 0 });
    }

    let accounts_checked = 0;
    let primary_notified = 0;
    let secondary_notified = 0;
    let filled_blank = 0;
    let updated_silently = 0;
    const errors: string[] = [];

    for (const bundle of bundles) {
      for (const account of bundle.accounts) {
        try {
          let liveTz: string;
          try {
            liveTz = await fetchLiveTz(account);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[calendar-timezone-cron] token ${bundle.handle}/${account.email}: ${msg}`);
            continue;
          }
          accounts_checked++;

          if (!liveTz || liveTz === 'UTC') continue;

          const previousAccountTz = account.storedAccountTz?.trim() || null;
          const accountTzChanged = previousAccountTz !== null && previousAccountTz !== liveTz;
          const accountTzFirstSeen = previousAccountTz === null;

          // Always persist the live timezone on the account row
          if (previousAccountTz !== liveTz) {
            await updateAccountTimezone(account, liveTz);
          }

          if (account.isPrimary) {
            // ── Primary account ──
            const profileTz = bundle.profileTz?.trim() || null;

            if (!profileTz) {
              await updateUserTimezone(bundle.handle, liveTz);
              filled_blank++;
              continue;
            }

            if (profileTz === liveTz) continue;

            // Primary changed — auto-update profile + notify
            const message = `Looks like your calendar timezone shifted (${tzLabel(profileTz)} to ${tzLabel(liveTz)}). Where are you off to?`;
            const chatId = await sendTzMessage(bundle.handle, message);

            if (chatId) {
              await emitOnboardingEvent({
                handle: bundle.handle,
                chatId,
                eventType: 'calendar_timezone_change_notified',
                payload: {
                  account_email: account.email,
                  account_type: 'primary',
                  previous_timezone: profileTz,
                  new_timezone: liveTz,
                  calendar_provider: account.provider,
                },
              });
              primary_notified++;
              console.log(
                `[calendar-timezone-cron] primary notified ${bundle.handle} (${account.email}): ${profileTz} -> ${liveTz}`,
              );
            } else {
              updated_silently++;
            }

            await updateUserTimezone(bundle.handle, liveTz);
          } else {
            // ── Secondary account ──
            if (accountTzFirstSeen || !accountTzChanged) continue;

            const prev = tzLabel(previousAccountTz!);
            const next = tzLabel(liveTz);
            const message =
              `Your ${account.email} calendar timezone changed (${prev} to ${next}). Want me to update your main timezone to ${next}?`;

            const chatId = await sendTzMessage(bundle.handle, message);
            if (chatId) {
              await emitOnboardingEvent({
                handle: bundle.handle,
                chatId,
                eventType: 'calendar_timezone_change_notified',
                payload: {
                  account_email: account.email,
                  account_type: 'secondary',
                  previous_timezone: previousAccountTz,
                  new_timezone: liveTz,
                  calendar_provider: account.provider,
                },
              });
              secondary_notified++;
              console.log(
                `[calendar-timezone-cron] secondary notified ${bundle.handle} (${account.email}): ${previousAccountTz} -> ${liveTz}`,
              );
            }
            // Profile timezone NOT updated — user decides via conversation
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[calendar-timezone-cron] ${bundle.handle}/${account.email}:`, msg);
          errors.push(`${bundle.handle}/${account.email}: ${msg}`);
        }
      }
    }

    return jsonResponse({
      message: 'Calendar timezone check complete',
      users: bundles.length,
      accounts_checked,
      primary_notified,
      secondary_notified,
      filled_blank_profile: filled_blank,
      updated_silently_no_bot: updated_silently,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[calendar-timezone-cron] fatal:', msg);
    return jsonResponse({ error: msg }, 500);
  }
});
