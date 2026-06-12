import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { effectiveRateFor, selectSettlementRoute } from '@/lib/partner-rates';
import type { PartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import type { Db } from '@/db/client';
import type { PartnerRate } from '@/lib/types';

const MID = 85;
const NOW = new Date();
const inHours = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

const baseRate = (over: Partial<PartnerRate>): PartnerRate => ({
  id: 'r', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR',
  updatedAt: NOW.toISOString(), ...over,
});

// A stub integrations store: per-partner payment config, everything else empty.
function stubIntegrations(byPartner: Record<string, PartnerIntegrations['payment']>): PartnerIntegrationsStore {
  return {
    getIntegrations: async (partnerId: string) => ({
      kyc: {}, whatsapp: {}, payment: byPartner[partnerId] ?? {},
    }),
  } as unknown as PartnerIntegrationsStore;
}

const ROUTABLE = { providerType: 'simulator', credentials: { settlementUrl: 'https://rail.test/x', signingSecret: 's' } };

describe('effectiveRateFor (pure)', () => {
  it('fresh pushed rate wins over margin', () => {
    const r = baseRate({ effectiveRate: 86.5, expiresAt: inHours(1), marginBps: 10 });
    expect(effectiveRateFor(r, MID, NOW)).toBe(86.5);
  });

  it('expired push falls back to the margin', () => {
    const r = baseRate({ effectiveRate: 86.5, expiresAt: inHours(-1), marginBps: 100 });
    expect(effectiveRateFor(r, MID, NOW)).toBeCloseTo(MID * 1.01, 6);
  });

  it('a push with no expiry never competes (freshness is mandatory)', () => {
    expect(effectiveRateFor(baseRate({ effectiveRate: 86.5 }), MID, NOW)).toBeNull();
  });

  it('margin is signed: negative means worse than mid', () => {
    expect(effectiveRateFor(baseRate({ marginBps: -50 }), MID, NOW)).toBeCloseTo(MID * 0.995, 6);
  });

  it('no push, no margin ⇒ not competing', () => {
    expect(effectiveRateFor(baseRate({}), MID, NOW)).toBeNull();
  });
});

describe('selectSettlementRoute (PGlite)', () => {
  let db: Db;

  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, 'p1');
    await seedPartner(db, 'p2');
  });

  it('no candidates ⇒ platform mid (today exactly)', async () => {
    const route = await selectSettlementRoute(db, stubIntegrations({}), 'USD', 'INR', MID);
    expect(route).toEqual({ fxRate: MID, source: 'platform' });
  });

  it('the best strictly-better partner with a routable rail wins', async () => {
    const repo = createPartnerRateRepo(db);
    await repo.upsertRate({ id: 'a', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 86, expiresAt: inHours(1) });
    await repo.upsertRate({ id: 'b', partnerId: 'p2', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 87, expiresAt: inHours(1) });
    const route = await selectSettlementRoute(
      db, stubIntegrations({ p1: ROUTABLE, p2: ROUTABLE }), 'USD', 'INR', MID,
    );
    expect(route).toEqual({ fxRate: 87, source: 'partner', settlementPartnerId: 'p2' });
  });

  it('a winner without a usable rail is skipped — next-best routable partner wins', async () => {
    const repo = createPartnerRateRepo(db);
    await repo.upsertRate({ id: 'a', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 86, expiresAt: inHours(1) });
    await repo.upsertRate({ id: 'b', partnerId: 'p2', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 87, expiresAt: inHours(1) });
    const route = await selectSettlementRoute(
      db,
      stubIntegrations({
        p1: ROUTABLE,
        p2: { providerType: 'mock' }, // best rate but mock rail — would fake-deliver real money
      }),
      'USD', 'INR', MID,
    );
    expect(route).toEqual({ fxRate: 86, source: 'partner', settlementPartnerId: 'p1' });
  });

  it('an empty settlementUrl disqualifies even an http rail', async () => {
    const repo = createPartnerRateRepo(db);
    await repo.upsertRate({ id: 'a', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 88, expiresAt: inHours(1) });
    const route = await selectSettlementRoute(
      db, stubIntegrations({ p1: { providerType: 'http', credentials: { settlementUrl: '  ' } } }), 'USD', 'INR', MID,
    );
    expect(route.source).toBe('platform');
  });

  it('a rate merely EQUAL to mid never wins (strictly better required)', async () => {
    const repo = createPartnerRateRepo(db);
    await repo.upsertRate({ id: 'a', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: MID, expiresAt: inHours(1) });
    const route = await selectSettlementRoute(db, stubIntegrations({ p1: ROUTABLE }), 'USD', 'INR', MID);
    expect(route.source).toBe('platform');
  });

  it('margin-only competitor wins via mid * (1 + bps/10000)', async () => {
    const repo = createPartnerRateRepo(db);
    await repo.upsertRate({ id: 'a', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', marginBps: 100 });
    const route = await selectSettlementRoute(db, stubIntegrations({ p1: ROUTABLE }), 'USD', 'INR', MID);
    expect(route.source).toBe('partner');
    expect(route.fxRate).toBeCloseTo(MID * 1.01, 6);
  });

  it('the default partner is never a contender even with a rate row', async () => {
    const repo = createPartnerRateRepo(db);
    await repo.upsertRate({ id: 'a', partnerId: 'default', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 99, expiresAt: inHours(1) });
    const route = await selectSettlementRoute(db, stubIntegrations({ default: ROUTABLE }), 'USD', 'INR', MID);
    expect(route.source).toBe('platform');
  });

  it('an integrations read failure skips the contender instead of throwing', async () => {
    const repo = createPartnerRateRepo(db);
    await repo.upsertRate({ id: 'a', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 87, expiresAt: inHours(1) });
    await repo.upsertRate({ id: 'b', partnerId: 'p2', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 86, expiresAt: inHours(1) });
    const throwing = {
      getIntegrations: async (partnerId: string) => {
        if (partnerId === 'p1') throw new Error('boom');
        return { kyc: {}, whatsapp: {}, payment: ROUTABLE };
      },
    } as unknown as PartnerIntegrationsStore;
    const route = await selectSettlementRoute(db, throwing, 'USD', 'INR', MID);
    expect(route).toEqual({ fxRate: 86, source: 'partner', settlementPartnerId: 'p2' });
  });

  it('a nonsensical mid falls straight back to platform', async () => {
    expect((await selectSettlementRoute(db, stubIntegrations({}), 'USD', 'INR', 0)).source).toBe('platform');
    expect((await selectSettlementRoute(db, stubIntegrations({}), 'USD', 'INR', NaN)).source).toBe('platform');
  });
});
