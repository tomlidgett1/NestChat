/**
 * Unit checks for Lightspeed → brand chat inventory grounding helpers.
 *
 * Run from repo:
 *   cd Nest/supabase/functions && deno run --allow-read --allow-env _shared/tests/test-brand-lightspeed-inventory.ts
 */

import {
  extractInventorySearchTerms,
  messageSuggestsInventoryQuery,
  sumItemShopsQoh,
} from '../brand-lightspeed-inventory.ts';
import { sumItemShopQohForShop } from '../lightspeed-client.ts';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── messageSuggestsInventoryQuery ───────────────────────────────────────────
check('inventory: how many bikes', messageSuggestsInventoryQuery('How many bikes do you have in stock?'));
check('inventory: stock keyword', messageSuggestsInventoryQuery('What road bikes are in stock?'));
check('inventory: SKU', messageSuggestsInventoryQuery('Do you have SKU 12345 on hand?'));
check('inventory: negative hello', !messageSuggestsInventoryQuery('Hello there'));

// ── extractInventorySearchTerms ─────────────────────────────────────────────
check(
  'terms: picks bike',
  extractInventorySearchTerms('How many mountain bikes are in stock?').includes('bikes') ||
    extractInventorySearchTerms('How many mountain bikes are in stock?').includes('bike'),
);
check('terms: drops stopwords', !extractInventorySearchTerms('How many in stock').includes('stock'));

// ── sumItemShopsQoh ─────────────────────────────────────────────────────────
check('qoh: sums strings', sumItemShopsQoh([{ qoh: '2' }, { qoh: '3' }]) === 5);
check('qoh: sums numbers', sumItemShopsQoh([{ qoh: 1 }, { QOH: 4 }]) === 5);
check('qoh: empty', sumItemShopsQoh([]) === 0);
check('qoh: ignores junk', sumItemShopsQoh([{ qoh: 'x' }, null, {}]) === 0);

// ── sumItemShopQohForShop (shop 1 QOH) ─────────────────────────────────────
check(
  'qoh shop 1: two rows user sample',
  sumItemShopQohForShop(
    [
      { qoh: '0', itemID: '403', shopID: '0' },
      { qoh: '0', itemID: '403', shopID: '1' },
    ],
    1,
  ) === 0,
);
check(
  'qoh shop 1: only shop 1 counted',
  sumItemShopQohForShop(
    [
      { qoh: '5', shopID: '1' },
      { qoh: '100', shopID: '2' },
    ],
    1,
  ) === 5,
);

console.log(`\n${'═'.repeat(60)}`);
console.log(`brand-lightspeed-inventory helpers: ${passed} passed, ${failed} failed`);

if (failed > 0) Deno.exit(1);
