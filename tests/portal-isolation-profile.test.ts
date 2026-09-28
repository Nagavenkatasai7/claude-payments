import { describe, it, expect, vi, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { customers, outbox } from '@/db/schema';
import { createStore } from '@/lib/store';
import { createCustomerStore, type CustomerStore } from '@/lib/customer-store';
import { emailVerifiedTag, getPortalPrefs } from '@/lib/portal-prefs';
import { renderSealedText } from '@/lib/sealed-text';
import { newRequestKey } from '@/lib/portal-request-key';
import type { Customer } from '@/lib/types';
import { freshDb, seedSender } from './helpers-db';
import { fakeRedis, type FakeRedis } from './helpers';
import { seedTwoPartners, type TwoPartnerFixture } from './helpers-portal-two-partner';

// UI redesign M2-11: the isolation pins (Review Focus 1: one phone under two partners) for Profile and
// Notifications, plus the binding-contract integration test with M2-7: the verify flow stamps
// email_verified_tag = emailVerifiedTag(), and the M2-7 "Email me a receipt" action then works.

const h = vi.hoisted(() => ({
  site: null as null | Record<string, unknown>,
  ctx: null as null | Record<string, unknown>,
  stale: false,
  db: null as unknown,
  redis: null as unknown,
  store: null as unknown,
  pokes: 0,
}));

vi.mock('@/lib/portal-site', () => ({
  getPortalSite: async () => h.site,
  requirePortalSite: async () => {
    if (!h.site) throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
    return h.site;
  },
}));
vi.mock('@/lib/portal-auth', () => ({
  getPortalCustomer: async () => h.ctx,
  requirePortalCustomer: async () => {
    if (!h.ctx) throw new Error('REDIRECT:/portal/login');
    return h.ctx;
  },
  requireFreshPortalAuth: async (returnTo: string) => {
    if (!h.ctx) throw new Error('REDIRECT:/portal/login');
    if (h.stale) throw new Error(`REDIRECT:/portal/verify?next=${returnTo}`);
    return h.ctx;
  },
}));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  redirect: (u: string) => {
    throw new Error(`REDIRECT:${u}`);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'acme.smartremit.ai' }) }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => h.db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => h.redis }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => h.store }));
vi.mock('@/lib/outbox', async (orig) => ({ ...(await orig<typeof import('@/lib/outbox')>()), pokeWorker: () => void h.pokes++, pokeWorkerDelayed: () => undefined }));
vi.mock('@/lib/whatsapp', async (orig) => ({ ...(await orig<typeof import('@/lib/whatsapp')>()), sendText: vi.fn(async () => {}) }));

import { setEmailReceiptsAction, setWhatsappNotificationsAction, updateEmailAction } from '@/app/portal/notifications/actions';
import { verifyEmailAction } from '@/app/portal/notifications/verify/actions';
import { emailReceiptAction } from '@/app/portal/transfers/[id]/actions';

const SITE = (partnerId: string) => ({ partnerId, slug: partnerId === 'pa' ? 'acme' : 'bolt', brand: partnerId === 'pa' ? 'Acme Remit' : 'Bolt Pay', logo: null, theme: {} });
const EMAIL = 'alice@example.com';
const OTHER = '14155550188';

let db: Db;
let redis: FakeRedis;
let cs: CustomerStore;
let phone: string;
let A: TwoPartnerFixture;

async function signIn(partnerId: string, p = phone) {
  h.site = SITE(partnerId);
  const customer = (await cs.getCustomer(partnerId, p)) as Customer;
  h.ctx = { site: h.site, session: { phone: p, sid: `sid-${partnerId}` }, token: `tok-${partnerId}`, customer };
}
const fd = (fields: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const emailRows = () => db.select().from(outbox).where(eq(outbox.kind, 'email.send'));
const row = async (pid: string, p = phone) => (await db.select().from(customers).where(and(eq(customers.partnerId, pid), eq(customers.phone, p))))[0];

async function lastToken(): Promise<string> {
  const rows = await emailRows();
  const p = rows.at(-1)!.payload as { text: string; sealed: unknown };
  const m = /verify\?token=([A-Za-z0-9_-]{43})/.exec(renderSealedText(p.text, p.sealed));
  if (!m) throw new Error('no token');
  return m[1];
}

/** A changes the address on partner pa and receives the link. */
async function aOnPaGetsToken(): Promise<string> {
  await signIn('pa');
  await updateEmailAction(null, fd({ email: EMAIL, requestKey: newRequestKey() }));
  return lastToken();
}

beforeEach(async () => {
  db = await freshDb();
  ({ A, phone } = await seedTwoPartners(db));
  await seedSender(db, { partnerId: 'pa', phone: OTHER });
  redis = fakeRedis();
  h.db = db;
  h.redis = redis;
  h.store = createStore(redis, db);
  cs = createCustomerStore(db, h.store as never);
  h.stale = false;
  h.pokes = 0;
});

describe('verify token isolation', () => {
  it("A's token (partner pa) posted on partner pb's host by the same phone → invalid, and it still works on pa afterwards", async () => {
    const token = await aOnPaGetsToken();
    // pb's row carries the same address, so only the tenant binding can refuse it.
    await cs.setEmail('pb', phone, EMAIL);
    await signIn('pb');
    expect(await verifyEmailAction(null, fd({ token }))).toEqual({ error: 'portal.email.link_invalid' });
    expect(await getPortalPrefs(db, 'pb', phone)).toBeNull();
    await signIn('pa');
    expect(await verifyEmailAction(null, fd({ token }))).toEqual({ notice: 'portal.email.verified' });
  });

  it("A's token posted by customer B on the SAME partner → invalid (B holds the same address)", async () => {
    const token = await aOnPaGetsToken();
    await cs.setEmail('pa', OTHER, EMAIL);
    await signIn('pa', OTHER);
    expect(await verifyEmailAction(null, fd({ token }))).toEqual({ error: 'portal.email.link_invalid' });
    expect(await getPortalPrefs(db, 'pa', OTHER)).toBeNull();
  });
});

describe('prefs + consent isolation', () => {
  it("A's changes on pa never touch pb's row or another customer on pa", async () => {
    await signIn('pa');
    await setWhatsappNotificationsAction(null, fd({ on: '0' }));
    await updateEmailAction(null, fd({ email: EMAIL, requestKey: newRequestKey() }));
    await signIn('pa');
    await verifyEmailAction(null, fd({ token: await lastToken() }));
    await setEmailReceiptsAction(null, fd({ on: '1' }));
    expect((await row('pb')).optedOutAt).toBeNull();
    expect((await row('pb')).emailEnc).toBeNull();
    expect((await row('pa', OTHER)).optedOutAt).toBeNull();
    expect(await getPortalPrefs(db, 'pb', phone)).toBeNull();
    expect(await getPortalPrefs(db, 'pa', OTHER)).toBeNull();
    expect(await getPortalPrefs(db, 'pa', phone)).toMatchObject({ emailReceipts: true });
  });

  it("verified on pa does not let the same phone turn receipts on at pb", async () => {
    const token = await aOnPaGetsToken();
    await signIn('pa');
    await verifyEmailAction(null, fd({ token }));
    await cs.setEmail('pb', phone, EMAIL);
    await signIn('pb');
    expect(await setEmailReceiptsAction(null, fd({ on: '1' }))).toEqual({ error: 'portal.receipt.verify_email_first' });
  });
});

describe('binding contract with M2-7: verify → "Email me a receipt" works', () => {
  it('before verification the receipt action refuses; after the real verify flow it enqueues ONE email to the verified address', async () => {
    const token = await aOnPaGetsToken();
    await signIn('pa');
    expect(await emailReceiptAction(A.transferIds[0], null, fd({ requestKey: newRequestKey() }))).toEqual({ error: 'portal.receipt.verify_email_first' });
    expect(await verifyEmailAction(null, fd({ token }))).toEqual({ notice: 'portal.email.verified' });
    expect((await getPortalPrefs(db, 'pa', phone))?.emailVerifiedTag).toBe(emailVerifiedTag('pa', phone, EMAIL));
    await signIn('pa');
    expect(await emailReceiptAction(A.transferIds[0], null, fd({ requestKey: newRequestKey() }))).toEqual({ notice: 'portal.receipt.sent' });
    const receipts = (await emailRows()).filter((r) => r.dedupeKey?.startsWith('rcpt:'));
    expect(receipts).toHaveLength(1);
    expect((receipts[0].payload as { to: string[] }).to).toEqual([EMAIL]);
  });
});
