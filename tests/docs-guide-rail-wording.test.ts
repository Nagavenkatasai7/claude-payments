import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// The reference-rail failure trigger and the failed / returned refund wording, pinned in the guides
// (they moved there from the old single-page /docs). The trigger string itself is pinned against
// isUnreachableAccount in tests/docs-sandbox-trigger.test.ts.
const SANDBOX = readFileSync('src/content/docs/sandbox.mdx', 'utf8').replace(/\s+/g, ' ');
const WEBHOOKS = readFileSync('src/content/docs/webhooks.mdx', 'utf8');

describe('sandbox guide: reference-rail failure example', () => {
  it('states that the account number must be the last group of digits', () => {
    expect(SANDBOX).toMatch(/account number must be the last group of digits/);
  });
});

describe('webhooks guide: failed / returned refund wording (src/lib/rail-failure.ts)', () => {
  it('names all three refund paths for both statuses: captured charge, partner-pulled reverse, partner returns funds', () => {
    for (const status of ['failed', 'returned']) {
      const row = WEBHOOKS.split('\n').find((l) => l.startsWith(`| \`${status}\` |`));
      expect(row, `${status} row`).toBeDefined();
      expect(row).toMatch(/if SmartRemit captured the charge it is refunded/i);
      expect(row).toMatch(/a partner-pulled debit gets a signed `reverse`/);
      expect(row).toMatch(/otherwise you return the funds/);
    }
  });
});
