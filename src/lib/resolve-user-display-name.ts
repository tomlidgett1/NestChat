import type { SupabaseClient } from '@supabase/supabase-js';

/** First given name for greetings, title-cased. Empty if missing. */
export function displayNameForAlerts(name: string | null | undefined): string {
  const t = (name ?? '').trim();
  if (!t) return '';
  const first = t.split(/\s+/)[0] ?? '';
  if (!first) return '';
  const lower = first.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Prefer `user_profiles` name (or display_name passed in via profile read), then Auth metadata.
 */
export async function resolveNameForAlerts(
  supabase: SupabaseClient,
  authUserId: string,
  profileName: string | null | undefined,
): Promise<string> {
  const fromProfile = displayNameForAlerts(profileName);
  if (fromProfile) return fromProfile;
  try {
    const { data, error } = await supabase.auth.admin.getUserById(authUserId);
    if (error || !data.user) return '';
    const meta = data.user.user_metadata as Record<string, unknown> | undefined;
    const raw =
      (typeof meta?.full_name === 'string' && meta.full_name.trim()) ||
      (typeof meta?.name === 'string' && meta.name.trim()) ||
      (typeof meta?.given_name === 'string' && meta.given_name.trim()) ||
      '';
    return displayNameForAlerts(raw);
  } catch {
    return '';
  }
}
