import { getAdminClient } from './supabase.ts';
import { getOptionalEnv } from './env.ts';

const GOOGLE_CLIENT_ID = getOptionalEnv('GOOGLE_CLIENT_ID') ?? '';
const GOOGLE_CLIENT_SECRET = getOptionalEnv('GOOGLE_CLIENT_SECRET') ?? '';
const MS_CLIENT_ID = getOptionalEnv('AZURE_CLIENT_ID') ?? getOptionalEnv('MS_CLIENT_ID') ?? '';
const MS_CLIENT_SECRET = getOptionalEnv('AZURE_CLIENT_SECRET') ?? getOptionalEnv('MS_CLIENT_SECRET') ?? '';

export interface TokenResult {
  accessToken: string;
  expiresIn: number;
  email: string;
  accountId: string;
}

export interface TokenOptions {
  accountId?: string;
  email?: string;
}

// ── Google ──

export async function getGoogleAccessToken(
  userId: string,
  options?: TokenOptions,
): Promise<TokenResult> {
  const supabase = getAdminClient();

  let query = supabase
    .from('user_google_accounts')
    .select('id, google_email, refresh_token, is_primary');

  if (options?.accountId) {
    query = query.eq('id', options.accountId).eq('user_id', userId);
  } else if (options?.email) {
    query = query.eq('google_email', options.email).eq('user_id', userId);
  } else {
    query = query.eq('user_id', userId).eq('is_primary', true);
  }

  const { data: account, error } = await query.maybeSingle();

  if (error) throw new Error(`Token broker: ${error.message}`);
  if (!account) throw new Error('No Google account found');

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured');
  }

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: account.refresh_token,
    }),
  });

  const data = await resp.json();

  if (!resp.ok) {
    throw new Error(`Google token refresh failed: ${data.error_description ?? data.error ?? resp.status}`);
  }

  // Rotate refresh token if Google returns a new one
  if (data.refresh_token && data.refresh_token !== account.refresh_token) {
    await supabase
      .from('user_google_accounts')
      .update({ refresh_token: data.refresh_token, updated_at: new Date().toISOString() })
      .eq('id', account.id);
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 3600,
    email: account.google_email,
    accountId: account.id,
  };
}

export async function getAllGoogleTokens(userId: string): Promise<TokenResult[]> {
  const supabase = getAdminClient();

  const { data: accounts, error } = await supabase
    .from('user_google_accounts')
    .select('id, google_email, refresh_token')
    .eq('user_id', userId);

  if (error) throw new Error(`Token broker: ${error.message}`);
  if (!accounts || accounts.length === 0) return [];

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured');
  }

  const results = await Promise.allSettled(
    accounts.map(async (account) => {
      const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: account.refresh_token,
        }),
      });

      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(`Refresh failed for ${account.google_email}: ${data.error_description ?? data.error}`);
      }

      if (data.refresh_token && data.refresh_token !== account.refresh_token) {
        await supabase
          .from('user_google_accounts')
          .update({ refresh_token: data.refresh_token, updated_at: new Date().toISOString() })
          .eq('id', account.id);
      }

      return {
        accessToken: data.access_token,
        expiresIn: data.expires_in ?? 3600,
        email: account.google_email,
        accountId: account.id,
      } as TokenResult;
    }),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<TokenResult> => r.status === 'fulfilled')
    .map((r) => r.value);
}

// ── Microsoft ──

export async function getMicrosoftAccessToken(
  userId: string,
  options?: TokenOptions,
): Promise<TokenResult> {
  const supabase = getAdminClient();

  let query = supabase
    .from('user_microsoft_accounts')
    .select('id, microsoft_email, refresh_token, is_primary');

  if (options?.accountId) {
    query = query.eq('id', options.accountId).eq('user_id', userId);
  } else if (options?.email) {
    query = query.eq('microsoft_email', options.email).eq('user_id', userId);
  } else {
    query = query.eq('user_id', userId).eq('is_primary', true);
  }

  const { data: account, error } = await query.maybeSingle();

  if (error) throw new Error(`Token broker: ${error.message}`);
  if (!account) throw new Error('No Microsoft account found');

  if (!MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    throw new Error('AZURE_CLIENT_ID and AZURE_CLIENT_SECRET must be configured');
  }

  const resp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      refresh_token: account.refresh_token,
      scope: 'openid email offline_access User.Read Calendars.ReadWrite Mail.ReadWrite Mail.Send Contacts.Read Files.Read.All',
    }),
  });

  const data = await resp.json();

  if (!resp.ok) {
    throw new Error(`Microsoft token refresh failed: ${data.error_description ?? data.error ?? resp.status}`);
  }

  if (data.refresh_token && data.refresh_token !== account.refresh_token) {
    await supabase
      .from('user_microsoft_accounts')
      .update({ refresh_token: data.refresh_token, updated_at: new Date().toISOString() })
      .eq('id', account.id);
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 3600,
    email: account.microsoft_email,
    accountId: account.id,
  };
}
