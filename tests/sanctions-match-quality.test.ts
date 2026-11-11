// Fix pack 2 T8 (R09): the dated match-quality fixture. Every case in
// tests/fixtures/sanctions-match-quality-2026-11.json records what TODAY's
// screener does with one invented name against an invented in-memory list:
// block, review, clear, or known_gap (a name a person would want reviewed that
// today's matcher clears). A change to normalisation, the threshold or the
// matcher that moves any outcome fails here, so the spec
// (docs/compliance/sanctions-screening-spec.md) and the fixture are updated
// together, on purpose.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FUZZY_THRESHOLD, ListSanctionsScreener, jaroWinkler } from '@/lib/sanctions/list-screener';
import { tokenKey } from '@/lib/sanctions/normalize';
import { MockSanctionsScreener } from '@/lib/providers/sanctions-provider';
import { WATCHLIST } from '@/lib/compliance-config';
import type { SanctionsList, SanctionsListSource } from '@/lib/sanctions/list-source';

type Tag = 'block' | 'review' | 'clear' | 'known_gap';
interface MatchCase {
  id: string;
  query: string;
  tag: Tag;
  /** The list name the case is about (block, review and known_gap cases). */
  listedAs?: string;
  /** block / review: the list entry the screener cites. */
  entryId?: string;
  /** Jaro-Winkler of the two token keys, 3 decimals (fuzzy cases only). */
  score?: number;
  note: string;
}
interface Fixture {
  asOf: string;
  threshold: number;
  screener: string;
  list: SanctionsList;
  cases: MatchCase[];
}

const FIXTURE_PATH = 'tests/fixtures/sanctions-match-quality-2026-11.json';
const SPEC_PATH = 'docs/compliance/sanctions-screening-spec.md';
const ROOT = join(__dirname, '..');
const fixture = JSON.parse(readFileSync(join(ROOT, FIXTURE_PATH), 'utf8')) as Fixture;

// The in-memory source of tests/list-screener.test.ts.
const fixtureSource = (): SanctionsListSource & { load: ReturnType<typeof vi.fn> } => ({
  load: vi.fn(async () => fixture.list),
});
const screener = () => new ListSanctionsScreener(fixtureSource());

const caseById = (id: string): MatchCase => {
  const c = fixture.cases.find((x) => x.id === id);
  if (!c) throw new Error(`fixture case ${id} missing`);
  return c;
};
const jw = (a: string, b: string) => jaroWinkler(tokenKey(a), tokenKey(b));

describe('sanctions match-quality fixture (R09)', () => {
  it('is dated, uses the 0.90 threshold and covers every tag', () => {
    expect(fixture.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fixture.threshold).toBe(FUZZY_THRESHOLD);
    expect(FUZZY_THRESHOLD).toBe(0.9);
    const tags = new Set(fixture.cases.map((c) => c.tag));
    expect([...tags].sort()).toEqual(['block', 'clear', 'known_gap', 'review']);
    expect(new Set(fixture.cases.map((c) => c.id)).size).toBe(fixture.cases.length);
  });

  it("every tagged case has today's outcome", async () => {
    const s = screener();
    for (const c of fixture.cases) {
      const hit = await s.screen({ name: c.query, sourceCountry: 'US' });
      if (c.tag === 'block') {
        expect(hit, c.id).toMatchObject({ matched: true, matchScore: 1, entryId: c.entryId });
      } else if (c.tag === 'review') {
        expect(hit.matched, c.id).toBe(false);
        expect(hit.possibleMatch, c.id).toBe(true);
        expect(hit.entryId, c.id).toBe(c.entryId);
        if (c.score !== undefined) expect(hit.matchScore, c.id).toBeCloseTo(c.score, 3);
      } else {
        // clear and known_gap: today's matcher lets the name through.
        expect(hit, c.id).toEqual({ matched: false });
      }
      if (c.score !== undefined) {
        expect(c.listedAs, c.id).toBeDefined();
        expect(jw(c.query, c.listedAs!), c.id).toBeCloseTo(c.score, 3);
        expect(c.score >= FUZZY_THRESHOLD, `${c.id}: score vs tag`).toBe(c.tag === 'review');
      }
    }
  });

  it('the spec names this fixture and 0.90', () => {
    const spec = readFileSync(join(ROOT, SPEC_PATH), 'utf8');
    expect(spec).toContain(FIXTURE_PATH);
    expect(spec).toContain('0.90');
    expect(spec).toContain(fixture.asOf);
  });

  it('the mock blocks exactly the demo names, nothing fuzzy', async () => {
    const mock = new MockSanctionsScreener(WATCHLIST);
    for (const [i, name] of WATCHLIST.entries()) {
      const words = name.split(' ');
      for (const q of [name, name.toUpperCase(), [...words].reverse().join(', ')]) {
        expect(await mock.screen({ name: q, sourceCountry: 'US' }), q).toMatchObject({
          matched: true,
          matchScore: 1,
          entryId: `mock:${i}`,
        });
      }
    }
    // One letter off a demo name, or any fixture name, is clear: the mock is exact-only.
    for (const q of ['Jon Doe', 'John Doee', 'Jane Roe Smith', 'Test Blockd', ...fixture.cases.map((c) => c.query)]) {
      expect(await mock.screen({ name: q, sourceCountry: 'US' }), q).toEqual({ matched: false });
    }
  });

  describe('Jaro-Winkler pins on token keys (confirmed with the real screener)', () => {
    it.each([
      ['husain-hussein', 'review'],
      ['chaudhry-choudhury', 'review'],
      ['abdul-rahman', 'review'],
      ['yusuf-yousef', 'review'],
      ['testo-testa', 'review'],
      ['mohammed-muhammad', 'known_gap'],
      ['added-middle-name', 'known_gap'],
      ['cyrillic-latin', 'known_gap'],
      ['abdul-rahman-bare', 'known_gap'],
    ] as const)('%s is %s', (id, tag) => {
      const c = caseById(id);
      expect(c.tag).toBe(tag);
      expect(c.score).toBeDefined();
      expect(Math.round(jw(c.query, c.listedAs!) * 1000) / 1000).toBe(c.score);
    });
  });
});
