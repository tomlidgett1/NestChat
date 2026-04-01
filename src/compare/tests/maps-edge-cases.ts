/**
 * Google Maps edge case tests — tests travel_time and places_search
 * tools directly via the production Supabase pipeline.
 *
 * Run: npx tsx src/compare/tests/maps-edge-cases.ts
 */

import 'dotenv/config';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ADMIN_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.NEW_SUPABASE_SECRET_KEY ||
  '';

if (!SUPABASE_URL || !SUPABASE_ADMIN_KEY) {
  console.error('Missing SUPABASE_URL and a Supabase server secret key in .env');
  process.exit(1);
}

interface TestResult {
  name: string;
  pass: boolean;
  message: string;
  responseText: string;
  latencyMs: number;
  toolsUsed?: string[];
}

const results: TestResult[] = [];

async function callOnboard(message: string, keepHistory = false): Promise<Record<string, unknown>> {
  const url = `${SUPABASE_URL}/functions/v1/debug-dashboard?api=run-single`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ADMIN_KEY}`,
    },
    body: JSON.stringify({ message, expectedAgent: 'onboard', keepHistory }),
  });
  if (!resp.ok) throw new Error(`API call failed (${resp.status}): ${await resp.text()}`);
  return await resp.json() as Record<string, unknown>;
}

async function clearHistory(): Promise<void> {
  const url = `${SUPABASE_URL}/functions/v1/debug-dashboard?api=clear-history`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ADMIN_KEY}`,
    },
  });
}

function record(name: string, pass: boolean, message: string, responseText: string, latencyMs: number, tools?: string[]) {
  results.push({ name, pass, message, responseText, latencyMs, toolsUsed: tools });
  const icon = pass ? '✅' : '❌';
  console.log(`${icon} ${name}: ${message}`);
  if (!pass) console.log(`   Response: ${responseText.substring(0, 250)}`);
}

// ═══════════════════════════════════════════════════════════════
// Travel Time Tests
// ═══════════════════════════════════════════════════════════════

async function testTravelTime() {
  console.log('\n═══ Travel Time Tests ═══\n');

  const cases = [
    {
      name: 'driving_normal',
      message: 'how long to drive from melbourne cbd to melbourne airport?',
      expectTool: 'travel_time',
      expectInResponse: [/min|hour/i, /airport|tullamarine/i],
    },
    {
      name: 'transit_normal',
      message: 'how do i get from flinders street station to caulfield station by train?',
      expectTool: 'travel_time',
      expectInResponse: [/min/i, /train|line/i],
    },
    {
      name: 'walking',
      message: 'how long to walk from federation square to the mcg?',
      expectTool: 'travel_time',
      expectInResponse: [/min/i, /walk/i],
    },
    {
      name: 'cycling',
      message: 'can i bike from st kilda beach to brighton beach? how long?',
      expectTool: 'travel_time',
      expectInResponse: [/min/i],
    },
    {
      name: 'ambiguous_location',
      message: 'how long from the coffee shop to the train station?',
      expectTool: null, // May not use tool, may ask for clarification
      expectInResponse: [/which|where|specific/i],
    },
    {
      name: 'long_distance',
      message: 'how long to drive from melbourne to sydney?',
      expectTool: 'travel_time',
      expectInResponse: [/hour/i],
    },
    {
      name: 'international_no_road',
      message: 'how long to drive from sydney to auckland?',
      expectTool: null, // Should handle gracefully
      expectInResponse: [/can('|')?t drive|fly|no road|ocean/i],
    },
  ];

  for (const test of cases) {
    await clearHistory();
    try {
      const result = await callOnboard(test.message);
      const text = (result.responseText as string) ?? '';
      const latency = (result.latencyMs as number) ?? 0;
      const tools = (result.tools as string[]) ?? [];

      const usedExpectedTool = test.expectTool ? tools.includes(test.expectTool) : true;
      const matchesExpected = test.expectInResponse.some((p) => p.test(text));
      const hasResponse = text.length > 10;
      const notTooLong = text.length < 1500; // iMessage readability

      const pass = hasResponse && notTooLong && (matchesExpected || !test.expectTool);
      const details = [
        `${text.length} chars`,
        test.expectTool ? (usedExpectedTool ? `used ${test.expectTool}` : `missing ${test.expectTool}`) : 'no tool expected',
        matchesExpected ? 'matches expected pattern' : 'no pattern match',
        notTooLong ? '' : 'TOO LONG',
      ].filter(Boolean).join(', ');

      record(`travel:${test.name}`, pass, details, text, latency, tools);
    } catch (err) {
      record(`travel:${test.name}`, false, `Error: ${(err as Error).message}`, '', 0);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Places Search Tests
// ═══════════════════════════════════════════════════════════════

async function testPlacesSearch() {
  console.log('\n═══ Places Search Tests ═══\n');

  const cases = [
    {
      name: 'coffee_specific',
      message: 'best coffee shops in fitzroy?',
      expectTool: 'places_search',
      expectInResponse: [/coffee|cafe|roast/i],
    },
    {
      name: 'restaurant_area',
      message: 'good restaurants near flinders lane?',
      expectTool: 'places_search',
      expectInResponse: [/restaurant|eat|food|dine/i],
    },
    {
      name: 'bar_recommendation',
      message: 'where should i get a drink in collingwood tonight?',
      expectTool: 'places_search',
      expectInResponse: [/bar|pub|drink|cocktail/i],
    },
    {
      name: 'generic_query',
      message: 'find me a gym',
      expectTool: 'places_search',
      expectInResponse: [/gym|fitness/i],
    },
    {
      name: 'specific_place',
      message: 'what are the reviews like for lune croissanterie?',
      expectTool: 'places_search',
      expectInResponse: [/lune|review|rating/i],
    },
    {
      name: 'hours_check',
      message: 'is queen victoria market open right now?',
      expectTool: 'places_search',
      expectInResponse: [/open|closed|hours|queen victoria/i],
    },
  ];

  for (const test of cases) {
    await clearHistory();
    try {
      const result = await callOnboard(test.message);
      const text = (result.responseText as string) ?? '';
      const latency = (result.latencyMs as number) ?? 0;
      const tools = (result.tools as string[]) ?? [];

      const usedExpectedTool = tools.includes(test.expectTool);
      const matchesExpected = test.expectInResponse.some((p) => p.test(text));
      const hasResponse = text.length > 10;
      const notTooLong = text.length < 2000;

      const pass = hasResponse && notTooLong;
      const details = [
        `${text.length} chars`,
        usedExpectedTool ? `used ${test.expectTool}` : `missing ${test.expectTool}`,
        matchesExpected ? 'matches pattern' : 'no pattern match',
        notTooLong ? '' : 'TOO LONG',
      ].filter(Boolean).join(', ');

      record(`places:${test.name}`, pass, details, text, latency, tools);
    } catch (err) {
      record(`places:${test.name}`, false, `Error: ${(err as Error).message}`, '', 0);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Formatting Tests (response readability for iMessage)
// ═══════════════════════════════════════════════════════════════

async function testFormatting() {
  console.log('\n═══ Formatting Tests ═══\n');

  const messages = [
    'how do i get from richmond to the city by tram?',
    'find me the 3 best rated pizza places in melbourne',
  ];

  for (const msg of messages) {
    await clearHistory();
    try {
      const result = await callOnboard(msg);
      const text = (result.responseText as string) ?? '';
      const latency = (result.latencyMs as number) ?? 0;

      // Check bubble splitting
      const bubbles = text.split('---').map((b) => b.trim()).filter(Boolean);
      const hasBubbles = bubbles.length >= 1;

      // Check no bubble is too long (max ~200 chars per bubble for readability)
      const longestBubble = Math.max(...bubbles.map((b) => b.length));
      const bubblesReasonable = longestBubble < 500;

      // Check no markdown headers or code blocks
      const noMarkdownHeaders = !/^#{1,3}\s/m.test(text);
      const noCodeBlocks = !text.includes('```');

      // Check no em dashes
      const noEmDashes = !text.includes('—') && !text.includes('–');

      const pass = hasBubbles && bubblesReasonable && noMarkdownHeaders && noCodeBlocks;
      const details = [
        `${bubbles.length} bubbles`,
        `longest: ${longestBubble} chars`,
        noMarkdownHeaders ? '' : 'HAS MARKDOWN HEADERS',
        noCodeBlocks ? '' : 'HAS CODE BLOCKS',
        noEmDashes ? '' : 'HAS EM DASHES',
      ].filter(Boolean).join(', ');

      record(`format:${msg.substring(0, 40)}`, pass, details, text, latency);
    } catch (err) {
      record(`format:${msg.substring(0, 40)}`, false, `Error: ${(err as Error).message}`, '', 0);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Main runner
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('🗺️  Nest V3 Google Maps Edge Case Tests\n');
  console.log(`Target: ${SUPABASE_URL}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  await testTravelTime();
  await testPlacesSearch();
  await testFormatting();

  // Summary
  console.log('\n═══ SUMMARY ═══\n');
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const total = results.length;

  console.log(`Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`Pass rate: ${((passed / total) * 100).toFixed(1)}%`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`  ❌ ${r.name}: ${r.message}`);
    }
  }

  // Write results to JSON
  const outputPath = 'src/compare/tests/results-maps.json';
  const { writeFileSync } = await import('fs');
  writeFileSync(outputPath, JSON.stringify({ timestamp: new Date().toISOString(), results, summary: { total, passed, failed } }, null, 2));
  console.log(`\nResults written to ${outputPath}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
