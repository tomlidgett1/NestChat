// ═══════════════════════════════════════════════════════════════
// Brand sessions — persisted in Supabase so sessions survive
// across isolate restarts between requests.
//
// Table: brand_sessions
//   chat_id     text  PRIMARY KEY
//   brand_key   text  NOT NULL
//   activated_at timestamptz NOT NULL DEFAULT now()
// ═══════════════════════════════════════════════════════════════

import { getBrandAsync, type BrandConfig } from './brand-registry.ts';
import { getAdminClient } from './supabase.ts';

const TABLE = 'brand_sessions';

export interface BrandSession {
  brandKey: string;
  brand: BrandConfig;
  activatedAt: number;
}

export async function activateBrandSession(chatId: string, brandKey: string): Promise<BrandSession | null> {
  const brand = await getBrandAsync(brandKey);
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
  const brand = await getBrandAsync(data.brand_key);
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

const HEY_BRAND_RE = /^hey\s+(\w+)(?:\s+(internal))?\b/i;

/**
 * Parse a "Hey [keyword]" or "Hey [keyword] Internal" activation phrase.
 * "Hey Ash" → "ash", "Hey Ash Internal" → "ash-internal".
 */
export function parseHeyBrand(text: string): string | null {
  const match = text.trim().match(HEY_BRAND_RE);
  if (!match) return null;
  const base = match[1].toLowerCase();
  const suffix = match[2]?.toLowerCase();
  return suffix ? `${base}-${suffix}` : base;
}
