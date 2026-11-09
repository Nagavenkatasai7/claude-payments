import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { realMoneyRail, railPartnerOf, readRailProviderType, realMoneyFor } from '@/lib/live-gate';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import type { Db, DbOrTx } from '@/db/client';
import type { PartnerId } from '@/lib/types';
import { captureQueries, freshDb, seedPartner } from './helpers-db';

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
