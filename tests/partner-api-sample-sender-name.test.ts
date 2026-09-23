import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Program-Fix 14 follow-up: a partner API transaction without sender.name is
// held for review, so every in-product sample partners copy must carry it.
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('partner API create-transaction samples include sender.name', () => {
  it.each([
    'src/app/admin-dashboard/partners/[id]/page.tsx',
    'src/app/docs/page.tsx',
  ])('%s: every "sender" object in a sample carries a name', (rel) => {
    const src = read(rel);
    const senders = src.match(/"sender"\s*:\s*\{[^}]*\}/g) ?? [];
    expect(senders.length).toBeGreaterThan(0);
    for (const s of senders) expect(s).toMatch(/"name"\s*:\s*"[^"]+"/);
  });
});
