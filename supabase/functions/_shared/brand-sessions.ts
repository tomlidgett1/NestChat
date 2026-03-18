// ═══════════════════════════════════════════════════════════════
// Brand sessions — persisted in Supabase so sessions survive
// across isolate restarts between requests.
//
// Table: brand_sessions
//   chat_id     text  PRIMARY KEY
//   brand_key   text  NOT NULL
//   activated_at timestamptz NOT NULL DEFAULT now()
// ═══════════════════════════════════════════════════════════════

import { getBrand, type BrandConfig } from './brand-registry.ts';
import { getAdminClient } from './supabase.ts';

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const TABLE = 'brand_sessions';

export interface BrandSession {
  brandKey: string;
  brand: BrandConfig;
  activatedAt: number;
}

export async function activateBrandSession(chatId: string, brandKey: string): Promise<BrandSession | null> {
  const brand = getBrand(brandKey);
  if (!brand) return null;

  const supabase = getAdminClient();
  const { error } = await supabase
    .from(TABLE)
    .upsert({ chat_id: chatId, brand_key: brandKey.toLowerCase(), activated_at: new Date().toISOString() }, { onConflict: 'chat_id' });

  if (error) {
    console.error('[brand-session] failed to activate:', error.message);
    return null;
  }

  const session: BrandSession = { brandKey: brandKey.toLowerCase(), brand, activatedAt: Date.now() };
  console.log(`[brand-session] activated "${brand.name}" for chat ${chatId}`);
  return session;
}

export async function getBrandSession(chatId: string): Promise<BrandSession | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from(TABLE)
    .select('brand_key, activated_at')
    .eq('chat_id', chatId)
    .maybeSingle();

  if (error || !data) return null;

  const activatedAt = new Date(data.activated_at).getTime();
  if (Date.now() - activatedAt > SESSION_TTL_MS) {
    // Expired — clean it up
    await supabase.from(TABLE).delete().eq('chat_id', chatId);
    console.log(`[brand-session] expired for chat ${chatId}`);
    return null;
  }

  const brand = getBrand(data.brand_key);
  if (!brand) return null;

  return { brandKey: data.brand_key, brand, activatedAt };
}

export async function deactivateBrandSession(chatId: string): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase.from(TABLE).delete().eq('chat_id', chatId);
  if (error) {
    console.error('[brand-session] failed to deactivate:', error.message);
  } else {
    console.log(`[brand-session] deactivated for chat ${chatId}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Detection helpers
// ═══════════════════════════════════════════════════════════════

const HEY_BRAND_RE = /^hey\s+(\w+)(?:\s*[:;]-?\))?\s*[!.?]*$/i;

/**
 * Parse a "Hey [keyword]" activation phrase.
 * Returns the keyword (lowercased) or null if the message doesn't match.
 */
export function parseHeyBrand(text: string): string | null {
  const match = text.trim().match(HEY_BRAND_RE);
  return match ? match[1].toLowerCase() : null;
}
