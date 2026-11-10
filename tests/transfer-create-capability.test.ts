import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTransfer, MintRefusedError, type CreateTransferInput } from '@/lib/transfer-create';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { updateLiveControlsKey } from '@/db/repos/partner-repo';
import { resetRateCacheForTests } from '@/lib/rate';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner, seedSender } from './helpers-db';
import { restoreOfacSource, setRailProviderType } from './helpers-sanctions';
import { certifyPartnerForTest } from './helpers-live';
import type { LiveCapability } from '@/lib/live-controls';
import type { Db } from '@/db/client';

// Fix pack 3 T12 (R13, contract 4 (c)): a CERTIFIED owner mints B2B, USDC and
// scheduled transfers only with that capability's opt-in (counsel ref +
// partner approval). Keyed on the owner's certification (not on the rail
// being real money); sandbox ('test') mints, uncertified partners and the
// default tenant are unchanged. Refused before any write.

const PHONE = '15550100099';
const WALLET = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const ORIGINAL_LIST = process.env.SANCTIONS_LIST;

beforeEach(() => {
  delete process.env.SANCTIONS_LIST;
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

/** A partner on `rail`, certified with `optIns` (undefined = not certified), and a seasoned sender. */
async function partnerWith(db: Db, id: string, rail: string | undefined, optIns?: readonly LiveCapability[]) {
  if (id !== 'default') await seedPartner(db, id);
  if (rail) await setRailProviderType(db, id, rail);
  if (optIns && id !== 'default') await certifyPartnerForTest(db, id, { optIns });
  await seedSender(db, { partnerId: id, phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
}

const base = {
  phone: PHONE,
  amountSource: 200,
  sourceCurrency: 'USD' as const,
  recipientName: 'Mom',
  recipientPhone: '919000000099',
  payoutMethod: 'upi' as const,
  payoutDestination: 'mom@upi',
  fundingMethod: 'bank_transfer' as const,
  senderKycStatus: 'verified' as const,
};

const b2b: Partial<CreateTransferInput> = {
  recipientName: 'Globex Trading LLC', transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
  senderBusinessName: 'Acme Imports Ltd', recipientBusinessName: 'Globex Trading LLC', payoutMethod: 'bank', payoutDestination: '',
};
const usdc: Partial<CreateTransferInput> = { payoutMethod: 'usdc', payoutDestination: `USDC|${WALLET}` };

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

describe('mint capability gate (fix pack 3 T12, contract 4 (c))', { retry: 0 }, () => {
  it('b2b transferType -> MintRefusedError capability_off, capability b2b; nothing written (no transfer, outbox or audit row)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http', []);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lock = vi.spyOn(store, 'mintUnderSenderLock');
    const before = await counts(db);
    const err = await refusal(createTransfer(store, partnerStore, mvs, { ...base, ...b2b, partnerId: 'acme' }));
    expect(err.code).toBe('capability_off');
    expect(err.capability).toBe('b2b');
    expect(err.copyKey).toBe('cannot_complete');
    expect(lock).not.toHaveBeenCalled();
    expect(await counts(db)).toEqual(before);
  });

  it('a partner-pulled funding method on a b2b mint -> capability_off b2b', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http', ['usdc', 'schedules']);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = await refusal(createTransfer(store, partnerStore, mvs, { ...base, ...b2b, fundingMethod: 'ach_pull', partnerId: 'acme' }));
    expect(err.code).toBe('capability_off');
    expect(err.capability).toBe('b2b');
  });

  it("payoutMethod 'usdc' -> capability_off usdc", async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http', ['b2b', 'schedules']);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = await refusal(createTransfer(store, partnerStore, mvs, { ...base, ...usdc, partnerId: 'acme' }));
    expect(err.code).toBe('capability_off');
    expect(err.capability).toBe('usdc');
    expect((await counts(db)).transfers).toBe(0);
  });

  it('scheduleId set -> capability_off schedules, before scheduleMintCheck (spy not called)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http', ['b2b', 'usdc']);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lock = vi.spyOn(store, 'mintUnderSenderLock');
    const err = await refusal(createTransfer(store, partnerStore, mvs, { ...base, scheduleId: 'sch_x', partnerId: 'acme' }));
    expect(err.code).toBe('capability_off');
    expect(err.capability).toBe('schedules');
    // scheduleMintCheck runs on the locked ops only: no lock, no check.
    expect(lock).not.toHaveBeenCalled();
  });

  it('several closed: the first of b2b, usdc, schedules is refused', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'simulator', ['b2b']);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = await refusal(createTransfer(store, partnerStore, mvs, { ...base, ...b2b, ...usdc, scheduleId: 'sch_x', partnerId: 'acme' }));
    expect(err.capability).toBe('usdc');
  });

  it("optIns ['b2b'] -> the b2b mint goes ahead", async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http', ['b2b']);
    const t = await createTransfer(store, partnerStore, mvs, { ...base, ...b2b, partnerId: 'acme' });
    expect(t.status).toBe('awaiting_payment');
    expect(t.transferType).toBe('b2b');
  });

  it('approval withdrawn (counselRef kept, partnerApprovedAt gone) -> refused', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http', ['b2b']);
    await updateLiveControlsKey('acme', 'optIns', (prev: unknown) => {
      const o = prev as Record<string, Record<string, unknown>>;
      const { partnerApprovedAt: _a, partnerApprovedBy: _b, ...kept } = o.b2b;
      return { ...o, b2b: kept };
    }, db);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = await refusal(createTransfer(store, partnerStore, mvs, { ...base, ...b2b, partnerId: 'acme' }));
    expect(err.code).toBe('capability_off');
    expect(err.capability).toBe('b2b');
  });

  it("environment 'test' on a certified partner with every capability closed -> mints (sandbox skips the check)", async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http', []);
    const t = await createTransfer(store, partnerStore, mvs, { ...base, ...b2b, partnerId: 'acme', environment: 'test' });
    expect(t.environment).toBe('test');
    const u = await createTransfer(store, partnerStore, mvs, { ...base, ...usdc, partnerId: 'acme', environment: 'test' });
    expect(u.payoutMethod).toBe('usdc');
  });

  it('uncertified partner, simulator rail, b2b + usdc -> mints as today', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'simco', 'simulator');
    const t = await createTransfer(store, partnerStore, mvs, { ...base, ...b2b, partnerId: 'simco' });
    expect(t.status).toBe('awaiting_payment');
    const u = await createTransfer(store, partnerStore, mvs, { ...base, ...usdc, partnerId: 'simco' });
    expect(u.status).toBe('awaiting_payment');
  });

  it('default tenant -> no capability check', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'default', undefined);
    const t = await createTransfer(store, partnerStore, mvs, { ...base, ...b2b, partnerId: 'default' });
    expect(t.status).toBe('awaiting_payment');
    const u = await createTransfer(store, partnerStore, mvs, { ...base, ...usdc, partnerId: 'default' });
    expect(u.status).toBe('awaiting_payment');
  });

  it('a simulator (not real money) certified partner with b2b closed -> capability_off (the check keys on certification, not on the rail)', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'simco', 'simulator', []);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = await refusal(createTransfer(store, partnerStore, mvs, { ...base, ...b2b, partnerId: 'simco' }));
    expect(err.code).toBe('capability_off');
    expect(err.capability).toBe('b2b');
    // A consumer UPI mint needs no capability: unchanged.
    const t = await createTransfer(store, partnerStore, mvs, { ...base, partnerId: 'simco' });
    expect(t.status).toBe('awaiting_payment');
  });

  it('logs transfer-create.live-refused with partnerId and code only', async () => {
    const { db, store, partnerStore, mvs } = await makeStores();
    await partnerWith(db, 'acme', 'http', []);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await refusal(createTransfer(store, partnerStore, mvs, { ...base, ...usdc, partnerId: 'acme' }));
    const lines = warn.mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])) as Record<string, unknown>; } catch { return null; } })
      .filter((l): l is Record<string, unknown> => l?.scope === 'transfer-create.live-refused');
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]).sort()).toEqual(['at', 'code', 'level', 'msg', 'partnerId', 'scope']);
    expect(lines[0]).toMatchObject({ partnerId: 'acme', code: 'capability_off', msg: 'live mint refused' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PHONE);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(WALLET);
  });
});
