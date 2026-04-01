import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { extractLightspeedRelationRows, sumItemShopQohForShop } from './lightspeed-client.ts';

const LIGHTSPEED_PROVIDER = 'lightspeed';

/** Triggers a read from mirrored `nest_brand_lightspeed_item` rows (POS inventory snapshot). */
export const INVENTORY_QUERY_RE =
  /(\blightspeed\b|\bstock\b|\binventory\b|\bon hand\b|\bin stock\b|\bout of stock\b|\bhow many\b|\bquantity\b|\bqoh\b|\bsku\b|\bavailable\b|\bsellable\b|\bbackorder\b|\breorder\b|do (?:you|we) (?:have|sell|carry|stock)|have (?:you|we) got|got any|any\s+\w+\s+left|any left|products?\s+in\s+stock|what'?s\s+in\s+stock|items?\s+in\s+stock|what\s+(?:\w+\s+)?do\s+we\s+have|what about\b|how about\b|and\s+\w+\s*\?|or\s+\w+\s*\?|\bcheapest\b|\bmost expensive\b|\bpriciest\b|\bprice of\b|\bhow much (?:is|are|for|does)\b|\bwhat(?:'s| is| are) the price\b)/i;

const PRODUCT_CATEGORY_RE =
  /\b(bikes?|tyres?|tires?|helmets?|lights?|pedals?|tubes?|chains?|gloves?|shoes?|saddles?|wheels?|frames?|forks?|grips?|pumps?|locks?|racks?|bells?|bottles?|jerseys?|shorts?|jackets?|mudguards?|panniers?|baskets?|cables?|brakes?|pads?|derailleurs?|cassettes?|cranks?|rotors?|e-?bikes?|electric\s+bikes?|handlebars?|seatposts?|stems?|cleats?|speedos?|computers?|gps|garmin|shimano|sram|campagnolo|continental|vittoria|pirelli|maxxis|schwalbe|knog|cateye|orbea|trek|giant|specialized|cannondale|bmc|merida|scott|cervelo|colnago|pinarello|bar\s*tape|tape|spokes?|hubs?|rims?|tapes?|bibs?|knicks?|socks?|sunglasses|glasses|goggles|gp\s*5000|gp\s*4000|turbo\s*levo|wahoo|elite|topeak|lezyne|fizik|brooks|campag|enve|zipp|dt\s*swiss|fulcrum|mavic|trainers?|rollers?|tools?|lube|cages?|vests?|caps?|warmers?)\b/i;

export function messageSuggestsInventoryQuery(message: string): boolean {
  const text = message.trim();
  if (INVENTORY_QUERY_RE.test(text)) return true;
  if (PRODUCT_CATEGORY_RE.test(text)) return true;
  return false;
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'you',
  'are',
  'our',
  'any',
  'can',
  'how',
  'many',
  'much',
  'what',
  'when',
  'where',
  'which',
  'with',
  'from',
  'that',
  'this',
  'your',
  'have',
  'does',
  'did',
  'will',
  'just',
  'like',
  'into',
  'also',
  'some',
  'very',
  'tell',
  'about',
  'please',
  'thanks',
  'stock',
  'inventory',
  'quantity',
  'available',
  'product',
  'products',
  'item',
  'items',
  'got',
  'get',
  'check',
  'cheapest',
  'most',
  'expensive',
  'looking',
  'need',
  'want',
  'sell',
  'carry',
  'price',
  'cost',
  'buy',
  'left',
  'brand',
  'brands',
  'range',
  'show',
  'list',
  'find',
  'being',
  'serviced',
  'service',
  'services',
  'workshop',
  'repair',
  'repairs',
  'today',
  'tomorrow',
  'yesterday',
  'week',
  'month',
  'revenue',
  'sales',
  'sold',
  'sell',
  'selling',
  'money',
  'made',
  'taken',
  'takings',
  'busy',
  'work',
  'orders',
  'workorder',
  'workorders',
  'due',
  'finished',
  'best',
  'total',
  'done',
  'open',
  'current',
  'currently',
  'right',
  'now',
  'whats',
  'what',
  'thing',
  'things',
  'stuff',
  'something',
  'anything',
  'everything',
  'nothing',
  'there',
  'here',
  'these',
  'those',
  'them',
  'their',
  'they',
  'could',
  'would',
  'should',
  'really',
  'pretty',
  'quite',
  'been',
  'going',
  'come',
  'still',
  'give',
  'keep',
  'reckon',
  'hey',
  'hello',
  'hi',
  'mate',
  'guys',
  'cheers',
  'yeah',
  'yep',
  'nah',
  'new',
  'old',
  'maybe',
  'perhaps',
  'think',
  'know',
  'see',
  'well',
  'only',
  'sure',
  'good',
  'great',
  'nice',
  'cool',
  'awesome',
  'okay',
  'couple',
  'few',
  'lots',
  'pair',
  'set',
  'bit',
  'sort',
  'kind',
  'type',
  'after',
  'ride',
  'rides',
  'riding',
  'cycling',
  'wondering',
  'wondering',
  'interested',
  'looking',
  'options',
  'option',
  'recommend',
  'recommendation',
  'suggest',
  'suggestion',
  'under',
  'over',
  'below',
  'above',
  'between',
  'around',
  'less',
  'more',
  'than',
  'bucks',
  'dollars',
  'budget',
  'affordable',
  'cheap',
  'money',
  'spend',
  'max',
  'minimum',
  'maximum',
  'water',
  'front',
  'rear',
  'back',
  'both',
  'full',
  'spare',
  'replacement',
  'replace',
  'upgrade',
  'mine',
  'hers',
  'his',
  'needs',
  'wants',
  'wanted',
  'knows',
  'thinks',
  'goes',
  'makes',
  'takes',
  'puts',
  'gets',
  'gives',
  'comes',
  'uses',
  'runs',
  'fits',
  'works',
  'looking',
  'searching',
  'wondering',
  'hoping',
  'trying',
  'needing',
  'getting',
  'buying',
  'christmas',
  'birthday',
  'present',
  'gift',
  'each',
  'every',
  'single',
  'all',
  'out',
  'own',
  'any',
  'many',
  'much',
  'other',
  'another',
  'different',
  'specific',
  'particular',
  'exact',
  'same',
  'various',
  'types',
  'kinds',
  'models',
  'styles',
  'sizes',
  'colours',
  'colors',
]);

const SEARCH_SYNONYMS: Record<string, string[]> = {
  ebike: ['electric', 'e-bike'],
  ebikes: ['electric', 'e-bike'],
  'e-bike': ['electric', 'ebike'],
  'e-bikes': ['electric', 'ebike'],
  electric: ['e-bike', 'ebike'],
  mtb: ['mountain'],
  roadie: ['road'],
  spd: ['shimano', 'pedal'],
  di2: ['shimano', 'electronic'],
  etap: ['sram', 'electronic'],
  fixie: ['fixed', 'track'],
  tubeless: ['tubeless'],
  groupset: ['groupset', 'gruppo'],
  gruppo: ['groupset', 'gruppo'],
  tyre: ['tyre', 'tire'],
  tyres: ['tyres', 'tires'],
  tire: ['tire', 'tyre'],
  tires: ['tires', 'tyres'],
  gp5000: ['grand prix', 'continental'],
  gp4000: ['grand prix', 'continental'],
  'turbo levo': ['turbo', 'levo', 'specialized'],
  sworks: ['s-works', 'specialized'],
  's-works': ['sworks', 'specialized'],
  wahoo: ['wahoo', 'elemnt'],
  elemnt: ['wahoo', 'elemnt'],
};

/** Pull search tokens from the user message, with synonym expansion. */
export function extractInventorySearchTerms(message: string): string[] {
  const lower = message.toLowerCase();
  const raw = lower.match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (w: string) => {
    if (w.length < 3) return;
    if (STOPWORDS.has(w)) return;
    if (seen.has(w)) return;
    seen.add(w);
    out.push(w);
  };

  for (const w of raw) {
    add(w);
    const synonyms = SEARCH_SYNONYMS[w];
    if (synonyms) {
      for (const s of synonyms) add(s);
    }
  }

  return out.slice(0, 10);
}

/** Sum quantity-on-hand across ItemShop blobs from Lightspeed (strings or numbers). */
export function sumItemShopsQoh(itemShops: unknown): number {
  if (!Array.isArray(itemShops)) return 0;
  let t = 0;
  for (const s of itemShops) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    const q = o.qoh ?? o.QOH ?? o.quantityOnHand ?? o.quantity;
    if (typeof q === 'number' && Number.isFinite(q)) {
      t += q;
      continue;
    }
    if (typeof q === 'string' && q.trim() !== '') {
      const n = Number(q);
      if (Number.isFinite(n)) t += n;
    }
  }
  return t;
}

function formatSyncLine(syncedAt: string | null): string {
  if (!syncedAt) return 'Snapshot time unknown.';
  try {
    const d = new Date(syncedAt);
    if (Number.isNaN(d.getTime())) return `Snapshot: ${syncedAt}`;
    const melb = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Melbourne',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(d);
    return `Snapshot (Melbourne): ${melb}`;
  } catch {
    return `Snapshot: ${syncedAt}`;
  }
}

/** Lightspeed shop id used for displayed QOH in chat (ItemShop.shopID). */
const INVENTORY_QOH_SHOP_ID = 1;

type ItemRow = {
  item_id: number;
  description: string | null;
  custom_sku: string | null;
  item_shops: unknown;
  synced_at: string;
  archived: boolean | null;
  default_price: number | null;
  qoh: number | null;
};

function qohForDisplayShop(r: ItemRow): number {
  if (typeof r.qoh === 'number' && Number.isFinite(r.qoh)) {
    return r.qoh;
  }
  const shops = extractLightspeedRelationRows(r.item_shops, ['ItemShop', 'itemShop']);
  return sumItemShopQohForShop(shops, INVENTORY_QOH_SHOP_ID);
}

function formatAudPrice(n: number): string {
  try {
    return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n);
  } catch {
    return `$${n}`;
  }
}

function formatItemLines(rows: ItemRow[]): { lines: string[]; totalQoh: number } {
  const lines: string[] = [];
  let totalQoh = 0;
  for (const r of rows) {
    const q = qohForDisplayShop(r);
    totalQoh += q;
    const name = (r.description ?? '').trim() || '(no description)';
    const sku = (r.custom_sku ?? '').trim();
    const skuBit = sku ? ` — SKU ${sku}` : '';
    const price =
      typeof r.default_price === 'number' && Number.isFinite(r.default_price)
        ? ` — ${formatAudPrice(r.default_price)}`
        : '';
    lines.push(
      `- ${name}${skuBit}${price} — QOH (shop ${INVENTORY_QOH_SHOP_ID}) ${q} (item id ${r.item_id})`,
    );
  }
  return { lines, totalQoh };
}

/**
 * When the shopper asks about stock/inventory, inject a factual block from the latest
 * Lightspeed inventory snapshot stored in Supabase (no live Lightspeed API call).
 */
export async function buildLightspeedInventoryPrefix(opts: {
  supabase: SupabaseClient;
  brandKey: string;
  message: string;
}): Promise<string> {
  if (!messageSuggestsInventoryQuery(opts.message)) return '';

  const { data: conn } = await opts.supabase
    .from('nest_brand_portal_connections')
    .select('api_endpoint')
    .eq('brand_key', opts.brandKey)
    .eq('provider', LIGHTSPEED_PROVIDER)
    .maybeSingle();

  const { count: totalItems, error: countErr } = await opts.supabase
    .from('nest_brand_lightspeed_item')
    .select('*', { count: 'exact', head: true })
    .eq('brand_key', opts.brandKey);

  if (countErr) {
    console.error('[brand-lightspeed-inventory] count error:', countErr.message);
    return [
      '[LIVE LIGHTSPEED INVENTORY]',
      '**Inventory lookup error** — could not read the mirrored Lightspeed table.',
      '---',
      '',
    ].join('\n');
  }

  const n = totalItems ?? 0;
  if (n === 0 && !conn) {
    return [
      '[LIVE LIGHTSPEED INVENTORY]',
      '**Lightspeed is not connected** and there is **no inventory snapshot** in Nest yet.',
      'Ask the business to connect Lightspeed in the portal and wait for the inventory sync (or run it from the portal).',
      '---',
      '',
    ].join('\n');
  }

  if (n === 0) {
    return [
      '[LIVE LIGHTSPEED INVENTORY]',
      'Lightspeed is connected, but **no inventory rows** are stored yet.',
      'The snapshot job may still be running, or the last run hit rate limits — try again later or sync from the portal.',
      '---',
      '',
    ].join('\n');
  }

  const baseBrandName = opts.brandKey.replace(/-internal$/, '');
  const cleanedMsg = opts.message
    .replace(new RegExp(`^hey\\s+${baseBrandName}(?:\\s+internal)?[,!.:\\s]*`, 'i'), '')
    .trim() || opts.message;
  const terms = extractInventorySearchTerms(cleanedMsg);
  let query = opts.supabase
    .from('nest_brand_lightspeed_item')
    .select('item_id, description, custom_sku, item_shops, synced_at, archived, default_price, qoh')
    .eq('brand_key', opts.brandKey)
    .order('description', { ascending: true, nullsFirst: false });

  if (terms.length > 0) {
    const safe = (t: string) => t.replace(/%/g, '').replace(/_/g, '');
    const usable = terms.map(safe).filter((t) => t.length >= 3);

    const GENERIC_BASE = new Set([
      'bike', 'bikes', 'light', 'lights', 'shoe', 'shoes', 'bar',
      'bell', 'bells', 'bottle', 'bottles', 'short', 'shorts',
    ]);

    const expandTerm = (t: string): string[] => {
      const out = [t];
      const stem = t.replace(/(?:ies)$/, 'y').replace(/(?:s|es|ed)$/, '');
      if (stem.length >= 3 && stem !== t) out.push(stem);
      const noHyphen = t.replace(/-/g, '');
      if (noHyphen.length >= 3 && noHyphen !== t) out.push(noHyphen);
      return out;
    };

    const buildSqlPatterns = (t: string): string[] => {
      const patterns = [`description.ilike.%${t}%`, `custom_sku.ilike.%${t}%`];
      if (/[a-z]\d/.test(t) || /\d[a-z]/.test(t)) {
        const gapped = t.replace(/([a-z])(\d)/g, '$1%$2').replace(/(\d)([a-z])/g, '$1%$2');
        if (gapped !== t) {
          patterns.push(`description.ilike.%${gapped}%`, `custom_sku.ilike.%${gapped}%`);
        }
      }
      return patterns;
    };

    const narrow = usable.filter((t) => !GENERIC_BASE.has(t) && !GENERIC_BASE.has(t.replace(/(?:s|es)$/, '')));
    const sqlTerms = new Set<string>();
    const termsToExpand = narrow.length > 0 ? narrow : usable;
    for (const t of termsToExpand) {
      for (const e of expandTerm(t)) sqlTerms.add(e);
    }

    if (sqlTerms.size > 0) {
      const allClauses: string[] = [];
      for (const t of sqlTerms) {
        allClauses.push(...buildSqlPatterns(t));
      }
      query = query.or(allClauses.join(','));
    }
  }

  const { data: rawRows, error: selErr } = await query.limit(120);
  if (selErr) {
    console.error('[brand-lightspeed-inventory] select error:', selErr.message);
    return [
      '[LIVE LIGHTSPEED INVENTORY]',
      `**Query error**: ${selErr.message}`,
      '---',
      '',
    ].join('\n');
  }

  let rows = (rawRows ?? []) as ItemRow[];
  if (terms.length > 1) {
    const CATEGORY_WORDS = new Set([
      'bike', 'bikes', 'tyre', 'tyres', 'tire', 'tires', 'helmet', 'helmets',
      'light', 'lights', 'pedal', 'pedals', 'tube', 'tubes', 'chain', 'chains',
      'glove', 'gloves', 'shoe', 'shoes', 'saddle', 'saddles', 'wheel', 'wheels',
      'frame', 'frames', 'fork', 'forks', 'bar', 'tape', 'grip', 'grips',
      'pump', 'pumps', 'lock', 'locks', 'rack', 'racks', 'bell', 'bells',
      'bottle', 'bottles', 'jersey', 'jerseys', 'short', 'shorts', 'jacket', 'jackets',
      'mudguard', 'mudguards', 'pannier', 'panniers', 'basket', 'baskets',
      'cable', 'cables', 'brake', 'brakes', 'derailleur', 'derailleurs',
      'cassette', 'cassettes', 'crank', 'cranks', 'rotor', 'rotors',
      'kids', 'electric', 'ebike', 'ebikes', 'e-bike', 'e-bikes', 'road', 'mountain', 'gravel', 'hybrid',
      'handlebar', 'handlebars', 'seatpost', 'seatposts', 'stem', 'stems',
      'cleat', 'cleats', 'speedo', 'computer', 'gps', 'tubeless', 'fixed', 'track',
      'groupset', 'gruppo', 'electronic',
      'pad', 'pads', 'cage', 'cages', 'trainer', 'trainers', 'roller', 'rollers',
      'tool', 'tools', 'multitool', 'lube', 'lubricant', 'grease',
      'mirror', 'mirrors', 'fender', 'fenders', 'kickstand',
      'bib', 'vest', 'vests', 'cap', 'caps', 'arm', 'warmers',
    ]);
    const termMatchesHay = (t: string, hay: string): boolean => {
      if (hay.includes(t)) return true;
      const stem = t.replace(/(?:ies)$/, 'y').replace(/(?:s|es|ed)$/, '');
      if (stem.length >= 3 && hay.includes(stem)) return true;
      const tNoHyphen = t.replace(/-/g, '');
      const hayNoHyphen = hay.replace(/-/g, '');
      if (hayNoHyphen.includes(tNoHyphen)) return true;
      if (stem.length >= 3 && hayNoHyphen.includes(stem.replace(/-/g, ''))) return true;
      if (/[a-z]\d|\d[a-z]/.test(t)) {
        const parts = t.split(/(?=[0-9])|(?<=[0-9])(?=[a-z])/).filter((p) => p.length >= 2);
        if (parts.length >= 2 && parts.every((p) => hay.includes(p))) return true;
      }
      if (t.includes(' ') && hay.includes(t)) return true;
      const syns = SEARCH_SYNONYMS[t];
      if (syns) {
        for (const s of syns) {
          if (hay.includes(s)) return true;
        }
      }
      return false;
    };
    const MODIFIER_WORDS = new Set([
      'electric', 'ebike', 'ebikes', 'e-bike', 'e-bikes',
      'road', 'mountain', 'gravel', 'hybrid', 'kids',
      'fixed', 'track', 'tubeless', 'electronic', 'carbon', 'disc',
    ]);

    const isStandaloneNumber = (t: string) => /^\d+$/.test(t);
    const brandTerms = terms.filter((t) => !CATEGORY_WORDS.has(t) && !isStandaloneNumber(t));
    const modTerms = terms.filter((t) => CATEGORY_WORDS.has(t) && MODIFIER_WORDS.has(t));
    const baseCatTerms = terms.filter((t) => CATEGORY_WORDS.has(t) && !MODIFIER_WORDS.has(t));

    const applyFilter = (useBrandTerms: boolean) =>
      rows.filter((r) => {
        const hay = `${r.description ?? ''} ${r.custom_sku ?? ''}`.toLowerCase();
        const brandOk = !useBrandTerms || brandTerms.length === 0 || brandTerms.every((t) => termMatchesHay(t, hay));
        const modOk = modTerms.length === 0 || modTerms.some((t) => termMatchesHay(t, hay));
        const catOk = baseCatTerms.length === 0 || baseCatTerms.some((t) => termMatchesHay(t, hay));
        return brandOk && modOk && catOk;
      });

    let filtered = applyFilter(true);
    if (filtered.length === 0 && brandTerms.length > 0 && (modTerms.length > 0 || baseCatTerms.length > 0)) {
      filtered = applyFilter(false);
    }
    rows = filtered;
  }

  rows = rows.filter((r) => r.archived !== true);

  const maxSynced = rows.reduce<string | null>((best, r) => {
    if (!r.synced_at) return best;
    if (!best || r.synced_at > best) return r.synced_at;
    return best;
  }, null);

  const header = [
    '[LIVE LIGHTSPEED INVENTORY — from Nest’s latest Lightspeed snapshot in Supabase; not a live API pull]',
    'Hard rule: you may ONLY mention product names, brands, models, prices, and quantities that appear in the data below. Do NOT invent, guess, or recall products from the system prompt, marketing copy, or your training data. If the matching lines below say NONE, there are NO matching products to report.',
    '',
    `Account / connection: Lightspeed Retail R-Series account id ${conn?.api_endpoint ?? 'unknown'}.`,
    `Items in snapshot (total rows): ${n}.`,
    formatSyncLine(maxSynced),
    terms.length > 0 ? `Search terms used: ${terms.join(', ')}.` : 'Search terms: (none — showing a broad sample).',
    '',
  ];

  if (rows.length === 0) {
    return [
      ...header,
      '**Matching lines**\nNONE. No products matched these search terms in the inventory snapshot.',
      'Critical: do NOT list any product names, brands, models, prices, or stock counts. The answer is: no matching products were found. Suggest different keywords or offer to call the store.',
      '---',
      '',
    ].join('\n');
  }

  const { lines, totalQoh } = formatItemLines(rows.slice(0, 80));
  const summary =
    rows.length > 80
      ? `\n(${rows.length} matches; showing first 80. Total QOH (shop ${INVENTORY_QOH_SHOP_ID}) shown: ${totalQoh}.)`
      : `\nTotal QOH (shop ${INVENTORY_QOH_SHOP_ID}) across listed lines: ${totalQoh}.`;

  return [...header, '**Matching products (mirrored inventory)**', ...lines, summary, '---', ''].join('\n');
}
