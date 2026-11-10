import { describe, it, expect } from 'vitest';
import {
  EMPTY_LIVE_CONTROLS,
  LIVE_CAPABILITIES,
  LIVE_CONTROLS_KEYS,
  parseLiveControls,
  postureSigned,
  type LiveControls,
} from '@/lib/live-controls';
import { capabilityOpen } from '@/lib/live-gate';

// Fix pack 3 T1 (contract 1): partners.live_controls is parsed per key and
// fails closed per key: a malformed key reads as absent, the others survive.

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const today = () => new Date().toISOString().slice(0, 10);

function fullRecord() {
  return {
    posture: {
      version: 1,
      signedBy: 'acme-admin',
      signedAt: iso(-3_600_000),
      kycDecider: 'partner',
      holdDecider: 'smartremit_delegated',
      requireKycBeforeSend: true,
      fourEyesNonSanctions: true,
    },
    certification: { certifiedAt: iso(-60_000), certifiedBy: 'ops-admin' },
    contract: { ref: 'MSA-2026-001', signedOn: today(), recordedBy: 'ops-admin', recordedAt: iso(-120_000) },
    optIns: {
      b2b: { counselRef: 'memo-1', counselBy: 'ops-admin', counselAt: iso(-1000), partnerApprovedBy: 'acme-admin', partnerApprovedAt: iso(-500) },
      usdc: { counselRef: 'memo-2', counselBy: 'ops-admin', counselAt: iso(-1000) },
    },
    complianceUsers: ['acme-admin', 'acme.mlro'],
  };
}

describe('parseLiveControls: root', () => {
  it('non-object root (null, [], x, 42, undefined) -> EMPTY_LIVE_CONTROLS', () => {
    for (const raw of [null, [], 'x', 42, undefined, true]) {
      expect(parseLiveControls(raw)).toEqual({ optIns: {}, complianceUsers: [] });
    }
  });

  it('EMPTY_LIVE_CONTROLS is frozen { optIns: {}, complianceUsers: [] }', () => {
    expect(EMPTY_LIVE_CONTROLS).toEqual({ optIns: {}, complianceUsers: [] });
    expect(Object.isFrozen(EMPTY_LIVE_CONTROLS)).toBe(true);
    expect(Object.isFrozen(EMPTY_LIVE_CONTROLS.optIns)).toBe(true);
    expect(Object.isFrozen(EMPTY_LIVE_CONTROLS.complianceUsers)).toBe(true);
  });

  it('the parser returns a fresh object, never the frozen EMPTY', () => {
    const a = parseLiveControls({});
    expect(a).not.toBe(EMPTY_LIVE_CONTROLS);
    expect(Object.isFrozen(a)).toBe(false);
    a.complianceUsers.push('x');
    expect(EMPTY_LIVE_CONTROLS.complianceUsers).toEqual([]);
    expect(parseLiveControls(null)).not.toBe(EMPTY_LIVE_CONTROLS);
  });
});

describe('parseLiveControls: keys', () => {
  it('a valid full record round-trips', () => {
    const rec = fullRecord();
    expect(parseLiveControls(JSON.parse(JSON.stringify(rec)))).toEqual(rec);
  });

  it('one malformed key is dropped, the others survive', () => {
    const rec = fullRecord();
    const raw = { ...rec, posture: { ...rec.posture, version: 2 } };
    const lc = parseLiveControls(raw);
    expect(lc.posture).toBeUndefined();
    expect(lc.certification).toEqual(rec.certification);
    expect(lc.contract).toEqual(rec.contract);

    const raw2 = { ...rec, contract: { ...rec.contract, signedOn: '2026-13-40' } };
    const lc2 = parseLiveControls(raw2);
    expect(lc2.contract).toBeUndefined();
    expect(lc2.posture).toEqual(rec.posture);
    expect(lc2.complianceUsers).toEqual(rec.complianceUsers);
  });

  it('contract signedOn must be YYYY-MM-DD and a real date', () => {
    const rec = fullRecord();
    for (const signedOn of ['2026-1-05', '20260105', 'yesterday', '2026-02-30', iso()]) {
      expect(parseLiveControls({ contract: { ...rec.contract, signedOn } }).contract).toBeUndefined();
    }
  });

  it('posture: version 1, requireKycBeforeSend true, kycDecider/holdDecider enums enforced', () => {
    const p = fullRecord().posture;
    expect(parseLiveControls({ posture: p }).posture).toEqual(p);
    expect(parseLiveControls({ posture: { ...p, version: 2 } }).posture).toBeUndefined();
    expect(parseLiveControls({ posture: { ...p, requireKycBeforeSend: false } }).posture).toBeUndefined();
    expect(parseLiveControls({ posture: { ...p, kycDecider: 'ours' } }).posture).toBeUndefined();
    expect(parseLiveControls({ posture: { ...p, kycDecider: 'smartremit_procedures' } }).posture?.kycDecider).toBe('smartremit_procedures');
    expect(parseLiveControls({ posture: { ...p, holdDecider: 'smartremit' } }).posture).toBeUndefined();
    expect(parseLiveControls({ posture: { ...p, holdDecider: 'partner' } }).posture?.holdDecider).toBe('partner');
    expect(parseLiveControls({ posture: { ...p, fourEyesNonSanctions: 'yes' } }).posture).toBeUndefined();
    const { signedBy: _drop, ...noSigner } = p;
    void _drop;
    expect(parseLiveControls({ posture: noSigner }).posture).toBeUndefined();
  });

  it('timestamps that do not Date.parse are refused', () => {
    const rec = fullRecord();
    expect(parseLiveControls({ certification: { certifiedAt: 'not a date', certifiedBy: 'x' } }).certification).toBeUndefined();
    expect(parseLiveControls({ posture: { ...rec.posture, signedAt: 'soon' } }).posture).toBeUndefined();
    expect(parseLiveControls({ contract: { ...rec.contract, recordedAt: '' } }).contract).toBeUndefined();
    expect(
      parseLiveControls({ certification: { ...rec.certification, revokedAt: 'never', revokedBy: 'x' } }).certification,
    ).toBeUndefined();
    const revoked = { ...rec.certification, revokedAt: iso(), revokedBy: 'ops-admin' };
    expect(parseLiveControls({ certification: revoked }).certification).toEqual(revoked);
    expect(parseLiveControls({ optIns: { b2b: { counselAt: 'later' } } }).optIns).toEqual({});
  });

  // Pack 3 review Q2 (G2): partnerApprovedAt is the only type guard on the
  // approval capabilityOpen reads (a truthy check), so a bad value must drop the opt-in.
  it('a malformed partnerApprovedAt drops that opt-in, so capabilityOpen stays closed for a certified partner', () => {
    const rec = fullRecord();
    for (const partnerApprovedAt of ['later', 'yes', '', true, 1]) {
      const lc = parseLiveControls({
        certification: rec.certification,
        optIns: { b2b: { counselRef: 'm', counselBy: 'ops-admin', counselAt: iso(-1000), partnerApprovedBy: 'acme-admin', partnerApprovedAt } },
      });
      expect(lc.certification, String(partnerApprovedAt)).toEqual(rec.certification);
      expect(lc.optIns, String(partnerApprovedAt)).toEqual({});
      expect(capabilityOpen({ id: 'acme', status: 'active', liveControls: lc }, 'b2b'), String(partnerApprovedAt)).toBe(false);
    }
    // The contrast: a real timestamp opens it.
    const ok = parseLiveControls({ certification: rec.certification, optIns: { b2b: rec.optIns.b2b } });
    expect(capabilityOpen({ id: 'acme', status: 'active', liveControls: ok }, 'b2b')).toBe(true);
  });

  it('a missing required field drops the key: certification without certifiedBy; posture without kycDecider, holdDecider, requireKycBeforeSend, version or fourEyesNonSanctions', () => {
    const rec = fullRecord();
    const { certifiedBy: _c, ...noCertifier } = rec.certification;
    void _c;
    expect(parseLiveControls({ certification: noCertifier }).certification).toBeUndefined();
    for (const field of ['kycDecider', 'holdDecider', 'requireKycBeforeSend', 'version', 'fourEyesNonSanctions', 'signedAt'] as const) {
      const p: Record<string, unknown> = { ...rec.posture };
      delete p[field];
      expect(parseLiveControls({ posture: p }).posture, field).toBeUndefined();
    }
  });

  it('strings over 200 chars are refused', () => {
    const rec = fullRecord();
    const long = 'a'.repeat(201);
    expect(parseLiveControls({ contract: { ...rec.contract, ref: long } }).contract).toBeUndefined();
    expect(parseLiveControls({ contract: { ...rec.contract, ref: 'a'.repeat(200) } }).contract?.ref).toHaveLength(200);
    expect(parseLiveControls({ certification: { ...rec.certification, certifiedBy: long } }).certification).toBeUndefined();
    expect(parseLiveControls({ optIns: { b2b: { counselRef: long } } }).optIns).toEqual({});
    expect(parseLiveControls({ posture: { ...rec.posture, signedBy: long } }).posture).toBeUndefined();
  });

  it('optIns: each capability parses alone; unknown capability ignored', () => {
    const good = { counselRef: 'memo-1', counselBy: 'ops', counselAt: iso() };
    const lc = parseLiveControls({ optIns: { b2b: good, usdc: { counselRef: 42 }, wire: good, schedules: {} } });
    expect(lc.optIns).toEqual({ b2b: good, schedules: {} });
    expect(parseLiveControls({ optIns: 'x' }).optIns).toEqual({});
    expect(parseLiveControls({ optIns: [good] }).optIns).toEqual({});
  });

  it('complianceUsers: deduped; a bad username, over 20 entries or a non-array -> []', () => {
    expect(parseLiveControls({ complianceUsers: ['a', 'b', 'a'] }).complianceUsers).toEqual(['a', 'b']);
    expect(parseLiveControls({ complianceUsers: ['a', 'Bad Name'] }).complianceUsers).toEqual([]);
    expect(parseLiveControls({ complianceUsers: ['a', ''] }).complianceUsers).toEqual([]);
    expect(parseLiveControls({ complianceUsers: ['x'.repeat(65)] }).complianceUsers).toEqual([]);
    expect(parseLiveControls({ complianceUsers: [42] }).complianceUsers).toEqual([]);
    const twenty = Array.from({ length: 20 }, (_, i) => `u${i}`);
    expect(parseLiveControls({ complianceUsers: twenty }).complianceUsers).toEqual(twenty);
    expect(parseLiveControls({ complianceUsers: [...twenty, 'u20'] }).complianceUsers).toEqual([]);
    expect(parseLiveControls({ complianceUsers: 'a' }).complianceUsers).toEqual([]);
    expect(parseLiveControls({ complianceUsers: ['ok.user_1-x'] }).complianceUsers).toEqual(['ok.user_1-x']);
  });

  it('reserved keys fundingMode, licence, retentionYears are copied, never validated', () => {
    const lc = parseLiveControls({ fundingMode: { anything: [1, 2] }, licence: 'x'.repeat(500), retentionYears: -3 });
    expect(lc.fundingMode).toEqual({ anything: [1, 2] });
    expect(lc.licence).toBe('x'.repeat(500));
    expect(lc.retentionYears).toBe(-3);
    expect('fundingMode' in parseLiveControls({})).toBe(false);
  });

  it('unknown top-level keys are not copied', () => {
    expect(parseLiveControls({ surprise: 1 })).toEqual({ optIns: {}, complianceUsers: [] });
  });
});

describe('postureSigned and the pinned lists', () => {
  it('postureSigned: undefined / no posture false; posture true', () => {
    expect(postureSigned(undefined)).toBe(false);
    expect(postureSigned(parseLiveControls({}))).toBe(false);
    const lc: LiveControls = parseLiveControls(fullRecord());
    expect(postureSigned(lc)).toBe(true);
  });

  it('LIVE_CAPABILITIES and LIVE_CONTROLS_KEYS pinned', () => {
    expect(LIVE_CAPABILITIES).toEqual(['b2b', 'usdc', 'telegram', 'mcp', 'schedules']);
    expect(LIVE_CONTROLS_KEYS).toEqual(['posture', 'certification', 'contract', 'optIns', 'complianceUsers']);
  });
});

describe('parseLiveControls never throws', () => {
  it('a throwing getter, a cyclic object', () => {
    const throwing = {};
    Object.defineProperty(throwing, 'posture', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(() => parseLiveControls(throwing)).not.toThrow();
    expect(parseLiveControls(throwing)).toEqual({ optIns: {}, complianceUsers: [] });

    const cyclic: Record<string, unknown> = { complianceUsers: ['a'] };
    cyclic.posture = cyclic;
    cyclic.optIns = { b2b: cyclic };
    cyclic.fundingMode = cyclic;
    expect(() => parseLiveControls(cyclic)).not.toThrow();
    const lc = parseLiveControls(cyclic);
    expect(lc.posture).toBeUndefined();
    expect(lc.complianceUsers).toEqual(['a']);

    const throwingOpt = { optIns: {} };
    Object.defineProperty(throwingOpt.optIns, 'b2b', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(() => parseLiveControls(throwingOpt)).not.toThrow();
  });
});
