/**
 * Supabase Functions HTTP gateway returns JSON like
 * `{ code: "NOT_FOUND", message: "Requested function was not found" }`
 * when the slug is not deployed on the project behind SUPABASE_URL.
 */
export function formatMissingEdgeFunctionMessage(
  fnSlug: string,
  status: number,
  errText: string,
  contextLabel: string,
): string {
  try {
    const j = JSON.parse(errText) as { code?: string; message?: string };
    if (j.code === 'NOT_FOUND' || String(j.message || '').toLowerCase().includes('not found')) {
      return (
        `${contextLabel} (${status}): ${errText}. ` +
        `Deploy the Edge Function on this Supabase project: \`supabase functions deploy ${fnSlug}\` from the Nest folder, ` +
        'and ensure Nest/.env SUPABASE_URL points at that same project.'
      );
    }
  } catch {
    /* non-JSON body */
  }
  return `${contextLabel} (${status}): ${errText}`;
}
