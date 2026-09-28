import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditEvents, recipientTombstones } from '@/db/schema';
import { createRecipientRepo } from '@/db/repos/aux-repos';
import { freshDb, seedSender } from './helpers-db';
import { fakeRedis, type FakeRedis } from './helpers';
import { seedTwoPartners, TWO_PARTNER_PHONE } from './helpers-portal-two-partner';

// UI redesign M2-8, Task 8.3: the customer-portal recipient actions and pages, through the REAL
// portal gate (requirePortalCustomer / requireFreshPortalAuth on a real session store), with the
// two-partner fixture. Partner A's customer can never read, edit or delete partner B's (or another
// customer's) recipient; every miss is the same "not found".

const SITE = (partnerId: string, slug: string) => ({
  partnerId,
  slug,
  brand: `Brand ${slug}`,
  logo: null,
  theme: { primary: '#0c5bd2', accent: '#0e7490', primaryFromPartner: false, accentFromPartner: false },
});

const h = vi.hoisted(() => {
  const state = {
    site: null as null | Record<string, unknown>,
    jar: new Map<string, string>(),
    redis: null as unknown as Record<string, (...a: unknown[]) => unknown>,
    db: null as unknown,
    // The portal session store caches its Redis client process-wide: route it to this test's fake.
    redisProxy: null as unknown,
  };
  state.redisProxy = new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => state.redis[k](...a) });
  return state;
});

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'acme.smartremit.ai', 'x-forwarded-for': '203.0.113.1', 'user-agent': 'test' }),
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    set: (n: string, v: string) => h.jar.set(n, v),
    delete: (n: string) => h.jar.delete(n),
  }),
}));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  redirect: (u: string) => {
    throw new Error(`REDIRECT:${u}`);
  },
}));
vi.mock('@/lib/portal-site', () => ({
  getPortalSite: async () => h.site,
  requirePortalSite: async () => {
    if (!h.site) throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
    return h.site;
  },
}));
vi.mock('@/lib/redis', () => ({ getRedis: () => h.redisProxy }));
vi.mock('@/db/client', () => ({ getDb: () => h.db }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => ({}) }));
vi.mock('@/lib/customer-store', async () => {
  const { createCustomerRepo } = await import('@/db/repos/customer-repo');
  return { getCustomerStore: () => createCustomerRepo(h.db as never, async () => null) };
});
vi.mock('@/lib/customer-mfa', () => ({
  getCustomerMfaStore: () => ({ isEnrolled: async () => false, verifyCode: async () => false }),
}));

import { addRecipientAction, deleteRecipientAction, editRecipientAction, type RecipientFormState } from '@/app/portal/recipients/actions';
import PortalRecipientsPage from '@/app/portal/recipients/page';
import EditRecipientPage from '@/app/portal/recipients/[rid]/edit/page';
import { createPortalSessionStore, PORTAL_SESSION_COOKIE } from '@/lib/portal-session-store';
import { newRequestKey } from '@/lib/portal-request-key';
import { recipientRid } from '@/lib/portal-recipients';
import { maskAccount } from '@/lib/tools';

const PHONE = TWO_PARTNER_PHONE;
const OTHER_SENDER = '14155550303';
const A_RP = '919000000001'; // pa's saved recipient in the fixture (account ends 2222)
const B_RP = '919000000002'; // pb's (account ends 4444)
const A_FULL = '000011112222';
const A_MASKED = maskAccount('bank', `${A_FULL}|HDFC0001111`); // the fixture's own format: the last digit run
const B_FULL = '000033334444';
const NEW_ACCOUNT = '123456789012';

let db: Db;
let redis: FakeRedis;
let now = Date.now();

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const init = (): RecipientFormState => ({ requestKey: newRequestKey() });
async function expectRedirect(p: Promise<unknown>, to: string) {
  await expect(p).rejects.toThrow(`REDIRECT:${to}`);
}
async function signIn(partnerId: string, phone = PHONE) {
  const { token } = await createPortalSessionStore(redis).create(partnerId, phone, 'Safari on iOS');
  h.jar.set(PORTAL_SESSION_COOKIE, token);
}
const onHost = (partnerId: 'pa' | 'pb') => {
  h.site = SITE(partnerId, partnerId === 'pa' ? 'acme' : 'bravo');
};
const audits = async (action?: string) =>
  (await db.select().from(auditEvents)).filter((a) => (action ? a.action === action : a.action.startsWith('recipient.') || a.action === 'schedule.cancel'));
const tombstoned = async (partnerId: string, sender: string, rp: string) =>
  (await db.select().from(recipientTombstones).where(and(eq(recipientTombstones.partnerId, partnerId), eq(recipientTombstones.senderPhone, sender), eq(recipientTombstones.recipientPhone, rp)))).length === 1;
const addForm = (o: Record<string, string> = {}) =>
  fd({ requestKey: newRequestKey(), name: 'New Person', recipientPhone: '+91 90000 00077', country: 'IN', accountNumber: NEW_ACCOUNT, ifsc: 'HDFC0001234', ...o });
async function listHtml() {
  return renderToStaticMarkup(await PortalRecipientsPage({ searchParams: Promise.resolve({}) }));
}

beforeEach(async () => {
  db = await freshDb();
  await seedTwoPartners(db);
  // B also saved a recipient with A's recipient phone (the same-phone isolation case), and a second
  // customer of A saved that same phone too.
  await createRecipientRepo(db).upsertRecipient('pb', PHONE, { name: 'Same Phone B', recipientPhone: A_RP, payoutMethod: 'bank', payoutDestination: `HDFC0005555 ${B_FULL}`, lastUsedAt: new Date().toISOString() });
  await seedSender(db, { partnerId: 'pa', phone: OTHER_SENDER, firstSeenDaysAgo: 5, kycStatus: 'verified' });
  await createRecipientRepo(db).upsertRecipient('pa', OTHER_SENDER, { name: 'Other Customer Pick', recipientPhone: A_RP, payoutMethod: 'bank', payoutDestination: `HDFC0006666 ${B_FULL}`, lastUsedAt: new Date().toISOString() });
  redis = fakeRedis();
  h.redis = redis as never;
  h.db = db;
  h.jar = new Map();
  onHost('pa');
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

describe('isolation: another tenant, another customer, a random rid', () => {
  const MISSES = () => [recipientRid('pb', PHONE, B_RP), recipientRid('pb', PHONE, A_RP), recipientRid('pa', OTHER_SENDER, A_RP), '0'.repeat(32), 'not-a-rid'];

  it("A cannot edit B's or another customer's recipient; every miss is the same not-found and nothing is written", async () => {
    await signIn('pa');
    for (const rid of MISSES()) {
      const s = await editRecipientAction(rid, init(), fd({ requestKey: newRequestKey(), name: 'Hijack' }));
      expect(s.error).toBe('portal.recipients.not_found');
    }
    expect((await createRecipientRepo(db).listAllForSender('pb', PHONE)).map((r) => r.name).sort()).toEqual(['Recipient PB', 'Same Phone B']);
    expect((await createRecipientRepo(db).listAllForSender('pa', OTHER_SENDER)).map((r) => r.name)).toEqual(['Other Customer Pick']);
    expect(await audits()).toEqual([]);
  });

  it("A cannot delete B's or another customer's recipient (same not-found redirect)", async () => {
    await signIn('pa');
    for (const rid of MISSES()) await expectRedirect(deleteRecipientAction(rid, fd({})), '/portal/recipients?error=not_found');
    expect(await db.select().from(recipientTombstones)).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it("deleting A's recipient leaves B's and the other customer's same-phone recipient in place", async () => {
    await signIn('pa');
    await expectRedirect(deleteRecipientAction(recipientRid('pa', PHONE, A_RP), fd({})), '/portal/recipients?done=deleted');
    expect(await tombstoned('pa', PHONE, A_RP)).toBe(true);
    expect(await tombstoned('pb', PHONE, A_RP)).toBe(false);
    expect(await tombstoned('pa', OTHER_SENDER, A_RP)).toBe(false);
    expect((await createRecipientRepo(db).listAllForSender('pb', PHONE)).some((r) => r.recipientPhone === A_RP)).toBe(true);
    expect((await createRecipientRepo(db).listAllForSender('pa', OTHER_SENDER)).some((r) => r.recipientPhone === A_RP)).toBe(true);
  });

  it("A's cookie on B's host is signed out (redirect to login) before any write", async () => {
    await signIn('pa');
    onHost('pb');
    await expectRedirect(deleteRecipientAction(recipientRid('pb', PHONE, B_RP), fd({})), '/portal/login');
    expect(await db.select().from(recipientTombstones)).toEqual([]);
  });

  it("the edit page 404s for B's rid, another customer's rid and a random rid", async () => {
    await signIn('pa');
    for (const rid of MISSES()) {
      await expect(EditRecipientPage({ params: Promise.resolve({ rid }) })).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
    }
  });

  it("the list shows only A's own recipients, masked; never B's, never a full account", async () => {
    await signIn('pa');
    const html = await listHtml();
    expect(html).toContain('Recipient PA');
    expect(html).toContain(A_MASKED);
    expect(html).not.toContain('Recipient PB');
    expect(html).not.toContain('Same Phone B');
    expect(html).not.toContain('Other Customer Pick');
    for (const secret of [A_FULL, B_FULL, 'HDFC0001111', A_RP, B_RP, PHONE]) expect(html).not.toContain(secret);
    expect(html).toContain(`/portal/recipients/${recipientRid('pa', PHONE, A_RP)}/edit`);
    expect(html).toContain(`/portal/send?r=${recipientRid('pa', PHONE, A_RP)}`);
  });
});

describe('the gate: host first, then a fresh step-up', () => {
  it('apex / portal off → 404 before any session read', async () => {
    h.site = null;
    await expect(addRecipientAction(init(), addForm())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    await expect(deleteRecipientAction(recipientRid('pa', PHONE, A_RP), fd({}))).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });

  it('no session → login', async () => {
    await expectRedirect(addRecipientAction(init(), addForm()), '/portal/login');
  });

  it('a stale session (> 15 min since the last code) → /portal/verify with the right next, and nothing written', async () => {
    await signIn('pa');
    now += 16 * 60_000;
    const rid = recipientRid('pa', PHONE, A_RP);
    await expectRedirect(addRecipientAction(init(), addForm()), '/portal/verify?next=/portal/recipients/new');
    await expectRedirect(editRecipientAction(rid, init(), fd({ requestKey: newRequestKey(), name: 'X' })), `/portal/verify?next=/portal/recipients/${rid}/edit`);
    await expectRedirect(deleteRecipientAction(rid, fd({})), '/portal/verify?next=/portal/recipients');
    await expectRedirect(EditRecipientPage({ params: Promise.resolve({ rid }) }), `/portal/verify?next=/portal/recipients/${rid}/edit`);
    expect(await db.select().from(recipientTombstones)).toEqual([]);
    expect(await audits()).toEqual([]);
  });
});

describe('add', () => {
  it('saves, audits recipient.create with the rid and field NAMES only, and redirects', async () => {
    await signIn('pa');
    await expectRedirect(addRecipientAction(init(), addForm()), '/portal/recipients?done=added');
    const saved = (await createRecipientRepo(db).listAllForSender('pa', PHONE)).find((r) => r.recipientPhone === '919000000077');
    expect(saved).toMatchObject({ name: 'New Person', payoutMethod: 'bank', payoutDestination: `HDFC0001234 ${NEW_ACCOUNT}` });
    const [a] = await audits('recipient.create');
    expect(a.meta).toEqual({ rid: recipientRid('pa', PHONE, '919000000077'), fields: ['name', 'destination'] });
    const meta = JSON.stringify(a.meta);
    for (const secret of [NEW_ACCOUNT, NEW_ACCOUNT.slice(-4), 'HDFC0001234', '919000000077', PHONE]) expect(meta).not.toContain(secret);
  });

  it('a duplicate (a live recipient with that phone) is refused with a fresh request key', async () => {
    await signIn('pa');
    const f = addForm({ recipientPhone: `+${A_RP}` });
    const s = await addRecipientAction(init(), f);
    expect(s.error).toBe('portal.recipients.exists');
    expect(s.requestKey).not.toBe(f.get('requestKey'));
    expect(await audits()).toEqual([]);
  });

  it('a refused form is not stored under its key: fixing it and resubmitting with the returned key succeeds', async () => {
    await signIn('pa');
    const bad = await addRecipientAction(init(), addForm({ ifsc: 'NOPE' }));
    expect(bad.errors?.bank?.ifsc).toBeTruthy();
    expect(bad.values).toEqual({ name: 'New Person', recipientPhone: '+91 90000 00077', country: 'IN' }); // never bank values
    await expectRedirect(addRecipientAction(bad, addForm({ requestKey: bad.requestKey })), '/portal/recipients?done=added');
  });

  it('a double submit with the same key writes once', async () => {
    await signIn('pa');
    const f = addForm();
    await expectRedirect(addRecipientAction(init(), f), '/portal/recipients?done=added');
    await expectRedirect(addRecipientAction(init(), f), '/portal/recipients?done=added');
    expect(await audits('recipient.create')).toHaveLength(1);
  });

  it('re-adding a deleted recipient brings it back (the tombstone is removed)', async () => {
    await signIn('pa');
    await expectRedirect(deleteRecipientAction(recipientRid('pa', PHONE, A_RP), fd({})), '/portal/recipients?done=deleted');
    await expectRedirect(addRecipientAction(init(), addForm({ recipientPhone: A_RP })), '/portal/recipients?done=added');
    expect(await tombstoned('pa', PHONE, A_RP)).toBe(false);
  });

  it('more than 30 changes an hour → too_many', async () => {
    await signIn('pa');
    for (let i = 0; i < 30; i++) {
      const s = await addRecipientAction(init(), addForm({ name: '' }));
      expect(s.errors?.name).toBe('portal.recipients.name_invalid');
    }
    expect((await addRecipientAction(init(), addForm())).error).toBe('portal.recipients.too_many');
  });
});

describe('edit', () => {
  it('a name change audits fields [name]; the key comes from the stored row, not the form', async () => {
    await signIn('pa');
    const rid = recipientRid('pa', PHONE, A_RP);
    await expectRedirect(editRecipientAction(rid, init(), fd({ requestKey: newRequestKey(), name: 'Renamed', recipientPhone: '919999999999' })), '/portal/recipients?done=updated');
    const list = await createRecipientRepo(db).listAllForSender('pa', PHONE);
    expect(list.map((r) => [r.recipientPhone, r.name])).toEqual([[A_RP, 'Renamed']]);
    expect(list[0].payoutDestination).toBe(`${A_FULL}|HDFC0001111`); // unchanged
    expect((await audits('recipient.update'))[0].meta).toEqual({ rid, fields: ['name'] });
  });

  it('new bank details replace the account and audit fields [destination] without values', async () => {
    await signIn('pa');
    const rid = recipientRid('pa', PHONE, A_RP);
    await expectRedirect(
      editRecipientAction(rid, init(), fd({ requestKey: newRequestKey(), name: 'Recipient PA', accountNumber: NEW_ACCOUNT, ifsc: 'ICIC0004321' })),
      '/portal/recipients?done=updated',
    );
    expect((await createRecipientRepo(db).getRecipient('pa', PHONE, A_RP))?.payoutDestination).toBe(`ICIC0004321 ${NEW_ACCOUNT}`);
    const [a] = await audits('recipient.update');
    expect(a.meta).toEqual({ rid, fields: ['destination'] });
    expect(JSON.stringify(a.meta)).not.toContain(NEW_ACCOUNT.slice(-4));
  });

  it('the edit page shows the account masked and never pre-fills it', async () => {
    await signIn('pa');
    const html = renderToStaticMarkup(await EditRecipientPage({ params: Promise.resolve({ rid: recipientRid('pa', PHONE, A_RP) }) }));
    expect(html).toContain(A_MASKED);
    expect(html).toContain('Recipient PA');
    for (const secret of [A_FULL, 'HDFC0001111', A_RP]) expect(html).not.toContain(secret);
  });
});

describe('delete: the tombstone is honoured on the web', () => {
  it('after delete the list no longer shows it and its edit page 404s; the row itself is kept', async () => {
    await signIn('pa');
    const rid = recipientRid('pa', PHONE, A_RP);
    await expectRedirect(deleteRecipientAction(rid, fd({})), '/portal/recipients?done=deleted');
    expect(await listHtml()).not.toContain('Recipient PA');
    await expect(EditRecipientPage({ params: Promise.resolve({ rid }) })).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
    expect(await createRecipientRepo(db).isTombstoned('pa', PHONE, A_RP)).toBe(true);
    const kept = await db.execute(`SELECT count(*)::int AS n FROM recipients WHERE partner_id = 'pa' AND sender_phone = '${PHONE}'` as never);
    expect((kept as unknown as { rows: Array<{ n: number }> }).rows[0].n).toBe(1);
    // the fixture's active schedule to this recipient was cancelled with it
    expect((await audits()).map((a) => a.action)).toEqual(['schedule.cancel', 'recipient.delete']);
    // a second delete is a not-found (idempotent, nothing more written)
    await expectRedirect(deleteRecipientAction(rid, fd({})), '/portal/recipients?error=not_found');
    expect(await audits()).toHaveLength(2);
  });

  it('the empty state renders when the customer has no recipients', async () => {
    await signIn('pa');
    await expectRedirect(deleteRecipientAction(recipientRid('pa', PHONE, A_RP), fd({})), '/portal/recipients?done=deleted');
    expect(await listHtml()).toContain('No saved recipients yet');
  });
});
