import { shouldSkipSemanticMemoryLookup } from "../memory.ts";

function assertEqual(actual: boolean, expected: boolean, name: string): void {
  if (actual !== expected) {
    throw new Error(`FAIL: ${name} (expected ${expected}, got ${actual})`);
  }
  console.log(`PASS: ${name}`);
}

const cases = [
  {
    message: "All of it so good",
    expected: true,
    name: "skips expressive short follow-up",
  },
  {
    message: "Both honestly",
    expected: true,
    name: "skips terse conversational continuation",
  },
  {
    message: "Love it",
    expected: true,
    name: "skips acknowledgement-style reaction",
  },
  {
    message: "What do you remember about me",
    expected: false,
    name: "keeps recall queries",
  },
  {
    message: "What's the weather tomorrow",
    expected: false,
    name: "keeps live-data questions",
  },
  {
    message: "Tell me about Kyoto history",
    expected: false,
    name: "keeps knowledge requests",
  },
  {
    message: "Did I mention my dad",
    expected: false,
    name: "keeps personal memory checks",
  },
];

for (const testCase of cases) {
  assertEqual(
    shouldSkipSemanticMemoryLookup(testCase.message),
    testCase.expected,
    testCase.name,
  );
}

console.log("All memory retrieval tests passed.");
