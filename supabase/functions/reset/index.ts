import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { getAdminClient } from '../_shared/supabase.ts';
import { USER_PROFILES_TABLE } from '../_shared/env.ts';

const HANDLE_TO_DELETE = '+61414187820';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405);
  }

  const supabase = getAdminClient();

  const { data: existing } = await supabase
    .from(USER_PROFILES_TABLE)
    .select('handle, name, status')
    .eq('handle', HANDLE_TO_DELETE)
    .maybeSingle();

  if (!existing) {
    return jsonResponse({ ok: true, message: `No user found with handle ${HANDLE_TO_DELETE}` });
  }

  const { error } = await supabase
    .from(USER_PROFILES_TABLE)
    .delete()
    .eq('handle', HANDLE_TO_DELETE);

  if (error) {
    console.error('[reset] Error deleting user profile:', error);
    return jsonResponse({ error: error.message }, 500);
  }

  console.log(`[reset] Deleted user profile: ${HANDLE_TO_DELETE}`);
  return jsonResponse({
    ok: true,
    deleted: {
      handle: existing.handle,
      name: existing.name,
      status: existing.status,
    },
  });
});
