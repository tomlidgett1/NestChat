/**
 * Unit checks for Lightspeed Item default price extraction.
 *
 * Run: cd Nest/supabase/functions && deno run --allow-read --allow-env _shared/tests/test-parse-item-default-price.ts
 */

import { parseLightspeedItemDefaultPrice } from '../lightspeed-client.ts';

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

const userSample: Record<string, unknown> = {
  ean: '',
  tax: 'true',
  upc: '',
  Prices: {
    ItemPrice: [
      { amount: '110', useType: 'Default', useTypeID: '1' },
      { amount: '110', useType: 'MSRP', useTypeID: '2' },
      { amount: '110', useType: 'Online', useTypeID: '3' },
    ],
  },
  itemID: '1',
  description: 'Gen Serv',
};

check('user sample Default → 110', parseLightspeedItemDefaultPrice(userSample) === 110);

check(
  'single ItemPrice object under Prices',
  parseLightspeedItemDefaultPrice({
    itemID: '2',
    Prices: { ItemPrice: { amount: '45.5', useType: 'Default', useTypeID: '1' } },
  }) === 45.5,
);

check(
  'useTypeID 1 when useType missing',
  parseLightspeedItemDefaultPrice({
    itemID: '3',
    Prices: { ItemPrice: [{ amount: '9', useTypeID: '1' }] },
  }) === 9,
);

check(
  'first row fallback',
  parseLightspeedItemDefaultPrice({
    itemID: '4',
    Prices: { ItemPrice: [{ amount: '12', useType: 'MSRP', useTypeID: '2' }] },
  }) === 12,
);

check(
  'top-level ItemPrice array',
  parseLightspeedItemDefaultPrice({
    itemID: '5',
    ItemPrice: [{ amount: '7', useType: 'Default', useTypeID: '1' }],
  }) === 7,
);

check(
  'lowercase prices key',
  parseLightspeedItemDefaultPrice({
    itemID: '6',
    prices: { ItemPrice: [{ amount: '3', useType: 'Default', useTypeID: '1' }] },
  }) === 3,
);

check('no prices → null', parseLightspeedItemDefaultPrice({ itemID: '7' }) === null);

console.log(`\nparseLightspeedItemDefaultPrice: ${passed} passed, ${failed} failed`);
if (failed > 0) Deno.exit(1);
