import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';

// Batch B2: the /partner payees and payment-links actions and the CSV download stay inside the
// SESSION's tenant. Real gate (requirePartnerStaff over the auth store on a fake Redis) and the
// real service on PGlite; the shared partner-action contract (anonymous, platform, wrong role,
// another tenant's id, forged tenant fields) for every action that takes a target id.

const redis = fakeRedis();
let db: Db;
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host: 'smartremit.ai' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/rate', async (orig) => ({ ...(await orig<typeof import('@/lib/rate')>()), getFxRates: async () => ({ toInr: 85 }) }));

import { cancelLinkAction, checkBulkAction, createBulkAction, createLinkAction } from '@/app/partner/(app)/payment-links/actions';
import { addPayeeAction } from '@/app/partner/(app)/payees/actions';
import { GET as downloadLinks } from '@/app/partner/(app)/payment-links/download/route';
import { addPayee, createLink, decidePayee } from '@/lib/payment-link-ops';
import { expectPartnerActionContract, seedTwoTenants, signInAs } from './helpers-partner-app';

const ADMIN = { username: 'root', role: 'admin' };
const PAYEE = { legalName: 'Sunrise Public School', accountHolder: 'Sunrise School Trust', ifsc: 'HDFC0001234', accountNumber: '50100123456789', accountNumberConfirm: '50100123456789' };

const fd = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
};
const count = async (q: string) => Number(((await db.execute(sql.raw(q))) as unknown as { rows: Array<{ n: number }> }).rows[0].n);
const snapshot = async () => ({
  links: await count('SELECT count(*)::int AS n FROM payment_links'),
  open: await count(`SELECT count(*)::int AS n FROM payment_links WHERE status = 'open'`),
  payees: await count('SELECT count(*)::int AS n FROM payees'),
});

async function approved(partnerId: string) {
  const p = await addPayee(db, { partnerId, username: `${partnerId}-admin`, role: 'admin' }, PAYEE);
  await decidePayee(db, ADMIN, p.id, 'approve');
  return p.id;
}

let ref = 0;
const linkForm = (payeeId: string) =>
  fd({ payeeId, name: 'Asha Patel', phone: '14155550100', amount: '25000', reference: `INV-${++ref}`, purpose: 'education' });

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  db = await freshDb();
  await seedTwoTenants(db);
});

describe('partner payment-link actions stay inside the tenant', () => {
  it('createLinkAction: the partner-action contract (payee id is the target)', async () => {
    const own = await approved('pa');
    const foreign = await approved('pb');
    await expectPartnerActionContract({
      db, redis, cookieJar, action: createLinkAction, form: linkForm, ownId: own, foreignId: foreign,
      allowedRole: 'admin', disallowedRole: 'agent', snapshot,
    });
    const [row] = ((await db.execute(sql.raw('SELECT partner_id, purpose FROM payment_links'))) as unknown as { rows: Array<{ partner_id: string; purpose: string }> }).rows;
    expect(row).toEqual({ partner_id: 'pa', purpose: 'education' });
  });

  it('cancelLinkAction: the partner-action contract (link id is the target)', async () => {
    const own = await createLink(db, { partnerId: 'pa', username: 'x', role: 'admin' }, { payeeId: await approved('pa'), raw: { name: 'Asha Patel', phone: '14155550100', amount: '25000', reference: 'A-1', purpose: 'gift' } });
    const foreign = await createLink(db, { partnerId: 'pb', username: 'y', role: 'admin' }, { payeeId: await approved('pb'), raw: { name: 'Ravi Kumar', phone: '14155550101', amount: '1000', reference: 'B-1', purpose: 'gift' } });
    await expectPartnerActionContract({
      db, redis, cookieJar, action: cancelLinkAction, form: (id) => fd({ id }), ownId: own.id, foreignId: foreign.id,
      allowedRole: 'admin', disallowedRole: 'agent', snapshot,
    });
    expect(await count(`SELECT count(*)::int AS n FROM payment_links WHERE id = '${foreign.id}' AND status = 'open'`)).toBe(1);
  });

  it('createBulkAction: the partner-action contract; purpose is required in every row', async () => {
    const own = await approved('pa');
    const foreign = await approved('pb');
    let n = 0;
    const csvForm = (payeeId: string) =>
      fd({ payeeId, csv: `name,phone,amount,reference,purpose\nAsha Patel,14155550100,25000,C-${++n},education\nRavi Kumar,14155550101,1000,D-${n},\n` });
    await expectPartnerActionContract({
      db, redis, cookieJar, action: createBulkAction, form: csvForm, ownId: own, foreignId: foreign,
      allowedRole: 'admin', disallowedRole: 'agent', snapshot,
    });
    // One link made: the row without a purpose was skipped.
    expect(await count(`SELECT count(*)::int AS n FROM payment_links WHERE partner_id = 'pa'`)).toBe(1);
  });

  it('checkBulkAction saves nothing and reports each row', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
    const r = await checkBulkAction(fd({ csv: 'name,phone,amount,reference,purpose\nAsha Patel,1.41E+10,25000,E-1,education\n' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows[0].errors.join(' ')).toMatch(/Excel/);
    expect((await snapshot()).links).toBe(0);
  });

  it('addPayeeAction adds a pending payee at the session tenant (a forged partnerId is ignored); agents are refused', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-agent', partnerId: 'pa', role: 'agent' });
    await expect(addPayeeAction(fd(PAYEE))).rejects.toThrow('REDIRECT:/partner');
    await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
    const r = await addPayeeAction(fd({ ...PAYEE, partnerId: 'pb' }));
    expect(r.ok).toBe(true);
    expect(await count(`SELECT count(*)::int AS n FROM payees WHERE partner_id = 'pa' AND status = 'pending'`)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM payees WHERE partner_id = 'pb'`)).toBe(0);
  });

  it('the CSV download holds only the session tenant\'s links and is audited', async () => {
    await createLink(db, { partnerId: 'pa', username: 'x', role: 'admin' }, { payeeId: await approved('pa'), raw: { name: 'Asha Patel', phone: '14155550100', amount: '25000', reference: 'MINE-1', purpose: 'gift' } });
    await createLink(db, { partnerId: 'pb', username: 'y', role: 'admin' }, { payeeId: await approved('pb'), raw: { name: 'Ravi Kumar', phone: '14155550101', amount: '1000', reference: 'THEIRS-1', purpose: 'gift' } });
    cookieJar.clear();
    await expect(downloadLinks()).rejects.toThrow('REDIRECT:/login');
    await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
    const res = await downloadLinks();
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    const text = await res.text();
    expect(text).toContain('MINE-1');
    expect(text).toContain('/pay/l/');
    expect(text).not.toContain('THEIRS-1');
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'paylink.export' AND partner_id = 'pa'`)).toBe(1);
  });
});
