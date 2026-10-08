import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedLedgerSpend, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';
import { createPartnerStore } from '@/lib/partner-store';

// Batch B4: POST /admin-dashboard/referrals/statement and the referrals page gate, through the
// REAL requireStaff chain (as tests/waitlist-admin.test.ts). Platform admin only, same-origin,
// audited, a GET is a 404, and the CSV holds no customer data.

const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
let pgPartnerStore: ReturnType<typeof createPartnerStore>;

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'smartremit.test' }),
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error(`REDIRECT:${p}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
vi.mock('@/lib/seed', () => ({ ensureSeedAdmin: async () => {} }));
vi.mock('@/db/client', async (orig) => ({
  ...((await orig()) as object),
  getDb: () => db,
}));

import { NextRequest } from 'next/server';
import { POST, GET } from '@/app/admin-dashboard/referrals/statement/route';
import ReferralsPage from '@/app/admin-dashboard/referrals/page';
import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { createReferralRepo } from '@/db/repos/referral-repo';

const URL_ = 'https://smartremit.test/admin-dashboard/referrals/statement';
function postReq(month: string | null, over: Record<string, string | null> = {}): NextRequest {
  const h = new Headers({ origin: 'https://smartremit.test', host: 'smartremit.test', 'content-type': 'application/x-www-form-urlencoded' });
  for (const [k, v] of Object.entries(over)) {
    if (v === null) h.delete(k);
    else h.set(k, v);
  }
  return new NextRequest(URL_, { method: 'POST', headers: h, body: month === null ? '' : `month=${encodeURIComponent(month)}` });
}

function staff(over: Partial<Staff>): Staff {
  return {
    username: 'u',
    name: 'U',
    role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'x',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}
async function signIn(s: Staff): Promise<void> {
  const store = getAuthStore();
  await store.saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await store.createSession(s.username));
}
const exportAudits = async () =>
  ((await db.execute(sql`SELECT actor, subject_id, meta FROM audit_events WHERE action = 'referral.statement_export' ORDER BY id`)) as unknown as {
    rows: { actor: string; subject_id: string; meta: Record<string, unknown> }[];
  }).rows;

const PHONE = '15550001111';
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
  pgPartnerStore = createPartnerStore(db);
  redis.dump.clear();
  cookieJar.clear();
  const repo = createReferralRepo(db);
  await repo.insertPartner({ id: 'rp_tana', name: 'TANA', contact: 'events@tana.org', commissionCents: 125, createdBy: 'admin' });
  await repo.insertCode({ code: 'REF-TANA01', referralPartnerId: 'rp_tana', createdBy: 'admin' });
  await repo.recordAttribution({ partnerId: 'acme', phone: PHONE, code: 'REF-TANA01', channel: 'portal' });
  await seedLedgerSpend(db, { partnerId: 'acme', phone: PHONE, amountUsd: 40, status: 'delivered', id: 'tr_ref1' });
  await db.execute(sql`UPDATE transfers SET delivered_at = '2026-09-03T10:00:00Z' WHERE id = 'tr_ref1'`);
  await db.execute(sql`UPDATE referral_attributions SET created_at = '2026-08-01T00:00:00Z'`);
});

describe('POST /admin-dashboard/referrals/statement', () => {
  it('a platform admin gets the month CSV (names and amounts only) and one audit row', async () => {
    await signIn(staff({ username: 'raj' }));
    const res = await POST(postReq('2026-09'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="referral-statement-2026-09.csv"');
    const body = await res.text();
    expect(body).toBe(
      'month,referral_partner,contact,delivered_transfers,commission_per_transfer_usd,commission_total_usd\r\n' +
        '"2026-09","TANA","events@tana.org",1,"1.25","1.25"\r\n',
    );
    expect(body).not.toContain(PHONE);
    expect(body).not.toContain('tr_ref1');
    expect(await exportAudits()).toEqual([{ actor: 'raj', subject_id: '2026-09', meta: { rowCount: 1, totalCents: 125 } }]);
  });

  it('GET is a 404; partner-scoped admins go to /partner; platform agents get a 404; cross-origin is 403; nothing audited', async () => {
    expect((await GET()).status).toBe(404);
    await signIn(staff({ username: 'pa', partnerId: 'acme' }));
    await expect(POST(postReq('2026-09'))).rejects.toThrow(/^REDIRECT:\/partner$/); // requireStaff (UI M5)
    await signIn(staff({ username: 'ag', role: 'agent' }));
    expect((await POST(postReq('2026-09'))).status).toBe(404);
    await signIn(staff({ username: 'raj' }));
    expect((await POST(postReq('2026-09', { origin: 'https://evil.test' }))).status).toBe(403);
    expect((await POST(postReq('2026-09', { origin: null }))).status).toBe(403);
    expect(await exportAudits()).toEqual([]);
  });

  it('anonymous → /login', async () => {
    await expect(POST(postReq('2026-09'))).rejects.toThrow('REDIRECT:/login');
  });

  it('STAFF_MFA_REQUIRED: an unenrolled platform admin gets a 404 and nothing is audited (same rule as requirePlatformAdmin)', async () => {
    process.env.STAFF_MFA_REQUIRED = 'true';
    try {
      await signIn(staff({ username: 'raj' }));
      expect((await POST(postReq('2026-09'))).status).toBe(404);
      expect(await exportAudits()).toEqual([]);
    } finally {
      delete process.env.STAFF_MFA_REQUIRED;
    }
  });
});

describe('the referrals page gate', () => {
  it('anonymous → /login; partner staff → /partner; a platform agent is refused; a platform admin renders', async () => {
    const page = () => ReferralsPage({ searchParams: Promise.resolve({}) });
    await expect(page()).rejects.toThrow('REDIRECT:/login');
    await signIn(staff({ username: 'pa', partnerId: 'acme' }));
    await expect(page()).rejects.toThrow(/^REDIRECT:\/partner$/);
    await signIn(staff({ username: 'ag', role: 'agent' }));
    await expect(page()).rejects.toThrow();
    await signIn(staff({ username: 'raj' }));
    await expect(page()).resolves.toBeTruthy();
  });
});
