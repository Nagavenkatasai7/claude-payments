import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { MockSanctionsScreener } from '@/lib/providers/sanctions-provider';
import { ListSanctionsScreener, SanctionsListUnavailableError } from '@/lib/sanctions/list-screener';
import { MultiListSanctionsScreener, isMultiListScreener } from '@/lib/sanctions/multi-list-screener';
import { listSetFitness } from '@/lib/sanctions/list-policy';
import type { SanctionsList, SanctionsListSource } from '@/lib/sanctions/list-source';
import type { SanctionsSourceId } from '@/lib/sanctions/list-sets';

// Fix pack 5 T28 (R08, P25): pure; in-memory list sources with invented names
// and relative times. Any match blocks, any possible match flags, any missing
// member fails closed.

const HOUR = 3_600_000;
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const PREFIX: Record<SanctionsSourceId, string> = { 'ofac-sdn': 'sdn', 'ofac-cons': 'cons', 'un-sc': 'unsc', 'in-mha-uapa': 'inmha' };

function list(source: SanctionsSourceId, entries: Array<{ names: string[]; weakNames?: string[] }>, version = '2026-01-01'): SanctionsList {
  return {
    source,
    version: `${source}-${version}`,
    hash: sha(`${source}:${JSON.stringify(entries)}`),
    entries: entries.map((e, i) => ({ id: `${PREFIX[source]}:${i + 1}`, type: 'Individual', programs: ['TEST'], ...e })),
  };
}

function src(l: SanctionsList | (() => Promise<SanctionsList>), checkedAgoMs: number | null = HOUR): SanctionsListSource {
  return {
    load: typeof l === 'function' ? l : async () => l,
    checkedAt: () => (checkedAgoMs === null ? null : new Date(Date.now() - checkedAgoMs)),
  };
}

function member(source: SanctionsSourceId, s: SanctionsListSource, extraNames: string[] = []) {
  return { source, screener: new ListSanctionsScreener(s, { extraNames, sourceName: source }) };
}

const SDN = list('ofac-sdn', [{ names: ['Zorvan Quillet'] }, { names: ['Shared Exact Person'] }]);
const CONS = list('ofac-cons', [{ names: ['Marlowe Tessaract'], weakNames: ['Weakalias Only'] }, { names: ['Shared Exact Person'] }, { names: ['Fuzzy Nearmissname'] }]);

describe('MultiListSanctionsScreener (pack 5 T28)', () => {
  it('an exact match on the second member blocks with that member\'s entryId (cons:...) and listSource = the composite source', async () => {
    const m = new MultiListSanctionsScreener([member('ofac-sdn', src(SDN)), member('ofac-cons', src(CONS))]);
    const hit = await m.screen({ name: 'Marlowe Tessaract', sourceCountry: 'US' });
    expect(hit).toMatchObject({ matched: true, entryId: 'cons:1', matchScore: 1, listSource: 'lists:ofac-sdn+ofac-cons' });
    expect(m.listInfo().source).toBe('lists:ofac-sdn+ofac-cons');
  });

  it('merge: an exact match anywhere beats an earlier possible match; two exact -> first member wins; possible only -> first member\'s; none -> { matched: false }', async () => {
    const a = list('ofac-sdn', [{ names: ['Fuzzy Nearmissnamx'] }, { names: ['Shared Exact Person'] }]);
    const m = new MultiListSanctionsScreener([member('ofac-sdn', src(a)), member('ofac-cons', src(CONS))]);
    // 'Fuzzy Nearmissname' is fuzzy on sdn (first) and exact on cons (second): the exact wins.
    expect(await m.screen({ name: 'Fuzzy Nearmissname', sourceCountry: 'US' })).toMatchObject({ matched: true, entryId: 'cons:3' });
    // Exact on both: the first member in order.
    expect(await m.screen({ name: 'Shared Exact Person', sourceCountry: 'US' })).toMatchObject({ matched: true, entryId: 'sdn:2' });
    // Possible only, on both: the first member's possible match (its score and entryId).
    const b = list('ofac-cons', [{ names: ['Fuzzy Nearmissnamz'] }]);
    const m2 = new MultiListSanctionsScreener([member('ofac-sdn', src(a)), member('ofac-cons', src(b))]);
    const first = await new ListSanctionsScreener(src(a), { sourceName: 'ofac-sdn' }).screen({ name: 'Fuzzy Nearmissname', sourceCountry: 'US' });
    const hit = await m2.screen({ name: 'Fuzzy Nearmissname', sourceCountry: 'US' });
    expect(first.possibleMatch).toBe(true);
    expect(hit).toEqual({ matched: false, possibleMatch: true, matchScore: first.matchScore, entryId: 'sdn:1', listSource: 'lists:ofac-sdn+ofac-cons' });
    expect(await m.screen({ name: 'Totally Unlisted Name', sourceCountry: 'US' })).toEqual({ matched: false });
  });

  it('a weak alias on one member and nothing else -> possibleMatch, never matched', async () => {
    const m = new MultiListSanctionsScreener([member('ofac-sdn', src(SDN)), member('ofac-cons', src(CONS))]);
    const hit = await m.screen({ name: 'Weakalias Only', sourceCountry: 'US' });
    expect(hit).toMatchObject({ matched: false, possibleMatch: true, matchScore: 1, entryId: 'cons:1' });
  });

  it('extras are screened once: only the first member carries extraNames, and an extra matches extra:<i>', async () => {
    const first = member('ofac-sdn', src(SDN), ['Partner Extra Villain']);
    const second = member('ofac-cons', src(CONS));
    const spies = [vi.spyOn(first.screener, 'screen'), vi.spyOn(second.screener, 'screen')];
    const m = new MultiListSanctionsScreener([first, second]);
    expect(await m.screen({ name: 'Partner Extra Villain', sourceCountry: 'US' })).toMatchObject({ matched: true, entryId: 'extra:0' });
    // Each member is screened exactly once per name.
    expect(spies.map((s) => s.mock.calls.length)).toEqual([1, 1]);
    // The second member alone does not know the extra.
    expect((await second.screener.screen({ name: 'Partner Extra Villain', sourceCountry: 'US' })).matched).toBe(false);
  });

  it('fail closed: a clear on a partial set (a member whose load rejects, whose list is empty, or whose screen throws) -> SanctionsListUnavailableError', async () => {
    // 'Nobody Listed' is on no member: without the failing member there is no answer.
    const rejecting = new MultiListSanctionsScreener([
      member('ofac-sdn', src(SDN)),
      member('ofac-cons', src(async () => { throw new Error('no active ofac-cons list'); })),
    ]);
    await expect(rejecting.screen({ name: 'Nobody Listed', sourceCountry: 'US' })).rejects.toBeInstanceOf(SanctionsListUnavailableError);
    const empty = new MultiListSanctionsScreener([member('ofac-sdn', src(SDN)), member('ofac-cons', src({ ...CONS, entries: [] }))]);
    await expect(empty.screen({ name: 'Nobody Listed', sourceCountry: 'US' })).rejects.toBeInstanceOf(SanctionsListUnavailableError);
    const throwing = new MultiListSanctionsScreener([
      member('ofac-sdn', src(SDN)),
      { source: 'ofac-cons', screener: { screen: async () => { throw new TypeError('boom'); }, listInfo: () => ({ source: 'ofac-cons', version: 'v', hash: 'h' }) } },
    ]);
    await expect(throwing.screen({ name: 'Nobody Listed', sourceCountry: 'US' })).rejects.toBeInstanceOf(SanctionsListUnavailableError);
    // A member that answers but reports no loaded list also fails closed.
    const unloaded = new MultiListSanctionsScreener([
      member('ofac-sdn', src(SDN)),
      { source: 'ofac-cons', screener: { screen: async () => ({ matched: false }), listInfo: () => ({ source: 'ofac-cons', version: 'unloaded', hash: '' }) } },
    ]);
    await expect(unloaded.screen({ name: 'Nobody Listed', sourceCountry: 'US' })).rejects.toBeInstanceOf(SanctionsListUnavailableError);
  });

  // LA1 (list review round 1): an exact match on any member blocks, whatever
  // the other members did; every other outcome on a partial set fails closed.
  describe('partial set (LA1): an exact match survives another member\'s failure', () => {
    const rejectingCons = () => member('ofac-cons', src(async () => { throw new Error('no active ofac-cons list'); }));
    const unloadedCons = () => ({
      source: 'ofac-cons' as const,
      screener: { screen: async () => ({ matched: false }), listInfo: () => ({ source: 'ofac-cons', version: 'unloaded', hash: '' }) },
    });

    it('(a) member 1 exact match + member 2 rejects -> matched with the member 1 entry id and the composite listSource', async () => {
      const m = new MultiListSanctionsScreener([member('ofac-sdn', src(SDN)), rejectingCons()]);
      expect(await m.screen({ name: 'Zorvan Quillet', sourceCountry: 'US' })).toEqual({
        matched: true, matchScore: 1, entryId: 'sdn:1', listSource: 'lists:ofac-sdn+ofac-cons',
      });
      // The composite identity still says the set is not loaded.
      expect(m.listInfo()).toEqual({ source: 'lists:ofac-sdn+ofac-cons', version: 'unavailable', hash: '' });
    });

    it('(b) member 1 exact match + member 2 unloaded but not throwing -> the same', async () => {
      const m = new MultiListSanctionsScreener([member('ofac-sdn', src(SDN)), unloadedCons()]);
      expect(await m.screen({ name: 'Zorvan Quillet', sourceCountry: 'US' })).toMatchObject({
        matched: true, entryId: 'sdn:1', listSource: 'lists:ofac-sdn+ofac-cons',
      });
    });

    it('(c) member 1 possible match + member 2 rejects -> SanctionsListUnavailableError', async () => {
      const fuzzy = list('ofac-sdn', [{ names: ['Fuzzy Nearmissnamx'] }]);
      const m = new MultiListSanctionsScreener([member('ofac-sdn', src(fuzzy)), rejectingCons()]);
      const alone = await new ListSanctionsScreener(src(fuzzy), { sourceName: 'ofac-sdn' }).screen({ name: 'Fuzzy Nearmissname', sourceCountry: 'US' });
      expect(alone).toMatchObject({ matched: false, possibleMatch: true });
      await expect(m.screen({ name: 'Fuzzy Nearmissname', sourceCountry: 'US' })).rejects.toBeInstanceOf(SanctionsListUnavailableError);
    });

    it('(d) member 1 clear + member 2 unloaded -> SanctionsListUnavailableError', async () => {
      const m = new MultiListSanctionsScreener([member('ofac-sdn', src(SDN)), unloadedCons()]);
      await expect(m.screen({ name: 'Nobody Listed', sourceCountry: 'US' })).rejects.toBeInstanceOf(SanctionsListUnavailableError);
    });

    it('(e) exact match on member 2 while member 1 rejects -> matched with the member 2 entry id', async () => {
      const m = new MultiListSanctionsScreener([
        member('ofac-sdn', src(async () => { throw new Error('no active ofac-sdn list'); })),
        member('ofac-cons', src(CONS)),
      ]);
      expect(await m.screen({ name: 'Marlowe Tessaract', sourceCountry: 'US' })).toMatchObject({
        matched: true, entryId: 'cons:1', listSource: 'lists:ofac-sdn+ofac-cons',
      });
    });

    it('an exact extras hit on the ofac-sdn member survives another member\'s failure', async () => {
      const m = new MultiListSanctionsScreener([member('ofac-sdn', src(SDN), ['Partner Extra Villain']), rejectingCons()]);
      expect(await m.screen({ name: 'Partner Extra Villain', sourceCountry: 'US' })).toMatchObject({ matched: true, entryId: 'extra:0' });
    });

    it('two exact matches with a third member failing -> the first in member order', async () => {
      const m = new MultiListSanctionsScreener([
        member('ofac-sdn', src(SDN)),
        member('ofac-cons', src(CONS)),
        member('un-sc', src(async () => { throw new Error('no active un-sc list'); })),
      ]);
      expect(await m.screen({ name: 'Shared Exact Person', sourceCountry: 'US' })).toMatchObject({ matched: true, entryId: 'sdn:2' });
    });
  });

  it('the constructor refuses an empty member list', () => {
    expect(() => new MultiListSanctionsScreener([])).toThrow();
  });

  it('listInfo() before any screen is unloaded with an empty hash; after a screen it is the composite', async () => {
    // LE5: fixed checkedAt values (no wall-clock window): sdn 2 h ago, cons 5 h ago.
    const now = Date.now();
    const sdnAt = new Date(now - 2 * HOUR);
    const consAt = new Date(now - 5 * HOUR);
    const fixed = (l: SanctionsList, at: Date): SanctionsListSource => ({ load: async () => l, checkedAt: () => at });
    const m = new MultiListSanctionsScreener([member('ofac-sdn', fixed(SDN, sdnAt)), member('ofac-cons', fixed(CONS, consAt))]);
    expect(m.listInfo()).toEqual({ source: 'lists:ofac-sdn+ofac-cons', version: 'unloaded', hash: '' });
    await m.screen({ name: 'Nobody Listed', sourceCountry: 'US' });
    const info = m.listInfo();
    const members = m.memberInfos();
    expect(info.source).toBe('lists:ofac-sdn+ofac-cons');
    expect(info.version).toBe(`${SDN.version}+${CONS.version}`);
    expect(info.hash).toBe(sha(members.map((x) => x.hash).join('|')));
    expect(info.hash).toMatch(/^[0-9a-f]{64}$/);
    // checkedAt = the OLDEST member checkedAt (cons, 5 h ago), exactly; also when the oldest is first.
    expect(info.checkedAt).toBe(consAt.toISOString());
    const m1 = new MultiListSanctionsScreener([member('ofac-cons', fixed(CONS, consAt)), member('ofac-sdn', fixed(SDN, sdnAt))]);
    await m1.screen({ name: 'Nobody Listed', sourceCountry: 'US' });
    expect(m1.listInfo().checkedAt).toBe(consAt.toISOString());
    // Absent when any member's checkedAt is absent.
    const m2 = new MultiListSanctionsScreener([member('ofac-sdn', src(SDN)), member('ofac-cons', src(CONS, null))]);
    await m2.screen({ name: 'Nobody Listed', sourceCountry: 'US' });
    expect('checkedAt' in m2.listInfo()).toBe(false);
  });

  it('memberInfos() -> one { source, version, hash, checkedAt?, fitness } per member, in order; the 8-day MHA age applies', async () => {
    const UN = list('un-sc', [{ names: ['Unsc Invented Person'] }]);
    const MHA = list('in-mha-uapa', [{ names: ['Mha Invented Group'] }]);
    const fiveDays = 5 * 24 * HOUR;
    const m = new MultiListSanctionsScreener([
      member('ofac-sdn', src(SDN)),
      member('ofac-cons', src(CONS)),
      member('un-sc', src(UN, fiveDays)),
      member('in-mha-uapa', src(MHA, fiveDays)),
    ]);
    expect(m.memberInfos().map((x) => [x.source, x.version, x.hash, x.fitness])).toEqual([
      ['ofac-sdn', 'unloaded', '', 'not_live'],
      ['ofac-cons', 'unloaded', '', 'not_live'],
      ['un-sc', 'unloaded', '', 'not_live'],
      ['in-mha-uapa', 'unloaded', '', 'not_live'],
    ]);
    await m.screen({ name: 'Nobody Listed', sourceCountry: 'IN' });
    const infos = m.memberInfos();
    expect(infos.map((x) => x.source)).toEqual(['ofac-sdn', 'ofac-cons', 'un-sc', 'in-mha-uapa']);
    expect(infos.map((x) => x.fitness)).toEqual(['live', 'live', 'stale', 'live']);
    expect(infos.map((x) => x.version)).toEqual([SDN.version, CONS.version, UN.version, MHA.version]);
    for (const x of infos) {
      expect(x.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof x.checkedAt).toBe('string');
      expect(Object.keys(x).sort()).toEqual(['checkedAt', 'fitness', 'hash', 'source', 'version']);
    }
  });

  it('a member stale and the rest live: screen still answers; listSetFitness(memberInfos, required) is stale', async () => {
    const m = new MultiListSanctionsScreener([member('ofac-sdn', src(SDN)), member('ofac-cons', src(CONS, 48 * HOUR))]);
    await expect(m.screen({ name: 'Zorvan Quillet', sourceCountry: 'US' })).resolves.toMatchObject({ matched: true, entryId: 'sdn:1' });
    expect(listSetFitness(m.memberInfos(), ['ofac-sdn', 'ofac-cons'], new Date())).toBe('stale');
  });

  it('isMultiListScreener: true for a multi screener only', () => {
    const multi = new MultiListSanctionsScreener([member('ofac-sdn', src(SDN))]);
    expect(isMultiListScreener(multi)).toBe(true);
    expect(isMultiListScreener(new ListSanctionsScreener(src(SDN)))).toBe(false);
    expect(isMultiListScreener(new MockSanctionsScreener([]))).toBe(false);
  });
});
