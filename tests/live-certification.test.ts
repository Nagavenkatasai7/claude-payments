import { describe, it, expect } from 'vitest';
import {
  LIVE_READINESS_LINE_IDS,
  NOT_BUILT_LINES,
  liveReadiness,
  type LiveReadiness,
  type LiveReadinessFacts,
  type LiveReadinessLineId,
} from '@/lib/live-certification';
import type { LiveControls } from '@/lib/live-controls';
import type { Partner } from '@/lib/types';
import { disclosureHash } from '@/lib/disclosure-hash';
import { approvedDisclosureConfig, certifiedLiveControls } from './helpers-live';

// Fix pack 3 (contract 8): the 12-line live readiness checklist. Pure: the
// partner and the facts are literals here. Seven lines are built (pack 4 T6
// added provider_block); the other five are 'not_built' (always failing), so
// `ok` is false for EVERY partner until PR9 (pinned below).

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

type StaffFact = LiveReadinessFacts['complianceStaff'][number];
const staffFact = (username: string, o: Partial<StaffFact> = {}): StaffFact => ({
  username,
  partnerId: 'acme',
  role: 'admin',
  active: true,
  mfaEnrolled: true,
  ...o,
});

function allPassFacts(o: Partial<LiveReadinessFacts> = {}): LiveReadinessFacts {
  return {
    goLiveApproved: true,
    listFitness: 'live',
    ownWhatsapp: true,
    complianceStaff: USERS.map((u) => staffFact(u)),
    ...o,
  };
}

const line = (r: LiveReadiness, id: LiveReadinessLineId) => {
  const l = r.lines.find((x) => x.id === id);
  if (!l) throw new Error(`no line ${id}`);
  return l;
};
const okOf = (p: P, f: LiveReadinessFacts, id: LiveReadinessLineId) => line(liveReadiness(p, f), id).ok;

function withPosture(lc: LiveControls, patch: Partial<NonNullable<LiveControls['posture']>>): LiveControls {
  if (!lc.posture) throw new Error('fixture has no posture');
  return { ...lc, posture: { ...lc.posture, ...patch } };
}

describe('liveReadiness: shape', () => {
  it('LIVE_READINESS_LINE_IDS and NOT_BUILT_LINES pinned (order and builtIn values)', () => {
    expect(LIVE_READINESS_LINE_IDS).toEqual([
      'go_live', 'sanctions_list', 'posture', 'compliance_users', 'own_whatsapp', 'contract',
      'provider_block', 'funding', 'licence_matrix', 'corridor_register', 'staff_mfa', 'dual_control',
    ]);
    expect(NOT_BUILT_LINES).toEqual({
      funding: 'PR5', licence_matrix: 'PR8', corridor_register: 'PR8', staff_mfa: 'PR9', dual_control: 'PR9',
    });
  });

  it('lines come back in LIVE_READINESS_LINE_IDS order, one each', () => {
    const r = liveReadiness(passingPartner(), allPassFacts());
    expect(r.lines.map((l) => l.id)).toEqual([...LIVE_READINESS_LINE_IDS]);
  });

  it('not-built lines are state not_built, ok false, builtIn PRn', () => {
    const r = liveReadiness(passingPartner(), allPassFacts());
    for (const [id, pr] of Object.entries(NOT_BUILT_LINES)) {
      expect(line(r, id as LiveReadinessLineId)).toEqual({ id, state: 'not_built', ok: false, builtIn: pr });
    }
  });

  it('ok is false for EVERY partner (pack 4: five lines not built; all built lines passing still false)', () => {
    const r = liveReadiness(passingPartner(), allPassFacts());
    const built = r.lines.filter((l) => !(l.id in NOT_BUILT_LINES));
    expect(built).toHaveLength(7);
    for (const l of built) expect(l).toEqual({ id: l.id, state: 'pass', ok: true });
    expect(r.ok).toBe(false);
  });

  it('a failing built line reads state fail, ok false', () => {
    const r = liveReadiness(passingPartner(), allPassFacts({ ownWhatsapp: false }));
    expect(line(r, 'own_whatsapp')).toEqual({ id: 'own_whatsapp', state: 'fail', ok: false });
  });

  it('missing liveControls reads as EMPTY (no throw)', () => {
    const p = passingPartner({ liveControls: undefined });
    const r = liveReadiness(p, allPassFacts());
    expect(line(r, 'posture').ok).toBe(false);
    expect(line(r, 'compliance_users').ok).toBe(false);
    expect(line(r, 'contract').ok).toBe(false);
    expect(line(r, 'go_live').ok).toBe(true);
    expect(r.ok).toBe(false);
  });
});

describe('liveReadiness: built lines', () => {
  it('go_live: approved + active + not default passes; not approved, suspended, or id default fails', () => {
    expect(okOf(passingPartner(), allPassFacts(), 'go_live')).toBe(true);
    expect(okOf(passingPartner(), allPassFacts({ goLiveApproved: false }), 'go_live')).toBe(false);
    expect(okOf(passingPartner({ status: 'suspended' }), allPassFacts(), 'go_live')).toBe(false);
    expect(okOf(passingPartner({ id: 'default' }), allPassFacts(), 'go_live')).toBe(false);
  });

  it("sanctions_list: only 'live' passes; 'stale' and 'not_live' fail", () => {
    expect(okOf(passingPartner(), allPassFacts({ listFitness: 'live' }), 'sanctions_list')).toBe(true);
    expect(okOf(passingPartner(), allPassFacts({ listFitness: 'stale' }), 'sanctions_list')).toBe(false);
    expect(okOf(passingPartner(), allPassFacts({ listFitness: 'not_live' }), 'sanctions_list')).toBe(false);
  });

  it('posture: unsigned fails', () => {
    const p = passingPartner({ liveControls: certifiedLiveControls({ complianceUsers: USERS }) });
    expect(okOf(p, allPassFacts(), 'posture')).toBe(false);
  });

  it("posture: kycDecider 'smartremit_procedures' with kycMode 'ours' (and absent kycMode) passes", () => {
    expect(okOf(passingPartner(), allPassFacts(), 'posture')).toBe(true);
    expect(okOf(passingPartner({ kycMode: undefined }), allPassFacts(), 'posture')).toBe(true);
  });

  it("posture: 'partner' with 'delegated' passes; a mismatch fails", () => {
    const lc = certifiedLiveControls({ posture: true, complianceUsers: USERS });
    const partnerDecides = withPosture(lc, { kycDecider: 'partner' });
    expect(okOf(passingPartner({ kycMode: 'delegated', liveControls: partnerDecides }), allPassFacts(), 'posture')).toBe(true);
    expect(okOf(passingPartner({ kycMode: 'ours', liveControls: partnerDecides }), allPassFacts(), 'posture')).toBe(false);
    expect(okOf(passingPartner({ kycMode: undefined, liveControls: partnerDecides }), allPassFacts(), 'posture')).toBe(false);
    expect(okOf(passingPartner({ kycMode: 'delegated', liveControls: lc }), allPassFacts(), 'posture')).toBe(false);
  });

  // pack 3 T9 inverted T2's 'no forcing yet' case: a signed posture now forces requireKyc itself.
  it('posture: a signed, matching posture passes the posture line even with requireKycBeforeSend false (T9 forcing)', () => {
    expect(okOf(passingPartner({ requireKycBeforeSend: false }), allPassFacts(), 'posture')).toBe(true);
    expect(okOf(passingPartner({ requireKycBeforeSend: undefined }), allPassFacts(), 'posture')).toBe(true);
  });

  it('posture: an unsigned posture with requireKycBeforeSend true still fails', () => {
    const p = passingPartner({ requireKycBeforeSend: true, liveControls: certifiedLiveControls({ complianceUsers: USERS }) });
    expect(okOf(p, allPassFacts(), 'posture')).toBe(false);
  });

  it('compliance_users: two listed, same tenant, admin or agent, active, MFA -> pass; one -> fail', () => {
    expect(okOf(passingPartner(), allPassFacts(), 'compliance_users')).toBe(true);
    const agents = allPassFacts({ complianceStaff: USERS.map((u) => staffFact(u, { role: 'agent' })) });
    expect(okOf(passingPartner(), agents, 'compliance_users')).toBe(true);
    const one = passingPartner({ liveControls: certifiedLiveControls({ posture: true, complianceUsers: ['acme-comp1'] }) });
    expect(okOf(one, allPassFacts(), 'compliance_users')).toBe(false);
    expect(okOf(passingPartner(), allPassFacts({ complianceStaff: [staffFact('acme-comp1')] }), 'compliance_users')).toBe(false);
  });

  it('compliance_users: another tenant, a platform user, support or finance, suspended, no MFA, or unlisted does not count', () => {
    const second = (o: Partial<StaffFact>) => allPassFacts({ complianceStaff: [staffFact('acme-comp1'), staffFact('acme-comp2', o)] });
    expect(okOf(passingPartner(), second({ partnerId: 'other' }), 'compliance_users')).toBe(false);
    expect(okOf(passingPartner(), second({ partnerId: undefined }), 'compliance_users')).toBe(false);
    expect(okOf(passingPartner(), second({ role: 'support' }), 'compliance_users')).toBe(false);
    expect(okOf(passingPartner(), second({ role: 'finance' }), 'compliance_users')).toBe(false);
    expect(okOf(passingPartner(), second({ active: false }), 'compliance_users')).toBe(false);
    expect(okOf(passingPartner(), second({ mfaEnrolled: false }), 'compliance_users')).toBe(false);
    // a facts entry for a username the partner did not list does not count
    const unlisted = allPassFacts({ complianceStaff: [staffFact('acme-comp1'), staffFact('acme-other')] });
    expect(okOf(passingPartner(), unlisted, 'compliance_users')).toBe(false);
    // the same listed user twice in the facts counts once
    const dup = allPassFacts({ complianceStaff: [staffFact('acme-comp1'), staffFact('acme-comp1')] });
    expect(okOf(passingPartner(), dup, 'compliance_users')).toBe(false);
  });

  it('own_whatsapp: follows facts.ownWhatsapp', () => {
    expect(okOf(passingPartner(), allPassFacts({ ownWhatsapp: true }), 'own_whatsapp')).toBe(true);
    expect(okOf(passingPartner(), allPassFacts({ ownWhatsapp: false }), 'own_whatsapp')).toBe(false);
  });

  it('contract: present passes, absent fails', () => {
    expect(okOf(passingPartner(), allPassFacts(), 'contract')).toBe(true);
    const lc = certifiedLiveControls({ posture: true, complianceUsers: USERS });
    delete lc.contract;
    expect(okOf(passingPartner({ liveControls: lc }), allPassFacts(), 'contract')).toBe(false);
  });
});

describe('provider_block (pack 4)', () => {
  const withBlock = (disclosure: unknown): P => passingPartner({ supportConfig: { disclosure: disclosure as never } });
  const stripped = () => {
    const { approval: _a, ...block } = approvedDisclosureConfig();
    void _a;
    return block;
  };
  // Re-stamp an edited block so only the edited field decides the line.
  const restamped = (block: Record<string, unknown>) => ({
    ...block,
    approval: { ...approvedDisclosureConfig().approval!, hash: disclosureHash(block) },
  });

  it('passes for a configured, approved block with licence, phone, website and regulator', () => {
    expect(line(liveReadiness(passingPartner(), allPassFacts()), 'provider_block')).toEqual({ id: 'provider_block', state: 'pass', ok: true });
  });

  it('fails with no block', () => {
    expect(okOf(passingPartner({ supportConfig: {} }), allPassFacts(), 'provider_block')).toBe(false);
  });

  it('fails for an unapproved block (no approval, or a stamp whose hash no longer matches after an edit)', () => {
    expect(okOf(withBlock(stripped()), allPassFacts(), 'provider_block')).toBe(false);
    const edited = { ...approvedDisclosureConfig(), phone: '+1 800 555 0111' };
    expect(okOf(withBlock(edited), allPassFacts(), 'provider_block')).toBe(false);
    // the same edit re-stamped passes (the fixture is sound)
    const { approval: _a, ...rest } = edited;
    void _a;
    expect(okOf(withBlock(restamped(rest)), allPassFacts(), 'provider_block')).toBe(true);
  });

  it('fails when licenseIds is empty / phone missing / website missing / regulator missing', () => {
    const b = stripped();
    expect(okOf(withBlock(restamped({ ...b, licenseIds: [] })), allPassFacts(), 'provider_block')).toBe(false);
    const { phone: _p, ...noPhone } = b;
    void _p;
    expect(okOf(withBlock(restamped(noPhone)), allPassFacts(), 'provider_block')).toBe(false);
    const { website: _w, ...noSite } = b;
    void _w;
    expect(okOf(withBlock(restamped(noSite)), allPassFacts(), 'provider_block')).toBe(false);
    const { stateRegulator: _r, ...noReg } = b;
    void _r;
    expect(okOf(withBlock(restamped(noReg)), allPassFacts(), 'provider_block')).toBe(false);
    // an http (not https) website reads as missing
    expect(okOf(withBlock(restamped({ ...b, website: 'http://acme.example' })), allPassFacts(), 'provider_block')).toBe(false);
  });

  it('fails for the default tenant even with an approved block', () => {
    expect(okOf(passingPartner({ id: 'default' }), allPassFacts(), 'provider_block')).toBe(false);
  });

  it('missing supportConfig does not throw', () => {
    const p = passingPartner({ supportConfig: undefined });
    expect(() => liveReadiness(p, allPassFacts())).not.toThrow();
    expect(okOf(p, allPassFacts(), 'provider_block')).toBe(false);
  });
});
