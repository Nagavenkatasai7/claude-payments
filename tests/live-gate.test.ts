import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  capabilityOpen,
  isLiveCertified,
  liveMoneyRefusal,
  liveRefusalFor,
  liveRefusalForRail,
  realMoneyRail,
  railPartnerOf,
  readRailProviderType,
  realMoneyFor,
  settlementTargetUrl,
} from '@/lib/live-gate';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import type { LiveControls } from '@/lib/live-controls';
import { env } from '@/lib/env';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import type { Db, DbOrTx } from '@/db/client';
import type { Partner, PartnerId } from '@/lib/types';
import { captureQueries, freshDb, seedPartner } from './helpers-db';
import { certifiedLiveControls, certifyPartnerForTest } from './helpers-live';

// Fix pack 2 (R02): "real money" is a real `http` rail on a non-test transfer.
// A failed rail read counts as real money (fail closed).

async function setRail(db: Db, partnerId: string, providerType: string) {
  await db.execute(sql`
    INSERT INTO partner_integrations (partner_id, payment_provider_type) VALUES (${partnerId}, ${providerType})
    ON CONFLICT (partner_id) DO UPDATE SET payment_provider_type = ${providerType}`);
}

const pid = (s: string) => s as PartnerId;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('realMoneyRail', () => {
  it('test+http false; live+http true; live+simulator/mock/null false; live+undefined true; env undefined+http true', () => {
    expect(realMoneyRail({ environment: 'test', railProviderType: 'http' })).toBe(false);
    expect(realMoneyRail({ environment: 'test', railProviderType: undefined })).toBe(false);
    expect(realMoneyRail({ environment: 'live', railProviderType: 'http' })).toBe(true);
    expect(realMoneyRail({ environment: 'live', railProviderType: 'simulator' })).toBe(false);
    expect(realMoneyRail({ environment: 'live', railProviderType: 'mock' })).toBe(false);
    expect(realMoneyRail({ environment: 'live', railProviderType: null })).toBe(false);
    expect(realMoneyRail({ environment: 'live', railProviderType: undefined })).toBe(true);
    expect(realMoneyRail({ environment: undefined, railProviderType: 'http' })).toBe(true);
    expect(realMoneyRail({ environment: undefined, railProviderType: 'mock' })).toBe(false);
  });
});

describe('railPartnerOf', () => {
  it('settlementPartnerId wins; undefined/null falls back to partnerId', () => {
    expect(railPartnerOf({ partnerId: pid('owner'), settlementPartnerId: pid('rail') })).toBe('rail');
    expect(railPartnerOf({ partnerId: pid('owner') })).toBe('owner');
    expect(railPartnerOf({ partnerId: pid('owner'), settlementPartnerId: undefined })).toBe('owner');
    expect(railPartnerOf({ partnerId: pid('owner'), settlementPartnerId: null })).toBe('owner');
  });
});

describe('readRailProviderType / realMoneyFor', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, 'acme');
    await seedPartner(db, 'sim');
  });

  it('readRailProviderType: row -> its value; no row -> null; throwing db -> undefined and no throw', async () => {
    await setRail(db, 'acme', 'http');
    expect(await readRailProviderType(db, pid('acme'))).toBe('http');
    expect(await readRailProviderType(db, pid('sim'))).toBeNull();
    const broken = {
      select: () => {
        throw new Error('connection reset');
      },
    } as unknown as DbOrTx;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(readRailProviderType(broken, pid('acme'))).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("realMoneyFor: 'test' makes zero queries", async () => {
    await setRail(db, 'acme', 'http');
    const stop = captureQueries();
    const r = await realMoneyFor(db, { partnerId: pid('acme'), environment: 'test' });
    const qs = stop();
    expect(r).toBe(false);
    expect(qs).toHaveLength(0);
  });

  it('realMoneyFor: default owner routed to an http partner -> true; http owner routed to a simulator partner -> false', async () => {
    await setRail(db, 'acme', 'http');
    await setRail(db, 'sim', 'simulator');
    expect(await realMoneyFor(db, { partnerId: DEFAULT_PARTNER_ID, settlementPartnerId: pid('acme'), environment: 'live' })).toBe(true);
    expect(await realMoneyFor(db, { partnerId: pid('acme'), settlementPartnerId: pid('sim'), environment: 'live' })).toBe(false);
    expect(await realMoneyFor(db, { partnerId: pid('acme'), environment: undefined })).toBe(true);
    expect(await realMoneyFor(db, { partnerId: pid('sim'), environment: 'live' })).toBe(false);
  });
});

describe('settlementTargetUrl (T10)', () => {
  it('settlementTargetUrl: http stored; simulator, mock, undefined hosted', () => {
    const hosted = `${env.appBaseUrl}/api/partner-rail`;
    const creds = { settlementUrl: 'https://rail.partner.example/settle', signingSecret: 's' };
    expect(settlementTargetUrl({ providerType: 'http', credentials: creds })).toBe('https://rail.partner.example/settle');
    expect(settlementTargetUrl({ providerType: 'http' })).toBe('');
    expect(settlementTargetUrl({ providerType: 'http', credentials: {} })).toBe('');
    expect(settlementTargetUrl({ providerType: 'simulator', credentials: creds })).toBe(hosted);
    expect(settlementTargetUrl({ providerType: 'simulator' })).toBe(hosted);
    expect(settlementTargetUrl({ providerType: 'mock', credentials: creds })).toBe(hosted);
    expect(settlementTargetUrl({ credentials: creds })).toBe(hosted);
    expect(settlementTargetUrl({})).toBe(hosted);
  });
});


// ── Fix pack 3 T1 (contract 3): the live certification predicates ──────────

type LP = Pick<Partner, 'id' | 'status' | 'liveControls'>;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const lp = (id: string, liveControls?: LiveControls, status: Partner['status'] = 'active'): LP => ({
  id: pid(id),
  status,
  liveControls,
});
const certified = (id = 'acme') => lp(id, certifiedLiveControls());

describe('isLiveCertified', () => {
  it("null false; 'default' false even when certified; suspended false; no certification false; certified true; revokedAt >= certifiedAt false; re-certified after a revoke true", () => {
    expect(isLiveCertified(null)).toBe(false);
    expect(isLiveCertified(undefined)).toBe(false);
    expect(isLiveCertified(lp(DEFAULT_PARTNER_ID, certifiedLiveControls()))).toBe(false);
    expect(isLiveCertified(lp('acme', certifiedLiveControls(), 'suspended'))).toBe(false);
    expect(isLiveCertified(lp('acme', { optIns: {}, complianceUsers: [] }))).toBe(false);
    expect(isLiveCertified(lp('acme'))).toBe(false);
    expect(isLiveCertified(certified())).toBe(true);
    const at = iso(-60_000);
    const revoked = (revokedAt: string): LiveControls => ({
      ...certifiedLiveControls(),
      certification: { certifiedAt: at, certifiedBy: 'a', revokedAt, revokedBy: 'b' },
    });
    expect(isLiveCertified(lp('acme', revoked(at)))).toBe(false);
    expect(isLiveCertified(lp('acme', revoked(iso(-1000))))).toBe(false);
    // Re-certified after a revoke: certifiedAt moves past the old revokedAt.
    const recert: LiveControls = {
      ...certifiedLiveControls(),
      certification: { certifiedAt: iso(-1000), certifiedBy: 'a', revokedAt: iso(-60_000), revokedBy: 'b' },
    };
    expect(isLiveCertified(lp('acme', recert))).toBe(true);
  });
});

describe('liveMoneyRefusal', () => {
  it("realMoney false -> null; owner 'default' -> default_on_live_rail even with a certified rail; uncertified rail -> live_not_certified; certified -> null", () => {
    expect(liveMoneyRefusal({ realMoney: false, ownerId: DEFAULT_PARTNER_ID, rail: null })).toBeNull();
    expect(liveMoneyRefusal({ realMoney: false, ownerId: pid('acme'), rail: lp('acme') })).toBeNull();
    expect(liveMoneyRefusal({ realMoney: true, ownerId: DEFAULT_PARTNER_ID, rail: certified() })).toBe('default_on_live_rail');
    expect(liveMoneyRefusal({ realMoney: true, ownerId: pid('acme'), rail: lp('acme') })).toBe('live_not_certified');
    expect(liveMoneyRefusal({ realMoney: true, ownerId: pid('acme'), rail: null })).toBe('live_not_certified');
    expect(liveMoneyRefusal({ realMoney: true, ownerId: pid('acme'), rail: certified() })).toBeNull();
  });
});

describe('capabilityOpen', () => {
  it('uncertified -> true; certified -> needs counselRef AND partnerApprovedAt', () => {
    expect(capabilityOpen(null, 'b2b')).toBe(true);
    expect(capabilityOpen(lp('acme'), 'b2b')).toBe(true);
    expect(capabilityOpen(lp(DEFAULT_PARTNER_ID, certifiedLiveControls({ optIns: [] })), 'b2b')).toBe(true);
    expect(capabilityOpen(lp('acme', certifiedLiveControls({ optIns: [] })), 'b2b')).toBe(false);
    expect(capabilityOpen(certified(), 'usdc')).toBe(true);
    const base = certifiedLiveControls({ optIns: [] });
    const counselOnly: LiveControls = { ...base, optIns: { b2b: { counselRef: 'memo', counselBy: 'a', counselAt: iso(-1) } } };
    const approvedOnly: LiveControls = { ...base, optIns: { b2b: { partnerApprovedBy: 'p', partnerApprovedAt: iso(-1) } } };
    const both: LiveControls = { ...base, optIns: { b2b: { counselRef: 'memo', partnerApprovedAt: iso(-1) } } };
    expect(capabilityOpen(lp('acme', counselOnly), 'b2b')).toBe(false);
    expect(capabilityOpen(lp('acme', approvedOnly), 'b2b')).toBe(false);
    expect(capabilityOpen(lp('acme', both), 'b2b')).toBe(true);
    expect(capabilityOpen(lp('acme', both), 'usdc')).toBe(false);
  });
});

/** A db whose first `allowed` select calls pass through and every later one throws. */
function failingAfter(db: Db, allowed: number): DbOrTx {
  let n = 0;
  return new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop === 'select') {
        return (...args: unknown[]) => {
          n += 1;
          if (n > allowed) throw new Error('connection reset');
          return (target as Db).select(...(args as Parameters<Db['select']>));
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as DbOrTx;
}

describe('liveRefusalFor / liveRefusalForRail', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, 'acme');
    await seedPartner(db, 'sim');
    await setRail(db, 'acme', 'http');
    await setRail(db, 'sim', 'simulator');
  });

  it("liveRefusalFor: 'test' -> null with zero queries; simulator -> null; http uncertified -> live_not_certified; http certified -> null; default owner routed to a certified http rail -> default_on_live_rail", async () => {
    const stop = captureQueries();
    expect(await liveRefusalFor(db, { partnerId: pid('acme'), environment: 'test' })).toBeNull();
    expect(stop()).toHaveLength(0);
    expect(await liveRefusalFor(db, { partnerId: pid('sim'), environment: 'live' })).toBeNull();
    expect(await liveRefusalFor(db, { partnerId: pid('acme'), environment: 'live' })).toBe('live_not_certified');
    expect(await liveRefusalFor(db, { partnerId: pid('sim'), settlementPartnerId: pid('acme'), environment: 'live' })).toBe('live_not_certified');
    await certifyPartnerForTest(db, pid('acme'));
    expect(await liveRefusalFor(db, { partnerId: pid('acme'), environment: 'live' })).toBeNull();
    expect(await liveRefusalFor(db, { partnerId: pid('sim'), settlementPartnerId: pid('acme'), environment: 'live' })).toBeNull();
    expect(
      await liveRefusalFor(db, { partnerId: DEFAULT_PARTNER_ID, settlementPartnerId: pid('acme'), environment: 'live' }),
    ).toBe('default_on_live_rail');
    // The default tenant's own mock rail is not real money.
    expect(await liveRefusalFor(db, { partnerId: DEFAULT_PARTNER_ID, environment: 'live' })).toBeNull();
  });

  it('liveRefusalFor: rail type read fails -> refused; partner read fails -> live_not_certified; never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await certifyPartnerForTest(db, pid('acme'));
    await certifyPartnerForTest(db, pid('sim'));
    // Every read fails: the rail type reads as real money, the partner as not certified.
    expect(await liveRefusalFor(failingAfter(db, 0), { partnerId: pid('sim'), environment: 'live' })).toBe('live_not_certified');
    expect(await liveRefusalFor(failingAfter(db, 0), { partnerId: DEFAULT_PARTNER_ID, environment: 'live' })).toBe('default_on_live_rail');
    // The rail-type read succeeds ('http'), the partner read fails.
    expect(await liveRefusalFor(failingAfter(db, 1), { partnerId: pid('acme'), environment: 'live' })).toBe('live_not_certified');
    const lines = warn.mock.calls.map((c) => String(c[0]));
    const partnerRead = lines.filter((l) => l.includes('live-gate.partner_read'));
    expect(partnerRead.length).toBeGreaterThan(0);
    for (const l of partnerRead) {
      const parsed = JSON.parse(l) as Record<string, unknown>;
      expect(parsed.msg).toBe('Error');
      expect(parsed.partnerId).toBeDefined();
      expect(l).not.toContain('connection reset');
    }
    warn.mockRestore();
  });

  it("liveRefusalForRail: the given type decides (no rail-type read); null / 'mock' / 'simulator' -> null with zero queries; 'http' + owner 'default' -> default_on_live_rail with zero queries", async () => {
    for (const type of [null, 'mock', 'simulator']) {
      const stop = captureQueries();
      expect(await liveRefusalForRail(db, { partnerId: pid('acme'), environment: 'live' }, type)).toBeNull();
      expect(stop()).toHaveLength(0);
    }
    const stop = captureQueries();
    expect(
      await liveRefusalForRail(db, { partnerId: DEFAULT_PARTNER_ID, settlementPartnerId: pid('acme'), environment: 'live' }, 'http'),
    ).toBe('default_on_live_rail');
    expect(stop()).toHaveLength(0);
  });

  it("liveRefusalForRail: 'http' uncertified -> live_not_certified; 'http' certified -> null; never a partner_integrations select", async () => {
    // 'sim' is a simulator rail in the table: the GIVEN type wins.
    let stop = captureQueries();
    expect(await liveRefusalForRail(db, { partnerId: pid('sim'), environment: 'live' }, 'http')).toBe('live_not_certified');
    let qs = stop();
    expect(qs.some((q) => q.sql.includes('partner_integrations'))).toBe(false);
    expect(qs.some((q) => q.sql.includes('"partners"'))).toBe(true);
    await certifyPartnerForTest(db, pid('sim'));
    stop = captureQueries();
    expect(await liveRefusalForRail(db, { partnerId: pid('sim'), environment: 'live' }, 'http')).toBeNull();
    qs = stop();
    expect(qs.some((q) => q.sql.includes('partner_integrations'))).toBe(false);
    // 'acme' is http in the table but the caller says simulator: not real money.
    expect(await liveRefusalForRail(db, { partnerId: pid('acme'), environment: 'live' }, 'simulator')).toBeNull();
  });

  it("liveRefusalForRail: undefined (caller's read failed) -> treated as real money; env 'test' -> null", async () => {
    expect(await liveRefusalForRail(db, { partnerId: pid('sim'), environment: 'live' }, undefined)).toBe('live_not_certified');
    await certifyPartnerForTest(db, pid('sim'));
    expect(await liveRefusalForRail(db, { partnerId: pid('sim'), environment: 'live' }, undefined)).toBeNull();
    const stop = captureQueries();
    expect(await liveRefusalForRail(db, { partnerId: pid('acme'), environment: 'test' }, 'http')).toBeNull();
    expect(await liveRefusalForRail(db, { partnerId: DEFAULT_PARTNER_ID, environment: 'test' }, undefined)).toBeNull();
    expect(stop()).toHaveLength(0);
  });

  it('liveRefusalForRail: a partner read failure -> live_not_certified, never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await certifyPartnerForTest(db, pid('acme'));
    await expect(liveRefusalForRail(failingAfter(db, 0), { partnerId: pid('acme'), environment: 'live' }, 'http')).resolves.toBe(
      'live_not_certified',
    );
    warn.mockRestore();
  });

  it('reads the partner from the DB (createPartnerRepo), the same row getPartner returns', async () => {
    await certifyPartnerForTest(db, pid('acme'));
    expect(isLiveCertified(await createPartnerRepo(db).getPartner(pid('acme')))).toBe(true);
    await db.execute(sql`UPDATE partners SET status = 'suspended' WHERE id = 'acme'`);
    expect(await liveRefusalForRail(db, { partnerId: pid('acme'), environment: 'live' }, 'http')).toBe('live_not_certified');
  });
});
