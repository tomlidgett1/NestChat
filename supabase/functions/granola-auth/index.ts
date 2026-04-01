import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getAdminClient } from '../_shared/supabase.ts';
import { internalJsonHeaders } from '../_shared/internal-auth.ts';

const admin = getAdminClient();

const GRANOLA_AUTH_SERVER = 'https://mcp-auth.granola.ai';
const GRANOLA_REGISTER_ENDPOINT = `${GRANOLA_AUTH_SERVER}/oauth2/register`;
const GRANOLA_AUTHORIZE_ENDPOINT = `${GRANOLA_AUTH_SERVER}/oauth2/authorize`;
const GRANOLA_TOKEN_ENDPOINT = `${GRANOLA_AUTH_SERVER}/oauth2/token`;

function getBaseUrl(): string {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  return `${url}/functions/v1/granola-auth`;
}

function getCallbackUrl(): string {
  return `${getBaseUrl()}/callback`;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateState(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

async function registerClient(redirectUri: string): Promise<{ clientId: string; clientSecret: string }> {
  const resp = await fetch(GRANOLA_REGISTER_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Nest Assistant',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      scope: 'email offline_access openid profile',
      token_endpoint_auth_method: 'client_secret_basic',
      response_types: ['code'],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`DCR failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return { clientId: data.client_id, clientSecret: data.client_secret };
}

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string | null }> {
  const credentials = btoa(`${clientId}:${clientSecret}`);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const resp = await fetch(GRANOLA_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
  };
}

async function fetchGranolaUserInfo(accessToken: string): Promise<{ email: string; name: string }> {
  try {
    const resp = await fetch(`${GRANOLA_AUTH_SERVER}/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      return { email: data.email ?? '', name: data.name ?? '' };
    }
  } catch { /* fall through */ }

  return { email: '', name: '' };
}

// ── Start auth flow ──

async function handleStart(userId: string): Promise<Response> {
  const { data: { user }, error } = await admin.auth.admin.getUserById(userId);
  if (error || !user) {
    return html(`
      <html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center;max-width:400px">
          <h2>Invalid link</h2>
          <p style="color:#666">This connection link is invalid or has expired. Ask Nest for a new one.</p>
        </div>
      </body></html>
    `, 400);
  }

  const redirectUri = getCallbackUrl();
  const { clientId, clientSecret } = await registerClient(redirectUri);

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  const { error: insertErr } = await admin.from('granola_oauth_state').insert({
    state,
    user_id: userId,
    code_verifier: codeVerifier,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  if (insertErr) {
    console.error('[granola-auth] Failed to store state:', insertErr.message);
    return html('<html><body><h2>Something went wrong. Please try again.</h2></body></html>', 500);
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'email offline_access openid profile',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const authorizeUrl = `${GRANOLA_AUTHORIZE_ENDPOINT}?${params.toString()}`;
  return new Response(null, {
    status: 302,
    headers: { Location: authorizeUrl },
  });
}

// ── OAuth callback ──

async function handleCallback(url: URL): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam) {
    const desc = url.searchParams.get('error_description') ?? errorParam;
    return html(`
      <html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center;max-width:400px">
          <h2>Connection cancelled</h2>
          <p style="color:#666">${desc}</p>
          <p style="color:#999;font-size:14px">You can close this window and ask Nest to try again.</p>
        </div>
      </body></html>
    `);
  }

  if (!code || !state) {
    return html('<html><body><h2>Missing parameters</h2></body></html>', 400);
  }

  const { data: oauthState, error: fetchErr } = await admin
    .from('granola_oauth_state')
    .select('*')
    .eq('state', state)
    .maybeSingle();

  if (fetchErr || !oauthState) {
    return html(`
      <html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center;max-width:400px">
          <h2>Link expired</h2>
          <p style="color:#666">This connection link has expired. Ask Nest for a new one.</p>
        </div>
      </body></html>
    `, 400);
  }

  await admin.from('granola_oauth_state').delete().eq('state', state);

  const created = new Date(oauthState.created_at).getTime();
  if (Date.now() - created > 10 * 60 * 1000) {
    return html(`
      <html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center;max-width:400px">
          <h2>Link expired</h2>
          <p style="color:#666">This connection link has expired. Ask Nest for a new one.</p>
        </div>
      </body></html>
    `, 400);
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(
      code,
      oauthState.code_verifier,
      oauthState.client_id,
      oauthState.client_secret,
      oauthState.redirect_uri,
    );
  } catch (err) {
    console.error('[granola-auth] Token exchange failed:', (err as Error).message);
    return html(`
      <html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center;max-width:400px">
          <h2>Connection failed</h2>
          <p style="color:#666">Could not complete the Granola connection. Please try again.</p>
        </div>
      </body></html>
    `, 500);
  }

  const userInfo = await fetchGranolaUserInfo(tokens.accessToken);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';

  const callbackResp = await fetch(`${supabaseUrl}/functions/v1/manage-google-accounts/add-granola-callback`, {
    method: 'POST',
    headers: internalJsonHeaders(),
    body: JSON.stringify({
      original_user_id: oauthState.user_id,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      email: userInfo.email,
      name: userInfo.name,
    }),
  });

  const callbackData = await callbackResp.json().catch(() => ({}));

  if (!callbackResp.ok) {
    console.error('[granola-auth] Callback failed:', callbackData);
    const detail = callbackData.detail ?? callbackData.error ?? 'Unknown error';
    return html(`
      <html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center;max-width:400px">
          <h2>Connection failed</h2>
          <p style="color:#666">${detail}</p>
        </div>
      </body></html>
    `, 500);
  }

  const displayName = encodeURIComponent(userInfo.name || userInfo.email || 'your account');

  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://nest.expert/dashboard?granola=connected&name=${displayName}`,
    },
  });
}

// ── Router ──

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
    });
  }

  const url = new URL(req.url);
  const path = url.pathname.split('/').pop() ?? '';

  try {
    if (path === 'callback') {
      return await handleCallback(url);
    }

    const userId = url.searchParams.get('user_id');
    if (!userId) {
      return html(`
        <html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
          <div style="text-align:center;max-width:400px">
            <h2>Missing user</h2>
            <p style="color:#666">This link is incomplete. Ask Nest for a new connection link.</p>
          </div>
        </body></html>
      `, 400);
    }

    return await handleStart(userId);
  } catch (err) {
    console.error('[granola-auth] Unhandled error:', err);
    return html('<html><body><h2>Something went wrong. Please try again.</h2></body></html>', 500);
  }
});
