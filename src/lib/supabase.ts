import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;
const CONVERSATIONS_TABLE = process.env.SUPABASE_CONVERSATIONS_TABLE || 'conversations';
const USER_PROFILES_TABLE = process.env.SUPABASE_USER_PROFILES_TABLE || 'user_profiles';

function getSupabaseUrl(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) {
    throw new Error('SUPABASE_URL is not configured');
  }
  return url;
}

function getSupabaseKey(): string {
  const key =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.NEW_SUPABASE_SECRET_KEY;

  if (!key) {
    throw new Error(
      'Set SUPABASE_SECRET_KEY or NEW_SUPABASE_SECRET_KEY',
    );
  }

  return key;
}

export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(getSupabaseUrl(), getSupabaseKey(), {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  return client;
}

export async function verifySupabaseSetup(): Promise<void> {
  const supabase = getSupabase();
  const tables = [CONVERSATIONS_TABLE, USER_PROFILES_TABLE];

  for (const table of tables) {
    const { error } = await supabase
      .from(table)
      .select('*', { head: true, count: 'exact' })
      .limit(1);

    if (error) {
      console.warn(`[supabase] Table "${table}" is not ready: ${error.message}`);
      console.warn('[supabase] Apply supabase/schema.sql in the Supabase SQL editor, or provide a server secret key for automated admin access.');
    } else {
      console.log(`[supabase] Table "${table}" is reachable`);
    }
  }
}
