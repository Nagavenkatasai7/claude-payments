import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { setRailProviderType } from './helpers-sanctions';
import { seedOriginatorForTest } from './helpers-live';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Customer, Staff } from '@/lib/types';
import type { PartnerCtx } from '@/lib/partner-access';

// Fix pack 5 T24 (P23): a per-transfer cap above $2,999 needs the sender's address on file when
// the customer's OWNER is on a real-money rail. Both limit actions (platform and partner) refuse
// with LIMIT_NEEDS_ADDRESS_COPY and write nothing. Raises up to $2,999, daily-only raises and
// clears never read the rail. PGlite; the rail is set with setRailProviderType.

const redis = fakeRedis();
let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let cs: ReturnType<typeof createCustomerStore>;
let pgPartnerStore: PartnerStore;
let currentStaff: Staff;
let partnerCtx: PartnerCtx;
const rail = { fail: false, reads: 0 };
const clampOverride: { perTransferCapCents: number | null } = { perTransferCapCents: null };

vi.mock('@/lib/auth', () => ({
  requirePlatformAdmin: async () => currentStaff,
  requireAdmin: async () => currentStaff,
  requireScope: async () => ({ staff: currentStaff }),
  requireStaff: async () => currentStaff,
  requirePartnerStaff: async () => partnerCtx,
}));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => store };
});
vi.mock('@/lib/customer-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getCustomerStore: () => cs };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
// The rail read: counted, with a switch for a failed read (readRailProviderType never throws; a
// failure is undefined, which realMoneyRail reads as real money).
vi.mock('@/lib/live-gate', async (orig) => {
  const real = await orig<typeof import('@/lib/live-gate')>();
  return {
    ...real,
    readRailProviderType: async (...a: Parameters<typeof real.readRailProviderType>) => {
      rail.reads++;
      if (rail.fail) return undefined;
      return real.readRailProviderType(...a);
    },
  };
});
// The partner form clamps every figure to min(partner level, platform $2,999), so the partner
// action can never post a cap above $2,999 today. This seam lets a test prove the rule is still
// enforced there should the clamp ever allow more (defence in depth).
vi.mock('@/lib/partner-send-limits', async (orig) => {
  const real = await orig<typeof import('@/lib/partner-send-limits')>();
  return {
    ...real,
    validatePartnerCustomerLimit: (...a: Parameters<typeof real.validatePartnerCustomerLimit>) => {
      const v = real.validatePartnerCustomerLimit(...a);
      if (clampOverride.perTransferCapCents !== null && v.value) {
        return { ...v, value: { ...v.value, perTransferCapCents: clampOverride.perTransferCapCents } };
      }
      return v;
    },
  };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('next/headers', async (orig) => ({
  ...(await orig<typeof import('next/headers')>()),
  headers: async () => new Headers({ host: 'smartremit.ai' }),
}));

import { setCustomerSendLimitAction } from '@/app/admin-dashboard/customers/actions';
import { setCustomerLimitAction } from '@/app/partner/(app)/customers/[ref]/limit-actions';
import { LIMIT_NEEDS_ADDRESS_COPY } from '@/lib/travel-rule';
import { ownerAddressCheck } from '@/lib/originator-info';
import { sealCustomerRef } from '@/lib/customer-ref';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { t } from '@/lib/i18n';

const PHONE = '15551234567';
const RAISE = { partnerId: 'A', phone: PHONE, perTransferUsd: '5000', t1DailyUsd: '5000', reason: 'QA large-amount test' };

function staff(o: Partial<Staff>): Staff {
  return {
    username: 'root', name: 'R', role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'x', createdAt: new Date().toISOString(), ...o,
  };
}
function makeCustomer(phone: string, partnerId: string): Customer {
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  return { senderPhone: phone, firstSeenAt: tenDaysAgo, kycStatus: 'verified', senderCountry: 'US', partnerId, createdAt: tenDaysAgo, updatedAt: tenDaysAgo };
}
function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}
async function overrideOf(partnerId: string, phone: string) {
  const r = await db.execute(sql`SELECT send_limit_override FROM customers WHERE partner_id = ${partnerId} AND phone = ${phone}`);
  return (r.rows[0] as { send_limit_override: unknown } | undefined)?.send_limit_override ?? null;
}
async function limitAudits() {
  const r = await db.execute(sql`SELECT action FROM audit_events WHERE action LIKE 'send_limits.%'`);
  return r.rows;
}

beforeEach(async () => {
  redis.dump.clear();
  rail.fail = false;
  rail.reads = 0;
  clampOverride.perTransferCapCents = null;
  db = await freshDb();
  await seedPartner(db, 'A');
  await seedPartner(db, 'pa');
  store = createStore(redis, db);
  cs = createCustomerStore(db, store);
  pgPartnerStore = createPartnerStore(db);
  await cs.saveCustomer(makeCustomer(PHONE, 'A'));
  await cs.saveCustomer(makeCustomer(PHONE, 'pa'));
  await cs.saveCustomer(makeCustomer(PHONE, DEFAULT_PARTNER_ID));
  currentStaff = staff({});
  partnerCtx = { partnerId: 'pa', username: 'pa-admin', role: 'admin', staff: staff({ username: 'pa-admin', partnerId: 'pa' }) };
});

describe('the copy', () => {
  it('partner.limits.needsAddress equals LIMIT_NEEDS_ADDRESS_COPY (no drift)', () => {
    expect(t('partner.limits.needsAddress')).toBe(LIMIT_NEEDS_ADDRESS_COPY);
  });
});

describe('ownerAddressCheck', () => {
  it('http owner, no address -> real money, not on file; with an address -> on file', async () => {
    await setRailProviderType(db, 'A', 'http');
    expect(await ownerAddressCheck(db, 'A', PHONE)).toEqual({ ownerRealMoney: true, addressOnFile: false });
    await seedOriginatorForTest(db, 'A', PHONE);
    expect(await ownerAddressCheck(db, 'A', PHONE)).toEqual({ ownerRealMoney: true, addressOnFile: true });
  });
  it('no integrations row / mock / simulator -> not real money', async () => {
    expect((await ownerAddressCheck(db, 'A', PHONE)).ownerRealMoney).toBe(false);
    for (const p of ['mock', 'simulator']) {
      await setRailProviderType(db, 'A', p);
      expect((await ownerAddressCheck(db, 'A', PHONE)).ownerRealMoney).toBe(false);
    }
  });
  it('the address is read for THIS tenant only', async () => {
    await setRailProviderType(db, 'A', 'http');
    await seedOriginatorForTest(db, 'pa', PHONE);
    expect((await ownerAddressCheck(db, 'A', PHONE)).addressOnFile).toBe(false);
  });
});

describe('setCustomerSendLimitAction: the address rule', () => {
  it('raise to $5,000, owner on http, no address -> throws LIMIT_NEEDS_ADDRESS_COPY; nothing written', async () => {
    await setRailProviderType(db, 'A', 'http');
    await expect(setCustomerSendLimitAction(form(RAISE))).rejects.toThrow(LIMIT_NEEDS_ADDRESS_COPY);
    expect(await overrideOf('A', PHONE)).toBeNull();
    expect(await limitAudits()).toEqual([]);
  });

  it('the same with an address on file -> saved as today', async () => {
    await setRailProviderType(db, 'A', 'http');
    await seedOriginatorForTest(db, 'A', PHONE);
    await setCustomerSendLimitAction(form(RAISE));
    expect(await overrideOf('A', PHONE)).toMatchObject({ perTransferCapCents: 500_000 });
    expect(await limitAudits()).toEqual([{ action: 'send_limits.set' }]);
  });

  it.each([['no integrations row', null], ['mock', 'mock'], ['simulator', 'simulator']])(
    'owner %s -> saved with no address',
    async (_label, provider) => {
      if (provider) await setRailProviderType(db, 'A', provider);
      await setCustomerSendLimitAction(form(RAISE));
      expect(await overrideOf('A', PHONE)).toMatchObject({ perTransferCapCents: 500_000 });
    },
  );

  it('the default tenant (no rail row) -> saved with no address', async () => {
    await setCustomerSendLimitAction(form({ ...RAISE, partnerId: DEFAULT_PARTNER_ID }));
    expect(await overrideOf(DEFAULT_PARTNER_ID, PHONE)).toMatchObject({ perTransferCapCents: 500_000 });
  });

  it('a failed rail read: no address -> refused; address on file -> saved', async () => {
    rail.fail = true;
    await expect(setCustomerSendLimitAction(form(RAISE))).rejects.toThrow(LIMIT_NEEDS_ADDRESS_COPY);
    expect(await overrideOf('A', PHONE)).toBeNull();
    await seedOriginatorForTest(db, 'A', PHONE);
    await setCustomerSendLimitAction(form(RAISE));
    expect(await overrideOf('A', PHONE)).toMatchObject({ perTransferCapCents: 500_000 });
  });

  it('a raise to exactly $2,999, a daily-only raise and a clear -> never refused, no rail read', async () => {
    await setRailProviderType(db, 'A', 'http');
    await setCustomerSendLimitAction(form({ ...RAISE, perTransferUsd: '2999', t1DailyUsd: '' }));
    expect(await overrideOf('A', PHONE)).toMatchObject({ perTransferCapCents: 299_900 });
    await setCustomerSendLimitAction(form({ ...RAISE, perTransferUsd: '', t1DailyUsd: '8000' }));
    expect(await overrideOf('A', PHONE)).toMatchObject({ t1DailyCapCents: 800_000 });
    await setCustomerSendLimitAction(form({ partnerId: 'A', phone: PHONE, clear: 'on', reason: 'back to normal' }));
    expect(await overrideOf('A', PHONE)).toBeNull();
    expect(rail.reads).toBe(0);
  });
});

describe('setCustomerLimitAction (partner): the address rule', () => {
  const pform = (o: Record<string, string> = {}) =>
    form({ ref: sealCustomerRef('pa', PHONE), perTransferUsd: '5000', t1DailyUsd: '', expiresAt: '', reason: 'Customer asked', ...o });

  it('today the clamp keeps a partner cap at or below $2,999: saved, no rail read, even on http with no address', async () => {
    await setRailProviderType(db, 'pa', 'http');
    expect(await setCustomerLimitAction(pform())).toMatchObject({ ok: true });
    expect(await overrideOf('pa', PHONE)).toMatchObject({ perTransferCapCents: 299_900 });
    expect(rail.reads).toBe(0);
  });

  it('a cap above $2,999 (seam), owner on http, no address -> { ok:false, needsAddress }; nothing written', async () => {
    await setRailProviderType(db, 'pa', 'http');
    clampOverride.perTransferCapCents = 500_000;
    expect(await setCustomerLimitAction(pform())).toEqual({ ok: false, error: t('partner.limits.needsAddress') });
    expect(await overrideOf('pa', PHONE)).toBeNull();
    expect(await limitAudits()).toEqual([]);
  });

  it('the same with an address on file -> saved', async () => {
    await setRailProviderType(db, 'pa', 'http');
    await seedOriginatorForTest(db, 'pa', PHONE);
    clampOverride.perTransferCapCents = 500_000;
    expect(await setCustomerLimitAction(pform())).toMatchObject({ ok: true });
    expect(await overrideOf('pa', PHONE)).toMatchObject({ perTransferCapCents: 500_000 });
  });

  it('a cap above $2,999 (seam) on a mock owner -> saved with no address', async () => {
    await setRailProviderType(db, 'pa', 'mock');
    clampOverride.perTransferCapCents = 500_000;
    expect(await setCustomerLimitAction(pform())).toMatchObject({ ok: true });
  });
});
