/**
 * Unit checks for Lightspeed sales → brand chat grounding helpers.
 *
 * Run from repo:
 *   cd Nest/supabase/functions && deno run --allow-read --allow-env _shared/tests/test-brand-lightspeed-sales.ts
 */

import { messageSuggestsSalesQuery } from '../brand-lightspeed-sales.ts';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── Positive matches ──────────────────────────────────────────────────────
check('sales: "what were our sales today"', messageSuggestsSalesQuery('What were our sales today?'));
check('sales: "how much did we sell"', messageSuggestsSalesQuery('How much did we sell today?'));
check('sales: "revenue"', messageSuggestsSalesQuery('What is our revenue this week?'));
check('sales: "turnover"', messageSuggestsSalesQuery('What was the turnover last month?'));
check('sales: "takings"', messageSuggestsSalesQuery('What were our takings yesterday?'));
check('sales: "transactions"', messageSuggestsSalesQuery('How many transactions today?'));
check('sales: "till"', messageSuggestsSalesQuery('How much is in the till?'));
check('sales: "receipt"', messageSuggestsSalesQuery('Can I see the last receipt?'));
check('sales: "layaway"', messageSuggestsSalesQuery('Do we have any layaway orders?'));
check('sales: "lay away"', messageSuggestsSalesQuery('Any lay away items?'));
check('sales: "best seller"', messageSuggestsSalesQuery('What is our best seller?'));
check('sales: "top selling"', messageSuggestsSalesQuery('What are the top selling items?'));
check('sales: "sold"', messageSuggestsSalesQuery('What did we sell most of?'));
check('sales: "average sale"', messageSuggestsSalesQuery('What is the average sale value?'));
check('sales: "total sales"', messageSuggestsSalesQuery('What are the total sales this month?'));
check('sales: "daily revenue"', messageSuggestsSalesQuery('Show me the daily revenue'));
check('sales: "weekly sales"', messageSuggestsSalesQuery('How are weekly sales looking?'));
check('sales: "monthly sales"', messageSuggestsSalesQuery('What are our monthly sales?'));
check('sales: "how much did we make"', messageSuggestsSalesQuery('How much did we make yesterday?'));
check('sales: "how much did we take"', messageSuggestsSalesQuery('How much did we take today?'));
check('sales: "sale value"', messageSuggestsSalesQuery('What was the average sale value?'));
check('sales: "what did we sell"', messageSuggestsSalesQuery('What did we sell on Saturday?'));
check('sales: single "sale"', messageSuggestsSalesQuery('How was that sale?'));

// ── Negative matches ──────────────────────────────────────────────────────
check('negative: greeting', !messageSuggestsSalesQuery('Hello there'));
check('negative: opening hours', !messageSuggestsSalesQuery('What time do you open?'));
check('negative: bike service', !messageSuggestsSalesQuery('Is my bike ready?'));
check('negative: directions', !messageSuggestsSalesQuery('Where is the store?'));
check('negative: weather', !messageSuggestsSalesQuery('What is the weather like tomorrow?'));

console.log(`\n${'═'.repeat(60)}`);
console.log(`brand-lightspeed-sales helpers: ${passed} passed, ${failed} failed`);

if (failed > 0) Deno.exit(1);
