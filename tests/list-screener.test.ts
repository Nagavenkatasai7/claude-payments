import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOfacSdnXml } from '@/lib/sanctions/ofac-sdn-loader';
import {
  ListSanctionsScreener,
  SanctionsListUnavailableError,
  jaroWinkler,
  listIndexBuildsForTests,
} from '@/lib/sanctions/list-screener';
import type { SanctionsListSource } from '@/lib/sanctions/list-source';

const LIST = parseOfacSdnXml(readFileSync(join(__dirname, 'fixtures', 'ofac-sdn-sample.xml'), 'utf8'));
const fixtureSource = (): SanctionsListSource & { load: ReturnType<typeof vi.fn> } => ({
  load: vi.fn(async () => LIST),
});

describe('jaroWinkler', () => {
  it('is 1 for equal strings, 0 against empty, and high for a one-letter typo', () => {
    expect(jaroWinkler('martha', 'martha')).toBe(1);
    expect(jaroWinkler('', 'abc')).toBe(0);
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 2); // the textbook value
    expect(jaroWinkler('dixon', 'dicksonx')).toBeCloseTo(0.813, 2);
  });
});

describe('ListSanctionsScreener', () => {
  it('an exact normalised / token-set match is matched with score 1 and the SDN id (primary name or AKA)', async () => {
    const s = new ListSanctionsScreener(fixtureSource());
    for (const [name, id] of [
      ['Testa Fixturelli', 'sdn:1003'],
      ['FIXTURELLI, Testa', 'sdn:1003'],
      ['sample  placeholder', 'sdn:1003'],
      ['National Example Bank', 'sdn:1002'],
      ['Alpha & Omega Test Foundation: Sample Branch', 'sdn:1005'],
    ] as const) {
      const hit = await s.screen({ name, sourceCountry: 'US' });
      expect(hit, name).toMatchObject({ matched: true, matchScore: 1, entryId: id, listSource: 'ofac-sdn' });
    }
  });

  it('a near miss (fuzzy ≥ 0.90) is a possible match for review, never matched and never a silent pass', async () => {
    const s = new ListSanctionsScreener(fixtureSource());
    const hit = await s.screen({ name: 'Banco Ejemplo Nacionel', sourceCountry: 'US' });
    expect(hit.matched).toBe(false);
    expect(hit.possibleMatch).toBe(true);
    expect(hit.entryId).toBe('sdn:1002');
    expect(hit.matchScore).toBeGreaterThanOrEqual(0.9);
    expect(hit.matchScore).toBeLessThan(1);
  });

  it('an unrelated name does not match', async () => {
    const s = new ListSanctionsScreener(fixtureSource());
    expect(await s.screen({ name: 'Mom', sourceCountry: 'US' })).toEqual({ matched: false });
    expect(await s.screen({ name: 'Alex Example', sourceCountry: 'US' })).toEqual({ matched: false });
    expect(await s.screen({ name: '  ', sourceCountry: 'US' })).toEqual({ matched: false });
  });

  it('screens the configured extra names (the partner watchlist) too, cited as extra:<index>', async () => {
    const s = new ListSanctionsScreener(fixtureSource(), { extraNames: ['john doe', 'corridor villain'] });
    expect(await s.screen({ name: 'Doe, John', sourceCountry: 'US' })).toMatchObject({ matched: true, entryId: 'extra:0' });
    expect(await s.screen({ name: 'Corridor  Villain', sourceCountry: 'US' })).toMatchObject({ matched: true, entryId: 'extra:1' });
  });

  it('listInfo carries the list version and a hash that also covers the extra names', async () => {
    const plain = new ListSanctionsScreener(fixtureSource());
    const extra = new ListSanctionsScreener(fixtureSource(), { extraNames: ['john doe'] });
    await plain.screen({ name: 'x', sourceCountry: 'US' });
    await extra.screen({ name: 'x', sourceCountry: 'US' });
    expect(plain.listInfo()).toMatchObject({ source: 'ofac-sdn', version: '2026-09-18' });
    expect(plain.listInfo().hash).toMatch(/^[0-9a-f]{64}$/);
    expect(extra.listInfo().hash).not.toBe(plain.listInfo().hash);
  });

  // PR C: the SOURCE owns caching (the Postgres source serves its cached
  // active version), so the screener asks it on every screen and re-indexes
  // only when it hands back a different list (a newly activated version).
  it('asks the source each screen but indexes a list once, shared across screeners', async () => {
    const src = fixtureSource();
    const a = new ListSanctionsScreener(src);
    const b = new ListSanctionsScreener(src, { extraNames: ['john doe'] });
    await a.screen({ name: 'a', sourceCountry: 'US' });
    await a.screen({ name: 'b', sourceCountry: 'US' });
    await b.screen({ name: 'c', sourceCountry: 'US' });
    expect(src.load).toHaveBeenCalledTimes(3);
    expect(listIndexBuildsForTests(LIST)).toBe(1);
  });

  it('picks up a newly activated list version on the next screen', async () => {
    const next = { ...LIST, version: '2026-09-22', hash: 'f'.repeat(64), entries: [
      ...LIST.entries,
      { id: 'sdn:2001', names: ['Newly Listed Person'], type: 'Individual', programs: ['SDGT'] },
    ] };
    const src = { load: vi.fn().mockResolvedValueOnce(LIST).mockResolvedValue(next) };
    const s = new ListSanctionsScreener(src);
    expect(await s.screen({ name: 'Newly Listed Person', sourceCountry: 'US' })).toEqual({ matched: false });
    expect(s.listInfo().version).toBe('2026-09-18');
    expect(await s.screen({ name: 'Newly Listed Person', sourceCountry: 'US' })).toMatchObject({ matched: true, entryId: 'sdn:2001' });
    expect(s.listInfo().version).toBe('2026-09-22');
  });

  it('a WEAK a.k.a. exact match is a possible match for review (score 1), never a block', async () => {
    const s = new ListSanctionsScreener(fixtureSource());
    const hit = await s.screen({ name: 'Ben', sourceCountry: 'US' });
    expect(hit).toMatchObject({ matched: false, possibleMatch: true, matchScore: 1, entryId: 'sdn:1002' });
  });

  it('a very long name is screened fast (keys that cannot reach the threshold are skipped) and still fuzzy-matches', async () => {
    const s = new ListSanctionsScreener(fixtureSource());
    const t0 = performance.now();
    expect(await s.screen({ name: 'x'.repeat(4000), sourceCountry: 'US' })).toEqual({ matched: false });
    expect(performance.now() - t0).toBeLessThan(50);
    expect((await s.screen({ name: 'Banco Ejemplo Nacionel', sourceCountry: 'US' })).possibleMatch).toBe(true);
  });

  it('length-ratio skip boundary: a 6-char name vs a 10-char entry sharing a 4-char prefix still fuzzy-matches (JW ≈ 0.92)', async () => {
    // ratio 0.6 — above the provable 0.5 bound; any tighter skip (e.g. < 0.83) would lose this match.
    expect(jaroWinkler('abcdef', 'abcdefghij')).toBeGreaterThanOrEqual(0.9);
    const s = new ListSanctionsScreener(fixtureSource(), { extraNames: ['abcdefghij'] });
    expect(await s.screen({ name: 'abcdef', sourceCountry: 'US' })).toMatchObject({ possibleMatch: true, entryId: 'extra:0' });
  });

  it('weak a.k.a.s are exact-only: a near miss on one is not a hit', async () => {
    const s = new ListSanctionsScreener(fixtureSource());
    expect(await s.screen({ name: 'Benn', sourceCountry: 'US' })).toEqual({ matched: false });
  });

  it('a load failure FAILS CLOSED: screen rejects with SanctionsListUnavailableError (never a pass) and retries next time', async () => {
    const src = { load: vi.fn().mockRejectedValueOnce(new Error('ENOENT')).mockResolvedValue(LIST) };
    const s = new ListSanctionsScreener(src);
    await expect(s.screen({ name: 'Mom', sourceCountry: 'US' })).rejects.toBeInstanceOf(SanctionsListUnavailableError);
    expect(s.listInfo()).toMatchObject({ source: 'ofac-sdn', version: 'unavailable' });
    await expect(s.screen({ name: 'Testa Fixturelli', sourceCountry: 'US' })).resolves.toMatchObject({ matched: true });
  });
});
