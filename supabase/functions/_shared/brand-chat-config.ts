// ═══════════════════════════════════════════════════════════════
// Brand chat config from Supabase — merged into registry prompts.
// Table: nest_brand_chat_config
//
// Architecture (what business owners need):
// 1. The long “playbook” prompt (e.g. Laser Raiders sections 1–28) lives in
//    brand-registry.ts — shipped with Nest, not edited in the portal.
// 2. Portal fields (hours, prices, contact, policies, tone notes, etc.) are
//    appended as ## LIVE BUSINESS CONFIG and override older static text when
//    they disagree.
// 3. Optional core_system_prompt in DB = full replacement baseline (e.g.
//    Ruby, or a brand with no registry entry). Portal UI does not expose this
//    to normal business logins; set via DB / internal tools only.
// ═══════════════════════════════════════════════════════════════

import { getAdminClient } from './supabase.ts';

const TABLE = 'nest_brand_chat_config';
const CACHE_TTL_MS = 30_000;

export interface BrandChatConfigRow {
  brand_key: string;
  /** E.164 mobiles authorised for internal ops (Deputy, rosters). Empty = customer-only for internal topics. */
  internal_admin_phone_e164s?: string[];
  /** When non-empty, replaces registry baseline before portal appendix (internal / special brands). */
  core_system_prompt: string;
  business_display_name: string;
  opening_line: string;
  hours_text: string;
  prices_text: string;
  services_products_text: string;
  policies_text: string;
  contact_text: string;
  booking_info_text: string;
  extra_knowledge: string;
  style_template: string;
  style_notes: string;
  topics_to_avoid: string;
  escalation_text: string;
  updated_at: string;
}

const cache = new Map<string, { at: number; row: BrandChatConfigRow | null }>();

export const STYLE_TEMPLATE_PROMPTS: Record<string, string> = {
  warm_local:
    'Tone: Warm, local, and approachable. Sound like a real team member texting from the business. Use plain Australian English. Prefer short, natural messages.',
  professional_calm:
    'Tone: Professional, calm, and precise. Confident without sounding stiff or corporate. Clear next steps.',
  energetic_fun:
    'Tone: Energetic and upbeat in a natural way (not over the top). Fun where it suits the brand. Still clear and organised.',
  concise_direct:
    'Tone: Very concise. Lead with the answer. Minimal filler. Respect the customer\'s time.',
  caring_supportive:
    'Tone: Caring, patient, and supportive. Extra empathy. Never dismissive. Still boundaried and honest.',
};

function s(val: string | undefined | null): string {
  return (val ?? '').trim();
}

function rowHasPortalContent(row: BrandChatConfigRow | null): boolean {
  if (!row) return false;
  if (row.style_template && row.style_template !== 'warm_local') return true;
  const keys: (keyof BrandChatConfigRow)[] = [
    'business_display_name',
    'opening_line',
    'hours_text',
    'prices_text',
    'services_products_text',
    'policies_text',
    'contact_text',
    'booking_info_text',
    'extra_knowledge',
    'style_notes',
    'topics_to_avoid',
    'escalation_text',
  ];
  return keys.some((k) => s(row[k] as string).length > 0);
}

function buildLiveConfigBlock(row: BrandChatConfigRow): string {
  const sections: string[] = [];

  const styleKey =
    row.style_template && STYLE_TEMPLATE_PROMPTS[row.style_template]
      ? row.style_template
      : 'warm_local';
  const styleBlock = STYLE_TEMPLATE_PROMPTS[styleKey] ?? STYLE_TEMPLATE_PROMPTS.warm_local;
  sections.push('### Voice and style (portal)\n' + styleBlock);
  if (s(row.style_notes)) {
    sections.push('### Extra style direction (portal)\n' + s(row.style_notes));
  }

  if (s(row.business_display_name)) {
    sections.push('### Business name to use in chat (portal)\n' + s(row.business_display_name));
  }
  if (s(row.opening_line)) {
    sections.push(
      '### First-message introduction (portal)\nPrefer this opening for a new thread (you may vary slightly while keeping the same intent):\n' +
        s(row.opening_line),
    );
  }
  if (s(row.contact_text)) {
    sections.push('### Contact details (portal — treat as current)\n' + s(row.contact_text));
  }
  if (s(row.hours_text)) {
    sections.push('### Opening hours (portal — treat as current)\n' + s(row.hours_text));
  }
  if (s(row.prices_text)) {
    sections.push('### Pricing and packages (portal — treat as current)\n' + s(row.prices_text));
  }
  if (s(row.services_products_text)) {
    sections.push('### Services and products (portal)\n' + s(row.services_products_text));
  }
  if (s(row.booking_info_text)) {
    sections.push('### Booking and enquiries (portal)\n' + s(row.booking_info_text));
  }
  if (s(row.policies_text)) {
    sections.push('### Policies (returns, weather, cancellations, etc.) (portal)\n' + s(row.policies_text));
  }
  if (s(row.escalation_text)) {
    sections.push('### When to hand off to a human (portal)\n' + s(row.escalation_text));
  }
  if (s(row.topics_to_avoid)) {
    sections.push('### Topics or claims to avoid (portal)\n' + s(row.topics_to_avoid));
  }
  if (s(row.extra_knowledge)) {
    sections.push('### Other facts and wording for the chatbot (portal)\n' + s(row.extra_knowledge));
  }

  return sections.join('\n\n');
}

export async function fetchBrandChatConfig(brandKey: string): Promise<BrandChatConfigRow | null> {
  const key = brandKey.toLowerCase();
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return hit.row;
  }

  const supabase = getAdminClient();
  const { data, error } = await supabase.from(TABLE).select('*').eq('brand_key', key).maybeSingle();

  if (error) {
    console.error('[brand-chat-config] fetch failed:', error.message);
    cache.set(key, { at: now, row: null });
    return null;
  }

  const row = (data as BrandChatConfigRow) ?? null;
  if (row && !Array.isArray(row.internal_admin_phone_e164s)) {
    row.internal_admin_phone_e164s = [];
  }
  cache.set(key, { at: now, row });
  return row;
}

export function invalidateBrandChatConfigCache(brandKey: string): void {
  cache.delete(brandKey.toLowerCase());
}

export async function fetchBrandOpeningLine(brandKey: string): Promise<string | null> {
  const row = await fetchBrandChatConfig(brandKey);
  const line = row?.opening_line?.trim();
  return line && line.length > 0 ? line : null;
}

/**
 * Combine registry playbook + optional DB baseline + portal “live facts”.
 *
 * - Baseline: `registryBaseline` from brand-registry.ts, unless `row.core_system_prompt`
 *   is set (then that string is the baseline — for internal / Ruby-style setups).
 * - If portal fields have content, append LIVE BUSINESS CONFIG (authoritative for facts).
 */
export function mergeBrandSystemPrompt(
  registryBaseline: string,
  row: BrandChatConfigRow | null,
): string {
  if (!row) return registryBaseline;

  const baseline = s(row.core_system_prompt) ? s(row.core_system_prompt) : registryBaseline;

  if (!rowHasPortalContent(row)) {
    return baseline;
  }

  const live = buildLiveConfigBlock(row);
  return `${baseline}

---

## LIVE BUSINESS CONFIG (Nest portal)

The business edited the following in their Nest portal. Treat it as **authoritative** for hours, pricing, contact details, policies, tone notes, opening line preference, and facts when it disagrees with older static prompt text above.

${live}

### Accuracy
Do not invent details outside what the business provided and what remains in the rest of this prompt. If something is unknown, say you will need the team to confirm.`;
}
