/**
 * ItemShops must unwrap `{ ItemShop: { qoh, shopID } }` wrappers (Lightspeed list JSON).
 *
 * Run: cd Nest/supabase/functions && deno run --allow-read --allow-env _shared/tests/test-normalise-item-shops.ts
 */

import {
  extractLightspeedRelationRows,
  normaliseItemShopsFromItem,
  sumItemShopQohForShop,
} from '../lightspeed-client.ts';

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

const wrappedTwoShops = [
  { ItemShop: { qoh: '0', shopID: '0', itemID: '403' } },
  { ItemShop: { qoh: '7', shopID: '1', itemID: '403' } },
];

check(
  'extractLightspeedRelationRows unwraps ItemShop wrappers',
  extractLightspeedRelationRows(wrappedTwoShops, ['ItemShop', 'itemShop']).length === 2 &&
    extractLightspeedRelationRows(wrappedTwoShops, ['ItemShop', 'itemShop'])[1].qoh === '7',
);

check(
  'shop 1 QOH from wrapped array',
  sumItemShopQohForShop(extractLightspeedRelationRows(wrappedTwoShops, ['ItemShop', 'itemShop']), 1) === 7,
);

check(
  'normaliseItemShopsFromItem reads ItemShops on item',
  sumItemShopQohForShop(
    normaliseItemShopsFromItem({
      itemID: '403',
      ItemShops: wrappedTwoShops,
    } as Record<string, unknown>),
    1,
  ) === 7,
);

check(
  'classic ItemShops object shape',
  sumItemShopQohForShop(
    normaliseItemShopsFromItem({
      ItemShops: {
        ItemShop: [
          { qoh: '2', shopID: '1' },
          { qoh: '3', shopID: '1' },
        ],
      },
    } as Record<string, unknown>),
    1,
  ) === 5,
);

check(
  'bare rows (already flat) still work',
  sumItemShopQohForShop(
    extractLightspeedRelationRows(
      [
        { qoh: '1', shopID: '1' },
        { qoh: '4', shopID: '1' },
      ],
      ['ItemShop', 'itemShop'],
    ),
    1,
  ) === 5,
);

console.log(`\nnormalise ItemShops / QOH: ${passed} passed, ${failed} failed`);
if (failed > 0) Deno.exit(1);
