import { describe, it, expect } from 'vitest';
import {
  holdQueueApplies,
  isQualifiedComplianceUser,
  partnerDecidesKyc,
  platformDelegated,
  reviewRecordApplies,
  type ComplianceStaffFact,
  type ScopeOwner,
} from '@/lib/partner-decision-scope';
import { liveReadiness, type LiveReadinessFacts } from '@/lib/live-certification';
import type { LiveControls, PostureRecord } from '@/lib/live-controls';
import type { KycMode, Partner } from '@/lib/types';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { approvedDisclosureConfig, certifiedLiveControls } from './helpers-live';

// Fix pack 7 T2 (P2): the routing key. Pure: every owner is a literal. Every
// predicate is false for every partner today (nobody can be certified before
// pack 9), and a signed posture alone changes nothing.

function withPosture(lc: LiveControls, patch: Partial<PostureRecord>): LiveControls {
  if (!lc.posture) throw new Error('fixture has no posture');
  return { ...lc, posture: { ...lc.posture, ...patch } };
}

function owner(o: Partial<ScopeOwner> = {}): ScopeOwner {
  return {
    id: 'acme',
    status: 'active',
    kycMode: 'delegated',
    liveControls: certifiedLiveControls({ posture: true, complianceUsers: ['co-a', 'co-b'] }),
    ...o,
  };
}

function staff(o: Partial<ComplianceStaffFact> = {}): ComplianceStaffFact {
  return { username: 'co-a', partnerId: 'acme', role: 'admin', active: true, ...o };
}

const routing = (o: ScopeOwner | null | undefined) => ({
  reviewRecordApplies: reviewRecordApplies(o),
  holdQueueApplies: holdQueueApplies(o),
  platformDelegated: platformDelegated(o),
  partnerDecidesKyc: partnerDecidesKyc(o),
});

const ALL_FALSE = { reviewRecordApplies: false, holdQueueApplies: false, platformDelegated: false, partnerDecidesKyc: false };

/** A posture-signing partner whose posture has every routing field set to make the predicates fire. */
function strongest(holdDecider: PostureRecord['holdDecider']): ScopeOwner {
  return owner({ liveControls: withPosture(owner().liveControls!, { holdDecider, kycDecider: 'partner' }) });
}

describe('partner-decision-scope: dead for every owner that is not certified', () => {
  it('every predicate is false for null, undefined and the default tenant (even with a certified record and a posture)', () => {
    expect(routing(null)).toEqual(ALL_FALSE);
    expect(routing(undefined)).toEqual(ALL_FALSE);
    for (const hd of ['partner', 'smartremit_delegated'] as const) {
      expect(routing({ ...strongest(hd), id: DEFAULT_PARTNER_ID })).toEqual(ALL_FALSE);
    }
  });

  it('every predicate is false for a suspended partner, a partner with no certification record, a revoked certification (revokedAt >= certifiedAt), and a malformed certifiedAt', () => {
    for (const hd of ['partner', 'smartremit_delegated'] as const) {
      const base = strongest(hd);
      const lc = base.liveControls!;
      const cert = lc.certification!;
      expect(routing({ ...base, status: 'suspended' })).toEqual(ALL_FALSE);
      const { certification: _drop, ...noCert } = lc;
      void _drop;
      expect(routing({ ...base, liveControls: noCert })).toEqual(ALL_FALSE);
      expect(routing({ ...base, liveControls: { ...lc, certification: { ...cert, revokedAt: cert.certifiedAt } } })).toEqual(ALL_FALSE);
      const later = new Date(Date.parse(cert.certifiedAt) + 1_000).toISOString();
      expect(routing({ ...base, liveControls: { ...lc, certification: { ...cert, revokedAt: later } } })).toEqual(ALL_FALSE);
      expect(routing({ ...base, liveControls: { ...lc, certification: { ...cert, certifiedAt: 'not-a-date' } } })).toEqual(ALL_FALSE);
      expect(routing({ ...base, liveControls: undefined })).toEqual(ALL_FALSE);
    }
  });

  it('a signed posture alone changes nothing', () => {
    const posture = certifiedLiveControls({ posture: true }).posture!;
    const kycModes: (KycMode | undefined)[] = ['ours', 'delegated', undefined];
    let cases = 0;
    for (const holdDecider of ['partner', 'smartremit_delegated'] as const) {
      for (const kycDecider of ['partner', 'smartremit_procedures'] as const) {
        for (const fourEyesNonSanctions of [true, false]) {
          for (const kycMode of kycModes) {
            const lc: LiveControls = { optIns: {}, complianceUsers: ['co-a', 'co-b'], posture: { ...posture, holdDecider, kycDecider, fourEyesNonSanctions } };
            const o: ScopeOwner = { id: 'acme', status: 'active', kycMode, liveControls: lc };
            expect(routing(o)).toEqual(ALL_FALSE);
            cases += 1;
          }
        }
      }
    }
    expect(cases).toBe(24);
  });
});

describe('partner-decision-scope: certified owners', () => {
  it('reviewRecordApplies equals isLiveCertified', () => {
    const o = owner({ liveControls: certifiedLiveControls({ complianceUsers: ['co-a', 'co-b'] }) });
    expect(routing(o)).toEqual({ reviewRecordApplies: true, holdQueueApplies: false, platformDelegated: false, partnerDecidesKyc: false });
    expect(reviewRecordApplies(owner())).toBe(true);
  });

  it("holdQueueApplies: certified + holdDecider 'partner' -> true; 'smartremit_delegated' -> false", () => {
    const lc = owner().liveControls!;
    const partner = owner({ liveControls: withPosture(lc, { holdDecider: 'partner' }) });
    const delegated = owner({ liveControls: withPosture(lc, { holdDecider: 'smartremit_delegated' }) });
    expect(holdQueueApplies(partner)).toBe(true);
    expect(platformDelegated(partner)).toBe(false);
    expect(holdQueueApplies(delegated)).toBe(false);
    expect(platformDelegated(delegated)).toBe(true);
  });

  it("partnerDecidesKyc: certified + kycDecider 'partner' + kycMode 'delegated' -> true; kycMode 'ours' or absent -> false (a posture that disagrees with kycMode, P2); kycDecider 'smartremit_procedures' -> false", () => {
    const lc = owner().liveControls!;
    const decides = withPosture(lc, { kycDecider: 'partner' });
    expect(partnerDecidesKyc(owner({ liveControls: decides }))).toBe(true);
    expect(partnerDecidesKyc(owner({ liveControls: decides, kycMode: 'ours' }))).toBe(false);
    expect(partnerDecidesKyc(owner({ liveControls: decides, kycMode: undefined }))).toBe(false);
    expect(partnerDecidesKyc(owner({ liveControls: withPosture(lc, { kycDecider: 'smartremit_procedures' }) }))).toBe(false);
  });
});

describe('partner-decision-scope: isQualifiedComplianceUser', () => {
  it('isQualifiedComplianceUser: true only when listed, same tenant, admin or agent, active and mfaEnrolled === true', () => {
    expect(isQualifiedComplianceUser(owner(), staff(), true)).toBe(true);
    expect(isQualifiedComplianceUser(owner(), staff({ username: 'co-b', role: 'agent' }), true)).toBe(true);
    const rows: Array<[string, Parameters<typeof isQualifiedComplianceUser>]> = [
      ['unlisted', [owner(), staff({ username: 'co-z' }), true]],
      ["partnerId 'other'", [owner(), staff({ partnerId: 'other' }), true]],
      ['partnerId undefined (platform staff)', [owner(), staff({ partnerId: undefined }), true]],
      ['partnerId null', [owner(), staff({ partnerId: null }), true]],
      ["role 'support'", [owner(), staff({ role: 'support' }), true]],
      ["role 'finance'", [owner(), staff({ role: 'finance' }), true]],
      ['active false', [owner(), staff({ active: false }), true]],
      ['mfaEnrolled false', [owner(), staff(), false]],
      ['staff null', [owner(), null, true]],
      ['owner null', [null, staff(), true]],
      ['owner with no liveControls', [owner({ liveControls: undefined }), staff(), true]],
    ];
    for (const [name, args] of rows) expect(isQualifiedComplianceUser(...args), name).toBe(false);
  });

  it('isQualifiedComplianceUser does not need certification', () => {
    const uncertified = owner({ liveControls: { optIns: {}, complianceUsers: ['co-a'] } });
    expect(reviewRecordApplies(uncertified)).toBe(false);
    expect(isQualifiedComplianceUser(uncertified, staff(), true)).toBe(true);
  });
});

// Builders copied from tests/live-certification.test.ts (not imported from another test file).
type P = Pick<Partner, 'id' | 'status' | 'kycMode' | 'requireKycBeforeSend' | 'liveControls' | 'supportConfig' | 'displayName' | 'brandName'>;
const USERS = ['acme-comp1', 'acme-comp2'];
function passingPartner(o: Partial<P> = {}): P {
  return {
    id: 'acme',
    status: 'active',
    kycMode: 'ours',
    requireKycBeforeSend: true,
    liveControls: certifiedLiveControls({ posture: true, complianceUsers: USERS }),
    supportConfig: { disclosure: approvedDisclosureConfig() },
    ...o,
  };
}
function allPassFacts(): LiveReadinessFacts {
  return {
    goLiveApproved: true,
    listFitness: 'live',
    ownWhatsapp: true,
    complianceStaff: USERS.map((username) => ({ username, partnerId: 'acme', role: 'admin', active: true, mfaEnrolled: true })),
  };
}

describe('partner-decision-scope: nobody is certifiable yet', () => {
  it('nothing can be certified before pack 9', () => {
    const r = liveReadiness(passingPartner(), allPassFacts());
    expect(r.ok).toBe(false);
    // Every built line passes for the strongest partner; only the not-built lines fail.
    expect(r.lines.filter((l) => !l.ok).every((l) => l.state === 'not_built')).toBe(true);
  });
});
