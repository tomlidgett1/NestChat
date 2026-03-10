import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { requireAnyEnv, requireEnv } from './env.ts';

let adminClient: SupabaseClient | null = null;

export function getAdminClient(): SupabaseClient {
  if (!adminClient) {
    adminClient = createClient(
      requireEnv('SUPABASE_URL'),
      requireAnyEnv('SUPABASE_SERVICE_ROLE_KEY', 'SERVICE_ROLE_KEY'),
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      },
    );
  }

  return adminClient;
}
