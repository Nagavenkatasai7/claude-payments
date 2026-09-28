import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// M4 PR-2 review round 1: the sandbox guide's reference-rail failure trigger must be a
// string the rail actually treats as unreachable. isUnreachableAccount only looks at the
// LAST digit run, so an account-first destination (account|IFSC) never fires it.
describe('sandbox.mdx failure-trigger example', () => {
  it('every documented payout_destination example fires isUnreachableAccount', async () => {
    const { isUnreachableAccount } = await import('@/app/api/partner-rail/route');
    const text = readFileSync('src/content/docs/sandbox.mdx', 'utf8');
    const examples = [...text.matchAll(/`([^`]*\|[^`]*)`/g)].map((m) => m[1]).filter((s) => /0{6,}/.test(s));
    expect(examples.length, 'the guide must give the exact destination string').toBeGreaterThan(0);
    for (const e of examples) expect({ e, fires: isUnreachableAccount(e) }).toEqual({ e, fires: true });
  });

  it('pins why the order matters (account-first does not fire)', async () => {
    const { isUnreachableAccount } = await import('@/app/api/partner-rail/route');
    expect(isUnreachableAccount('000000000000|HDFC0001234')).toBe(false);
    expect(isUnreachableAccount('HDFC0001234|000000000000')).toBe(true);
  });
});
