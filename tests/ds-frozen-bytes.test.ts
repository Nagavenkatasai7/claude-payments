import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
// Frozen @ 96c8933, computed with `git show 96c8933:<file> | shasum -a 256` (tailwind: `| head -n 246`).
// The post-demo re-skin updates these DELIBERATELY, in the same PR. 2026-10-04 (the demo freeze was
// cancelled on 2026-09-28): the admin re-skin added the .admin-brand scope inside the first 246 lines,
// so the tailwind prefix hash moved on purpose; :root, .account-brand and the .sh-* rules are unchanged
// (tests/ds-tokens.test.ts still pins every frozen value).
const TAILWIND_PREFIX_SHA = 'c4767ffebd92e3ae2601217637f301260fa77aca11ac36096361d1d3a3327234';
const SHADCN_SHA: Record<string, string> = {
  'src/components/ui/alert.tsx': '2cc59b5f7bda91c1670884b1bf46bfc8a2a6f226cef184f5762acc037188885b',
  'src/components/ui/badge.tsx': '46a0de5224f6a5d5d63d45246534288518dce888f031064bff925bbc7fe6ad97',
  'src/components/ui/button.tsx': 'cc36af0f8b5019c33cc039fbf03bb952a513072b15b55b53c592b78af3e5f4c4',
  'src/components/ui/card.tsx': 'c48dd3b96be90a7066f1aebf294f0af9d00ebcdc367d5d4aca55429ade570c1c',
  'src/components/ui/dialog.tsx': 'dce39c6adc47d997bd2567f8b7a72f466b0134715105cd42f9194007b8ecdb14',
  'src/components/ui/input.tsx': '8c4612a7c41319ac5049daa3b34b080f9784b6245c17780eb87c127e58e473db',
  'src/components/ui/label.tsx': 'a476e41f08b9de5bd447de66a33d8bc2ad18f2fa6b96c064778bab4b6f439f4c',
  'src/components/ui/select.tsx': '0b796a108a4eb5ba52d9ad938b7aea36dc56ae66c703a6d0a23dbc24f96daff3',
  'src/components/ui/separator.tsx': '6da346505c8629a4668420d2a5ca48891383bbe0b0ceb14163537c671879427e',
  'src/components/ui/skeleton.tsx': 'ba48dd5be5a6a1378bd4e011028654b5bf419f1e7d20ee4b9f8330c1264e7239',
  'src/components/ui/table.tsx': '20e5a7f224959c6b75802995706a97e9da171f693d4b6b1b436388fcd9df96f3',
  'src/components/ui/tabs.tsx': '865d0194331b9b2be36723fa79d3575dc83078b4cb941cafee87cb72fc2cff46',
};

describe('demo-critical bytes are frozen until Oct 6 (SPEC §7)', () => {
  it('tailwind.css lines 1-246 (incl. every .sh-* class, :root, .account-brand, @theme) are byte-identical', () => {
    const lines = readFileSync('src/app/tailwind.css', 'utf8').split('\n');
    expect(sha(lines.slice(0, 246).join('\n') + '\n')).toBe(TAILWIND_PREFIX_SHA);
  });
  it('the 12 shadcn files are byte-identical and no file was added or removed', () => {
    const now = readdirSync('src/components/ui').map((n) => `src/components/ui/${n}`).sort();
    expect(now).toEqual(Object.keys(SHADCN_SHA).sort());
    expect(now).toHaveLength(12);
    for (const f of now) expect(sha(readFileSync(f, 'utf8')), f).toBe(SHADCN_SHA[f]);
  });
});
