import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { effectiveOfferFor, effectiveRateFor, selectSettlementRoute, MAX_ROUTE_PREMIUM } from '@/lib/partner-rates';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { railFailAlertKey, hourBucketAt, recentlyFailingRails } from '@/lib/rail-health';
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

// Step 0 FX-5: the same rule, plus WHICH offer won and when a push expires,
// so the draft can stop honouring a partner rate the partner no longer offers.
describe('effectiveOfferFor (pure, Step 0 FX-5)', () => {
  it('a fresh push → partner_push carrying its expiry', () => {
    const exp = inHours(1);
    expect(effectiveOfferFor(baseRate({ effectiveRate: 86.5, expiresAt: exp, marginBps: 10 }), MID, NOW))
      .toEqual({ fxRate: 86.5, kind: 'partner_push', expiresAt: exp });
  });
  it('an expired push with a margin → partner_margin, no expiry', () => {
    const offer = effectiveOfferFor(baseRate({ effectiveRate: 86.5, expiresAt: inHours(-1), marginBps: 100 }), MID, NOW);
    expect(offer?.kind).toBe('partner_margin');
    expect(offer?.fxRate).toBeCloseTo(MID * 1.01, 6);
    expect(offer).not.toHaveProperty('expiresAt');
  });
  it('nothing competing → null; effectiveRateFor is its rate', () => {
    expect(effectiveOfferFor(baseRate({}), MID, NOW)).toBeNull();
    const r = baseRate({ effectiveRate: 86.5, expiresAt: inHours(1) });
    expect(effectiveRateFor(r, MID, NOW)).toBe(effectiveOfferFor(r, MID, NOW)?.fxRate);
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
    // Step 0 FX-5: a pushed winner carries its kind and expiry.
    expect(route).toEqual({ fxRate: 87, source: 'partner', settlementPartnerId: 'p2', kind: 'partner_push', expiresAt: inHours(1) });
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
    expect(route).toEqual({ fxRate: 86, source: 'partner', settlementPartnerId: 'p1', kind: 'partner_push', expiresAt: inHours(1) });
  });

  it('an empty settlementUrl disqualifies even an http rail', async () => {
    const repo = createPartnerRateRepo(db);
    await repo.upsertRate({ id: 'a', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 88, expiresAt: inHours(1) });
    const route = await selectSettlementRoute(
      db, stubIntegrations({ p1: { providerType: 'http', credentials: { settlementUrl: '  ' } } }), 'USD', 'INR', MID,
    );
    expect(route.source).toBe('platform');
  });

  it.each([
    'https://10.1.1.1/x',
    'http://rail.acme.com/x',
    'https://169.254.169.254/latest',
    'https://user:pw@rail.acme.com/x',
    'https://rail.acme.com:8443/x',
    'https://localhost/x',
  ])('fix 22 (test 12): a contender with an http rail at %s is skipped and routing falls back to mid', async (url) => {
    const repo = createPartnerRateRepo(db);
    await repo.upsertRate({ id: 'a', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 88, expiresAt: inHours(1) });
    const route = await selectSettlementRoute(
      db, stubIntegrations({ p1: { providerType: 'http', credentials: { settlementUrl: url, signingSecret: 's' } } }), 'USD', 'INR', MID,
    );
    expect(route).toEqual({ fxRate: MID, source: 'platform' });
  });

  it('fix 22: a bad-URL winner is skipped and the next-best contender with a PUBLIC https rail wins', async () => {
    const repo = createPartnerRateRepo(db);
    await repo.upsertRate({ id: 'a', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 86, expiresAt: inHours(1) });
    await repo.upsertRate({ id: 'b', partnerId: 'p2', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 87, expiresAt: inHours(1) });
    const route = await selectSettlementRoute(
      db,
      stubIntegrations({
        p1: ROUTABLE,
        p2: { providerType: 'http', credentials: { settlementUrl: 'https://10.1.1.1/x', signingSecret: 's' } },
      }),
      'USD', 'INR', MID,
    );
    expect(route).toEqual({ fxRate: 86, source: 'partner', settlementPartnerId: 'p1', kind: 'partner_push', expiresAt: inHours(1) });
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
    expect(route.kind).toBe('partner_margin');
    expect(route.expiresAt).toBeUndefined();
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
    expect(route).toEqual({ fxRate: 86, source: 'partner', settlementPartnerId: 'p2', kind: 'partner_push', expiresAt: inHours(1) });
  });

  it('a nonsensical mid falls straight back to platform', async () => {
    expect((await selectSettlementRoute(db, stubIntegrations({}), 'USD', 'INR', 0)).source).toBe('platform');
    expect((await selectSettlementRoute(db, stubIntegrations({}), 'USD', 'INR', NaN)).source).toBe('platform');
  });
});

// Smart-routing R0 fix A: a typo'd push (or a fat-fingered margin) must not win
// every route. A rate more than MAX_ROUTE_PREMIUM above mid is implausible and
// is treated as not competing; the next-best plausible contender (or mid) wins.
describe('selectSettlementRoute: rate sanity band (R0 fix A)', () => {
  let db: Db;

  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, 'p1');
    await seedPartner(db, 'p2');
  });

  it('the band is 5% above mid', () => {
    expect(MAX_ROUTE_PREMIUM).toBe(0.05);
  });

  it('a pushed rate more than 5% above mid never wins (typo guard), mid is kept', async () => {
    const repo = createPartnerRateRepo(db);
    await repo.upsertRate({ id: 'a', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 850, expiresAt: inHours(1) });
    const route = await selectSettlementRoute(db, stubIntegrations({ p1: ROUTABLE }), 'USD', 'INR', MID);
    expect(route).toEqual({ fxRate: MID, source: 'platform' });
  });

  it('an out-of-band contender is skipped and the next-best in-band contender wins', async () => {
    const repo = createPartnerRateRepo(db);
    await repo.upsertRate({ id: 'a', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: MID * 1.06, expiresAt: inHours(1) });
    await repo.upsertRate({ id: 'b', partnerId: 'p2', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 86, expiresAt: inHours(1) });
    const route = await selectSettlementRoute(db, stubIntegrations({ p1: ROUTABLE, p2: ROUTABLE }), 'USD', 'INR', MID);
    expect(route).toEqual({ fxRate: 86, source: 'partner', settlementPartnerId: 'p2', kind: 'partner_push', expiresAt: inHours(1) });
  });

  it('a rate exactly at the band edge still competes', async () => {
    const repo = createPartnerRateRepo(db);
    await repo.upsertRate({ id: 'a', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', marginBps: 500 });
    const route = await selectSettlementRoute(db, stubIntegrations({ p1: ROUTABLE }), 'USD', 'INR', MID);
    expect(route.source).toBe('partner');
    expect(route.fxRate).toBeCloseTo(MID * 1.05, 6);
  });

  it('a legacy margin above the band (e.g. +10000 bps) never wins', async () => {
    const repo = createPartnerRateRepo(db);
    await repo.upsertRate({ id: 'a', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', marginBps: 10_000 });
    const route = await selectSettlementRoute(db, stubIntegrations({ p1: ROUTABLE }), 'USD', 'INR', MID);
    expect(route.source).toBe('platform');
  });
});

// Smart-routing R0 fix B: a rail that is failing right now must not keep
// winning new quotes. The worker already raises one `railfail:<partner>:<hour>`
// ops alert per failing rail per hour (outbox-worker alertRailFailing, from
// attempt 3); a partner with that alert in the current or previous hour is
// skipped. Fail-open: a lookup error never blocks quoting.
describe('rail health: skip a partner whose rail is failing (R0 fix B)', () => {
  let db: Db;

  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, 'p1');
    await seedPartner(db, 'p2');
  });

  const raiseRailFail = (partnerId: string, bucket: number) =>
    createOutboxRepo(db).enqueue('ops.alert', { message: 'rail failing' }, { dedupeKey: railFailAlertKey(partnerId, bucket) });

  it('the key matches the worker alert format railfail:<partner>:<hour bucket>', () => {
    expect(railFailAlertKey('p1', 123)).toBe('railfail:p1:123');
    expect(hourBucketAt(7_200_000 + 5)).toBe(2);
  });

  it('a failing-rail alert this hour skips the best partner; the next-best healthy partner wins', async () => {
    const repo = createPartnerRateRepo(db);
    await repo.upsertRate({ id: 'a', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 87, expiresAt: inHours(1) });
    await repo.upsertRate({ id: 'b', partnerId: 'p2', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 86, expiresAt: inHours(1) });
    await raiseRailFail('p1', hourBucketAt(NOW.getTime()));
    const route = await selectSettlementRoute(db, stubIntegrations({ p1: ROUTABLE, p2: ROUTABLE }), 'USD', 'INR', MID, NOW);
    expect(route).toEqual({ fxRate: 86, source: 'partner', settlementPartnerId: 'p2', kind: 'partner_push', expiresAt: inHours(1) });
  });

  it('an alert from the previous hour still skips the partner', async () => {
    const repo = createPartnerRateRepo(db);
    await repo.upsertRate({ id: 'a', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 87, expiresAt: inHours(1) });
    await raiseRailFail('p1', hourBucketAt(NOW.getTime()) - 1);
    const route = await selectSettlementRoute(db, stubIntegrations({ p1: ROUTABLE }), 'USD', 'INR', MID, NOW);
    expect(route).toEqual({ fxRate: MID, source: 'platform' });
  });

  it('an alert two or more hours old no longer skips the partner', async () => {
    const repo = createPartnerRateRepo(db);
    await repo.upsertRate({ id: 'a', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 87, expiresAt: inHours(1) });
    await raiseRailFail('p1', hourBucketAt(NOW.getTime()) - 2);
    const route = await selectSettlementRoute(db, stubIntegrations({ p1: ROUTABLE }), 'USD', 'INR', MID, NOW);
    expect(route).toEqual({ fxRate: 87, source: 'partner', settlementPartnerId: 'p1', kind: 'partner_push', expiresAt: inHours(1) });
  });

  it("another partner's alert does not skip this partner", async () => {
    const repo = createPartnerRateRepo(db);
    await repo.upsertRate({ id: 'a', partnerId: 'p1', sourceCurrency: 'USD', destinationCurrency: 'INR', effectiveRate: 87, expiresAt: inHours(1) });
    await raiseRailFail('p2', hourBucketAt(NOW.getTime()));
    const route = await selectSettlementRoute(db, stubIntegrations({ p1: ROUTABLE }), 'USD', 'INR', MID, NOW);
    expect(route).toEqual({ fxRate: 87, source: 'partner', settlementPartnerId: 'p1', kind: 'partner_push', expiresAt: inHours(1) });
  });

  it('recentlyFailingRails returns only the partners with a current or previous-hour alert', async () => {
    const h = hourBucketAt(NOW.getTime());
    await raiseRailFail('p1', h);
    await raiseRailFail('p2', h - 3);
    expect([...(await recentlyFailingRails(db, ['p1', 'p2'], NOW))]).toEqual(['p1']);
  });

  it('recentlyFailingRails with no partners does not query and returns empty', async () => {
    expect((await recentlyFailingRails(db, [], NOW)).size).toBe(0);
  });

  it('a health lookup error fails open (empty set, quoting continues)', async () => {
    const broken = { select: () => { throw new Error('db down'); } } as unknown as Db;
    expect((await recentlyFailingRails(broken, ['p1'], NOW)).size).toBe(0);
  });
});
