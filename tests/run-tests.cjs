'use strict';
const assert = require('assert');
const rules = require('../lib/rules.cjs');

console.log('Running test suite for humanizer rules engine...');

// Test 1: Em dash detection
const t1 = rules.findHardViolations('This policy — unexpected by many — changed today.');
assert(t1.some(v => v.rule === 'em-dash'), 'Expected em-dash violation');
console.log('✓ Em dash detection passed');

// Test 2: En dash detection
const t2 = rules.findHardViolations('The result – while interesting – was not clear.');
assert(t2.some(v => v.rule === 'em-dash'), 'Expected en-dash violation');
console.log('✓ En dash detection passed');

// Test 3: Curly quotes detection
const t3 = rules.findHardViolations('He said “hello” to the team.');
assert(t3.some(v => v.rule === 'curly-quotes'), 'Expected curly quotes violation');
console.log('✓ Curly quotes detection passed');

// Test 4: Chatbot residue
const t4 = rules.findHardViolations('Great question! Here is an overview of the system. I hope this helps!');
assert(t4.some(v => v.rule === 'chatbot-residue'), 'Expected chatbot residue violation');
console.log('✓ Chatbot residue detection passed');

// Test 5: Not X but Y formula
const t5 = rules.findHardViolations('It is not only fast, but also secure.');
assert(t5.some(v => v.rule === 'not-x-but-y'), 'Expected not-X-but-Y violation');
console.log('✓ Not X but Y detection passed');

// Test 6: One-line closer
const t6 = rules.findHardViolations('Caching reduces redundant database calls.\n\nThat is the real win.');
assert(t6.some(v => v.rule === 'dramatic-closer'), 'Expected dramatic closer violation');
console.log('✓ Dramatic closer detection passed');

// Test 7: Staged run-up
const t7 = rules.findHardViolations("Let's dive into how caching works. Here's what you need to know.");
assert(t7.some(v => v.rule === 'staged-runup'), 'Expected staged run-up violation');
console.log('✓ Staged run-up detection passed');

// Test 8: Arguing with no one
const t8 = rules.findHardViolations("This isn't mainly about prompt length, but performance.");
assert(t8.some(v => v.rule === 'arguing-with-no-one'), 'Expected arguing with no one violation');
console.log('✓ Arguing with no one detection passed');

// Test 9: Inflated significance
const t9 = rules.findHardViolations('The tool stands as a testament to engineering excellence, playing a pivotal role.');
assert(t9.some(v => v.rule === 'inflated-significance'), 'Expected inflated significance violation');
console.log('✓ Inflated significance detection passed');

// Test 10: Emoji in heading
const t10 = rules.findHardViolations('## 🚀 Launch Strategy');
assert(t10.some(v => v.rule === 'emoji-heading'), 'Expected emoji heading violation');
console.log('✓ Emoji heading detection passed');

// Test 11: Repetitive bold list labels
const t11Text = `
- **Performance:** Speeds up database queries.
- **Security:** Adds end-to-end encryption.
- **Reliability:** Recovers automatically from failure.
`;
const t11 = rules.findHardViolations(t11Text);
assert(t11.some(v => v.rule === 'decorative-bold-list'), 'Expected decorative bold list violation');
console.log('✓ Decorative bold list detection passed');

// Test 12: Density watchlist (§12 words)
const t12Text = `
# Overview
We delve into the intricate landscape and showcase its crucial tapestry.
`;
const t12 = rules.findDensityViolations(t12Text);
assert(t12.some(v => v.rule === 'watchlist-density'), 'Expected watchlist density violation');
console.log('✓ Watchlist density detection passed');

// Test 13: Clean human prose passes without violations
const t13Clean = `
# Caching Strategy

The service stores session tokens in Redis. Lookups take less than two milliseconds, and expired keys are purged every ten minutes.
`;
const t13 = rules.findAllViolations(t13Clean);
assert.strictEqual(t13.length, 0, 'Clean text should have 0 violations');
console.log('✓ Clean text passed with 0 violations');

// Test 14: Code fences are ignored
const t14Fences = `
# Code Example

\`\`\`javascript
// This comment has an em dash — and "curly quotes"
const x = "let's dive into this";
\`\`\`
`;
const t14 = rules.findAllViolations(t14Fences);
assert.strictEqual(t14.length, 0, 'Fenced code should not trigger prose violations');
console.log('✓ Fenced code exemption passed');

// Test 15: Skip marker is respected
assert(rules.hasSkipMarker('<!-- humanizer:skip --> some text'), 'Skip marker recognized');
console.log('✓ Skip marker recognized');

// Test 16: Domains, versions, and initials are not fragmented punctuation
const t16Pass = [
  'Access the portal at portal.example.ac.id for academic services.',
  'Deploy to app.example.ac.id for production.',
  'Reach us at info@example.co.id for help.',
  'Version 1.2.3 is now released.',
  'J. K. Rowling wrote the book.',
];
for (const text of t16Pass) {
  const hits = rules.findHardViolations(text).filter(function (v) { return v.rule === 'periods-between-words'; });
  assert.strictEqual(hits.length, 0, 'Should not flag fragmented punctuation: ' + text);
}
const t16Block = [
  'It happened every. single. day. here.',
  'No. More. Delays. please.',
];
for (const text of t16Block) {
  const hits = rules.findHardViolations(text).filter(function (v) { return v.rule === 'periods-between-words'; });
  assert(hits.length > 0, 'Should flag fragmented punctuation: ' + text);
}
console.log('✓ Fragmented punctuation ignores domains/versions/initials');

console.log('\nAll 16 rule engine tests passed successfully!');
