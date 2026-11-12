import { describe, it, expect } from 'vitest';
import {
  KYC_DISPOSITIONS,
  isKycDisposition,
  partnerKycFlag,
  partnerKycOffer,
  partnerKycOfferedDecisions,
  partnerKycDecision,
  type KycOwner,
} from '@/lib/partner-reviews';
import { canDecideCustomerKyc, type CustomerScreeningFlags } from '@/lib/compliance-config';
import type { LiveControls } from '@/lib/live-controls';
import type { Customer } from '@/lib/types';
import { certifiedLiveControls } from './helpers-live';

// Fix pack 7 T24 (P22, P25): the pure partner-decides KYC rules. Owners are plain objects; the
// certified live controls come from the shared helper (posture kycDecider switched to 'partner',
// the same way tests/partner-decision-scope.test.ts builds it).

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function withKycDecider(lc: LiveControls, kycDecider: 'partner' | 'smartremit_procedures'): LiveControls {
  return { ...lc, posture: { ...lc.posture!, kycDecider } };
}

const certified = certifiedLiveControls({ posture: true, complianceUsers: ['co-a'] });
const decides: KycOwner = { id: 'acme', status: 'active', kycMode: 'delegated', liveControls: withKycDecider(certified, 'partner') };
const plain: KycOwner = { kycMode: 'delegated' };
const postureNotCertified: KycOwner = {
  id: 'acme',
  status: 'active',
  kycMode: 'delegated',
  liveControls: { ...withKycDecider(certified, 'partner'), certification: undefined },
};
const certifiedOurs: KycOwner = { id: 'acme', status: 'active', kycMode: 'ours', liveControls: withKycDecider(certified, 'partner') };

type C = Pick<Customer, 'kycStatus' | 'kycReviewState'> & CustomerScreeningFlags;
const queue = (f: CustomerScreeningFlags = {}): C => ({ kycStatus: 'pending', kycReviewState: 'pending_review', ...f });
const manual = (kycStatus: Customer['kycStatus'], f: CustomerScreeningFlags = {}): C => ({ kycStatus, kycReviewState: 'none', ...f });

// Flags as readSenderScreeningFlags returns them (screeningWatchlistAt read: null = empty).
const pepOnly: CustomerScreeningFlags = { pepHit: true, watchlistHit: false, screeningFlaggedAt: ago(60_000), screeningClearedAt: null, screeningWatchlistAt: null };
const pepCleared: CustomerScreeningFlags = { pepHit: true, watchlistHit: false, screeningFlaggedAt: ago(120_000), screeningClearedAt: ago(60_000), screeningWatchlistAt: null };
const watchlist: CustomerScreeningFlags = { watchlistHit: true, pepHit: false, screeningFlaggedAt: ago(60_000), screeningClearedAt: null, screeningWatchlistAt: ago(60_000) };
const stampOnly: CustomerScreeningFlags = { watchlistHit: null, pepHit: null, screeningFlaggedAt: ago(60_000), screeningClearedAt: null, screeningWatchlistAt: null };

describe('partner-kyc-posture: dispositions', () => {
  it("KYC_DISPOSITIONS is the frozen tuple ['false_positive','pep_accepted_with_edd','reject']; isKycDisposition accepts each and refuses 'approve', '', null", () => {
    expect(KYC_DISPOSITIONS).toEqual(['false_positive', 'pep_accepted_with_edd', 'reject']);
    expect(Object.isFrozen(KYC_DISPOSITIONS)).toBe(true);
    for (const d of KYC_DISPOSITIONS) expect(isKycDisposition(d)).toBe(true);
    for (const v of ['approve', '', null, undefined, 1, 'REJECT', '__proto__']) expect(isKycDisposition(v)).toBe(false);
  });
});

describe('partner-kyc-posture: partnerKycFlag', () => {
  it("{} -> 'none'; pepHit + stamp, no clear -> 'pep'; pepHit + stamp + later clear -> 'none'; pepHit, no stamp, no clear -> 'pep'; watchlistHit (cleared or not) -> 'platform'; stamp only (booleans null) -> 'platform'; watchlistHit + pepHit -> 'platform'", () => {
    expect(partnerKycFlag({ screeningWatchlistAt: null })).toBe('none');
    expect(partnerKycFlag({})).toBe('none');
    expect(partnerKycFlag(pepOnly)).toBe('pep');
    expect(partnerKycFlag(pepCleared)).toBe('none');
    expect(partnerKycFlag({ pepHit: true, watchlistHit: false, screeningFlaggedAt: null, screeningClearedAt: null, screeningWatchlistAt: null })).toBe('pep');
    expect(partnerKycFlag(watchlist)).toBe('platform');
    expect(partnerKycFlag({ ...watchlist, screeningClearedAt: ago(1_000) })).toBe('platform');
    expect(partnerKycFlag(stampOnly)).toBe('platform');
    expect(partnerKycFlag({ ...pepOnly, watchlistHit: true })).toBe('platform');
  });

  it("fails closed: null/undefined -> 'platform'; a customer object without screeningWatchlistAt (not read) and an active PEP stamp -> 'platform'", () => {
    expect(partnerKycFlag(null)).toBe('platform');
    expect(partnerKycFlag(undefined)).toBe('platform');
    const notRead: CustomerScreeningFlags = { pepHit: true, watchlistHit: false, screeningFlaggedAt: ago(60_000), screeningClearedAt: null };
    expect(partnerKycFlag(notRead)).toBe('platform');
  });

  it("a watchlist stamp newer than the last clear (a stale save nulled watchlistHit) -> 'platform', even when the PEP stamp itself reads cleared", () => {
    expect(partnerKycFlag({ ...pepOnly, screeningWatchlistAt: ago(30_000) })).toBe('platform');
    // Unreachable through stampScreeningFlagged (greatest() moves flaggedAt too), but fail closed.
    expect(partnerKycFlag({ ...pepCleared, screeningWatchlistAt: ago(10_000) })).toBe('platform');
    // A watchlist stamp a later clear covers no longer counts.
    expect(partnerKycFlag({ ...pepOnly, screeningWatchlistAt: ago(120_000), screeningClearedAt: ago(90_000), screeningFlaggedAt: ago(60_000) })).toBe('pep');
  });
});

describe('partner-kyc-posture: partnerKycOffer on a deciding owner', () => {
  it('viewer absent or { qualified: false } -> { ok: false } for every customer', () => {
    for (const c of [queue(), queue(pepOnly), manual('pending'), manual('rejected'), queue(watchlist)]) {
      for (const d of ['approve', 'reject'] as const) {
        expect(partnerKycOffer(decides, c, d)).toEqual({ ok: false });
        expect(partnerKycOffer(decides, c, d, { qualified: false })).toEqual({ ok: false });
      }
    }
  });

  it('qualified viewer: unflagged queue customer -> kyc.review.approve persona_review; PEP-only -> offered (same slug rules); watchlist or stamp-only -> { ok: false }; the no-op rules stay', () => {
    const v = { qualified: true };
    expect(partnerKycOffer(decides, queue({ screeningWatchlistAt: null }), 'approve', v)).toEqual({ ok: true, slug: 'kyc.review.approve', source: 'persona_review' });
    expect(partnerKycOffer(decides, queue(pepOnly), 'approve', v)).toEqual({ ok: true, slug: 'kyc.review.approve', source: 'persona_review' });
    expect(partnerKycOffer(decides, queue(pepOnly), 'reject', v)).toEqual({ ok: true, slug: 'kyc.review.reject', source: 'persona_review' });
    expect(partnerKycOffer(decides, manual('pending', pepOnly), 'approve', v)).toEqual({ ok: true, slug: 'kyc.manual_override.approve', source: 'manual' });
    for (const f of [watchlist, stampOnly]) {
      for (const d of ['approve', 'reject'] as const) {
        expect(partnerKycOffer(decides, queue(f), d, v)).toEqual({ ok: false });
        expect(partnerKycOffer(decides, manual('pending', f), d, v)).toEqual({ ok: false });
      }
    }
    expect(partnerKycOffer(decides, manual('verified', { screeningWatchlistAt: null }), 'approve', v)).toEqual({ ok: false });
    expect(partnerKycOffer(decides, manual('grandfathered', { screeningWatchlistAt: null }), 'approve', v)).toEqual({ ok: false });
    expect(partnerKycOffer(decides, manual('rejected', { screeningWatchlistAt: null }), 'reject', v)).toEqual({ ok: false });
    expect(partnerKycOffer(decides, null, 'approve', v)).toEqual({ ok: false });
    expect(partnerKycOffer(decides, queue(), 'bogus' as never, v)).toEqual({ ok: false });
  });
});

describe('partner-kyc-posture: owners where partnerDecidesKyc is false keep pack 3', () => {
  const customers = [queue(), queue(pepOnly), queue(watchlist), queue(stampOnly), manual('pending', watchlist), manual('verified'), manual('rejected', pepOnly)];

  it('a plain delegated owner ignores the viewer and the flags: identical results with and without { qualified: true } for a flagged and an unflagged customer', () => {
    for (const c of customers) {
      for (const d of ['approve', 'reject'] as const) {
        const base = partnerKycOffer(plain, c, d);
        expect(partnerKycOffer(plain, c, d, { qualified: true })).toEqual(base);
        expect(partnerKycOffer(plain, c, d, { qualified: false })).toEqual(base);
      }
    }
    // Golden: a flagged queue customer is offered exactly like an unflagged one (pack 3).
    expect(partnerKycOffer(plain, queue(watchlist), 'approve')).toEqual({ ok: true, slug: 'kyc.review.approve', source: 'persona_review' });
  });

  it("posture 'partner' but NOT certified -> today's delegated behaviour (viewer ignored); certified with kycMode 'ours' -> { ok: false } as today", () => {
    for (const c of customers) {
      for (const d of ['approve', 'reject'] as const) {
        expect(partnerKycOffer(postureNotCertified, c, d)).toEqual(partnerKycOffer(plain, c, d));
        expect(partnerKycOffer(postureNotCertified, c, d, { qualified: false })).toEqual(partnerKycOffer(plain, c, d));
        expect(partnerKycOffer(certifiedOurs, c, d, { qualified: true })).toEqual({ ok: false });
      }
    }
  });
});

describe('partner-kyc-posture: offered decisions and the decision', () => {
  it('partnerKycOfferedDecisions(decides, customer, viewer) lists what partnerKycOffer allows', () => {
    const v = { qualified: true };
    for (const c of [queue(pepOnly), queue(watchlist), manual('pending', { screeningWatchlistAt: null }), manual('verified', { screeningWatchlistAt: null })]) {
      for (const viewer of [undefined, v, { qualified: false }]) {
        const want = (['approve', 'reject'] as const).filter((d) => partnerKycOffer(decides, c, d, viewer).ok);
        expect(partnerKycOfferedDecisions(decides, c, viewer)).toEqual(want);
      }
    }
    expect(partnerKycOfferedDecisions(decides, queue(pepOnly), v)).toEqual(['approve', 'reject']);
    expect(partnerKycOfferedDecisions(decides, queue(pepOnly))).toEqual([]);
  });

  it('partnerKycDecision on a deciding owner, qualified: PEP-only uncleared -> ok; PEP cleared later -> ok; watchlist -> refused; stamp-only -> refused; not qualified -> refused', () => {
    const v = { qualified: true };
    expect(partnerKycDecision(decides, queue(pepOnly), 'approve', v).ok).toBe(true);
    expect(partnerKycDecision(decides, queue(pepCleared), 'approve', v).ok).toBe(true);
    expect(partnerKycDecision(decides, queue(watchlist), 'approve', v)).toEqual({ ok: false });
    expect(partnerKycDecision(decides, queue(stampOnly), 'reject', v)).toEqual({ ok: false });
    expect(partnerKycDecision(decides, queue(pepOnly), 'approve')).toEqual({ ok: false });
  });

  it('partnerKycDecision on a plain owner: unchanged (any hit refused), viewer ignored', () => {
    for (const f of [pepOnly, watchlist, stampOnly]) {
      expect(partnerKycDecision(plain, queue(f), 'approve')).toEqual({ ok: false });
      expect(partnerKycDecision(plain, queue(f), 'approve', { qualified: true })).toEqual({ ok: false });
    }
    expect(partnerKycDecision(plain, queue(), 'approve', { qualified: true })).toEqual({ ok: true, slug: 'kyc.review.approve', source: 'persona_review' });
  });
});

describe('partner-kyc-posture: canDecideCustomerKyc with the owner', () => {
  const all: CustomerScreeningFlags[] = [{}, pepOnly, pepCleared, watchlist, stampOnly];

  it('platform scope is false for every customer of a deciding owner; with a plain owner, null or no third argument it is true', () => {
    for (const c of all) {
      expect(canDecideCustomerKyc({ kind: 'platform' }, c, decides as never)).toBe(false);
      expect(canDecideCustomerKyc({ kind: 'platform' }, c, plain as never)).toBe(true);
      expect(canDecideCustomerKyc({ kind: 'platform' }, c, null)).toBe(true);
      expect(canDecideCustomerKyc({ kind: 'platform' }, c)).toBe(true);
    }
  });

  it('partner scope with the owner given: unchanged rule', () => {
    for (const c of all) {
      const today = canDecideCustomerKyc({ kind: 'partner' }, c);
      expect(canDecideCustomerKyc({ kind: 'partner' }, c, decides as never)).toBe(today);
      expect(canDecideCustomerKyc({ kind: 'partner' }, c, plain as never)).toBe(today);
    }
  });
});
