import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOfacSdnXml } from '@/lib/sanctions/ofac-sdn-loader';
import { ListSanctionsScreener, SanctionsListUnavailableError, jaroWinkler } from '@/lib/sanctions/list-screener';
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

  it('loads the list once and reuses it', async () => {
    const src = fixtureSource();
    const s = new ListSanctionsScreener(src);
    await s.screen({ name: 'a', sourceCountry: 'US' });
    await s.screen({ name: 'b', sourceCountry: 'US' });
    expect(src.load).toHaveBeenCalledTimes(1);
  });

  it('a load failure FAILS CLOSED: screen rejects with SanctionsListUnavailableError (never a pass) and retries next time', async () => {
    const src = { load: vi.fn().mockRejectedValueOnce(new Error('ENOENT')).mockResolvedValue(LIST) };
    const s = new ListSanctionsScreener(src);
    await expect(s.screen({ name: 'Mom', sourceCountry: 'US' })).rejects.toBeInstanceOf(SanctionsListUnavailableError);
    expect(s.listInfo()).toMatchObject({ source: 'ofac-sdn', version: 'unavailable' });
    await expect(s.screen({ name: 'Testa Fixturelli', sourceCountry: 'US' })).resolves.toMatchObject({ matched: true });
  });
});
