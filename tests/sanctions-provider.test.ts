import { describe, it, expect } from 'vitest';
import { MockSanctionsScreener, getSanctionsScreener } from '@/lib/providers/sanctions-provider';

describe('MockSanctionsScreener', () => {
  it('matches a base-list name case-insensitively and trimmed', async () => {
    const s = new MockSanctionsScreener(['John Doe', 'jane roe']);
    const hit = await s.screen({ name: '  JOHN DOE ', sourceCountry: 'US' });
    expect(hit.matched).toBe(true);
    expect(hit.matchedName).toBe('john doe');
    expect(hit.listSource).toBe('mock-watchlist');
  });

  it('returns { matched: false } for an unlisted name', async () => {
    const s = new MockSanctionsScreener(['john doe']);
    const hit = await s.screen({ name: 'Mom', sourceCountry: 'US' });
    expect(hit).toEqual({ matched: false });
  });

  it('matches a corridor watchlistExtra name folded into the base list', async () => {
    const s = new MockSanctionsScreener(['john doe', 'corridor villain']);
    const hit = await s.screen({ name: 'Corridor Villain', sourceCountry: 'GB' });
    expect(hit.matched).toBe(true);
  });

  it('empty / whitespace name never matches (defensive ?? \'\')', async () => {
    const s = new MockSanctionsScreener(['john doe']);
    expect((await s.screen({ name: '', sourceCountry: 'US' })).matched).toBe(false);
    expect((await s.screen({ name: '   ', sourceCountry: 'US' })).matched).toBe(false);
  });

  it('accepts and ignores sourceCountry without error', async () => {
    const s = new MockSanctionsScreener(['john doe']);
    await expect(s.screen({ name: 'john doe', sourceCountry: 'AE' })).resolves.toMatchObject({ matched: true });
  });
});

describe('getSanctionsScreener', () => {
  it('builds a MockSanctionsScreener over the supplied base list', async () => {
    const s = getSanctionsScreener(['test blocked']);
    expect((await s.screen({ name: 'Test Blocked', sourceCountry: 'US' })).matched).toBe(true);
  });
});

// ── Program-Fix 14 ───────────────────────────────────────────────────────────
import { afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  setOfacListSourceForTests,
  ofacListSourceForTests,
  warmSanctionsList,
} from '@/lib/providers/sanctions-provider';
import { PostgresSanctionsListSource } from '@/lib/sanctions/pg-list-source';
import { ListSanctionsScreener, SanctionsListUnavailableError } from '@/lib/sanctions/list-screener';
import { parseOfacSdnXml } from '@/lib/sanctions/ofac-sdn-loader';
import { WATCHLIST } from '@/lib/compliance-config';

describe('MockSanctionsScreener — normalised matching (prs-03)', () => {
  const s = new MockSanctionsScreener(WATCHLIST);
  for (const name of ['John  Doe', 'John\tDoe', 'Doe, John', 'JOHN DOE.', 'Jöhn Doe', 'john-doe', 'Test\nBlocked']) {
    it(`blocks ${JSON.stringify(name)}`, async () => {
      expect((await s.screen({ name, sourceCountry: 'US' })).matched).toBe(true);
    });
  }
  it('does not over-match a longer or different name', async () => {
    expect((await s.screen({ name: 'John Doe Smith', sourceCountry: 'US' })).matched).toBe(false);
    expect((await s.screen({ name: 'Jon Doe', sourceCountry: 'US' })).matched).toBe(false);
  });
  it('cites the entry as mock:<index> with score 1', async () => {
    expect(await s.screen({ name: 'Jane Roe', sourceCountry: 'US' })).toMatchObject({ matched: true, entryId: 'mock:1', matchScore: 1 });
  });
  it('listInfo is { mock-watchlist, static, sha256 } and changes with the (per-partner) list', () => {
    const info = s.listInfo();
    expect(info).toMatchObject({ source: 'mock-watchlist', version: 'static' });
    expect(info.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new MockSanctionsScreener([...WATCHLIST, 'corridor villain']).listInfo().hash).not.toBe(info.hash);
    expect(new MockSanctionsScreener([...WATCHLIST].reverse()).listInfo().hash).toBe(info.hash);
  });
});

describe('getSanctionsScreener — SANCTIONS_LIST picks WHICH list, never WHETHER', () => {
  const original = process.env.SANCTIONS_LIST;
  afterEach(() => {
    if (original === undefined) delete process.env.SANCTIONS_LIST;
    else process.env.SANCTIONS_LIST = original;
    setOfacListSourceForTests(null);
    vi.restoreAllMocks();
  });

  it('unset or "mock" → the mock', () => {
    delete process.env.SANCTIONS_LIST;
    expect(getSanctionsScreener(WATCHLIST)).toBeInstanceOf(MockSanctionsScreener);
    process.env.SANCTIONS_LIST = 'mock';
    expect(getSanctionsScreener(WATCHLIST)).toBeInstanceOf(MockSanctionsScreener);
  });

  it('an unknown value → the mock plus ONE warning, and screening still runs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.SANCTIONS_LIST = 'bogus';
    setOfacListSourceForTests(null); // resets the one-time warning
    const s = getSanctionsScreener(WATCHLIST);
    getSanctionsScreener(WATCHLIST);
    expect(s).toBeInstanceOf(MockSanctionsScreener);
    expect((await s.screen({ name: 'John Doe', sourceCountry: 'US' })).matched).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('sanctions.unknown-list');
  });

  it('"ofac-sdn" → the list screener over the OFAC source, still screening the base list', async () => {
    const list = parseOfacSdnXml(readFileSync(join(__dirname, 'fixtures', 'ofac-sdn-sample.xml'), 'utf8'));
    setOfacListSourceForTests({ load: async () => list });
    process.env.SANCTIONS_LIST = 'ofac-sdn';
    const s = getSanctionsScreener(WATCHLIST);
    expect(s).toBeInstanceOf(ListSanctionsScreener);
    expect(await s.screen({ name: 'Testa Fixturelli', sourceCountry: 'US' })).toMatchObject({ matched: true, entryId: 'sdn:1003' });
    expect(await s.screen({ name: 'John Doe', sourceCountry: 'US' })).toMatchObject({ matched: true, entryId: 'extra:0' });
  });

  it('"ofac-sdn" with no loaded list version fails CLOSED (rejects; never a pass, never the mock)', async () => {
    process.env.SANCTIONS_LIST = 'ofac-sdn';
    setOfacListSourceForTests({ load: async () => { throw new Error('no active ofac-sdn list version is loaded'); } });
    const s = getSanctionsScreener(WATCHLIST);
    await expect(s.screen({ name: 'Mom', sourceCountry: 'US' })).rejects.toBeInstanceOf(SanctionsListUnavailableError);
  });

  // PR C: the OFAC list lives in Postgres (migration 0023), loaded by the daily loader.
  it('"ofac-sdn" reads the Postgres-backed list by default (no checked-in snapshot)', () => {
    setOfacListSourceForTests(null);
    expect(ofacListSourceForTests()).toBeInstanceOf(PostgresSanctionsListSource);
  });

  it('warmSanctionsList refreshes the OFAC source only when SANCTIONS_LIST=ofac-sdn, and never throws', async () => {
    const warm = vi.fn(async () => { throw new Error('db down'); });
    setOfacListSourceForTests({ load: async () => { throw new Error('unused'); }, warm });
    delete process.env.SANCTIONS_LIST;
    await warmSanctionsList();
    process.env.SANCTIONS_LIST = 'mock';
    await warmSanctionsList();
    expect(warm).not.toHaveBeenCalled();
    process.env.SANCTIONS_LIST = 'ofac-sdn';
    await expect(warmSanctionsList()).resolves.toBeUndefined();
    expect(warm).toHaveBeenCalledTimes(1);
  });
});

describe('MockSanctionsScreener — entries that normalise to empty keep the old exact compare', () => {
  const s = new MockSanctionsScreener(['john doe', '!!!', '😀😀']);
  it('a punctuation-only or emoji-only entry still matches its exact (trimmed, lowercased) form', async () => {
    expect(await s.screen({ name: ' !!! ', sourceCountry: 'US' })).toMatchObject({ matched: true, entryId: 'mock:1' });
    expect(await s.screen({ name: '😀😀', sourceCountry: 'US' })).toMatchObject({ matched: true, entryId: 'mock:2' });
  });
  it('but a different symbol-only name does not match, and blank never matches', async () => {
    expect((await s.screen({ name: '???', sourceCountry: 'US' })).matched).toBe(false);
    expect((await s.screen({ name: '   ', sourceCountry: 'US' })).matched).toBe(false);
  });
});

// ── Fix pack 5 T28 (R08, P25): the opt-in 'lists' mode ──────────────────────
import {
  setListSourceForTests,
  listSourceForTests,
  servedListInfo,
  servedOfacListInfo,
} from '@/lib/providers/sanctions-provider';
import { MultiListSanctionsScreener, isMultiListScreener } from '@/lib/sanctions/multi-list-screener';
import { SANCTIONS_SOURCES } from '@/lib/sanctions/list-sets';
import { LIST_SET_NAMES, primeListSet, restoreOfacSource } from './helpers-sanctions';
import { createHash } from 'node:crypto';

describe('getSanctionsScreener — SANCTIONS_LIST=lists (pack 5 T28)', () => {
  const original = process.env.SANCTIONS_LIST;
  afterEach(() => {
    restoreOfacSource(original);
    vi.restoreAllMocks();
  });

  async function memberSources(s: ReturnType<typeof getSanctionsScreener>): Promise<string[]> {
    expect(isMultiListScreener(s)).toBe(true);
    await s.screen({ name: 'Nobody Listed Here', sourceCountry: 'US' });
    return (s as MultiListSanctionsScreener).memberInfos().map((m) => m.source);
  }

  it('destination IN -> all four lists in order; DE -> the two OFAC lists; no opts / null -> all four', async () => {
    primeListSet({});
    const inScreener = getSanctionsScreener(WATCHLIST, { destinationCountry: 'IN' });
    expect(inScreener).toBeInstanceOf(MultiListSanctionsScreener);
    expect(await memberSources(inScreener)).toEqual(['ofac-sdn', 'ofac-cons', 'un-sc', 'in-mha-uapa']);
    expect(await memberSources(getSanctionsScreener(WATCHLIST, { destinationCountry: 'DE' }))).toEqual(['ofac-sdn', 'ofac-cons']);
    expect(await memberSources(getSanctionsScreener(WATCHLIST))).toEqual(['ofac-sdn', 'ofac-cons', 'un-sc', 'in-mha-uapa']);
    expect(await memberSources(getSanctionsScreener(WATCHLIST, { destinationCountry: null }))).toEqual(['ofac-sdn', 'ofac-cons', 'un-sc', 'in-mha-uapa']);
  });

  it('each source blocks with its own namespaced id; the base list is screened once, on ofac-sdn only', async () => {
    primeListSet({});
    const s = getSanctionsScreener(WATCHLIST, { destinationCountry: 'IN' });
    expect(await s.screen({ name: LIST_SET_NAMES['un-sc'], sourceCountry: 'US' })).toMatchObject({ matched: true, entryId: 'unsc:1' });
    expect(await s.screen({ name: LIST_SET_NAMES['in-mha-uapa'], sourceCountry: 'US' })).toMatchObject({ matched: true, entryId: 'inmha:1' });
    expect(await s.screen({ name: 'John Doe', sourceCountry: 'US' })).toMatchObject({ matched: true, entryId: 'extra:0', listSource: 'lists:ofac-sdn+ofac-cons+un-sc+in-mha-uapa' });
    // Members other than ofac-sdn carry no extras: their bound hash is sha256(list hash + '\n' + '').
    const infos = (s as MultiListSanctionsScreener).memberInfos();
    const sources = SANCTIONS_SOURCES.map((src) => listSourceForTests(src));
    const listHashes = await Promise.all(sources.map(async (src) => (await src.load()).hash));
    const bare = (h: string) => createHash('sha256').update(`${h}\n`, 'utf8').digest('hex');
    expect(infos[0].hash).not.toBe(bare(listHashes[0]));
    expect(infos.slice(1).map((i) => i.hash)).toEqual(listHashes.slice(1).map(bare));
  });

  it('one source failing -> screen rejects SanctionsListUnavailableError', async () => {
    primeListSet({ missing: ['un-sc'] });
    const s = getSanctionsScreener(WATCHLIST, { destinationCountry: 'IN' });
    await expect(s.screen({ name: 'Mom', sourceCountry: 'US' })).rejects.toBeInstanceOf(SanctionsListUnavailableError);
    // The same set without un-sc (destination DE) still answers.
    await expect(getSanctionsScreener(WATCHLIST, { destinationCountry: 'DE' }).screen({ name: 'Mom', sourceCountry: 'US' })).resolves.toEqual({ matched: false });
  });

  it('uses one PostgresSanctionsListSource per source by default, each with its own source name', () => {
    for (const src of SANCTIONS_SOURCES) setListSourceForTests(src, null);
    const seen = new Set<unknown>();
    for (const src of SANCTIONS_SOURCES) {
      const s = listSourceForTests(src);
      expect(s).toBeInstanceOf(PostgresSanctionsListSource);
      expect((s as unknown as { source: string }).source).toBe(src);
      seen.add(s);
    }
    expect(seen.size).toBe(4);
    expect(ofacListSourceForTests()).toBe(listSourceForTests('ofac-sdn'));
  });

  it('warmSanctionsList under "lists" warms all four sources once each and never throws when one warm throws', async () => {
    const warms = SANCTIONS_SOURCES.map((src, i) => {
      const warm = vi.fn(async () => { if (i === 1) throw new Error('db down'); });
      setListSourceForTests(src, { load: async () => { throw new Error('unused'); }, warm });
      return warm;
    });
    process.env.SANCTIONS_LIST = 'lists';
    await expect(warmSanctionsList()).resolves.toBeUndefined();
    expect(warms.map((w) => w.mock.calls.length)).toEqual([1, 1, 1, 1]);
    // ofac-sdn warms only ofac-sdn; unset and mock warm none.
    process.env.SANCTIONS_LIST = 'ofac-sdn';
    await warmSanctionsList();
    expect(warms.map((w) => w.mock.calls.length)).toEqual([2, 1, 1, 1]);
    delete process.env.SANCTIONS_LIST;
    await warmSanctionsList();
    process.env.SANCTIONS_LIST = 'mock';
    await warmSanctionsList();
    expect(warms.map((w) => w.mock.calls.length)).toEqual([2, 1, 1, 1]);
  });

  it('servedListInfo(source) returns that source\'s info; servedOfacListInfo() equals servedListInfo("ofac-sdn")', async () => {
    const srcs = primeListSet({});
    const un = await srcs['un-sc'].load();
    const info = await servedListInfo('un-sc');
    expect(info).toMatchObject({ source: 'un-sc', version: un.version, hash: un.hash, baseHash: un.hash });
    expect(typeof info.checkedAt).toBe('string');
    expect(await servedOfacListInfo()).toEqual(await servedListInfo('ofac-sdn'));
    primeListSet({ missing: ['in-mha-uapa'] });
    await expect(servedListInfo('in-mha-uapa')).rejects.toThrow();
  });

  it('opts is ignored outside "lists": unset, mock, ofac-sdn and bogus return the same class as before', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cases: Array<[string | undefined, unknown]> = [
      [undefined, MockSanctionsScreener], ['mock', MockSanctionsScreener], ['ofac-sdn', ListSanctionsScreener], ['bogus', MockSanctionsScreener],
    ];
    for (const [value, cls] of cases) {
      if (value === undefined) delete process.env.SANCTIONS_LIST;
      else process.env.SANCTIONS_LIST = value;
      for (const destinationCountry of ['IN', 'DE', null] as const) {
        const s = getSanctionsScreener(WATCHLIST, { destinationCountry });
        expect(s).toBeInstanceOf(cls as new (...a: never[]) => unknown);
        expect(isMultiListScreener(s)).toBe(false);
      }
    }
  });
});
