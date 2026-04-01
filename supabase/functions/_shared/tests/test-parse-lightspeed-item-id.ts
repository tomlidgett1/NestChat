/**
 * Unit checks for Lightspeed Item id parsing (direct + @attributes).
 *
 * Run from repo:
 *   cd Nest/supabase/functions && deno run --allow-read _shared/tests/test-parse-lightspeed-item-id.ts
 */

import { parseLightspeedItemId } from '../lightspeed-client.ts';

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

check('itemID string', parseLightspeedItemId({ itemID: '42' }) === 42n);
check('itemID number', parseLightspeedItemId({ itemID: 7 }) === 7n);
check(
  '@attributes.itemID',
  parseLightspeedItemId({ '@attributes': { itemID: '99' }, description: 'x' }) === 99n,
);
check('missing id', parseLightspeedItemId({ description: 'no id' }) === null);

console.log(`\nparseLightspeedItemId: ${passed} passed, ${failed} failed`);
if (failed > 0) Deno.exit(1);
