/**
 * Unit checks for Lightspeed workorder → brand chat grounding helpers.
 *
 * Run from repo:
 *   cd Nest/supabase/functions && deno run --allow-read --allow-env _shared/tests/test-brand-lightspeed-workorders.ts
 */

import { messageSuggestsWorkorderQuery } from '../brand-lightspeed-workorders.ts';

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

// ── messageSuggestsWorkorderQuery ─────────────────────────────────────────
check('workorder: direct keyword', messageSuggestsWorkorderQuery('Tell me about the workorders'));
check('workorder: service keyword', messageSuggestsWorkorderQuery('Any services in tomorrow?'));
check('workorder: servicing keyword', messageSuggestsWorkorderQuery('How many bikes are we servicing?'));
check('workorder: repair keyword', messageSuggestsWorkorderQuery('Any repairs due today?'));
check('workorder: workshop keyword', messageSuggestsWorkorderQuery('What is in the workshop?'));
check('workorder: bike service', messageSuggestsWorkorderQuery('How many bike services do we have?'));
check('workorder: jobs', messageSuggestsWorkorderQuery('Any jobs due tomorrow?'));
check('workorder: drop-off', messageSuggestsWorkorderQuery('Who dropped off a bike today?'));
check('workorder: collection', messageSuggestsWorkorderQuery('Any bikes ready for collection?'));
check('workorder: due today', messageSuggestsWorkorderQuery('What is due today?'));
check('workorder: due tomorrow', messageSuggestsWorkorderQuery('What services are due tomorrow?'));
check('workorder: eta', messageSuggestsWorkorderQuery('What is the ETA on that service?'));
check('workorder: how many bikes', messageSuggestsWorkorderQuery('How many bikes are being serviced?'));
check('workorder: finished', messageSuggestsWorkorderQuery('Which jobs are finished?'));
check('workorder: awaiting', messageSuggestsWorkorderQuery('Any bikes awaiting pickup?'));
check('workorder: ready', messageSuggestsWorkorderQuery('Is my bike ready?'));
check('workorder: pick up', messageSuggestsWorkorderQuery('Can I pick up my bike?'));
check('workorder: negative - hello', !messageSuggestsWorkorderQuery('Hello there'));
check('workorder: negative - weather', !messageSuggestsWorkorderQuery('What is the weather like?'));
check('workorder: negative - opening hours', !messageSuggestsWorkorderQuery('What are your opening hours?'));

console.log(`\n${'═'.repeat(60)}`);
console.log(`brand-lightspeed-workorders helpers: ${passed} passed, ${failed} failed`);

if (failed > 0) Deno.exit(1);
