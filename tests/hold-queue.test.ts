import { describe, expect, it } from 'vitest';
import {
  AML_HOLD_REASON, EDD_REQUIRED_REASON, HOLD_REASONS, LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON,
  ORIGINATOR_INFO_MISSING_REASON, POSSIBLE_MATCH_REASON, RECIPIENT_IDENTITY_MISSING_REASON,
  RECIPIENT_WATCHLIST_REASON, SENDER_IDENTITY_MISSING_REASON, SENDER_SCREENING_REASON,
  SENDER_WATCHLIST_REASON, VELOCITY_REASON, type CustomerScreeningFlags,
} from '@/lib/compliance-config';
import {
  HOLD_CLASSES, REASON_CLASS, classReasonsFp, classifyHold, isHoldClass, rowReasonsFp, senderPepOnly,
  type ClassifyOwner, type HoldClass,
} from '@/lib/hold-queue';

// Fix pack 7 T5 (P4, DP3, R1, R2, R5): the pure hold classes and fingerprints.
// Relative times only.

const Q: ClassifyOwner = { queue: true, partnerDecidesKyc: true };
const N: ClassifyOwner = { queue: false, partnerDecidesKyc: false };
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const H = 3_600_000;
// Every PEP-only fixture sets screeningWatchlistAt: null (the column was read, empty).
const pep: CustomerScreeningFlags = { pepHit: true, watchlistHit: false, screeningFlaggedAt: ago(H), screeningWatchlistAt: null };
const watch: CustomerScreeningFlags = { pepHit: false, watchlistHit: true, screeningFlaggedAt: ago(H), screeningWatchlistAt: ago(H) };

const one = (reasons: readonly unknown[] | null | undefined, flags: CustomerScreeningFlags | null | undefined = undefined, owner = Q, opts?: { blocked?: boolean; dataOnFile?: boolean }) =>
  classifyHold(reasons, flags, owner, opts).map((c) => ({ holdClass: c.holdClass, reasons: [...c.reasons], decider: c.decider }));

describe('hold-queue (P4)', () => {
  it('HOLD_CLASSES is the frozen 9-tuple in P4 order', () => {
    expect(Object.isFrozen(HOLD_CLASSES)).toBe(true);
    expect([...HOLD_CLASSES]).toEqual([
      'kyc', 'aml', 'sender_pep', 'sanctions_review', 'sender_watchlist', 'list_wait', 'data_missing', 'blocked', 'unknown',
    ]);
  });

  it('registry coverage: every HOLD_REASONS key has exactly one REASON_CLASS entry, and REASON_CLASS has no key outside the registry', () => {
    expect(Object.isFrozen(REASON_CLASS)).toBe(true);
    expect(Object.keys(REASON_CLASS).sort()).toEqual(Object.keys(HOLD_REASONS).sort());
    for (const v of Object.values(REASON_CLASS)) {
      expect(v === 'sender' || isHoldClass(v), String(v)).toBe(true);
    }
    for (const k of Object.keys(HOLD_REASONS)) expect(REASON_CLASS[k], k).toBeDefined();
  });

  const TABLE: Array<[string, HoldClass, 'partner' | 'platform' | 'nobody', 'partner' | 'platform' | 'nobody']> = [
    [LARGE_AMOUNT_REASON, 'kyc', 'partner', 'platform'],
    [VELOCITY_REASON, 'kyc', 'partner', 'platform'],
    [EDD_REQUIRED_REASON, 'kyc', 'partner', 'platform'],
    [AML_HOLD_REASON, 'aml', 'partner', 'platform'],
    [POSSIBLE_MATCH_REASON, 'sanctions_review', 'platform', 'platform'],
    [SENDER_IDENTITY_MISSING_REASON, 'sanctions_review', 'platform', 'platform'],
    [LIST_UNAVAILABLE_REASON, 'list_wait', 'nobody', 'nobody'],
    [RECIPIENT_IDENTITY_MISSING_REASON, 'data_missing', 'nobody', 'nobody'],
    [ORIGINATOR_INFO_MISSING_REASON, 'data_missing', 'nobody', 'nobody'],
    [RECIPIENT_WATCHLIST_REASON, 'blocked', 'nobody', 'nobody'],
    [SENDER_WATCHLIST_REASON, 'blocked', 'nobody', 'nobody'],
    ['Some legacy text.', 'unknown', 'platform', 'platform'],
  ];

  it.each(TABLE)('the P4 table, queue partner: %s', (reason, holdClass, decider) => {
    expect(one([reason])).toEqual([{ holdClass, reasons: [reason], decider }]);
  });

  it.each(TABLE)('the same table, uncertified owner (N): %s', (reason, holdClass, _q, decider) => {
    expect(one([reason], undefined, N)).toEqual([{ holdClass, reasons: [reason], decider }]);
  });

  it('sender_pep is platform for an uncertified owner (N)', () => {
    expect(one([SENDER_SCREENING_REASON], pep, N)).toEqual([{ holdClass: 'sender_pep', reasons: [SENDER_SCREENING_REASON], decider: 'platform' }]);
  });

  describe('sender_pep vs sender_watchlist (DP3)', () => {
    const S = [SENDER_SCREENING_REASON];
    const cls = (flags: CustomerScreeningFlags | null | undefined, owner = Q) => one(S, flags, owner);
    it('pepHit only with Q -> sender_pep partner', () => {
      expect(cls(pep)).toEqual([{ holdClass: 'sender_pep', reasons: S, decider: 'partner' }]);
    });
    it('pepHit only with a queue owner whose KYC is not partner-decided -> sender_pep platform', () => {
      expect(cls(pep, { queue: true, partnerDecidesKyc: false })).toEqual([{ holdClass: 'sender_pep', reasons: S, decider: 'platform' }]);
    });
    it('watchlistHit true (with or without pepHit) -> sender_watchlist platform', () => {
      expect(cls(watch)).toEqual([{ holdClass: 'sender_watchlist', reasons: S, decider: 'platform' }]);
      expect(cls({ ...pep, watchlistHit: true })).toEqual([{ holdClass: 'sender_watchlist', reasons: S, decider: 'platform' }]);
    });
    it('a stamp with both booleans null -> sender_watchlist', () => {
      expect(cls({ pepHit: null, watchlistHit: null, screeningFlaggedAt: ago(H), screeningWatchlistAt: null })[0]!.holdClass).toBe('sender_watchlist');
    });
    it('flags null (unreadable) -> sender_watchlist', () => {
      expect(cls(null)).toEqual([{ holdClass: 'sender_watchlist', reasons: S, decider: 'platform' }]);
    });
    it('no stamp and no boolean -> sender_watchlist', () => {
      expect(cls({ screeningWatchlistAt: null })[0]!.holdClass).toBe('sender_watchlist');
    });
    it('pepHit with watchlistHit null: screeningWatchlistAt null -> sender_pep; undefined (not read) -> sender_watchlist', () => {
      expect(cls({ pepHit: true, watchlistHit: null, screeningFlaggedAt: ago(H), screeningWatchlistAt: null })[0]!.holdClass).toBe('sender_pep');
      expect(cls({ pepHit: true, watchlistHit: null, screeningFlaggedAt: ago(H) })[0]!.holdClass).toBe('sender_watchlist');
    });
    it('a watchlist stamp newer than the clear (a stale save nulled the boolean, R2) -> sender_watchlist; older -> sender_pep', () => {
      const base = { pepHit: true, watchlistHit: null, screeningFlaggedAt: ago(H) };
      expect(cls({ ...base, screeningClearedAt: ago(3 * H), screeningWatchlistAt: ago(2 * H) })[0]!.holdClass).toBe('sender_watchlist');
      expect(cls({ ...base, screeningClearedAt: ago(2 * H), screeningWatchlistAt: ago(3 * H) })[0]!.holdClass).toBe('sender_pep');
    });
    it('flags undefined (not read) with SENDER_SCREENING present -> sender_watchlist (fail closed)', () => {
      expect(cls(undefined)).toEqual([{ holdClass: 'sender_watchlist', reasons: S, decider: 'platform' }]);
    });
  });

  describe('synthetic sender class (R1)', () => {
    it('a watchlist stamp active with no SENDER_SCREENING reason -> [kyc, sender_watchlist] with reasons []', () => {
      expect(one([LARGE_AMOUNT_REASON], watch)).toEqual([
        { holdClass: 'kyc', reasons: [LARGE_AMOUNT_REASON], decider: 'partner' },
        { holdClass: 'sender_watchlist', reasons: [], decider: 'platform' },
      ]);
    });
    it('a PEP-only active stamp -> [kyc, sender_pep]', () => {
      expect(one([LARGE_AMOUNT_REASON], pep)).toEqual([
        { holdClass: 'kyc', reasons: [LARGE_AMOUNT_REASON], decider: 'partner' },
        { holdClass: 'sender_pep', reasons: [], decider: 'partner' },
      ]);
    });
    it('flags undefined or a cleared stamp -> [kyc] only', () => {
      const kycOnly = [{ holdClass: 'kyc', reasons: [LARGE_AMOUNT_REASON], decider: 'partner' }];
      expect(one([LARGE_AMOUNT_REASON], undefined)).toEqual(kycOnly);
      expect(one([LARGE_AMOUNT_REASON], { pepHit: false, watchlistHit: false, screeningFlaggedAt: ago(2 * H), screeningClearedAt: ago(H), screeningWatchlistAt: null })).toEqual(kycOnly);
      expect(one([LARGE_AMOUNT_REASON], { screeningWatchlistAt: null })).toEqual(kycOnly);
    });
    it('flags null (the read failed) -> a synthetic sender_watchlist (fail closed)', () => {
      expect(one([LARGE_AMOUNT_REASON], null)).toEqual([
        { holdClass: 'kyc', reasons: [LARGE_AMOUNT_REASON], decider: 'partner' },
        { holdClass: 'sender_watchlist', reasons: [], decider: 'platform' },
      ]);
    });
  });

  it('data_missing decider (P4 dataOnFile): nobody, platform once the data is on file', () => {
    expect(one([ORIGINATOR_INFO_MISSING_REASON])[0]!.decider).toBe('nobody');
    expect(one([ORIGINATOR_INFO_MISSING_REASON], undefined, Q, { dataOnFile: true })[0]!.decider).toBe('platform');
    expect(one([RECIPIENT_IDENTITY_MISSING_REASON], undefined, N, { dataOnFile: true })[0]!.decider).toBe('platform');
  });

  it('senderPepOnly truth table', () => {
    expect(senderPepOnly(pep)).toBe(true);
    expect(senderPepOnly({ ...pep, watchlistHit: null })).toBe(true);
    expect(senderPepOnly({ ...pep, watchlistHit: true })).toBe(false);
    expect(senderPepOnly({ pepHit: true, watchlistHit: null, screeningFlaggedAt: ago(H) })).toBe(false);
    expect(senderPepOnly({ ...pep, screeningClearedAt: ago(3 * H), screeningWatchlistAt: ago(2 * H) })).toBe(false);
    expect(senderPepOnly({ ...pep, screeningClearedAt: ago(2 * H), screeningWatchlistAt: ago(3 * H) })).toBe(true);
    expect(senderPepOnly({ ...pep, screeningWatchlistAt: ago(2 * H) })).toBe(false);
    const t = ago(2 * H);
    expect(senderPepOnly({ ...pep, screeningClearedAt: t, screeningWatchlistAt: t })).toBe(false);
    expect(senderPepOnly({ ...pep, screeningClearedAt: 'not a time', screeningWatchlistAt: ago(3 * H) })).toBe(false);
    expect(senderPepOnly({ ...pep, pepHit: false })).toBe(false);
    expect(senderPepOnly({ ...pep, pepHit: null })).toBe(false);
    expect(senderPepOnly(null)).toBe(false);
    expect(senderPepOnly(undefined)).toBe(false);
  });

  it('blocked via opts', () => {
    expect(one([LARGE_AMOUNT_REASON], undefined, Q, { blocked: true })).toEqual([
      { holdClass: 'kyc', reasons: [LARGE_AMOUNT_REASON], decider: 'partner' },
      { holdClass: 'blocked', reasons: [], decider: 'nobody' },
    ]);
    expect(one([RECIPIENT_WATCHLIST_REASON], undefined, Q, { blocked: true })).toEqual([
      { holdClass: 'blocked', reasons: [RECIPIENT_WATCHLIST_REASON], decider: 'nobody' },
    ]);
  });

  it.each([[[]], [null], [undefined], ['x'], [[42]]] as Array<[unknown]>)('empty, null, non-array or non-string entries -> unknown platform (%j)', (v) => {
    expect(one(v as readonly unknown[])).toEqual([{ holdClass: 'unknown', reasons: [], decider: 'platform' }]);
  });

  it('a non-string entry beside a known reason -> kyc plus unknown with no reason string', () => {
    expect(one([LARGE_AMOUNT_REASON, 42])).toEqual([
      { holdClass: 'kyc', reasons: [LARGE_AMOUNT_REASON], decider: 'partner' },
      { holdClass: 'unknown', reasons: [], decider: 'platform' },
    ]);
  });

  it('prototype keys read as unknown', () => {
    expect(one(['__proto__', 'constructor', 'toString'])).toEqual([
      { holdClass: 'unknown', reasons: ['__proto__', 'constructor', 'toString'], decider: 'platform' },
    ]);
  });

  it('one entry per present class, in HOLD_CLASSES order, reasons sorted and de-duplicated', () => {
    expect(one([AML_HOLD_REASON, POSSIBLE_MATCH_REASON, LARGE_AMOUNT_REASON, VELOCITY_REASON, LARGE_AMOUNT_REASON])).toEqual([
      { holdClass: 'kyc', reasons: [LARGE_AMOUNT_REASON, VELOCITY_REASON].sort(), decider: 'partner' },
      { holdClass: 'aml', reasons: [AML_HOLD_REASON], decider: 'partner' },
      { holdClass: 'sanctions_review', reasons: [POSSIBLE_MATCH_REASON], decider: 'platform' },
    ]);
  });

  it('the input array is not mutated, and output arrays are frozen', () => {
    const input = [VELOCITY_REASON, LARGE_AMOUNT_REASON, VELOCITY_REASON];
    const copy = [...input];
    const out = classifyHold(input, undefined, Q);
    expect(input).toEqual(copy);
    expect(Object.isFrozen(out)).toBe(true);
    for (const c of out) expect(Object.isFrozen(c.reasons)).toBe(true);
  });

  describe('rowReasonsFp', () => {
    it('is v1| plus the sorted unique reasons, order and duplicates independent', () => {
      const a = rowReasonsFp([VELOCITY_REASON, LARGE_AMOUNT_REASON, VELOCITY_REASON]);
      expect(a).toBe('v1|' + [LARGE_AMOUNT_REASON, VELOCITY_REASON].sort().join('|'));
      expect(rowReasonsFp([LARGE_AMOUNT_REASON, VELOCITY_REASON])).toBe(a);
      expect(rowReasonsFp([])).toBe('v1|');
      expect(rowReasonsFp(null)).toBe('v1|');
      expect(rowReasonsFp(undefined)).toBe('v1|');
    });
    it('escapes % and |, so a|b differs from a and b', () => {
      expect(rowReasonsFp(['a|b'])).toBe('v1|a%7Cb');
      expect(rowReasonsFp(['a%b'])).toBe('v1|a%25b');
      expect(rowReasonsFp(['a|b'])).not.toBe(rowReasonsFp(['a', 'b']));
    });
    it('escaping is the identity for every registry reason', () => {
      for (const r of Object.keys(HOLD_REASONS)) expect(rowReasonsFp([r])).toBe('v1|' + r);
    });
    it('throws RangeError above 1000 characters', () => {
      expect(() => rowReasonsFp(['x'.repeat(1001)])).toThrow(RangeError);
    });
  });

  describe('classReasonsFp', () => {
    it('is v1|<class>| plus the reasons, escaped', () => {
      const [kyc] = classifyHold([VELOCITY_REASON, LARGE_AMOUNT_REASON], undefined, Q);
      expect(classReasonsFp(kyc!)).toBe('v1|kyc|' + [LARGE_AMOUNT_REASON, VELOCITY_REASON].sort().join('|'));
      expect(classReasonsFp({ holdClass: 'unknown', reasons: ['a|b'] })).toBe('v1|unknown|a%7Cb');
    });
    it('a reason added to another class does not change it; one added to this class does', () => {
      const fp = (rs: string[]) => classReasonsFp(classifyHold(rs, undefined, Q).find((c) => c.holdClass === 'kyc')!);
      const base = fp([LARGE_AMOUNT_REASON]);
      expect(fp([LARGE_AMOUNT_REASON, AML_HOLD_REASON, POSSIBLE_MATCH_REASON])).toBe(base);
      expect(fp([LARGE_AMOUNT_REASON, VELOCITY_REASON])).not.toBe(base);
    });
    it('the sender classes append |f=<flag time ISO or ->, so a re-armed stamp opens a new cycle (R5)', () => {
      const d = new Date(Date.now() - H);
      const c = { holdClass: 'sender_pep' as const, reasons: [SENDER_SCREENING_REASON] };
      expect(classReasonsFp(c, { ...pep, screeningFlaggedAt: d })).toBe(`v1|sender_pep|${SENDER_SCREENING_REASON}|f=${d.toISOString()}`);
      expect(classReasonsFp(c, { ...pep, screeningFlaggedAt: d.toISOString() })).toBe(`v1|sender_pep|${SENDER_SCREENING_REASON}|f=${d.toISOString()}`);
      expect(classReasonsFp(c, null)).toBe(`v1|sender_pep|${SENDER_SCREENING_REASON}|f=-`);
      expect(classReasonsFp(c)).toBe(`v1|sender_pep|${SENDER_SCREENING_REASON}|f=-`);
      expect(classReasonsFp({ holdClass: 'sender_watchlist', reasons: [] }, { screeningFlaggedAt: null })).toBe('v1|sender_watchlist||f=-');
      const rearmed = classReasonsFp(c, { ...pep, screeningFlaggedAt: new Date(Date.now()) });
      expect(rearmed).not.toBe(classReasonsFp(c, { ...pep, screeningFlaggedAt: d }));
      // Other classes ignore the flags.
      expect(classReasonsFp({ holdClass: 'kyc', reasons: [LARGE_AMOUNT_REASON] }, pep)).toBe(`v1|kyc|${LARGE_AMOUNT_REASON}`);
    });
    it('throws RangeError above 1000 characters', () => {
      expect(() => classReasonsFp({ holdClass: 'unknown', reasons: ['x'.repeat(1001)] })).toThrow(RangeError);
    });
  });

  it('isHoldClass accepts the nine names and refuses others', () => {
    for (const c of HOLD_CLASSES) expect(isHoldClass(c)).toBe(true);
    for (const v of ['KYC', '', undefined, null, 42, '__proto__', 'sender']) expect(isHoldClass(v)).toBe(false);
  });
});
