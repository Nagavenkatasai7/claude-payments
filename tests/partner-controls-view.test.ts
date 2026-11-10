import { describe, it, expect } from 'vitest';
import { controlsView, capabilityRows } from '@/lib/partner-controls-view';
import { PARTNER_FLAG_KEYS } from '@/lib/flag-switch';
import { LIVE_CAPABILITIES, EMPTY_LIVE_CONTROLS, type LiveControls } from '@/lib/live-controls';
import type { FlagRow } from '@/db/repos/feature-flag-repo';
import { certifiedLiveControls } from './helpers-live';

// Fix pack 3 T11 (R26, R13; contract 18): the PURE half of /partner/controls. The switches view
// shows this tenant's own rows (with its own username) and the platform rows that touch it as
// read-only 'SmartRemit' lines; never another tenant's row, a platform username or a reason.

const at = new Date(Date.now() - 60_000);
const row = (o: Partial<FlagRow>): FlagRow => ({
  key: 'sends.paused',
  scopeType: 'partner',
  scopeId: 'tenant:acme',
  enabled: true,
  reason: 'TENANT_SECRET_REASON',
  updatedBy: 'acme-admin',
  updatedAt: at,
  ...o,
});
const byKey = (v: ReturnType<typeof controlsView>, key: string) => v.find((s) => s.key === key)!;

describe('controlsView', () => {
  it('one entry per PARTNER_FLAG_KEYS, in order; no row = nothing on', () => {
    const v = controlsView([], 'acme');
    expect(v.map((s) => s.key)).toEqual([...PARTNER_FLAG_KEYS]);
    for (const s of v) {
      expect(s.workspace).toEqual({ on: false });
      expect(s.corridors).toEqual([]);
      expect(s.platform).toEqual([]);
    }
    expect(byKey(v, 'sends.paused').tenantCorridor).toBe(true);
    expect(byKey(v, 'agent.paused').tenantCorridor).toBe(false);
  });

  it('tenant:acme on -> workspace { on, by }; tenant:acme:IN -> a corridor entry', () => {
    const v = controlsView(
      [row({}), row({ key: 'settlement.paused', scopeId: 'tenant:acme:IN', updatedBy: 'acme-ops' })],
      'acme',
    );
    expect(byKey(v, 'sends.paused').workspace).toEqual({ on: true, by: 'acme-admin', at: at.toISOString() });
    expect(byKey(v, 'settlement.paused').workspace).toEqual({ on: false });
    expect(byKey(v, 'settlement.paused').corridors).toEqual([{ corridor: 'IN', by: 'acme-ops', at: at.toISOString() }]);
  });

  it('off rows, another tenant, unparsable tenant ids, unknown keys and corridor rows on a no-corridor key -> nothing', () => {
    const v = controlsView(
      [
        row({ enabled: false }),
        row({ scopeId: 'tenant:globex', updatedBy: 'globex-admin' }),
        row({ scopeId: 'tenant:globex:IN', updatedBy: 'globex-admin' }),
        row({ scopeId: 'tenant:' }),
        row({ scopeId: 'tenant:acme:ZZ' }),
        row({ scopeId: 'tenant:acme:IN:x' }),
        row({ key: 'voice.notes' }),
        row({ key: 'nope.key' }),
        row({ key: 'agent.paused', scopeId: 'tenant:acme:IN' }),
        row({ scopeType: 'partner', scopeId: 'globex', updatedBy: 'owner-admin' }),
      ],
      'acme',
    );
    for (const s of v) {
      expect(s.workspace, s.key).toEqual({ on: false });
      expect(s.corridors, s.key).toEqual([]);
      expect(s.platform, s.key).toEqual([]);
    }
    expect(JSON.stringify(v)).not.toContain('globex');
  });

  it("platform rows (global, partner:acme, corridor IN) are read-only 'SmartRemit' lines; no platform username or reason in the output JSON", () => {
    const v = controlsView(
      [
        row({ scopeType: 'global', scopeId: '', updatedBy: 'owner-admin', reason: 'PLATFORM_SECRET_REASON' }),
        row({ key: 'settlement.paused', scopeType: 'partner', scopeId: 'acme', updatedBy: 'owner-admin', reason: 'PLATFORM_SECRET_REASON' }),
        row({ key: 'agent.paused', scopeType: 'corridor', scopeId: 'IN', updatedBy: 'owner-admin', reason: 'PLATFORM_SECRET_REASON' }),
        row({ key: 'agent.tools.paused', scopeType: 'partner', scopeId: 'tenant:acme' }),
      ],
      'acme',
    );
    expect(byKey(v, 'sends.paused').platform).toEqual([{ scope: 'global', by: 'SmartRemit' }]);
    expect(byKey(v, 'settlement.paused').platform).toEqual([{ scope: 'partner', by: 'SmartRemit' }]);
    expect(byKey(v, 'agent.paused').platform).toEqual([{ scope: 'corridor', corridor: 'IN', by: 'SmartRemit' }]);
    // A platform row never turns the tenant's own switch on (only the tenant's own row does).
    expect(byKey(v, 'sends.paused').workspace).toEqual({ on: false });
    expect(byKey(v, 'agent.tools.paused').workspace).toMatchObject({ on: true, by: 'acme-admin' });
    const json = JSON.stringify(v);
    for (const s of ['owner-admin', 'PLATFORM_SECRET_REASON', 'TENANT_SECRET_REASON']) expect(json).not.toContain(s);
  });
});

describe('capabilityRows', () => {
  it('one row per LIVE_CAPABILITIES; uncertified -> every capability open, none approvable', () => {
    const rows = capabilityRows(EMPTY_LIVE_CONTROLS, false);
    expect(rows.map((r) => r.cap)).toEqual([...LIVE_CAPABILITIES]);
    for (const r of rows) {
      expect(r).toEqual({ cap: r.cap, counsel: false, approved: false, open: true, canApprove: false, canWithdraw: false });
    }
    expect(capabilityRows(undefined, false).map((r) => r.open)).toEqual(LIVE_CAPABILITIES.map(() => true));
  });

  it('uncertified with counsel on record: still open, not approvable', () => {
    const lc: LiveControls = { ...EMPTY_LIVE_CONTROLS, optIns: { b2b: { counselRef: 'SECRET_COUNSEL_REF', counselBy: 'owner-admin', counselAt: at.toISOString() } } };
    const b2b = capabilityRows(lc, false)[0];
    expect(b2b).toMatchObject({ cap: 'b2b', counsel: true, approved: false, open: true, canApprove: false });
  });

  it('certified: counsel without approval -> closed and approvable; approved -> open and withdrawable; no counsel -> closed, not approvable', () => {
    const lc = certifiedLiveControls({ optIns: ['usdc'] });
    lc.optIns.b2b = { counselRef: 'SECRET_COUNSEL_REF', counselBy: 'owner-admin', counselAt: at.toISOString() };
    const rows = capabilityRows(lc, true);
    const get = (c: string) => rows.find((r) => r.cap === c)!;
    expect(get('b2b')).toEqual({ cap: 'b2b', counsel: true, approved: false, open: false, canApprove: true, canWithdraw: false });
    expect(get('usdc')).toEqual({
      cap: 'usdc',
      counsel: true,
      approved: true,
      approvedBy: 'test-partner-admin',
      approvedAt: lc.optIns.usdc!.partnerApprovedAt,
      open: true,
      canApprove: false,
      canWithdraw: true,
    });
    expect(get('mcp')).toEqual({ cap: 'mcp', counsel: false, approved: false, open: false, canApprove: false, canWithdraw: false });
    const json = JSON.stringify(rows);
    for (const s of ['SECRET_COUNSEL_REF', 'test-counsel', 'owner-admin', 'test-admin']) expect(json).not.toContain(s);
  });
});
