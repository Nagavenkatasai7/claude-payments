import { describe, it, expect, afterEach } from 'vitest';
import {
  screenTransfer,
  LIST_UNAVAILABLE_REASON,
  RECIPIENT_WATCHLIST_REASON,
} from '@/lib/compliance';
import { inputHash } from '@/lib/sanctions/evidence';
import { MockSanctionsScreener, setListSourceForTests } from '@/lib/providers/sanctions-provider';
import { LIST_SET_NAMES, listSetList, primeListSet, restoreOfacSource } from './helpers-sanctions';

// Fix pack 5 T29 (R08, P25, P26): under the opt-in SANCTIONS_LIST=lists the
// destination picks the list floor, the evidence records each list of the set
// as lists[] ({ source, version, hash, fitness, checkedAt? }), and listFitness
// is the SET fitness (worst member, a required list absent -> not_live), so a
// real-money screen clears only when every floor list is live. Invented names.

const DAY = 86_400_000;
const FOUR = ['ofac-sdn', 'ofac-cons', 'un-sc', 'in-mha-uapa'];
const COMPOSITE_IN = `lists:${FOUR.join('+')}`;
const CLEAN_PAYEE = 'Plain Invented Payee';
const CLEAN_SENDER = 'Plain Invented Sender';

// The served hash covers the list AND its extras digest (list-screener.ts); for
// ofac-sdn (which carries the WATCHLIST base list) it is the literal pinned in
// tests/sanctions-golden-modes.test.ts. The others are checked as 64-hex.
const SDN_SERVED_HASH = '00bfe29a82d0cd55e400d97e0cff5eb213936ee156b539bc60694b51c8a3cc2d';
const expectServedHash = (source: string, hash: string) =>
  source === 'ofac-sdn' ? expect(hash).toBe(SDN_SERVED_HASH) : expect(hash).toMatch(/^[0-9a-f]{64}$/);

const screen = (over: Partial<Parameters<typeof screenTransfer>[0]> = {}) =>
  screenTransfer({ amountUsd: 100, recipientName: CLEAN_PAYEE, senderName: CLEAN_SENDER, transfersToday: 0, ...over });

describe('screenTransfer under SANCTIONS_LIST=lists: destination floor, lists[], set fitness (pack 5 T29)', { retry: 0 }, () => {
  const original = process.env.SANCTIONS_LIST;
  afterEach(() => restoreOfacSource(original));

  it("destinationCountry 'IN': composite listSource and version, lists has the four lists in floor order", async () => {
    primeListSet({});
    const r = await screen({ destinationCountry: 'IN' });
    const e = r.evidence!;
    expect(e.listSource).toBe(COMPOSITE_IN);
    expect(e.listVersion).toBe(FOUR.map((s) => listSetList(s as never).version).join('+'));
    expect(e.lists!.map((l) => l.source)).toEqual(FOUR);
    for (const l of e.lists!) {
      expect(Object.keys(l)).toEqual(['source', 'version', 'hash', 'fitness', 'checkedAt']);
      expect(l.version).toBe(listSetList(l.source as never).version);
      expectServedHash(l.source, l.hash);
      expect(l.fitness).toBe('live');
      expect(Number.isFinite(Date.parse(l.checkedAt!))).toBe(true);
    }
  });

  it("destinationCountry 'DE': lists has ofac-sdn and ofac-cons only", async () => {
    primeListSet({});
    const r = await screen({ destinationCountry: 'DE' });
    expect(r.evidence!.listSource).toBe('lists:ofac-sdn+ofac-cons');
    expect(r.evidence!.lists!.map((l) => l.source)).toEqual(['ofac-sdn', 'ofac-cons']);
  });

  it('no destination, or null: all four lists', async () => {
    primeListSet({});
    expect((await screen()).evidence!.lists!.map((l) => l.source)).toEqual(FOUR);
    expect((await screen({ destinationCountry: null })).evidence!.lists!.map((l) => l.source)).toEqual(FOUR);
  });

  it("listFitness is the set fitness: every member live -> 'live' and a real-money screen clears", async () => {
    primeListSet({});
    const r = await screen({ destinationCountry: 'IN', requireLiveList: true });
    expect(r.evidence!.listFitness).toBe('live');
    expect(r.status).toBe('cleared');
    expect(r.reasons).toEqual([]);
    expect(r.evidence!.decision).toBe('clear');
  });

  it("MHA checked 9 days ago, 'IN' -> 'stale', requireLiveList -> flagged with LIST_UNAVAILABLE first", async () => {
    primeListSet({ checkedAgoMs: { 'in-mha-uapa': 9 * DAY } });
    const r = await screen({ destinationCountry: 'IN', requireLiveList: true, amountUsd: 5000 });
    expect(r.evidence!.listFitness).toBe('stale');
    expect(r.status).toBe('flagged');
    expect(r.reasons[0]).toBe(LIST_UNAVAILABLE_REASON);
    expect(r.evidence!.decision).toBe('list_unavailable');
    expect(r.evidence!.lists!.find((l) => l.source === 'in-mha-uapa')!.fitness).toBe('stale');
  });

  it("MHA 9 days old, 'DE' -> 'live' (not required) and the real-money screen clears", async () => {
    primeListSet({ checkedAgoMs: { 'in-mha-uapa': 9 * DAY } });
    const r = await screen({ destinationCountry: 'DE', requireLiveList: true });
    expect(r.evidence!.listFitness).toBe('live');
    expect(r.status).toBe('cleared');
  });

  it("a member missing (never loaded) -> flagged, 'list_unavailable', not_live; lists names every required list, the missing one not_live and not checked", async () => {
    primeListSet({ missing: ['un-sc'] });
    const r = await screen({ destinationCountry: 'IN' });
    expect(r.status).toBe('flagged');
    expect(r.reasons).toEqual([LIST_UNAVAILABLE_REASON]);
    expect(r.evidence).toMatchObject({ decision: 'list_unavailable', listSource: COMPOSITE_IN, listHash: '', listFitness: 'not_live' });
    const lists = r.evidence!.lists!;
    expect(lists.map((l) => l.source)).toEqual(FOUR);
    expect(lists.find((l) => l.source === 'un-sc')).toEqual({ source: 'un-sc', version: 'unavailable', hash: '', fitness: 'not_live' });
    for (const l of lists.filter((x) => x.source !== 'un-sc')) {
      expect(l.fitness).toBe('live');
      expectServedHash(l.source, l.hash);
    }
    // Nobody was screened on the partial set: every party says so.
    expect(r.evidence!.parties).toEqual([
      { role: 'recipient', inputHash: inputHash(CLEAN_PAYEE), matched: false, matchScore: 0, unscreened: true },
      { role: 'sender', inputHash: inputHash(CLEAN_SENDER), matched: false, matchScore: 0, unscreened: true },
    ]);
  });

  it('a partial-set block (MHA missing, recipient an exact SDN entry): lists shows which lists answered; the sender who was not screened is marked, the evidence keeps the not-checked fields', async () => {
    primeListSet({ missing: ['in-mha-uapa'] });
    const r = await screen({ destinationCountry: 'IN', recipientName: LIST_SET_NAMES['ofac-sdn'] });
    expect(r.status).toBe('blocked');
    const e = r.evidence!;
    expect(e).toMatchObject({ decision: 'match', listSource: COMPOSITE_IN, listVersion: 'unavailable', listHash: '', listFitness: 'not_live' });
    expect('listCheckedAt' in e).toBe(false);
    expect(e.lists!.find((l) => l.source === 'in-mha-uapa')).toEqual({ source: 'in-mha-uapa', version: 'unavailable', hash: '', fitness: 'not_live' });
    for (const l of e.lists!.filter((x) => x.source !== 'in-mha-uapa')) {
      expect(l.fitness).toBe('live');
      expectServedHash(l.source, l.hash);
    }
    expect(e.parties).toEqual([
      { role: 'recipient', inputHash: inputHash(LIST_SET_NAMES['ofac-sdn']), matched: true, matchScore: 1, matchedEntryId: 'sdn:1003' },
      { role: 'sender', inputHash: inputHash(CLEAN_SENDER), matched: false, matchScore: 0, unscreened: true },
    ]);
  });

  it("a match on un-sc blocks with matchedEntryId 'unsc:1' and RECIPIENT_WATCHLIST; no name and no list entry text in the evidence JSON", async () => {
    primeListSet({});
    const name = LIST_SET_NAMES['un-sc'];
    const r = await screen({ destinationCountry: 'IN', recipientName: name });
    expect(r.status).toBe('blocked');
    expect(r.reasons).toEqual([RECIPIENT_WATCHLIST_REASON]);
    expect(r.evidence!.parties[0]).toMatchObject({ matched: true, matchedEntryId: 'unsc:1' });
    expect(r.evidence!.lists!.map((l) => l.fitness)).toEqual(['live', 'live', 'live', 'live']);
    const raw = JSON.stringify(r.evidence);
    for (const n of [...Object.values(LIST_SET_NAMES), CLEAN_SENDER]) expect(raw).not.toContain(n);
    expect(raw).not.toContain('unscreened');
  });

  it('GA2: a member that rejects on the recipient screen and loads again for the sender -> list_unavailable keeps the not-checked identity (never the composite read after the screens)', async () => {
    primeListSet({});
    const mha = listSetList('in-mha-uapa');
    let calls = 0;
    setListSourceForTests('in-mha-uapa', {
      load: async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        return mha;
      },
      warm: async () => {},
      checkedAt: () => new Date(Date.now() - 3_600_000),
    });
    const r = await screen({ destinationCountry: 'IN' });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(r.status).toBe('flagged');
    expect(r.reasons).toEqual([LIST_UNAVAILABLE_REASON]);
    const e = r.evidence!;
    expect(e).toMatchObject({ decision: 'list_unavailable', listSource: COMPOSITE_IN, listVersion: 'unavailable', listHash: '', listFitness: 'not_live' });
    expect('listCheckedAt' in e).toBe(false);
    expect('listBaseHash' in e).toBe(false);
    expect(e.lists!.find((l) => l.source === 'in-mha-uapa')).toEqual({ source: 'in-mha-uapa', version: 'unavailable', hash: '', fitness: 'not_live' });
  });

  it('an explicit input.screener that is not multi: fitness via listFitness, no lists key', async () => {
    primeListSet({});
    const r = await screen({ destinationCountry: 'IN', screener: new MockSanctionsScreener([]) });
    expect(r.evidence!.listFitness).toBe('not_live');
    expect('lists' in r.evidence!).toBe(false);
    expect(r.evidence!.parties.some((p) => 'unscreened' in p)).toBe(false);
  });
});
