import { describe, expect, it } from 'vitest';
import {
  AML_HOLD_REASON, LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON, POSSIBLE_MATCH_REASON,
  RECIPIENT_IDENTITY_MISSING_REASON, SENDER_SCREENING_REASON, type CustomerScreeningFlags,
} from '@/lib/compliance-config';
import {
  HOLD_CLASSES, QUEUE_STATES, classReasonsFp, classifyHold, holdQueueView,
  type ClassifyOwner, type HoldClass, type HoldDisposition, type QueueInputRow, type ReviewRowLite,
} from '@/lib/hold-queue';

// Fix pack 7 T17 (P15 queue half): the pure grouping of a queue partner's held
// rows by hold class and state. Relative times only.

const Q: ClassifyOwner = { queue: true, partnerDecidesKyc: true };
const H = 3_600_000;
const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const pep: CustomerScreeningFlags = { pepHit: true, watchlistHit: false, screeningFlaggedAt: ago(H), screeningWatchlistAt: null };

const row = (id: string, reasons: readonly unknown[], o: Partial<QueueInputRow> = {}): QueueInputRow => ({
  id, complianceReasons: reasons, complianceStatus: 'flagged', paidAt: ago(2 * H), createdAt: ago(3 * H), ...o,
});

/** A review row under the CURRENT fingerprint of the class as classified for `r`. */
function reviewOf(r: QueueInputRow, holdClass: HoldClass, o: { final: boolean; step?: 1 | 2; disposition?: HoldDisposition; fpOverride?: string; flags?: CustomerScreeningFlags | null }): ReviewRowLite {
  const c = classifyHold(r.complianceReasons, o.flags, Q).find((x) => x.holdClass === holdClass);
  if (!c) throw new Error(`no class ${holdClass}`);
  return {
    holdClass, reasonsFp: o.fpOverride ?? classReasonsFp(c, o.flags), step: o.step ?? 1, final: o.final,
    disposition: o.disposition ?? 'documents_verified', actor: 'co-a', actorScope: 'partner', createdAt: ago(H),
  };
}

const view = (
  rows: readonly QueueInputRow[],
  o: {
    reviews?: Map<string, ReviewRowLite[]>;
    flags?: Map<string, CustomerScreeningFlags | null>;
    owner?: ClassifyOwner;
    dataOnFile?: Map<string, boolean>;
  } = {},
) => holdQueueView(rows, o.reviews ?? new Map(), o.flags ?? new Map(), o.owner ?? Q, o.dataOnFile ?? new Map(), NOW);

const shape = (g: ReturnType<typeof view>) => g.map((x) => ({ holdClass: x.holdClass, state: x.state, ids: x.rows.map((r) => r.transferId) }));

describe('holdQueueView (P15, T17)', () => {
  it('QUEUE_STATES is the P15 priority order', () => {
    expect([...QUEUE_STATES]).toEqual(['waits_list', 'waits_data', 'awaiting_second', 'awaiting_first', 'waits_smartremit']);
  });

  it('1. kyc row, queue owner, no reviews -> one group { kyc, awaiting_first }', () => {
    const g = view([row('t1', [LARGE_AMOUNT_REASON])]);
    expect(shape(g)).toEqual([{ holdClass: 'kyc', state: 'awaiting_first', ids: ['t1'] }]);
    expect(g[0].rows[0]).toEqual({ transferId: 't1', holdClass: 'kyc', state: 'awaiting_first', heldSince: ago(2 * H), ageHours: 2 });
  });

  it('2. kyc row with a non-final step-1 row under the current fp -> awaiting_second', () => {
    const r = row('t1', [LARGE_AMOUNT_REASON]);
    const reviews = new Map([['t1', [reviewOf(r, 'kyc', { final: false })]]]);
    expect(shape(view([r], { reviews }))).toEqual([{ holdClass: 'kyc', state: 'awaiting_second', ids: ['t1'] }]);
  });

  it('2b. the same row under an OLD fp (reasons changed) -> awaiting_first (a stale cycle does not count)', () => {
    const r = row('t1', [LARGE_AMOUNT_REASON]);
    const reviews = new Map([['t1', [reviewOf(r, 'kyc', { final: false, fpOverride: 'v1|kyc|Some older reason.' })]]]);
    expect(shape(view([r], { reviews }))).toEqual([{ holdClass: 'kyc', state: 'awaiting_first', ids: ['t1'] }]);
  });

  it('3. kyc + sanctions_review: the kyc class is partner -> awaiting_first wins over waits_smartremit', () => {
    const r = row('t1', [LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]);
    expect(shape(view([r]))).toEqual([{ holdClass: 'kyc', state: 'awaiting_first', ids: ['t1'] }]);
  });

  it('3b. kyc finalised + sanctions_review open -> { sanctions_review, waits_smartremit }', () => {
    const r = row('t1', [LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]);
    const reviews = new Map([['t1', [reviewOf(r, 'kyc', { final: true })]]]);
    expect(shape(view([r], { reviews }))).toEqual([{ holdClass: 'sanctions_review', state: 'waits_smartremit', ids: ['t1'] }]);
  });

  it('4. LIST_UNAVAILABLE with kyc -> { list_wait, waits_list }', () => {
    expect(shape(view([row('t1', [LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON])]))).toEqual([
      { holdClass: 'list_wait', state: 'waits_list', ids: ['t1'] },
    ]);
  });

  it('4b. RECIPIENT_IDENTITY_MISSING with kyc -> { data_missing, waits_data }', () => {
    expect(shape(view([row('t1', [LARGE_AMOUNT_REASON, RECIPIENT_IDENTITY_MISSING_REASON])]))).toEqual([
      { holdClass: 'data_missing', state: 'waits_data', ids: ['t1'] },
    ]);
  });

  it('5. SENDER_SCREENING with no flags entry -> sender_watchlist, waits_smartremit (fail closed)', () => {
    expect(shape(view([row('t1', [SENDER_SCREENING_REASON])]))).toEqual([
      { holdClass: 'sender_watchlist', state: 'waits_smartremit', ids: ['t1'] },
    ]);
  });

  it('5b. SENDER_SCREENING with pepHit flags and partnerDecidesKyc -> sender_pep, awaiting_first', () => {
    const flags = new Map([['t1', pep]]);
    expect(shape(view([row('t1', [SENDER_SCREENING_REASON])], { flags }))).toEqual([
      { holdClass: 'sender_pep', state: 'awaiting_first', ids: ['t1'] },
    ]);
    // Without partnerDecidesKyc the PEP class is SmartRemit's (DP3).
    expect(shape(view([row('t1', [SENDER_SCREENING_REASON])], { flags, owner: { queue: true, partnerDecidesKyc: false } }))).toEqual([
      { holdClass: 'sender_pep', state: 'waits_smartremit', ids: ['t1'] },
    ]);
  });

  it('5c. a sender_pep step 1 under the current fp (with its flag time) -> awaiting_second', () => {
    const r = row('t1', [SENDER_SCREENING_REASON]);
    const reviews = new Map([['t1', [reviewOf(r, 'sender_pep', { final: false, flags: pep, disposition: 'pep_accepted_with_edd' })]]]);
    expect(shape(view([r], { reviews, flags: new Map([['t1', pep]]) }))).toEqual([
      { holdClass: 'sender_pep', state: 'awaiting_second', ids: ['t1'] },
    ]);
  });

  it('6. blocked row -> waits_smartremit (a partner class of a blocked row is not the partner\'s to decide, P5 rule 2)', () => {
    expect(shape(view([row('t1', [LARGE_AMOUNT_REASON], { complianceStatus: 'blocked' })]))).toEqual([
      { holdClass: 'kyc', state: 'waits_smartremit', ids: ['t1'] },
    ]);
    // A blocked row with no partner class: the blocked class is nobody-decided -> SmartRemit.
    expect(shape(view([row('t2', [POSSIBLE_MATCH_REASON], { complianceStatus: 'blocked' })]))).toEqual([
      { holdClass: 'sanctions_review', state: 'waits_smartremit', ids: ['t2'] },
    ]);
  });

  it('6b. every class finalised -> waits_smartremit with the first class', () => {
    const r = row('t1', [LARGE_AMOUNT_REASON, AML_HOLD_REASON]);
    const reviews = new Map([['t1', [
      reviewOf(r, 'kyc', { final: true }),
      reviewOf(r, 'aml', { final: true, disposition: 'false_positive' }),
    ]]]);
    expect(shape(view([r], { reviews }))).toEqual([{ holdClass: 'kyc', state: 'waits_smartremit', ids: ['t1'] }]);
  });

  it('7. ordering: groups in HOLD_CLASSES then QUEUE_STATES order; rows oldest first by paidAt ?? createdAt; ties by id', () => {
    const rows = [
      row('b2', [AML_HOLD_REASON], { paidAt: ago(5 * H) }),
      row('a9', [LARGE_AMOUNT_REASON], { paidAt: undefined, createdAt: ago(10 * H) }),
      row('a2', [LARGE_AMOUNT_REASON], { paidAt: ago(20 * H) }),
      row('a1', [LARGE_AMOUNT_REASON], { paidAt: ago(10 * H) }),
      row('k2', [LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON], { paidAt: ago(H) }),
      row('s1', [POSSIBLE_MATCH_REASON], { paidAt: ago(H) }),
    ];
    const g = view(rows);
    expect(shape(g)).toEqual([
      { holdClass: 'kyc', state: 'awaiting_first', ids: ['a2', 'a1', 'a9'] },
      { holdClass: 'aml', state: 'awaiting_first', ids: ['b2'] },
      { holdClass: 'sanctions_review', state: 'waits_smartremit', ids: ['s1'] },
      { holdClass: 'list_wait', state: 'waits_list', ids: ['k2'] },
    ]);
    const order = g.map((x) => [HOLD_CLASSES.indexOf(x.holdClass), QUEUE_STATES.indexOf(x.state)]);
    expect(order).toEqual([...order].sort((p, q) => p[0] - q[0] || p[1] - q[1]));
    expect(g[0].rows.find((r) => r.transferId === 'a9')?.heldSince).toBe(ago(10 * H));
  });

  it('7a. the same class in two states: QUEUE_STATES order inside the class', () => {
    const r1 = row('t1', [LARGE_AMOUNT_REASON]);
    const r2 = row('t2', [LARGE_AMOUNT_REASON]);
    const reviews = new Map([['t2', [reviewOf(r2, 'kyc', { final: false })]]]);
    expect(shape(view([r1, r2], { reviews }))).toEqual([
      { holdClass: 'kyc', state: 'awaiting_second', ids: ['t2'] },
      { holdClass: 'kyc', state: 'awaiting_first', ids: ['t1'] },
    ]);
  });

  it('7b. ageHours floors; a future date -> 0; a bad date -> 0', () => {
    const g = view([
      row('t1', [LARGE_AMOUNT_REASON], { paidAt: ago(3 * H - 1) }),
      row('t2', [LARGE_AMOUNT_REASON], { paidAt: ago(-5 * H) }),
      row('t3', [LARGE_AMOUNT_REASON], { paidAt: 'not a date' }),
    ]);
    const age = Object.fromEntries(g.flatMap((x) => x.rows).map((r) => [r.transferId, r.ageHours]));
    expect(age).toEqual({ t1: 2, t2: 0, t3: 0 });
  });

  it('7c. ties by transferId', () => {
    const at = ago(4 * H);
    const g = view([row('t3', [LARGE_AMOUNT_REASON], { paidAt: at }), row('t1', [LARGE_AMOUNT_REASON], { paidAt: at })]);
    expect(shape(g)).toEqual([{ holdClass: 'kyc', state: 'awaiting_first', ids: ['t1', 't3'] }]);
  });

  it('8. the input arrays are not mutated (frozen inputs)', () => {
    const r1 = Object.freeze(row('t2', Object.freeze([LARGE_AMOUNT_REASON])));
    const r2 = Object.freeze(row('t1', Object.freeze([AML_HOLD_REASON])));
    const rows = Object.freeze([r1, r2]);
    const rev = Object.freeze([Object.freeze(reviewOf(r1, 'kyc', { final: false }))]);
    expect(() => holdQueueView(rows, new Map([['t2', rev]]), new Map(), Q, new Map(), NOW)).not.toThrow();
    expect(rows.map((r) => r.id)).toEqual(['t2', 't1']);
  });

  it('8b. RECIPIENT_IDENTITY_MISSING with dataOnFile true -> { data_missing, waits_smartremit } (P4: platform decides it)', () => {
    const r = row('t1', [RECIPIENT_IDENTITY_MISSING_REASON]);
    expect(shape(view([r], { dataOnFile: new Map([['t1', true]]) }))).toEqual([
      { holdClass: 'data_missing', state: 'waits_smartremit', ids: ['t1'] },
    ]);
    // An id missing from dataOnFile reads false.
    expect(shape(view([r], { dataOnFile: new Map([['other', true]]) }))).toEqual([
      { holdClass: 'data_missing', state: 'waits_data', ids: ['t1'] },
    ]);
  });

  it('8c. pepHit flags on a row with NO SENDER_SCREENING_REASON -> synthetic sender_pep class, awaiting_first (R1)', () => {
    const r = row('t1', [POSSIBLE_MATCH_REASON]);
    expect(shape(view([r], { flags: new Map([['t1', pep]]) }))).toEqual([
      { holdClass: 'sender_pep', state: 'awaiting_first', ids: ['t1'] },
    ]);
  });

  it('8d. flags read but failed (null) on a row with no sender reason -> synthetic sender_watchlist, SmartRemit (fail closed)', () => {
    const r = row('t1', [POSSIBLE_MATCH_REASON]);
    expect(shape(view([r], { flags: new Map([['t1', null]]) }))).toEqual([
      { holdClass: 'sanctions_review', state: 'waits_smartremit', ids: ['t1'] },
    ]);
  });
});
