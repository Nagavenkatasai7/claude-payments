import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  screenTransfer,
  LIST_UNAVAILABLE_REASON,
  RECIPIENT_WATCHLIST_REASON,
  SENDER_WATCHLIST_REASON,
} from '@/lib/compliance';
import { screenPayee } from '@/lib/payees';
import { inputHash, type ScreeningEvidence } from '@/lib/sanctions/evidence';
import { ListSanctionsScreener } from '@/lib/sanctions/list-screener';
import { MultiListSanctionsScreener } from '@/lib/sanctions/multi-list-screener';
import type { SanctionsList, SanctionsListSource } from '@/lib/sanctions/list-source';
import { LIST_SET_NAMES, primeListSet, restoreOfacSource } from './helpers-sanctions';

// LA1 (pack 5 list review round 1): under the opt-in SANCTIONS_LIST=lists, an
// exact match on any member blocks, whatever the other members did. Here the
// India MHA list has no active version (not uploaded yet) while the recipient
// (or sender) is an exact OFAC SDN entry: the screen must block, never hold the
// row as LIST_UNAVAILABLE (a hold a person can reject and refund). Everything
// else on the partial set still fails closed. Invented names only.

const SDN_NAME = LIST_SET_NAMES['ofac-sdn']; // sdn:1003 in the sample fixture
const COMPOSITE = 'lists:ofac-sdn+ofac-cons+un-sc+in-mha-uapa';

describe('screenTransfer under SANCTIONS_LIST=lists with in-mha-uapa unloaded (LA1)', () => {
  const original = process.env.SANCTIONS_LIST;
  afterEach(() => restoreOfacSource(original));

  it('an exact ofac-sdn recipient -> blocked with the recipient watchlist reason and truthful evidence', async () => {
    primeListSet({ missing: ['in-mha-uapa'] });
    const r = await screenTransfer({ amountUsd: 100, recipientName: SDN_NAME, transfersToday: 0 });
    expect(r.status).toBe('blocked');
    expect(r.reasons).toEqual([RECIPIENT_WATCHLIST_REASON]);
    expect(r.evidence).toMatchObject({ decision: 'match', listSource: COMPOSITE });
    expect(r.evidence!.parties).toEqual([
      { role: 'recipient', inputHash: inputHash(SDN_NAME), matched: true, matchScore: 1, matchedEntryId: 'sdn:1003' },
    ]);
    // The set was NOT fully checked, and the evidence says so: no set version,
    // no set hash, no check time, never live.
    expect(r.evidence!.listVersion).toBe('unavailable');
    expect(r.evidence!.listHash).toBe('');
    expect(r.evidence!.listFitness).toBe('not_live');
    expect('listCheckedAt' in r.evidence!).toBe(false);
  });

  it('with a clear sender name the recipient match still blocks; the sender is recorded as unscreened', async () => {
    primeListSet({ missing: ['in-mha-uapa'] });
    const r = await screenTransfer({ amountUsd: 100, recipientName: SDN_NAME, senderName: 'Plain Invented Sender', transfersToday: 0, requireLiveList: true });
    expect(r.status).toBe('blocked');
    expect(r.reasons).toEqual([RECIPIENT_WATCHLIST_REASON]);
    expect(r.evidence!.parties).toEqual([
      { role: 'recipient', inputHash: inputHash(SDN_NAME), matched: true, matchScore: 1, matchedEntryId: 'sdn:1003' },
      { role: 'sender', inputHash: inputHash('Plain Invented Sender'), matched: false, matchScore: 0 },
    ]);
  });

  it('an exact sender with a clear recipient -> blocked with the sender watchlist reason', async () => {
    primeListSet({ missing: ['in-mha-uapa'] });
    const r = await screenTransfer({ amountUsd: 100, recipientName: 'Plain Invented Payee', senderName: SDN_NAME, transfersToday: 0 });
    expect(r.status).toBe('blocked');
    expect(r.reasons).toEqual([SENDER_WATCHLIST_REASON]);
    expect(r.evidence!.decision).toBe('match');
  });

  it('an exact further recipient name (alsoRecipientNames) -> blocked with the recipient watchlist reason', async () => {
    primeListSet({ missing: ['in-mha-uapa'] });
    const r = await screenTransfer({ amountUsd: 100, recipientName: 'Plain Invented Payee', alsoRecipientNames: [SDN_NAME], transfersToday: 0 });
    expect(r.status).toBe('blocked');
    expect(r.reasons).toEqual([RECIPIENT_WATCHLIST_REASON]);
  });

  it('an exact extras (WATCHLIST) recipient -> blocked', async () => {
    primeListSet({ missing: ['in-mha-uapa'] });
    const r = await screenTransfer({ amountUsd: 100, recipientName: 'John Doe', transfersToday: 0 });
    expect(r.status).toBe('blocked');
    expect(r.evidence!.parties[0]).toMatchObject({ matched: true, matchedEntryId: 'extra:0' });
  });

  it('no exact match on the partial set -> still the LIST_UNAVAILABLE hold, every party unscreened', async () => {
    primeListSet({ missing: ['in-mha-uapa'] });
    const r = await screenTransfer({ amountUsd: 100, recipientName: 'Plain Invented Payee', senderName: 'Plain Invented Sender', transfersToday: 0 });
    expect(r.status).toBe('flagged');
    expect(r.reasons).toEqual([LIST_UNAVAILABLE_REASON]);
    expect(r.evidence).toMatchObject({ decision: 'list_unavailable', listSource: COMPOSITE, listHash: '', listFitness: 'not_live' });
    expect(r.evidence!.parties.map((p) => [p.role, p.matched, p.matchScore])).toEqual([['recipient', false, 0], ['sender', false, 0]]);
  });

  it('screenPayee: an exact SDN legal name -> verdict match (not review) while MHA is unloaded', async () => {
    primeListSet({ missing: ['in-mha-uapa'] });
    const r = await screenPayee({ legalName: SDN_NAME, accountHolder: 'Plain Invented Holder' });
    expect(r.verdict).toBe('match');
    expect(r.listUnavailable).toBe(false);
  });
});

// LF1-D1 (list review L1): a partial-set block must say the set was not
// checked even when the failing member loads again before the screen ends.
// The composite listInfo read AFTER every party is screened would otherwise
// show the full set's version, hash and check time for a party that was
// never screened. Invented names only.
describe('screenTransfer: a member that recovers mid-screen (LF1-D1)', () => {
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
  const mk = (source: 'ofac-sdn' | 'ofac-cons', id: string, names: string[]): SanctionsList => ({
    source,
    version: 'v1',
    hash: sha(`${source}:${names.join('|')}`),
    entries: names.map((n, i) => ({ id: `${id}:${i + 1}`, type: 'Individual', programs: ['TEST'], names: [n] })),
  });
  const SDN_LIST = mk('ofac-sdn', 'sdn', ['Zorvan Quillet']);
  const CONS_LIST = mk('ofac-cons', 'cons', ['Marlowe Tessaract']);
  const at = new Date(Date.now() - 3_600_000);
  /** A source whose first `fails` loads reject and every later one succeeds. */
  const flaky = (l: SanctionsList, fails: number): SanctionsListSource => {
    let n = 0;
    return {
      load: async () => {
        n += 1;
        if (n <= fails) throw new Error('transient');
        return l;
      },
      checkedAt: () => at,
    };
  };
  const steady = (l: SanctionsList): SanctionsListSource => ({ load: async () => l, checkedAt: () => at });
  const multi = (cons: SanctionsListSource) =>
    new MultiListSanctionsScreener([
      { source: 'ofac-sdn', screener: new ListSanctionsScreener(steady(SDN_LIST), { sourceName: 'ofac-sdn' }) },
      { source: 'ofac-cons', screener: new ListSanctionsScreener(cons, { sourceName: 'ofac-cons' }) },
    ]);
  const notChecked = (e: ScreeningEvidence | undefined) => {
    expect(e!.listSource).toBe('lists:ofac-sdn+ofac-cons');
    expect(e!.listVersion).toBe('unavailable');
    expect(e!.listHash).toBe('');
    expect(e!.listFitness).toBe('not_live');
    expect('listCheckedAt' in e!).toBe(false);
    expect('listBaseHash' in e!).toBe(false);
  };

  it('the recipient screen failed closed, the member recovers, the sender is an exact SDN entry -> blocked, evidence says not checked', async () => {
    const m = multi(flaky(CONS_LIST, 1));
    const r = await screenTransfer({ amountUsd: 100, recipientName: 'Plain Payee', senderName: 'Zorvan Quillet', transfersToday: 0, screener: m });
    expect(r.status).toBe('blocked');
    expect(r.reasons).toEqual([SENDER_WATCHLIST_REASON]);
    // The member did load again before listInfo was read: the full identity is there.
    expect(m.listInfo().hash).toMatch(/^[0-9a-f]{64}$/);
    notChecked(r.evidence);
    expect(r.evidence!.parties).toEqual([
      { role: 'recipient', inputHash: inputHash('Plain Payee'), matched: false, matchScore: 0 },
      { role: 'sender', inputHash: inputHash('Zorvan Quillet'), matched: true, matchScore: 1, matchedEntryId: 'sdn:1' },
    ]);
  });

  it('the exact match itself came from a partial set, the member recovers for the next party -> evidence says not checked', async () => {
    const m = multi(flaky(CONS_LIST, 1));
    const r = await screenTransfer({ amountUsd: 100, recipientName: 'Zorvan Quillet', senderName: 'Plain Sender', transfersToday: 0, screener: m });
    expect(r.status).toBe('blocked');
    expect(r.reasons).toEqual([RECIPIENT_WATCHLIST_REASON]);
    notChecked(r.evidence);
  });

  it('a full set (no member failed) keeps the composite version, hash and check time', async () => {
    const m = multi(steady(CONS_LIST));
    const r = await screenTransfer({ amountUsd: 100, recipientName: 'Zorvan Quillet', transfersToday: 0, screener: m });
    expect(r.status).toBe('blocked');
    expect(r.evidence!.listVersion).toBe('v1+v1');
    expect(r.evidence!.listHash).toBe(m.listInfo().hash);
    expect(r.evidence!.listCheckedAt).toBe(at.toISOString());
  });
});
