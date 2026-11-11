/**
 * Fix pack 5 T13b (P13 route pre-verify, M5): payMoneyGateRefusal, the
 * pre-verify copy of pay-process steps 5 (no unsigned rail) and 7 (no mock
 * funding on real money). Only a context that KNOWS the rail is real money
 * makes a read; everything else answers null with no read at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { freshDb, seedPartner } from './helpers-db';
import { seedRealMoneyRail } from './helpers-live';
import { setRailProviderType } from './helpers-sanctions';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { readPayGateContext, SAFE_PAY_GATE_CONTEXT } from '@/lib/pay-gate-context';

let db: Awaited<ReturnType<typeof freshDb>>;
const seam = vi.hoisted(() => ({
  integrationsCalls: 0,
  fundingCalls: 0,
  integrationsThrows: false,
  fundingThrows: false,
}));
vi.mock('@/lib/partner-integrations-store', async (orig) => {
  const real = await orig<typeof import('@/lib/partner-integrations-store')>();
  return {
    ...real,
    getPartnerIntegrationsStore: () => {
      const s = real.createPartnerIntegrationsStore(db);
      return {
        ...s,
        getIntegrations: async (id: string) => {
          seam.integrationsCalls++;
          if (seam.integrationsThrows) throw new Error('integrations-read-leak postgres://user:pw@host/db');
          return s.getIntegrations(id);
        },
        getFundingConfig: async (id: string) => {
          seam.fundingCalls++;
          if (seam.fundingThrows) throw new Error('funding-read-leak postgres://user:pw@host/db');
          return s.getFundingConfig(id);
        },
      };
    },
  };
});
const logWarn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn }));

import { payMoneyGateRefusal } from '@/lib/pay-money-gate';

type Subject = Parameters<typeof payMoneyGateRefusal>[1]['subject'];
const b2c = (o: Partial<Subject> = {}): Subject => ({
  transferType: 'b2c',
  fundingMethod: 'bank_transfer',
  partnerId: 'acme',
  settlementPartnerId: undefined,
  environment: undefined,
  fundingProvider: undefined,
  fundingIntentRef: undefined,
  ...o,
});
const ctxFor = (transferType: 'b2c' | 'b2b' = 'b2c') =>
  readPayGateContext(db, { ownerId: 'acme', railPartnerId: 'acme', environment: undefined, transferType });

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
  seam.integrationsCalls = 0;
  seam.fundingCalls = 0;
  seam.integrationsThrows = false;
  seam.fundingThrows = false;
  logWarn.mockReset();
  delete process.env.STRIPE_FUNDING_ENABLED;
});
afterEach(() => {
  delete process.env.STRIPE_FUNDING_ENABLED;
});

describe('payMoneyGateRefusal (P13 route pre-verify)', { retry: 0 }, () => {
  it('not realMoneyKnown: null and no read (the SAFE context, and a simulator rail)', async () => {
    process.env.STRIPE_FUNDING_ENABLED = 'true';
    expect(await payMoneyGateRefusal(db, { ctx: SAFE_PAY_GATE_CONTEXT, railPartnerId: 'acme', subject: b2c() })).toBeNull();
    await setRailProviderType(db, 'acme', 'simulator');
    const sim = await ctxFor();
    expect(sim.realMoneyKnown).toBe(false);
    expect(await payMoneyGateRefusal(db, { ctx: sim, railPartnerId: 'acme', subject: b2c() })).toBeNull();
    expect(seam.integrationsCalls).toBe(0);
    expect(seam.fundingCalls).toBe(0);
  });

  it("an http rail with no current signing secret: 'rail_unsigned'", async () => {
    await seedRealMoneyRail(db, 'acme', { signingSecret: null });
    const ctx = await ctxFor();
    expect(ctx.realMoneyKnown).toBe(true);
    expect(await payMoneyGateRefusal(db, { ctx, railPartnerId: 'acme', subject: b2c() })).toBe('rail_unsigned');
    expect(seam.fundingCalls).toBe(0);
  });

  it("an integrations read that throws: 'rail_unsigned' (fail closed), logged by error name only", async () => {
    await seedRealMoneyRail(db, 'acme');
    const ctx = await ctxFor();
    seam.integrationsThrows = true;
    expect(await payMoneyGateRefusal(db, { ctx, railPartnerId: 'acme', subject: b2c() })).toBe('rail_unsigned');
    expect(logWarn).toHaveBeenCalledWith('pay.money-gate', 'Error', { railPartnerId: 'acme' });
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain('postgres://');
  });

  it("a signed http rail, mock funding: 'mock_on_real_money' (flag off: no funding-config read)", async () => {
    await seedRealMoneyRail(db, 'acme');
    const ctx = await ctxFor();
    expect(await payMoneyGateRefusal(db, { ctx, railPartnerId: 'acme', subject: b2c() })).toBe('mock_on_real_money');
    expect(seam.fundingCalls).toBe(0);
  });

  it('flag on + Stripe config, unrouted: null', async () => {
    await seedRealMoneyRail(db, 'acme');
    await createPartnerIntegrationsStore(db).setFundingConfig('acme', { providerType: 'stripe', secretKey: 'rk_test_gate' });
    process.env.STRIPE_FUNDING_ENABLED = 'true';
    const ctx = await ctxFor();
    expect(await payMoneyGateRefusal(db, { ctx, railPartnerId: 'acme', subject: b2c() })).toBeNull();
    expect(seam.fundingCalls).toBe(1);
  });

  it('B2B bank_pull: null', async () => {
    await seedRealMoneyRail(db, 'acme');
    const ctx = await ctxFor('b2b');
    expect(
      await payMoneyGateRefusal(db, { ctx, railPartnerId: 'acme', subject: b2c({ transferType: 'b2b', fundingMethod: 'bank_pull' }) }),
    ).toBeNull();
  });

  it("a funding-config read that throws counts as no config: 'mock_on_real_money'", async () => {
    await seedRealMoneyRail(db, 'acme');
    process.env.STRIPE_FUNDING_ENABLED = 'true';
    const ctx = await ctxFor();
    seam.fundingThrows = true;
    expect(await payMoneyGateRefusal(db, { ctx, railPartnerId: 'acme', subject: b2c() })).toBe('mock_on_real_money');
    expect(logWarn).toHaveBeenCalledWith('pay.funding-config', 'Error', { railPartnerId: 'acme' });
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain('postgres://');
  });
});
