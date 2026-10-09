import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { createScheduleRepo } from '@/db/repos/schedule-repo';
import { createRecipientRepo } from '@/db/repos/aux-repos';
import { freshDb } from './helpers-db';
import { fakeRedis, type FakeRedis } from './helpers';
import { seedTwoPartners, TWO_PARTNER_PHONE, type TwoPartnerFixture } from './helpers-portal-two-partner';

// UI redesign M2-10: the customer-portal schedule actions and pages, through the REAL portal gate
// (requirePortalSite first, requirePortalCustomer / requireFreshPortalAuth on a real session store)
// and the REAL tool context (the bot's validation), with the two-partner fixture. Partner A's
// customer never sees, pauses, resumes or cancels partner B's (or another customer's) schedule, and
// cannot create one to B's recipient or to a deleted recipient.

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
vi.mock('@/lib/store', async (orig) => {
  const real = await orig<typeof import('@/lib/store')>();
  return { ...real, getStore: () => real.createStore(h.redisProxy as never, h.db as never) };
});
vi.mock('@/lib/customer-mfa', () => ({
  getCustomerMfaStore: () => ({ isEnrolled: async () => false, verifyCode: async () => false }),
}));

import { cancelScheduleAction, createScheduleAction, pauseScheduleAction, resumeScheduleAction, type ScheduleFormState } from '@/app/portal/schedules/actions';
import PortalSchedulesPage from '@/app/portal/schedules/page';
import NewSchedulePage from '@/app/portal/schedules/new/page';
import { createPortalSessionStore, PORTAL_SESSION_COOKIE } from '@/lib/portal-session-store';
import { newRequestKey } from '@/lib/portal-request-key';
import { recipientRid } from '@/lib/portal-recipients';
import { createCustomerStore } from '@/lib/customer-store';
import { createStore } from '@/lib/store';
import type { Customer } from '@/lib/types';
import { maskAccount } from '@/lib/tools';

const PHONE = TWO_PARTNER_PHONE;
const OTHER = '14155550303';
const A_RP = '919000000001';
const B_RP = '919000000002';
const A_FULL = '000011112222';
const B_FULL = '000033334444';

let db: Db;
let redis: FakeRedis;
let now = Date.now();
let A: TwoPartnerFixture;
let B: TwoPartnerFixture;

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const init = (): ScheduleFormState => ({ requestKey: newRequestKey() });
const createForm = (o: Record<string, string> = {}) =>
  fd({ requestKey: newRequestKey(), rid: recipientRid('pa', PHONE, A_RP), amount: '120', frequency: 'monthly', dayOfMonth: '9', purpose: 'savings', ...o });
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
const audits = async () =>
  ((await db.execute(sql`SELECT action, partner_id, meta FROM audit_events WHERE action LIKE 'schedule.%' ORDER BY id`)) as unknown as {
    rows: Array<{ action: string; partner_id: string; meta: Record<string, unknown> }>;
  }).rows;
const statusOf = async (partnerId: string, phone: string, id: string) => (await createScheduleRepo(db).getOwnedSchedule(partnerId, phone, id))?.status;
const listHtml = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await PortalSchedulesPage({ searchParams: Promise.resolve(sp) }));
const schedulesOf = (partnerId: string, phone = PHONE) => createScheduleRepo(db).listForCustomer(partnerId, phone);

async function nameOnFile(partnerId: string, phone = PHONE) {
  const cs = createCustomerStore(db, createStore(redis, db));
  const c = (await cs.getCustomer(partnerId, phone)) as Customer;
  await cs.saveCustomer({ ...c, fullName: 'Alex Rivera' });
}

beforeEach(async () => {
  db = await freshDb();
  ({ A, B } = await seedTwoPartners(db));
  redis = fakeRedis();
  h.redis = redis as never;
  h.db = db;
  h.jar = new Map();
  await nameOnFile('pa');
  await nameOnFile('pb');
  onHost('pa');
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network: a schedule prices at run time'); }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the gate', () => {
  it('apex / portal off → 404 before any session read, for every action and page', async () => {
    h.site = null;
    await expect(createScheduleAction(init(), createForm())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    for (const act of [pauseScheduleAction, resumeScheduleAction, cancelScheduleAction]) {
      await expect(act(A.scheduleIds[0], fd({}))).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    }
    await expect(listHtml()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    await expect(NewSchedulePage()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });

  it('no session → login, nothing written', async () => {
    await expectRedirect(createScheduleAction(init(), createForm()), '/portal/login');
    await expectRedirect(pauseScheduleAction(A.scheduleIds[0], fd({})), '/portal/login');
    await expectRedirect(listHtml(), '/portal/login');
    expect(await statusOf('pa', PHONE, A.scheduleIds[0])).toBe('active');
  });

  it("A's cookie on B's host is signed out before any write", async () => {
    await signIn('pa');
    onHost('pb');
    await expectRedirect(cancelScheduleAction(B.scheduleIds[0], fd({})), '/portal/login');
    expect(await statusOf('pb', PHONE, B.scheduleIds[0])).toBe('active');
  });

  it('a stale session: create, resume and the new page need the step-up; pause and cancel do not', async () => {
    await signIn('pa');
    now += 16 * 60_000;
    await expectRedirect(createScheduleAction(init(), createForm()), '/portal/verify?next=/portal/schedules/new');
    await expectRedirect(NewSchedulePage(), '/portal/verify?next=/portal/schedules/new');
    await expectRedirect(pauseScheduleAction(A.scheduleIds[0], fd({})), '/portal/schedules?done=paused');
    await expectRedirect(resumeScheduleAction(A.scheduleIds[0], fd({})), '/portal/verify?next=/portal/schedules');
    expect(await statusOf('pa', PHONE, A.scheduleIds[0])).toBe('paused');
    await expectRedirect(cancelScheduleAction(A.scheduleIds[0], fd({})), '/portal/schedules?done=cancelled');
    expect((await schedulesOf('pa')).length).toBe(1);
  });
});

describe('isolation', () => {
  it("A cannot pause, resume or cancel B's schedule, another customer's, or a made-up id: one not-found, nothing written", async () => {
    const mine = (await schedulesOf('pa'))[0];
    await createScheduleRepo(db).saveSchedule({ ...mine, id: 's_other_cust', phone: OTHER });
    await signIn('pa');
    for (const id of [B.scheduleIds[0], 's_other_cust', 'nope', '../../x']) {
      for (const act of [pauseScheduleAction, resumeScheduleAction, cancelScheduleAction]) {
        await expectRedirect(act(id, fd({})), '/portal/schedules?error=not_found');
      }
    }
    expect(await statusOf('pb', PHONE, B.scheduleIds[0])).toBe('active');
    expect(await statusOf('pa', OTHER, 's_other_cust')).toBe('active');
    expect(await audits()).toEqual([]);
  });

  it("A cannot create a schedule to B's recipient, another customer's, or a deleted recipient", async () => {
    await signIn('pa');
    await createRecipientRepo(db).tombstoneRecipient('pa', PHONE, A_RP);
    for (const rid of [recipientRid('pb', PHONE, B_RP), recipientRid('pa', OTHER, A_RP), recipientRid('pa', PHONE, A_RP)]) {
      const s = await createScheduleAction(init(), createForm({ rid }));
      expect(s.error).toBe('portal.schedules.recipient_gone');
    }
    expect((await schedulesOf('pa')).length).toBe(1);
    expect((await schedulesOf('pb')).length).toBe(1);
    expect(await audits()).toEqual([]);
  });

  it("the list shows only A's own schedules, masked; never B's, never a full account or a phone", async () => {
    await signIn('pa');
    const html = await listHtml();
    expect(html).toContain('Recipient PA');
    expect(html).toContain(maskAccount('bank', `${A_FULL}|HDFC0001111`)); // the recipients page's own masking
    expect(html).not.toContain('Recipient PB');
    for (const secret of [A_FULL, B_FULL, 'HDFC0001111', A_RP, B_RP, PHONE]) expect(html).not.toContain(secret);
  });
});

describe('create', () => {
  it('saves through the bot validation, audits schedule.create with the id only, and redirects', async () => {
    await signIn('pa');
    await expectRedirect(createScheduleAction(init(), createForm()), '/portal/schedules?done=created');
    const mine = await schedulesOf('pa');
    expect(mine).toHaveLength(2);
    const created = mine.find((s) => s.id !== A.scheduleIds[0])!;
    expect(created).toMatchObject({ recipientPhone: A_RP, amountSource: 120, dayOfMonth: 9, payoutDestination: `${A_FULL}|HDFC0001111`, status: 'active', purpose: 'savings' });
    const a = await audits();
    expect(a).toEqual([{ action: 'schedule.create', partner_id: 'pa', meta: { scheduleId: created.id } }]);
  });

  it('a double submit with the same key writes once', async () => {
    await signIn('pa');
    const f = createForm();
    await expectRedirect(createScheduleAction(init(), f), '/portal/schedules?done=created');
    await expectRedirect(createScheduleAction(init(), f), '/portal/schedules?done=created');
    expect(await schedulesOf('pa')).toHaveLength(2);
    expect((await audits()).filter((x) => x.action === 'schedule.create')).toHaveLength(1);
  });

  it('a refused form keeps its non-secret values and returns a fresh key; the fixed resubmit succeeds', async () => {
    await signIn('pa');
    const bad = await createScheduleAction(init(), createForm({ amount: '5' }));
    expect(bad.error).toBe('portal.schedules.amount_invalid');
    expect(bad.values).toMatchObject({ amount: '5', frequency: 'monthly', dayOfMonth: '9' });
    await expectRedirect(createScheduleAction(bad, createForm({ requestKey: bad.requestKey })), '/portal/schedules?done=created');
  });

  it('field errors come back per field', async () => {
    await signIn('pa');
    const s = await createScheduleAction(init(), createForm({ frequency: 'weekly', dayOfWeek: '9' }));
    expect(s.errors?.day).toBe('portal.schedules.day_invalid');
  });

  it('A3: Other with no reason ⇒ the reason error with the words echoed; nothing saved', async () => {
    await signIn('pa');
    const before = (await schedulesOf('pa')).length;
    const s = await createScheduleAction(init(), createForm({ purpose: 'other', purpose_detail: 'send money' }));
    expect(s.errors?.purposeDetail).toBe('portal.send.purpose_detail_invalid');
    expect(s.values).toMatchObject({ purpose: 'other', purpose_detail: 'send money' });
    expect(s.scamWarning).toBeUndefined();
    expect(await schedulesOf('pa')).toHaveLength(before);
  });

  it('A4: a scam-pattern reason ⇒ the warning and the tick first (no rule named), then the schedule is saved', async () => {
    await signIn('pa');
    const before = (await schedulesOf('pa')).length;
    const words = { purpose: 'other', purpose_detail: 'to claim my lottery prize' };
    const s = await createScheduleAction(init(), createForm(words));
    expect(s).toMatchObject({ error: 'portal.send.scam_ack_required', scamWarning: true, values: words });
    expect(JSON.stringify(s)).not.toMatch(/category/);
    expect(await schedulesOf('pa')).toHaveLength(before);
    await expectRedirect(createScheduleAction(s, createForm({ ...words, scam_ack: 'on', requestKey: s.requestKey })), '/portal/schedules?done=created');
    expect(await schedulesOf('pa')).toHaveLength(before + 1);
  });

  it('required purpose: none chosen ⇒ the purpose field error, the choice echoed, nothing saved', async () => {
    await signIn('pa');
    const before = (await schedulesOf('pa')).length;
    for (const purpose of ['', 'P1301']) {
      const s = await createScheduleAction(init(), createForm({ purpose }));
      expect(s.errors?.purpose, purpose).toBe('portal.schedules.purpose_invalid');
      expect(s.values?.purpose).toBe(purpose);
    }
    expect(await schedulesOf('pa')).toHaveLength(before);
  });

  it('more than 20 schedule changes an hour → too_many', async () => {
    await signIn('pa');
    for (let i = 0; i < 20; i++) {
      await expectRedirect(pauseScheduleAction('nope', fd({})), '/portal/schedules?error=not_found');
    }
    expect((await createScheduleAction(init(), createForm())).error).toBe('portal.schedules.too_many');
    await expectRedirect(pauseScheduleAction(A.scheduleIds[0], fd({})), '/portal/schedules?error=too_many');
  });
});

describe('status changes and the list', () => {
  it('pause → resume → cancel; the list shows paused, hides cancelled, and the empty state renders', async () => {
    await signIn('pa');
    const id = A.scheduleIds[0];
    await expectRedirect(pauseScheduleAction(id, fd({})), '/portal/schedules?done=paused');
    expect(await listHtml()).toContain('Paused');
    await expectRedirect(pauseScheduleAction(id, fd({})), '/portal/schedules?error=already_paused');
    await expectRedirect(resumeScheduleAction(id, fd({})), '/portal/schedules?done=resumed');
    await expectRedirect(cancelScheduleAction(id, fd({})), '/portal/schedules?done=cancelled');
    await expectRedirect(resumeScheduleAction(id, fd({})), '/portal/schedules?error=cancelled');
    const html = await listHtml({ done: 'cancelled' });
    expect(html).toContain('Schedule cancelled.');
    expect(html).toContain('No scheduled payments');
    expect((await audits()).map((a) => a.action)).toEqual(['schedule.pause', 'schedule.resume', 'schedule.cancel']);
  });

  it('the flash is a fixed allow-list: an unknown query value echoes nothing', async () => {
    await signIn('pa');
    const html = await listHtml({ done: '<script>x</script>', error: 'pwned' });
    expect(html).not.toContain('pwned');
    expect(html).not.toContain('<script>x');
  });

  it('the new page lists only live saved recipients, masked, by rid', async () => {
    await signIn('pa');
    const html = renderToStaticMarkup(await NewSchedulePage());
    expect(html).toContain('Recipient PA');
    expect(html).toContain(recipientRid('pa', PHONE, A_RP));
    for (const secret of [A_FULL, A_RP, 'Recipient PB']) expect(html).not.toContain(secret);
    await createRecipientRepo(db).tombstoneRecipient('pa', PHONE, A_RP);
    expect(renderToStaticMarkup(await NewSchedulePage())).toContain('Save a recipient first');
  });

  it('required purpose: the new page has a required "Why you are sending" select with the 8 reasons, none chosen', async () => {
    await signIn('pa');
    const html = renderToStaticMarkup(await NewSchedulePage());
    expect(html).toContain('Why you are sending');
    expect(html).toMatch(/<select[^>]*name="purpose"[^>]*required/);
    expect(html).toMatch(/<option value="" disabled="" selected="">Choose a reason<\/option>/);
    for (const label of ['Family support', 'Gift', 'Education', 'Medical', 'Savings', 'Bills', 'Business', 'Other']) expect(html).toContain(`>${label}</option>`);
  });

  it('required purpose (Q2): the list shows each schedule\'s purpose; one from before the requirement says "Not stated"', async () => {
    await signIn('pa');
    expect(await listHtml()).toContain('Purpose: Not stated');
    await db.execute(sql`UPDATE schedules SET purpose = 'medical' WHERE id = ${A.scheduleIds[0]}`);
    const html = await listHtml();
    expect(html).toContain('Purpose: Medical');
    expect(html).not.toContain('Not stated');
  });
});
