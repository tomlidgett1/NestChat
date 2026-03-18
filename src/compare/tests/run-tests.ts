/**
 * Unified test runner for all Nest V3 onboarding tests.
 *
 * Usage:
 *   npx tsx src/compare/tests/run-tests.ts          # Run all suites
 *   npx tsx src/compare/tests/run-tests.ts onboard  # Run onboarding only
 *   npx tsx src/compare/tests/run-tests.ts maps     # Run maps only
 */

import { execSync } from 'child_process';
import path from 'path';

const args = process.argv.slice(2);
const suite = args[0] || 'all';

const testsDir = path.resolve(__dirname);

const suites: Record<string, string> = {
  onboard: path.join(testsDir, 'onboarding-scenarios.ts'),
  maps: path.join(testsDir, 'maps-edge-cases.ts'),
};

function runSuite(name: string, filePath: string): boolean {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Running: ${name}`);
  console.log(`${'═'.repeat(60)}\n`);

  try {
    execSync(`npx tsx "${filePath}"`, {
      stdio: 'inherit',
      cwd: path.resolve(testsDir, '../../..'),
      env: { ...process.env },
    });
    return true;
  } catch {
    return false;
  }
}

function main() {
  console.log('🧪 Nest V3 Test Runner\n');

  const toRun = suite === 'all' ? Object.entries(suites) : [[suite, suites[suite]]];
  const failed: string[] = [];

  for (const [name, filePath] of toRun) {
    if (!filePath) {
      console.error(`Unknown suite: ${name}. Available: ${Object.keys(suites).join(', ')}`);
      process.exit(1);
    }
    const pass = runSuite(name, filePath);
    if (!pass) failed.push(name);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('FINAL RESULTS');
  console.log(`${'═'.repeat(60)}\n`);

  if (failed.length === 0) {
    console.log('All suites passed ✅');
  } else {
    console.log(`Failed suites: ${failed.join(', ')} ❌`);
    process.exit(1);
  }
}

main();
