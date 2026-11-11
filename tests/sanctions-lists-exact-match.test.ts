import { describe, it, expect, afterEach } from 'vitest';
import {
  screenTransfer,
  LIST_UNAVAILABLE_REASON,
  RECIPIENT_WATCHLIST_REASON,
  SENDER_WATCHLIST_REASON,
} from '@/lib/compliance';
import { screenPayee } from '@/lib/payees';
import { inputHash } from '@/lib/sanctions/evidence';
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
