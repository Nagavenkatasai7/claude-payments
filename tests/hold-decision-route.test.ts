import { describe, expect, it } from 'vitest';
import {
  AML_HOLD_REASON, LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON, POSSIBLE_MATCH_REASON,
  RECIPIENT_IDENTITY_MISSING_REASON, RECIPIENT_WATCHLIST_REASON, SENDER_SCREENING_REASON,
  type CustomerScreeningFlags,
} from '@/lib/compliance-config';
import {
  HOLD_CLASSES, HOLD_DISPOSITIONS, allowedDispositions, classReasonsFp, classifyHold, decisionRoute,
  dispositionReleases, isHoldDisposition, nextStep, toReviewRowLite,
  type ClassifiedClass, type ClassifyOwner, type HoldClass, type HoldDisposition, type HoldScope, type ReviewRowLite,
} from '@/lib/hold-queue';

// Fix pack 7 T6 (P5 rules 1-9, DP4, DP12/M11): the pure decision rules. No
// I/O; relative times only.

const Q: ClassifyOwner = { queue: true, partnerDecidesKyc: true };
const N: ClassifyOwner = { queue: false, partnerDecidesKyc: false };

const KYC = [LARGE_AMOUNT_REASON];
const SANC = [POSSIBLE_MATCH_REASON];
const LIST = [LIST_UNAVAILABLE_REASON];
const DATA = [RECIPIENT_IDENTITY_MISSING_REASON];
const BLOCK = [RECIPIENT_WATCHLIST_REASON];

const cls = (reasons: readonly string[], owner = Q, opts?: { blocked?: boolean; dataOnFile?: boolean }) =>
  classifyHold(reasons, undefined, owner, opts);
const of = (classes: readonly ClassifiedClass[], h: HoldClass) => {
  const c = classes.find((x) => x.holdClass === h);
  if (!c) throw new Error(`no ${h}`);
  return c;
};

let seq = 0;
function row(classes: readonly ClassifiedClass[], o: Partial<ReviewRowLite> & { holdClass: HoldClass }): ReviewRowLite {
  seq += 1;
  const c = classes.find((x) => x.holdClass === o.holdClass);
  return {
    reasonsFp: c ? classReasonsFp(c) : `v1|${o.holdClass}|`,
    step: 1,
    final: true,
    disposition: 'documents_verified',
    actor: 'a',
    actorScope: 'partner',
    createdAt: new Date(Date.now() - 60_000 + seq).toISOString(),
    ...o,
  };
}

function route(o: {
  classes: readonly ClassifiedClass[];
  reviews?: readonly ReviewRowLite[];
  scope: HoldScope;
  holdClass: HoldClass;
  disposition: HoldDisposition;
  actor?: string;
  fourEyes?: boolean;
  flags?: CustomerScreeningFlags | null;
}) {
  return decisionRoute({ reviews: [], actor: 'a', fourEyes: false, ...o });
}
const refused = (why: string) => ({ kind: 'refused', why });

describe('dispositions (P5 lists)', () => {
  it('HOLD_DISPOSITIONS is the frozen 14-tuple of P5', () => {
    expect(Object.isFrozen(HOLD_DISPOSITIONS)).toBe(true);
    expect([...HOLD_DISPOSITIONS]).toEqual([
      'documents_verified', 'activity_explained', 'customer_not_verified', 'activity_unexplained', 'false_positive',
      'suspicious_activity', 'scam_suspected', 'pep_accepted_with_edd', 'pep_rejected', 'false_positive_match',
      'confirmed_match', 'unable_to_clear', 'data_received', 'data_not_provided',
    ]);
    for (const d of HOLD_DISPOSITIONS) expect(isHoldDisposition(d)).toBe(true);
    for (const v of ['', 'release', 'DOCUMENTS_VERIFIED', '__proto__', 1, null, undefined]) expect(isHoldDisposition(v)).toBe(false);
  });

  it('allowedDispositions follows the P5 table', () => {
    const both = {
      kyc: { release: ['documents_verified', 'activity_explained'], reject: ['customer_not_verified', 'activity_unexplained'] },
      aml: { release: ['false_positive', 'activity_explained'], reject: ['suspicious_activity', 'scam_suspected'] },
      sender_pep: { release: ['pep_accepted_with_edd', 'false_positive'], reject: ['pep_rejected'] },
    } as const;
    const sanctions = { release: ['false_positive_match'], reject: ['confirmed_match', 'unable_to_clear'] };
    const none = { release: [], reject: [] };
    const want: Record<HoldClass, { partner: unknown; platform: unknown }> = {
      kyc: { partner: both.kyc, platform: both.kyc },
      aml: { partner: both.aml, platform: both.aml },
      sender_pep: { partner: both.sender_pep, platform: both.sender_pep },
      sanctions_review: { partner: none, platform: sanctions },
      sender_watchlist: { partner: none, platform: sanctions },
      unknown: { partner: none, platform: sanctions },
      data_missing: { partner: none, platform: { release: ['data_received'], reject: ['data_not_provided'] } },
      blocked: { partner: none, platform: { release: [], reject: ['confirmed_match'] } },
      list_wait: { partner: none, platform: { release: [], reject: ['unable_to_clear'] } },
    };
    for (const h of HOLD_CLASSES) {
      for (const s of ['partner', 'platform'] as const) {
        const got = allowedDispositions(h, s);
        expect({ release: [...got.release], reject: [...got.reject] }, `${h}/${s}`).toEqual(want[h][s]);
        expect(Object.isFrozen(got.release) && Object.isFrozen(got.reject), `${h}/${s} frozen`).toBe(true);
        for (const d of got.release) expect(dispositionReleases(d), d).toBe(true);
        for (const d of got.reject) expect(dispositionReleases(d), d).toBe(false);
      }
    }
  });

  it('dispositionReleases is true exactly for documents_verified, activity_explained, false_positive, pep_accepted_with_edd, false_positive_match, data_received', () => {
    expect(HOLD_DISPOSITIONS.filter((d) => dispositionReleases(d))).toEqual([
      'documents_verified', 'activity_explained', 'false_positive', 'pep_accepted_with_edd', 'false_positive_match', 'data_received',
    ]);
  });
});

describe('nextStep (P5 rule 8)', () => {
  const k = cls(KYC);
  const r = (o: Partial<ReviewRowLite>) => row(k, { holdClass: 'kyc', ...o });
  it('an empty cycle: one final step without four-eyes; with four-eyes a release is step 1 open, a reject step 1 final', () => {
    expect(nextStep([], 'a', 'documents_verified', false)).toEqual({ step: 1, final: true });
    expect(nextStep([], 'a', 'documents_verified', true)).toEqual({ step: 1, final: false });
    expect(nextStep([], 'a', 'customer_not_verified', true)).toEqual({ step: 1, final: true });
  });
  it('an open step 1 by A: B gets step 2 final (release or reject); A gets same_actor', () => {
    const cycle = [r({ step: 1, final: false, actor: 'A' })];
    expect(nextStep(cycle, 'B', 'documents_verified', true)).toEqual({ step: 2, final: true });
    expect(nextStep(cycle, 'B', 'customer_not_verified', true)).toEqual({ step: 2, final: true });
    expect(nextStep(cycle, 'A', 'documents_verified', true)).toEqual({ refused: 'same_actor' });
  });
  it('any final row in the cycle -> closed', () => {
    expect(nextStep([r({ step: 1, final: true })], 'B', 'documents_verified', false)).toEqual({ refused: 'closed' });
    expect(nextStep([r({ step: 1, final: false, actor: 'A' }), r({ step: 2, final: true, actor: 'B' })], 'C', 'documents_verified', true))
      .toEqual({ refused: 'closed' });
  });
  it('an open step 1 still needs step 2 when fourEyes is now false', () => {
    expect(nextStep([r({ step: 1, final: false, actor: 'A' })], 'B', 'documents_verified', false)).toEqual({ step: 2, final: true });
  });
  it('a step 1 by a since-removed user still counts (known limit, owner question 10)', () => {
    // nextStep takes no user list: A's step 1 was given by a user qualified at
    // its decision time (P5 rule 9, R8), so B's step 2 closes the cycle.
    expect(nextStep([r({ step: 1, final: false, actor: 'removed-user' })], 'B', 'documents_verified', true)).toEqual({ step: 2, final: true });
  });
});

describe('decisionRoute (P5 check order)', () => {
  it('rule 3: list_wait present: every partner decision and every platform release -> waits_list; a PLATFORM reject -> reject (M11, DP12)', () => {
    const q = cls([...KYC, ...LIST]);
    expect(route({ classes: q, scope: 'partner', holdClass: 'kyc', disposition: 'documents_verified' })).toEqual(refused('waits_list'));
    expect(route({ classes: q, scope: 'partner', holdClass: 'kyc', disposition: 'customer_not_verified' })).toEqual(refused('waits_list'));
    const n = cls([...SANC, ...LIST]);
    expect(route({ classes: n, scope: 'platform', holdClass: 'sanctions_review', disposition: 'false_positive_match' })).toEqual(refused('waits_list'));
    expect(route({ classes: n, scope: 'platform', holdClass: 'list_wait', disposition: 'unable_to_clear' })).toEqual({ kind: 'reject' });
    expect(route({ classes: n, scope: 'platform', holdClass: 'sanctions_review', disposition: 'confirmed_match' })).toEqual({ kind: 'reject' });
  });

  it('posted class absent from the row -> changed', () => {
    expect(route({ classes: cls(KYC), scope: 'partner', holdClass: 'aml', disposition: 'false_positive' })).toEqual(refused('changed'));
  });

  it('rule 1: each class by its own decider', () => {
    expect(route({ classes: cls(SANC), scope: 'partner', holdClass: 'sanctions_review', disposition: 'false_positive_match' })).toEqual(refused('not_yours'));
    expect(route({ classes: cls(KYC), scope: 'platform', holdClass: 'kyc', disposition: 'documents_verified' })).toEqual(refused('not_yours'));
    expect(route({ classes: cls(KYC, N), scope: 'platform', holdClass: 'kyc', disposition: 'documents_verified' })).toEqual({ kind: 'release' });
    expect(route({ classes: cls(KYC, N), scope: 'partner', holdClass: 'kyc', disposition: 'documents_verified' })).toEqual(refused('not_yours'));
  });

  it('disposition outside allowedDispositions(class, scope) -> disposition', () => {
    expect(route({ classes: cls(KYC), scope: 'partner', holdClass: 'kyc', disposition: 'false_positive_match' })).toEqual(refused('disposition'));
    expect(route({ classes: cls(KYC), scope: 'partner', holdClass: 'kyc', disposition: 'confirmed_match' })).toEqual(refused('disposition'));
    expect(route({ classes: cls(SANC), scope: 'platform', holdClass: 'sanctions_review', disposition: 'documents_verified' })).toEqual(refused('disposition'));
  });

  it('rule 2: on a blocked row every partner decision and every platform release -> blocked; a platform reject -> reject', () => {
    const q = cls([...KYC, ...BLOCK]);
    expect(route({ classes: q, scope: 'partner', holdClass: 'kyc', disposition: 'documents_verified' })).toEqual(refused('blocked'));
    expect(route({ classes: q, scope: 'partner', holdClass: 'kyc', disposition: 'customer_not_verified' })).toEqual(refused('blocked'));
    const n = cls([...KYC, ...BLOCK], N);
    expect(route({ classes: n, scope: 'platform', holdClass: 'kyc', disposition: 'documents_verified' })).toEqual(refused('blocked'));
    expect(route({ classes: n, scope: 'platform', holdClass: 'blocked', disposition: 'confirmed_match' })).toEqual({ kind: 'reject' });
    expect(route({ classes: n, scope: 'platform', holdClass: 'kyc', disposition: 'customer_not_verified' })).toEqual({ kind: 'reject' });
    // blocked via opts (complianceStatus 'blocked') reads the same.
    const b = cls(KYC, N, { blocked: true });
    expect(route({ classes: b, scope: 'platform', holdClass: 'kyc', disposition: 'documents_verified' })).toEqual(refused('blocked'));
    expect(route({ classes: b, scope: 'platform', holdClass: 'blocked', disposition: 'confirmed_match' })).toEqual({ kind: 'reject' });
  });

  describe('rule 4: data_missing (DP4, R11)', () => {
    it('data not on file (decider nobody): every release -> waits_data', () => {
      const q = cls([...KYC, ...SANC, ...DATA]);
      expect(of(q, 'data_missing').decider).toBe('nobody');
      expect(route({ classes: q, scope: 'partner', holdClass: 'kyc', disposition: 'documents_verified' })).toEqual(refused('waits_data'));
      expect(route({ classes: q, scope: 'platform', holdClass: 'sanctions_review', disposition: 'false_positive_match' })).toEqual(refused('waits_data'));
      expect(route({ classes: q, scope: 'platform', holdClass: 'data_missing', disposition: 'data_received' })).toEqual(refused('waits_data'));
    });
    it('data on file (decider platform): data_received releases when last open, else record; a partner kyc release records', () => {
      const q = cls([...KYC, ...DATA], Q, { dataOnFile: true });
      expect(of(q, 'data_missing').decider).toBe('platform');
      expect(route({ classes: q, scope: 'platform', holdClass: 'data_missing', disposition: 'data_received' })).toEqual({ kind: 'record' });
      expect(route({ classes: q, scope: 'partner', holdClass: 'kyc', disposition: 'documents_verified' })).toEqual({ kind: 'record' });
      const kycDone = [row(q, { holdClass: 'kyc', disposition: 'documents_verified' })];
      expect(route({ classes: q, reviews: kycDone, scope: 'platform', holdClass: 'data_missing', disposition: 'data_received' })).toEqual({ kind: 'release' });
      const only = cls(DATA, Q, { dataOnFile: true });
      expect(route({ classes: only, scope: 'platform', holdClass: 'data_missing', disposition: 'data_received' })).toEqual({ kind: 'release' });
    });
    it('a platform reject stays possible: data_not_provided, or the sanctions_review class with confirmed_match (DP4)', () => {
      const q = cls([...SANC, ...DATA]);
      expect(route({ classes: q, scope: 'platform', holdClass: 'data_missing', disposition: 'data_not_provided' })).toEqual({ kind: 'reject' });
      expect(route({ classes: q, scope: 'platform', holdClass: 'sanctions_review', disposition: 'confirmed_match' })).toEqual({ kind: 'reject' });
    });
  });

  it('rule 5: a partner reject waits while a platform- or nobody-decided class is present', () => {
    expect(route({ classes: cls([...KYC, ...SANC]), scope: 'partner', holdClass: 'kyc', disposition: 'customer_not_verified' })).toEqual(refused('waits_platform'));
    expect(route({ classes: cls([...KYC, 'Some legacy text.']), scope: 'partner', holdClass: 'kyc', disposition: 'customer_not_verified' })).toEqual(refused('waits_platform'));
    const pepPlatform = classifyHold([...KYC, SENDER_SCREENING_REASON], { pepHit: true, watchlistHit: false, screeningWatchlistAt: null }, { queue: true, partnerDecidesKyc: false });
    expect(of(pepPlatform, 'sender_pep').decider).toBe('platform');
    expect(route({ classes: pepPlatform, scope: 'partner', holdClass: 'kyc', disposition: 'customer_not_verified' })).toEqual(refused('waits_platform'));
    // a data_missing class (nobody) blocks a partner reject too
    expect(route({ classes: cls([...KYC, ...DATA]), scope: 'partner', holdClass: 'kyc', disposition: 'customer_not_verified' })).toEqual(refused('waits_platform'));
  });

  describe('rule 6: mixed rows release only in the decision that closes the last class', () => {
    const q = cls([...KYC, ...SANC]);
    it('partner kyc release, final, while sanctions_review has no review -> record', () => {
      expect(route({ classes: q, scope: 'partner', holdClass: 'kyc', disposition: 'documents_verified' })).toEqual({ kind: 'record' });
    });
    it('platform sanctions_review release after a final partner kyc release under the current fp -> release', () => {
      const reviews = [row(q, { holdClass: 'kyc' })];
      expect(route({ classes: q, reviews, scope: 'platform', holdClass: 'sanctions_review', disposition: 'false_positive_match', actor: 'p' })).toEqual({ kind: 'release' });
    });
    it('the same release after a kyc release under an OLD fp -> record (another cycle)', () => {
      const reviews = [row(q, { holdClass: 'kyc', reasonsFp: 'v1|kyc|old_reason' })];
      expect(route({ classes: q, reviews, scope: 'platform', holdClass: 'sanctions_review', disposition: 'false_positive_match', actor: 'p' })).toEqual({ kind: 'record' });
    });
    it('the same release after only a step-1 kyc row (fourEyes) -> record', () => {
      const reviews = [row(q, { holdClass: 'kyc', step: 1, final: false })];
      expect(route({ classes: q, reviews, scope: 'platform', holdClass: 'sanctions_review', disposition: 'false_positive_match', actor: 'p' })).toEqual({ kind: 'record' });
    });
    it('a final reject row on another class never counts as its release', () => {
      // A defensive read: the row would already be cancelled, so it is closed.
      const reviews = [row(q, { holdClass: 'kyc', disposition: 'customer_not_verified' })];
      expect(route({ classes: q, reviews, scope: 'platform', holdClass: 'sanctions_review', disposition: 'false_positive_match', actor: 'p' })).toEqual(refused('closed'));
    });
  });

  it('rule 7: a final reject by the class decider rejects even with other classes open', () => {
    expect(route({ classes: cls([...KYC, ...SANC]), scope: 'platform', holdClass: 'sanctions_review', disposition: 'confirmed_match' })).toEqual({ kind: 'reject' });
    expect(route({ classes: cls([...KYC, AML_HOLD_REASON]), scope: 'partner', holdClass: 'kyc', disposition: 'customer_not_verified' })).toEqual({ kind: 'reject' });
  });

  describe('rule 8: partner four-eyes', () => {
    const k = cls(KYC);
    it('no rows: a release records step 1 (not final)', () => {
      expect(route({ classes: k, scope: 'partner', holdClass: 'kyc', disposition: 'documents_verified', fourEyes: true })).toEqual({ kind: 'record' });
      expect(nextStep([], 'a', 'documents_verified', true)).toEqual({ step: 1, final: false });
    });
    const open = [row(k, { holdClass: 'kyc', step: 1, final: false, actor: 'A' })];
    it('the second person releases when kyc is the only class', () => {
      expect(route({ classes: k, reviews: open, scope: 'partner', holdClass: 'kyc', disposition: 'documents_verified', actor: 'B', fourEyes: true })).toEqual({ kind: 'release' });
      expect(route({ classes: k, reviews: open, scope: 'partner', holdClass: 'kyc', disposition: 'customer_not_verified', actor: 'B', fourEyes: true })).toEqual({ kind: 'reject' });
    });
    it('the same person a second time -> same_actor', () => {
      expect(route({ classes: k, reviews: open, scope: 'partner', holdClass: 'kyc', disposition: 'documents_verified', actor: 'A', fourEyes: true })).toEqual(refused('same_actor'));
    });
    it('a reject at step 1 -> reject', () => {
      expect(route({ classes: k, scope: 'partner', holdClass: 'kyc', disposition: 'activity_unexplained', fourEyes: true })).toEqual({ kind: 'reject' });
    });
    it('fourEyes on a platform decision is ignored: one final step', () => {
      expect(route({ classes: cls(KYC, N), scope: 'platform', holdClass: 'kyc', disposition: 'documents_verified', fourEyes: true })).toEqual({ kind: 'release' });
    });
  });

  it('a decision after the class\'s final row -> closed', () => {
    const k = cls([...KYC, ...SANC]);
    const reviews = [row(k, { holdClass: 'kyc' })];
    expect(route({ classes: k, reviews, scope: 'partner', holdClass: 'kyc', disposition: 'documents_verified', actor: 'b' })).toEqual(refused('closed'));
  });

  it('a class that already has a final reject under its current fp -> closed', () => {
    const k = cls([...KYC, AML_HOLD_REASON]);
    const reviews = [row(k, { holdClass: 'aml', disposition: 'suspicious_activity' })];
    expect(route({ classes: k, reviews, scope: 'partner', holdClass: 'kyc', disposition: 'documents_verified', actor: 'b' })).toEqual(refused('closed'));
    // under an old fp it is another cycle and does not close the sibling
    const old = [row(k, { holdClass: 'aml', disposition: 'suspicious_activity', reasonsFp: 'v1|aml|old' })];
    expect(route({ classes: k, reviews: old, scope: 'partner', holdClass: 'kyc', disposition: 'documents_verified', actor: 'b' })).toEqual({ kind: 'record' });
  });

  it('the sender classes match their cycle with the flag time (classReasonsFp |f=, R5)', () => {
    const flags: CustomerScreeningFlags = { pepHit: true, watchlistHit: false, screeningWatchlistAt: null, screeningFlaggedAt: new Date(Date.now() - 3_600_000).toISOString() };
    const c = classifyHold([...KYC, SENDER_SCREENING_REASON], flags, Q);
    const pepRow = row(c, { holdClass: 'sender_pep', disposition: 'pep_accepted_with_edd', reasonsFp: classReasonsFp(of(c, 'sender_pep'), flags) });
    expect(route({ classes: c, reviews: [pepRow], scope: 'partner', holdClass: 'kyc', disposition: 'documents_verified', actor: 'b', flags })).toEqual({ kind: 'release' });
    // a re-armed stamp (another flag time) opens a new cycle: the old row no longer counts
    const later = { ...flags, screeningFlaggedAt: new Date(Date.now() - 60_000).toISOString() };
    expect(route({ classes: c, reviews: [pepRow], scope: 'partner', holdClass: 'kyc', disposition: 'documents_verified', actor: 'b', flags: later })).toEqual({ kind: 'record' });
  });
});

describe('toReviewRowLite', () => {
  const base = {
    holdClass: 'kyc', reasonsFp: 'v1|kyc|x', step: 2 as const, final: true, disposition: 'documents_verified',
    actor: 'u1', actorScope: 'partner' as const, createdAt: new Date(Date.now() - 1000).toISOString(),
  };
  it('a valid row maps every field (and only those)', () => {
    expect(toReviewRowLite({ ...base, reason: 'not copied', evidence: {} } as typeof base)).toEqual(base);
  });
  it('an unknown hold_class or disposition -> null', () => {
    expect(toReviewRowLite({ ...base, holdClass: 'kyc2' })).toBeNull();
    expect(toReviewRowLite({ ...base, disposition: 'approve' })).toBeNull();
    expect(toReviewRowLite({ ...base, holdClass: '__proto__' })).toBeNull();
  });
});
