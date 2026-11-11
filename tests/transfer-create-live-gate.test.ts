import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTransfer, MintRefusedError } from '@/lib/transfer-create';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { updateLiveControlsKey } from '@/db/repos/partner-repo';
import { LIST_UNAVAILABLE_REASON } from '@/lib/compliance-config';
import { resetRateCacheForTests } from '@/lib/rate';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedPartner, seedSender } from './helpers-db';
import { restoreOfacSource, setRailProviderType } from './helpers-sanctions';
import { certifyPartnerForTest } from './helpers-live';
import type { Db } from '@/db/client';

// Fix pack 3 T4 (R15, contract 4 (a)(b)): the mint's live gate. A real-money
// mint (an `http` rail on the SETTLEMENT partner, or a failed rail-type read,
// environment not 'test') refuses with MintRefusedError before any write
// unless its rail partner is certified for live money; the default tenant
// refuses any real-money mint, owned or routed. Everything else is unchanged.

const PHONE = '15550100088';
const ORIGINAL_LIST = process.env.SANCTIONS_LIST;

beforeEach(() => {
  delete process.env.SANCTIONS_LIST; // the mock list (production today)
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
});
afterEach(() => {
  restoreOfacSource(ORIGINAL_LIST);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function makeStores() {
  const redis = fakeRedis();
  const db = await freshDb();
  const store = createStore(redis, db);
  return { db, store, partnerStore: createPartnerStore(db), mvs: createMonthlyVolumeStore(store) };
}

/** A partner with a rail of `rail` (none = no integrations row) and a seasoned sender. */
async function partnerWith(db: Db, id: string, rail?: string) {
  if (id !== 'default') await seedPartner(db, id);
  if (rail) await setRailProviderType(db, id, rail);
  await seedSender(db, { partnerId: id, phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
}

const base = {
  phone: PHONE,
  amountSource: 200,
  sourceCurrency: 'USD' as const,
  recipientName: 'Mom',
  recipientPhone: '919000000088',
  payoutMethod: 'upi' as const,
  payoutDestination: 'mom@upi',
  fundingMethod: 'bank_transfer' as const,
  senderKycStatus: 'verified' as const,
};

const quote = {
  amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85, amountInr: 17_000,
  amountSource: 200, feeSource: 0, totalChargeSource: 200,
};

async function counts(db: Db) {
  const n = async (table: string) =>
    Number(((await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))).rows[0] as { n: number }).n);
  return { transfers: await n('transfers'), outbox: await n('outbox'), audit: await n('audit_events') };
}

async function refusal(p: Promise<unknown>): Promise<MintRefusedError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(MintRefusedError);
  return err as MintRefusedError;
}

describe('mint live gate (fix pack 3 T4, contract 4)', { retry: 0 }, () => {
  it('uncertified http owner, live -> MintRefusedError live_not_certified; no transfer, outbox or audit row; mintUnderSenderLock never called', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lock = vi.spyOn(store, 'mintUnderSenderLock');
    const before = await counts(db);
    const err = await refusal(createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' }));
    expect(err.code).toBe('live_not_certified');
    expect(err.copyKey).toBe('cannot_complete');
    expect(err.message).toBe('mint_refused:live_not_certified');
    expect(lock).not.toHaveBeenCalled();
    expect(await counts(db)).toEqual(before);
  });

  it('certified http owner -> mints', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http');
    await certifyPartnerForTest(db, 'acme');
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' });
    expect(t.status).toBe('awaiting_payment');
    expect(t.partnerId).toBe('acme');
  });

  it('default owner + quote routed to a CERTIFIED http partner -> default_on_live_rail', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'default');
    await seedPartner(db, 'railco');
    await setRailProviderType(db, 'railco', 'http');
    await certifyPartnerForTest(db, 'railco');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = await counts(db);
    const err = await refusal(createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'default', quote, settlementPartnerId: 'railco' }));
    expect(err.code).toBe('default_on_live_rail');
    expect(await counts(db)).toEqual(before);
  });

  it('default owner on its own http rail -> default_on_live_rail', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'default', 'http');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lock = vi.spyOn(store, 'mintUnderSenderLock');
    const err = await refusal(createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'default' }));
    expect(err.code).toBe('default_on_live_rail');
    expect(lock).not.toHaveBeenCalled();
  });

  it('non-default owner routed to an uncertified http rail -> live_not_certified; to a certified one -> mints with settlementPartnerId', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'simulator');
    await seedPartner(db, 'railco');
    await setRailProviderType(db, 'railco', 'http');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = await refusal(createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', quote, settlementPartnerId: 'railco' }));
    expect(err.code).toBe('live_not_certified');
    expect((await counts(db)).transfers).toBe(0);

    await certifyPartnerForTest(db, 'railco');
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', quote, settlementPartnerId: 'railco' });
    expect(t.settlementPartnerId).toBe('railco');
    expect(t.status).toBe('awaiting_payment');
  });

  it('rail partner read throws -> live_not_certified', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'simulator');
    await seedPartner(db, 'railco');
    await setRailProviderType(db, 'railco', 'http');
    await certifyPartnerForTest(db, 'railco');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const real = partnerStore.getPartner.bind(partnerStore);
    vi.spyOn(partnerStore, 'getPartner').mockImplementation(async (id) => {
      if (id === 'railco') throw new Error('read failed');
      return real(id);
    });
    const err = await refusal(createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', quote, settlementPartnerId: 'railco' }));
    expect(err.code).toBe('live_not_certified');
    expect((await counts(db)).transfers).toBe(0);
  });

  it('rail type read fails (table renamed) -> uncertified owner refused; certified owner mints, held LIST_UNAVAILABLE', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'simco', 'simulator');
    await partnerWith(db, 'certco', 'simulator');
    await certifyPartnerForTest(db, 'certco');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await db.execute(sql`ALTER TABLE partner_integrations RENAME TO partner_integrations_gone`);
    try {
      const err = await refusal(createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'simco' }));
      expect(err.code).toBe('live_not_certified');
      const held = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'certco' });
      expect(held.complianceStatus).toBe('flagged');
      expect(held.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON]);
    } finally {
      await db.execute(sql`ALTER TABLE partner_integrations_gone RENAME TO partner_integrations`);
    }
  });

  it('revoked or suspended -> refused', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'revoked', 'http');
    await certifyPartnerForTest(db, 'revoked');
    await updateLiveControlsKey('revoked', 'certification', (prev: unknown) => ({
      ...(prev as Record<string, unknown>),
      revokedAt: new Date().toISOString(),
      revokedBy: 'test-admin',
    }), db);
    await partnerWith(db, 'paused', 'http');
    await certifyPartnerForTest(db, 'paused');
    await db.execute(sql`UPDATE partners SET status = 'suspended' WHERE id = 'paused'`);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await refusal(createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'revoked' }))).code).toBe('live_not_certified');
    expect((await refusal(createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'paused' }))).code).toBe('live_not_certified');
    expect((await counts(db)).transfers).toBe(0);
  });

  it("env 'test' on uncertified http -> mints, no rail-partner read", async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http');
    await seedPartner(db, 'railco');
    await setRailProviderType(db, 'railco', 'http');
    const getPartner = vi.spyOn(partnerStore, 'getPartner');
    const stop = captureQueries();
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme', environment: 'test', quote, settlementPartnerId: 'railco' });
    const log = stop();
    expect(t.environment).toBe('test');
    expect(t.settlementPartnerId).toBeUndefined();
    // Only the owner row is read; the (dropped) route's rail partner never is.
    expect(getPartner.mock.calls.map((c) => c[0])).toEqual(['acme']);
    expect(log.filter((q) => q.params.includes('railco'))).toEqual([]);
  });

  it.each([
    ['simulator', 'simco', 'simulator'],
    ['mock', 'mockco', 'mock'],
    ['no row', 'bare', undefined],
    ['default tenant on mock', 'default', 'mock'],
  ] as const)('%s rail -> unchanged: mints, cleared', async (_label, id, rail) => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, id, rail);
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: id });
    expect(t.status).toBe('awaiting_payment');
    expect(t.complianceStatus).toBe('cleared');
  });

  it('logs transfer-create.live-refused with partnerId and code only', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await refusal(createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'acme' }));
    const lines = warn.mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])) as Record<string, unknown>; } catch { return null; } })
      .filter((l): l is Record<string, unknown> => l?.scope === 'transfer-create.live-refused');
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]).sort()).toEqual(['at', 'code', 'level', 'msg', 'partnerId', 'scope']);
    expect(lines[0]).toMatchObject({ partnerId: 'acme', code: 'live_not_certified', msg: 'live mint refused' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PHONE);
  });
});
