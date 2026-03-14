import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { activateUser, getUserByToken } from '../_shared/state.ts';
import { getAdminClient } from '../_shared/supabase.ts';
import { sendMessage } from '../_shared/sendblue.ts';
import { fetchGrantedScopes, mergeScopes, BASE_SCOPES } from '../_shared/google-scopes.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function fetchGoogleProfile(accessToken: string): Promise<{ email: string; name: string; picture: string } | null> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { email: data.email ?? '', name: data.name ?? '', picture: data.picture ?? '' };
  } catch {
    return null;
  }
}

async function fetchMicrosoftProfile(accessToken: string): Promise<{ email: string; name: string; picture: string } | null> {
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const email = data.mail ?? data.userPrincipalName ?? '';
    const name = data.displayName ?? '';
    let picture = '';
    try {
      const photoRes = await fetch('https://graph.microsoft.com/v1.0/me/photo/$value', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (photoRes.ok) {
        const blob = await photoRes.arrayBuffer();
        const bytes = new Uint8Array(blob);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        picture = `data:image/jpeg;base64,${btoa(binary)}`;
      }
    } catch { /* photo not available */ }
    return { email, name, picture };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
  const providerToken = typeof body.provider_token === 'string' ? body.provider_token : '';
  const providerRefreshToken = typeof body.provider_refresh_token === 'string' ? body.provider_refresh_token : '';
  const provider: string = typeof body.provider === 'string' ? body.provider : 'google';
  const bodyUserId = typeof body.user_id === 'string' ? body.user_id : '';
  const isMicrosoft = provider === 'azure';

  const supabase = getAdminClient();

  // Resolve the Supabase auth user
  let uid = bodyUserId;
  if (!uid && accessToken) {
    const { data: { user }, error } = await supabase.auth.getUser(accessToken);
    if (error || !user) {
      console.error('[nest-onboard] Auth lookup failed:', error?.message);
      return json({ error: 'bad_token' }, 401);
    }
    uid = user.id;
  }

  // ── iMessage token activation flow ──
  if (token) {
    const nestUser = await getUserByToken(token);
    if (!nestUser) {
      return json({ error: 'invalid_token' }, 404);
    }

    if (nestUser.status === 'active') {
      // Still store account if we have provider tokens (re-auth case)
      if (uid && providerToken && providerRefreshToken) {
        await storeAccount(supabase, uid, providerToken, providerRefreshToken, isMicrosoft);
        await supabase.from('user_profiles').update({ auth_user_id: uid }).eq('handle', nestUser.handle);
      }
      return json({ success: true, already_active: true });
    }

    const handle = await activateUser(token);
    if (!handle) {
      return json({ error: 'activation_failed' }, 500);
    }

    console.log(`[nest-onboard] Activated user ${handle.slice(0, 6)}*** via iMessage token`);

    // Link auth user and store account
    if (uid) {
      await supabase.from('user_profiles').update({ auth_user_id: uid }).eq('handle', handle);

      if (providerToken && providerRefreshToken) {
        const result = await storeAccount(supabase, uid, providerToken, providerRefreshToken, isMicrosoft);
        if (result?.error) {
          console.error('[nest-onboard] Account store error:', result.error);
        }
      } else {
        console.warn('[nest-onboard] No provider tokens — account not stored');
      }
    }

    // Send verified welcome message in background
    const verifiedMessages = [
      "Well look at that, you're actually human\nI'm all yours now. Go on, ask me anything",
      "Verified. Welcome to the inner circle\nHit me with something, anything",
      "Alright you passed the vibe check\nI'm ready when you are. What do you need?",
      "And just like that, you're in\nGo on then, put me to work",
      "Confirmed real human. Good start\nNow the fun part. What can I help with?",
    ];
    const welcomeMsg = verifiedMessages[Math.floor(Math.random() * verifiedMessages.length)];

    const bgWork = (async () => {
      try {
        const chatId = `DM#${nestUser.botNumber}#${handle}`;
        await new Promise((r) => setTimeout(r, 3000));
        await sendMessage(chatId, welcomeMsg);
        console.log(`[nest-onboard] Sent verified welcome to ${handle.slice(0, 6)}***`);
      } catch (e) {
        console.error('[nest-onboard] Welcome message failed:', e);
      }
    })();

    // @ts-ignore — Deno Deploy EdgeRuntime
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(bgWork);
    } else {
      bgWork.catch(() => {});
    }

    return json({ success: true });
  }

  // ── Direct website sign-up (no iMessage token) ──
  if (!uid) {
    return json({ error: 'missing_token', detail: 'Provide either a verification token or an access_token.' }, 400);
  }

  if (providerToken && providerRefreshToken) {
    const result = await storeAccount(supabase, uid, providerToken, providerRefreshToken, isMicrosoft);
    if (result?.error) {
      if (result.errorType === 'email_conflict') {
        return json({ error: 'email_conflict', detail: result.detail, hint: result.hint }, 409);
      }
      if (result.errorType === 'no_refresh_token') {
        return json({ error: 'no_refresh_token', detail: result.detail, hint: result.hint }, 400);
      }
      console.error('[nest-onboard] Account store failed:', result.error);
    }
  } else {
    console.warn('[nest-onboard] Direct sign-up without provider tokens');
  }

  console.log(`[nest-onboard] Direct website sign-up: ${uid}`);
  return json({ success: true, uid });
});

// ── Store Google or Microsoft account ──

interface StoreResult {
  error?: string;
  errorType?: string;
  detail?: string;
  hint?: string;
}

async function storeAccount(
  supabase: ReturnType<typeof getAdminClient>,
  userId: string,
  providerToken: string,
  providerRefreshToken: string,
  isMicrosoft: boolean,
): Promise<StoreResult | null> {
  if (!providerRefreshToken) {
    const providerName = isMicrosoft ? 'Microsoft' : 'Google';
    return {
      error: 'no_refresh_token',
      errorType: 'no_refresh_token',
      detail: `${providerName} did not provide a refresh token. Please try signing in again.`,
      hint: 'Make sure you grant all permissions when asked.',
    };
  }

  const profile = isMicrosoft
    ? await fetchMicrosoftProfile(providerToken)
    : await fetchGoogleProfile(providerToken);

  if (!profile?.email) {
    // Non-blocking: profile fetch can fail if provider_token expired
    console.warn('[nest-onboard] Could not fetch profile from provider token');

    // Try resolving from Supabase auth metadata
    try {
      const { data: { user } } = await supabase.auth.admin.getUserById(userId);
      if (user?.email) {
        const fallbackProfile = {
          email: user.email,
          name: user.user_metadata?.full_name ?? user.user_metadata?.name ?? '',
          picture: user.user_metadata?.avatar_url ?? '',
        };
        return await upsertAccount(supabase, userId, fallbackProfile, providerRefreshToken, providerToken, isMicrosoft);
      }
    } catch { /* fall through */ }

    console.error('[nest-onboard] No email resolved — cannot store account');
    return { error: 'profile_fetch_failed' };
  }

  return await upsertAccount(supabase, userId, profile, providerRefreshToken, providerToken, isMicrosoft);
}

async function upsertAccount(
  supabase: ReturnType<typeof getAdminClient>,
  userId: string,
  profile: { email: string; name: string; picture: string },
  refreshToken: string,
  providerToken: string,
  isMicrosoft: boolean,
): Promise<StoreResult | null> {
  if (isMicrosoft) {
    // Check email conflict
    const { data: conflict } = await supabase
      .from('user_microsoft_accounts')
      .select('user_id')
      .eq('microsoft_email', profile.email)
      .neq('user_id', userId)
      .maybeSingle();

    if (conflict) {
      return {
        error: 'email_conflict',
        errorType: 'email_conflict',
        detail: 'This Microsoft account is already linked to a different Nest user.',
      };
    }

    const { data: existing } = await supabase
      .from('user_microsoft_accounts')
      .select('id, is_primary')
      .eq('user_id', userId)
      .eq('microsoft_email', profile.email)
      .maybeSingle();

    let shouldBePrimary = existing?.is_primary ?? false;
    if (!existing) {
      const { count } = await supabase
        .from('user_microsoft_accounts')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);
      shouldBePrimary = (count ?? 0) === 0;
    }

    const { error } = await supabase.from('user_microsoft_accounts').upsert(
      {
        user_id: userId,
        microsoft_email: profile.email,
        microsoft_name: profile.name,
        microsoft_avatar_url: profile.picture,
        refresh_token: refreshToken,
        is_primary: shouldBePrimary,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,microsoft_email' },
    );

    if (error) return { error: error.message };
    console.log(`[nest-onboard] Stored Microsoft account ${profile.email} for ${userId}`);
    triggerIngestion(userId).catch((e) => console.warn(`[nest-onboard] ingestion trigger failed: ${(e as Error).message}`));
    return null;
  }

  // Google
  const { data: conflict } = await supabase
    .from('user_google_accounts')
    .select('user_id')
    .eq('google_email', profile.email)
    .neq('user_id', userId)
    .maybeSingle();

  if (conflict) {
    return {
      error: 'email_conflict',
      errorType: 'email_conflict',
      detail: 'This Google account is already linked to a different Nest user.',
    };
  }

  const grantedScopes = providerToken ? await fetchGrantedScopes(providerToken) : [];
  const resolvedScopes = grantedScopes.length > 0 ? grantedScopes : [...BASE_SCOPES];

  const { data: existing } = await supabase
    .from('user_google_accounts')
    .select('id, is_primary, scopes')
    .eq('user_id', userId)
    .eq('google_email', profile.email)
    .maybeSingle();

  const finalScopes = existing?.scopes?.length
    ? mergeScopes(existing.scopes, resolvedScopes)
    : resolvedScopes;

  let shouldBePrimary = existing?.is_primary ?? false;
  if (!existing) {
    const { count } = await supabase
      .from('user_google_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    shouldBePrimary = (count ?? 0) === 0;
  }

  const { error } = await supabase.from('user_google_accounts').upsert(
    {
      user_id: userId,
      google_email: profile.email,
      google_name: profile.name,
      google_avatar_url: profile.picture,
      refresh_token: refreshToken,
      scopes: finalScopes,
      is_primary: shouldBePrimary,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,google_email' },
  );

  if (error) return { error: error.message };
  console.log(`[nest-onboard] Stored Google account ${profile.email} for ${userId}`);
  triggerIngestion(userId).catch((e) => console.warn(`[nest-onboard] ingestion trigger failed: ${(e as Error).message}`));
  return null;
}

async function triggerIngestion(authUserId: string): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const resp = await fetch(`${supabaseUrl}/functions/v1/ingest-pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        auth_user_id: authUserId,
        mode: 'full',
        sources: ['emails', 'calendar'],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const data = await resp.json().catch(() => ({}));
    console.log(`[nest-onboard] Triggered ingestion for ${authUserId}: job=${data.job_id ?? 'none'}, status=${resp.status}`);
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (msg.includes('abort')) {
      console.log(`[nest-onboard] Ingestion request sent for ${authUserId} (timed out — pipeline is running)`);
    } else {
      console.warn('[nest-onboard] triggerIngestion failed:', msg);
    }
  }
}
