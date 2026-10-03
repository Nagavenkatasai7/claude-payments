import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { seedPartnerTransfer, seedTwoTenants } from './helpers-partner-app';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import type { Db } from '@/db/client';
import type { Customer, Staff } from '@/lib/types';

// Lost-features restore p1 A4 + B3: revealTransferFieldAction, the transfer page's click-to-reveal.
// ONE rule (partner-reveal-policy, review BL-1): identity fields (sender name and phone, recipient
// name and phone) for admin and agent with enrolled two-step verification; the full payout account
// also needs canRevealPii; support and finance never. The shared throttle, then ONE pii.reveal row
// BEFORE the value. Every refusal has the not-found shape and writes nothing.
const redis = fakeRedis();
let db: Db;
const fail = { audit: false, redis: false };
const cookieJar = new Map<string, string>();
let host = 'smartremit.ai';
const decryptReads: Array<boolean> = [];
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@/lib/redis', () => ({
  getRedis: () =>
    fail.redis
      ? new Proxy(redis, {
          get: (target, p, r) => (p === 'incr' ? async () => Promise.reject(new Error('redis down')) : Reflect.get(target, p, r)),
        })
      : redis,
}));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => actual.createStore(redis, db) };
});
vi.mock('@/lib/customer-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getCustomerStore: (store: Parameters<typeof actual.createCustomerStore>[1]) => actual.createCustomerStore(db, store) };
});
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis) };
});
const logWarnSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async () => {
  const actual = await vi.importActual<typeof import('@/lib/log')>('@/lib/log');
  return { ...actual, logWarn: logWarnSpy };
});
vi.mock('@/db/repos/aux-repos', async () => {
  const actual = await vi.importActual<typeof import('@/db/repos/aux-repos')>('@/db/repos/aux-repos');
  return {
    ...actual,
    createAuditRepo: (d: Parameters<typeof actual.createAuditRepo>[0]) => {
      const repo = actual.createAuditRepo(d);
      if (fail.audit) repo.record = async () => Promise.reject(new Error('audit down 14155550101'));
      return repo;
    },
  };
});
vi.mock('@/db/repos/transfer-repo', async () => {
  const actual = await vi.importActual<typeof import('@/db/repos/transfer-repo')>('@/db/repos/transfer-repo');
  return {
    ...actual,
    createTransferRepo: (...a: Parameters<typeof actual.createTransferRepo>) => {
      const repo = actual.createTransferRepo(...a);
      const get = repo.getOwnedTransfer.bind(repo);
      repo.getOwnedTransfer = async (p, id, opts) => {
        decryptReads.push(opts?.decrypt === true);
        return get(p, id, opts);
      };
      return repo;
    },
  };
});

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { staffMfaKeys } from '@/lib/staff-mfa-store';
import { REVEAL_LIMIT } from '@/lib/partner-reveal-throttle';
import { revealTransferFieldAction } from '@/app/partner/(app)/transfers/[id]/reveal-actions';

const PHONE = '14155550101';
const LEGAL = 'Ashaqz Ramanathan';
const NOT_FOUND = { error: 'That transfer was not found.' };
const noPerms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };

async function signInAs(o: Partial<Staff>, opts: { mfa?: boolean } = { mfa: true }): Promise<Staff> {
  const s: Staff = { username: 'u1', name: 'U', role: 'admin', permissions: noPerms, passwordHash: 'x', createdAt: new Date().toISOString(), ...o };
  await getAuthStore().saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
  if (opts.mfa) await redis.set(staffMfaKeys.secret(s.username), JSON.stringify({ secretEnc: 'x', enrolledAt: 'y' }));
  return s;
}
async function reveals() {
  const res = await db.execute(sql`SELECT partner_id, actor, subject_id, meta FROM audit_events WHERE action = 'pii.reveal' ORDER BY id`);
  return (res as unknown as { rows: Array<{ partner_id: string; actor: string; subject_id: string; meta: Record<string, unknown> }> }).rows;
}
const reveal = (id: string, field: string) => revealTransferFieldAction(id, field as never);

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  logWarnSpy.mockClear();
  decryptReads.length = 0;
  fail.audit = false;
  fail.redis = false;
  host = 'smartremit.ai';
  db = await freshDb();
  await seedTwoTenants(db);
  await seedPartnerTransfer(db, { id: 'tr_A1', partnerId: 'pa', phone: PHONE });
  await seedPartnerTransfer(db, { id: 'tr_B1', partnerId: 'pb', phone: PHONE });
  await seedPartnerTransfer(db, { id: 'tr_A_norec', partnerId: 'pa', phone: '15550001111', recipientPhone: '' });
  const cs = createCustomerStore(db, createStore(redis, db));
  const c = { senderPhone: PHONE, firstSeenAt: new Date().toISOString(), kycStatus: 'verified', senderCountry: 'US', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await cs.saveCustomer({ ...c, partnerId: 'pa', fullName: LEGAL } as Customer);
  await cs.saveCustomer({ ...c, partnerId: 'pb', fullName: 'Zubqx Quellen' } as Customer);
});

describe('revealTransferFieldAction: the gate', () => {
  it('a partner-site host is refused before anything else', async () => {
    await signInAs({ partnerId: 'pa' });
    host = 'acme.smartremit.ai';
    await expect(reveal('tr_A1', 'recipient_name')).rejects.toThrow('NOT_FOUND');
    expect(await reveals()).toHaveLength(0);
  });
  it('anonymous, platform, support and finance never reach a value', async () => {
    await expect(reveal('tr_A1', 'recipient_name')).rejects.toThrow('REDIRECT:/login');
    await signInAs({ partnerId: undefined });
    await expect(reveal('tr_A1', 'recipient_name')).rejects.toThrow('REDIRECT:/admin-dashboard');
    for (const role of ['support', 'finance'] as const) {
      await signInAs({ username: `pa-${role}`, partnerId: 'pa', role, permissions: { ...noPerms, canRevealPii: true } });
      await expect(reveal('tr_A1', 'payout_destination')).rejects.toThrow(/^REDIRECT:\/(partner|login)/);
    }
    expect(await reveals()).toHaveLength(0);
  });
});

describe('revealTransferFieldAction: the one reveal rule', () => {
  it('an agent WITHOUT canRevealPii reveals identity fields, but not the payout account', async () => {
    await signInAs({ username: 'pa-agent', partnerId: 'pa', role: 'agent' });
    expect(await reveal('tr_A1', 'recipient_name')).toEqual({ value: 'Testname Samplesurname' });
    expect(await reveal('tr_A1', 'payout_destination')).toEqual(NOT_FOUND);
    expect((await reveals()).map((r) => r.meta.field)).toEqual(['recipient_name']);
  });
  it('an agent WITH canRevealPii reveals the payout account', async () => {
    await signInAs({ username: 'pa-agent', partnerId: 'pa', role: 'agent', permissions: { ...noPerms, canRevealPii: true } });
    expect(await reveal('tr_A1', 'payout_destination')).toEqual({ value: '000011112222|HDFC0001111' });
  });
  it('no enrolled two-step verification: refused, for an admin too', async () => {
    await signInAs({ partnerId: 'pa', role: 'admin' }, { mfa: false });
    expect(await reveal('tr_A1', 'recipient_name')).toEqual(NOT_FOUND);
    expect(await reveal('tr_A1', 'payout_destination')).toEqual(NOT_FOUND);
    expect(await reveals()).toHaveLength(0);
  });
});

describe('revealTransferFieldAction: refusals (not-found shape, no audit)', () => {
  it("another tenant's id, a missing id, junk ids and non-strings", async () => {
    await signInAs({ partnerId: 'pa' });
    for (const id of ['tr_B1', 'tr_missing', "x' OR 1=1", '', 'a'.repeat(80)]) expect(await reveal(id, 'recipient_name'), id).toEqual(NOT_FOUND);
    expect(await revealTransferFieldAction(42 as never, 'recipient_name')).toEqual(NOT_FOUND);
    expect(await reveals()).toHaveLength(0);
  });
  it('a field outside the allowlist', async () => {
    await signInAs({ partnerId: 'pa' });
    for (const f of ['date_of_birth', 'admin_note', '__proto__', 'adminNote', '']) expect(await reveal('tr_A1', f), f).toEqual(NOT_FOUND);
    expect(await reveals()).toHaveLength(0);
  });
  it('a value the transfer does not have (no recipient phone, no sender customer row)', async () => {
    await signInAs({ partnerId: 'pa' });
    expect(await reveal('tr_A_norec', 'recipient_phone')).toEqual(NOT_FOUND);
    expect(await reveal('tr_A_norec', 'full_name')).toEqual(NOT_FOUND);
    expect(await reveals()).toHaveLength(0);
  });
});

describe('revealTransferFieldAction: success', () => {
  it('each field returns its own value, the tenant\'s own customer for the sender name', async () => {
    await signInAs({ username: 'pa-admin', partnerId: 'pa', role: 'admin' });
    expect(await reveal('tr_A1', 'full_name')).toEqual({ value: LEGAL });
    expect(await reveal('tr_A1', 'phone')).toEqual({ value: `+${PHONE}` });
    expect(await reveal('tr_A1', 'recipient_phone')).toEqual({ value: '+919876543210' });
    const rows = await reveals();
    expect(rows.map((r) => r.meta)).toEqual([
      { field: 'full_name', actorScope: 'partner' },
      { field: 'phone', actorScope: 'partner' },
      { field: 'recipient_phone', actorScope: 'partner' },
    ]);
    for (const r of rows) expect(r).toMatchObject({ partner_id: 'pa', actor: 'pa-admin', subject_id: 'tr_A1' });
    expect(JSON.stringify(rows)).not.toMatch(/Ashaqz|14155550101|919876543210/);
  });
  it('the decrypting read runs only for the payout account', async () => {
    await signInAs({ partnerId: 'pa' });
    await reveal('tr_A1', 'recipient_name');
    await reveal('tr_A1', 'phone');
    expect(decryptReads).toEqual([false, false]);
    await reveal('tr_A1', 'payout_destination');
    expect(decryptReads).toEqual([false, false, true]);
  });
  it('an audit failure returns no value; the log has the error name only', async () => {
    await signInAs({ partnerId: 'pa' });
    fail.audit = true;
    expect(await reveal('tr_A1', 'payout_destination')).toEqual(NOT_FOUND);
    expect(JSON.stringify(logWarnSpy.mock.calls)).not.toMatch(/000011112222|14155550101|Testname/);
  });
});

describe('revealTransferFieldAction: the shared throttle (fails closed)', () => {
  it('REVEAL_LIMIT reveals per window, then refused with no audit row', async () => {
    await signInAs({ partnerId: 'pa' });
    for (let i = 0; i < REVEAL_LIMIT; i++) expect(await reveal('tr_A1', 'recipient_name')).toEqual({ value: 'Testname Samplesurname' });
    expect(await reveal('tr_A1', 'recipient_name')).toEqual(NOT_FOUND);
    expect(await reveals()).toHaveLength(REVEAL_LIMIT);
  });
  it('a Redis failure refuses (no value, no audit)', async () => {
    await signInAs({ partnerId: 'pa' });
    fail.redis = true;
    expect(await reveal('tr_A1', 'recipient_name')).toEqual(NOT_FOUND);
    expect(await reveals()).toHaveLength(0);
  });
});
