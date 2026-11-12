// Fix pack 8 (R44, P11, T14): the receipt and portal "Report a problem" forms open the case.
// A consumer, non-test transfer is routed by routeReport (P5): every report opens (or reuses) its
// regulatory case through openErrorNoticeCaseLocked in one transaction, and the page shows
// caseOpenedReply (surface 'page'). No step-up, no support switch and no open-ticket cap refuses a
// classed case (DP9). Inside the cancel window the case opens AND the cancel card stays (DP13).
// b2b and sandbox rows keep today's 24-hour recall path byte-identical.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PortalSite } from '@/lib/portal-site';
import type { Db } from '@/db/client';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createStore, type Store } from '@/lib/store';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import { createTicketRepo, type TicketRepo } from '@/db/repos/ticket-repo';
import { newRequestKey } from '@/lib/portal-request-key';
import { refundDisposition, RECALL_WINDOW_MS } from '@/lib/refund-policy';
import { caseNoticeLine, caseOpenedReply, caseSubject } from '@/lib/legal/error-notice-drafts';
import type { Customer, Ticket, Transfer } from '@/lib/types';

const PHONE = '15551230000';
const OTHER_PHONE = '15559990000';
const DAY = 86_400_000;

const h = vi.hoisted(() => ({
  db: null as unknown,
  store: null as unknown,
  ps: null as unknown,
  redis: null as unknown,
  customer: null as unknown,
  site: null as unknown,
  ctx: null as unknown,
  mfaEnrolled: false,
}));

vi.mock('@/lib/customer-auth', () => ({
  requireCustomer: async () => {
    if (!h.customer) throw new Error('REDIRECT:/account/login');
    return h.customer;
  },
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
  requirePortalCustomer: async () => h.ctx,
  requireFreshPortalAuth: async () => {
    if (!h.ctx) throw new Error('REDIRECT:/portal/login');
    return h.ctx;
  },
}));
vi.mock('@/lib/store', async (orig) => ({ ...((await orig()) as object), getStore: () => h.store }));
vi.mock('@/lib/partner-store', async (orig) => ({ ...((await orig()) as object), getPartnerStore: () => h.ps }));
vi.mock('@/db/client', async (orig) => ({ ...((await orig()) as object), getDb: () => h.db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => h.redis }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error(`REDIRECT:${p}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '198.51.100.7' }) }));
vi.mock('@/lib/customer-mfa', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-mfa')>('@/lib/customer-mfa');
  return {
    ...actual,
    getCustomerMfaStore: () => ({ isEnrolled: async () => h.mfaEnrolled, verifyCode: async (_k: unknown, c: string) => c === '246810' }),
  };
});
vi.mock('@/lib/customer-auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-auth-store')>('@/lib/customer-auth-store');
  return { ...actual, getCustomerAuthStore: () => ({ reserveLoginAttempt: async () => true, clearLoginFailures: async () => undefined }) };
});

import { requestRecallAction } from '@/app/account/receipt/recall-actions';
import { requestRecallPortalAction } from '@/app/portal/transfers/[id]/actions';
import { requestRecallFor } from '@/lib/receipt-cores';
import { caseBannerFor } from '@/lib/report-banner';

let db: Db;
let store: Store;
let ps: PartnerStore;
let repo: TicketRepo;

function customer(): Customer {
  return {
    senderPhone: PHONE,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    kycStatus: 'verified',
    senderCountry: 'US',
    partnerId: 'p1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as Customer;
}

function signInPortal() {
  const site = { partnerId: 'p1', slug: 'p1', host: 'p1.smartremit.ai', brand: 'Brand p1', logo: null, theme: {} } as unknown as PortalSite;
  h.site = site;
  h.ctx = { site, session: { phone: PHONE, sid: 's1' }, token: 'tok', customer: { partnerId: 'p1', senderPhone: PHONE } };
}

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

let n = 0;
function mkTransfer(over: Partial<Transfer> = {}): Transfer {
  n += 1;
  return {
    id: `T_rs${String(n).padStart(4, '0')}`, phone: PHONE, amountUsd: 100, feeUsd: 1.99, totalChargeUsd: 101.99,
    fxRate: 85.2, amountInr: 8520, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'delivered',
    createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    paidAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
    deliveredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    partnerId: 'p1',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 100, feeSource: 1.99, totalChargeSource: 101.99,
    ...over,
  } as Transfer;
}

/** Delivered `days` days ago (paid an hour before). */
async function delivered(days: number, over: Partial<Transfer> = {}): Promise<Transfer> {
  const t = mkTransfer({
    paidAt: new Date(Date.now() - days * DAY - 3600_000).toISOString(),
    deliveredAt: new Date(Date.now() - days * DAY).toISOString(),
    ...over,
  });
  await store.saveTransfer(t);
  return t;
}

/** Paid `minutes` minutes ago, not delivered. */
async function paid(minutes: number, over: Partial<Transfer> = {}): Promise<Transfer> {
  const t = mkTransfer({ status: 'paid', deliveredAt: undefined, paidAt: new Date(Date.now() - minutes * 60_000).toISOString(), ...over });
  await store.saveTransfer(t);
  return t;
}

async function ticketsOf(id: string): Promise<Ticket[]> {
  return (await repo.listByCustomer(PHONE)).filter((t) => t.transferId === id);
}

async function regAudits() {
  const r = await db.execute(sql`SELECT subject_id, meta FROM audit_events WHERE action = 'ticket.reg_case.open' ORDER BY id`);
  return r.rows as Array<{ subject_id: string; meta: Record<string, unknown> }>;
}

async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const m = /^REDIRECT:(.*)$/.exec((err as Error).message);
    if (m) return m[1];
    throw err;
  }
  throw new Error('no redirect');
}

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'p1');
  store = createStore(fakeRedis(), db);
  ps = createPartnerStore(db);
  repo = createTicketRepo(db);
  h.db = db;
  h.store = store;
  h.ps = ps;
  h.redis = fakeRedis();
  h.customer = customer();
  h.mfaEnrolled = false;
  signInPortal();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('receipt report (P11, T14)', { retry: 0 }, () => {
  it('receipt: a delivered transfer 3 days old opens an error_notice case', async () => {
    const t = await delivered(3);
    const before = Date.now();
    const url = await redirectOf(requestRecallAction(fd({ transferId: t.id, reason: 'not_received' })));
    const [tk] = await ticketsOf(t.id);
    expect(url).toBe(`/account/receipt/${t.id}?case=${tk.id}`);
    expect(tk.id).toMatch(/^tk_/);
    expect(tk.regClass).toBe('error_notice');
    expect(tk.priority).toBe('urgent');
    expect(tk.subject).toBe(caseSubject('not_received'));
    expect(Date.parse(tk.dueAt!)).toBeGreaterThanOrEqual(before + 90 * DAY);
    const msgs = await repo.listMessages(tk.id, { includeInternal: false });
    expect(msgs[0].body).toContain(caseNoticeLine({ code: 'not_received', dueAt: tk.dueAt! }));
    expect(msgs[0].body).not.toContain('Recovery is not guaranteed');
    expect(await regAudits()).toHaveLength(1);
  });

  it('receipt: unauthorized on a paid transfer opens fraud_report; 10 minutes after payment it is cancellable too', async () => {
    const old = await paid(45);
    await redirectOf(requestRecallAction(fd({ transferId: old.id, reason: 'unauthorized' })));
    expect((await ticketsOf(old.id))[0].regClass).toBe('fraud_report');

    const fresh = await paid(10);
    const r = await requestRecallFor(customer(), fresh.id, { reason: 'unauthorized' }, async () => 'ok');
    expect(r).toMatchObject({ kind: 'opened', regClass: 'fraud_report', cancellable: true, reused: false });
  });

  it('receipt: paid 10 minutes ago -> the case opens and the cancel stays offered', async () => {
    const t = await paid(10);
    const r = await requestRecallFor(customer(), t.id, { reason: 'wrong_amount' }, async () => 'ok');
    expect(r).toMatchObject({ kind: 'opened', regClass: 'error_notice', cancellable: true, reused: false });
    if (r.kind !== 'opened') throw new Error('not opened');
    expect(r.dueAt).toEqual(expect.any(String));

    const t2 = await paid(10);
    const url = await redirectOf(requestRecallAction(fd({ transferId: t2.id, reason: 'wrong_amount' })));
    const [tk] = await ticketsOf(t2.id);
    expect(url).toBe(`/account/receipt/${t2.id}?case=${tk.id}`);
    expect(await ticketsOf(t2.id)).toHaveLength(1);
    expect(tk.regClass).toBe('error_notice');
    const row = await store.getTransfer(t2.id);
    expect(refundDisposition(row!, Date.now()).kind).toBe('cancellable');
    expect(row!.status).toBe('paid');
  });

  it('receipt: the same report twice -> reused (&added=1, the same ticket)', async () => {
    const t = await delivered(3);
    const first = await redirectOf(requestRecallAction(fd({ transferId: t.id, reason: 'not_received' })));
    const second = await redirectOf(requestRecallAction(fd({ transferId: t.id, reason: 'not_received' })));
    const [tk] = await ticketsOf(t.id);
    expect(first).toBe(`/account/receipt/${t.id}?case=${tk.id}`);
    expect(second).toBe(`/account/receipt/${t.id}?case=${tk.id}&added=1`);
    expect(await ticketsOf(t.id)).toHaveLength(1);
  });

  it('receipt: the support switch off still opens a classed case', async () => {
    const t = await delivered(3);
    await ps.updateSupportConfig('p1', (prev) => ({ ...prev, enableSupportPortal: false }));
    const url = await redirectOf(requestRecallAction(fd({ transferId: t.id, reason: 'wrong_recipient' })));
    const [tk] = await ticketsOf(t.id);
    expect(url).toBe(`/account/receipt/${t.id}?case=${tk.id}`);
    expect(tk.regClass).toBe('error_notice');
  });

  it('receipt: the cap does not refuse a classed case (5 open tickets)', async () => {
    for (let i = 0; i < 5; i++) {
      await repo.createTicket({ id: `tk_capseed${i}`, partnerId: 'p1', kind: 'customer', customerPhone: PHONE, subject: 's', body: 'b' });
    }
    const t = await delivered(3);
    const url = await redirectOf(requestRecallAction(fd({ transferId: t.id, reason: 'not_received' })));
    expect(url).toMatch(new RegExp(`^/account/receipt/${t.id}\\?case=tk_`));
    expect(await ticketsOf(t.id)).toHaveLength(1);
  });

  it('receipt: step-up enrolled + no code still opens a classed case (no code asked)', async () => {
    h.mfaEnrolled = true;
    const t = await delivered(3);
    const url = await redirectOf(requestRecallAction(fd({ transferId: t.id, reason: 'not_received' })));
    expect(url).toMatch(new RegExp(`^/account/receipt/${t.id}\\?case=tk_`));
  });

  it("receipt: another customer's transfer or a forged reason still refuses (no case)", async () => {
    const theirs = await delivered(3, { phone: OTHER_PHONE });
    expect(await redirectOf(requestRecallAction(fd({ transferId: theirs.id, reason: 'not_received' })))).toBe(
      `/account/receipt/${theirs.id}?error=ineligible`,
    );
    const mine = await delivered(3);
    expect(await redirectOf(requestRecallAction(fd({ transferId: mine.id, reason: 'complaint' })))).toBe(
      `/account/receipt/${mine.id}?error=reason`,
    );
    expect(await repo.listByCustomer(PHONE)).toEqual([]);
    expect(await repo.listByCustomer(OTHER_PHONE)).toEqual([]);
  });

  it("receipt: b2b transfer keeps today's path", async () => {
    const inside = await delivered(0, { transferType: 'b2b', deliveredAt: new Date(Date.now() - 3600_000).toISOString() });
    const url = await redirectOf(requestRecallAction(fd({ transferId: inside.id, reason: 'not_received' })));
    const [tk] = await ticketsOf(inside.id);
    expect(url).toBe(`/account/support/${tk.id}`);
    expect(tk.regClass).toBeUndefined();
    expect(await requestRecallFor(customer(), inside.id, { reason: 'not_received' }, async () => 'ok')).toEqual({
      kind: 'opened', ticketId: tk.id, reused: true, regClass: null, dueAt: null, cancellable: false,
    });

    const outside = await delivered(0, { transferType: 'b2b', deliveredAt: new Date(Date.now() - RECALL_WINDOW_MS - 60_000).toISOString() });
    expect(await redirectOf(requestRecallAction(fd({ transferId: outside.id, reason: 'not_received' })))).toBe(
      `/account/receipt/${outside.id}?error=ineligible`,
    );

    const mfa = await delivered(0, { transferType: 'b2b', deliveredAt: new Date(Date.now() - 3600_000).toISOString() });
    h.mfaEnrolled = true;
    expect(await redirectOf(requestRecallAction(fd({ transferId: mfa.id, reason: 'not_received' })))).toBe(
      `/account/receipt/${mfa.id}?error=mfa_code`,
    );
    h.mfaEnrolled = false;

    await ps.updateSupportConfig('p1', (prev) => ({ ...prev, enableSupportPortal: false }));
    const off = await delivered(0, { transferType: 'b2b', deliveredAt: new Date(Date.now() - 3600_000).toISOString() });
    expect(await redirectOf(requestRecallAction(fd({ transferId: off.id, reason: 'not_received' })))).toBe('/account/support');
    expect(await ticketsOf(outside.id)).toEqual([]);
    expect(await ticketsOf(mfa.id)).toEqual([]);
    expect(await ticketsOf(off.id)).toEqual([]);
    expect(await regAudits()).toEqual([]);
  });

  it('a sandbox (test) transfer keeps the recall path too', async () => {
    const t = await delivered(3, { environment: 'test' });
    expect(await redirectOf(requestRecallAction(fd({ transferId: t.id, reason: 'not_received' })))).toBe(
      `/account/receipt/${t.id}?error=ineligible`,
    );
    expect(await ticketsOf(t.id)).toEqual([]);
  });
});

describe('caseBannerFor (receipt page case text)', () => {
  const dueAt = new Date(Date.now() + 90 * DAY).toISOString();
  const ticket = (over: Partial<Ticket> = {}): Ticket => ({
    id: 'tk_abc123', partnerId: 'p1', kind: 'customer', customerPhone: PHONE, transferId: 'T_x00001',
    subject: caseSubject('other'), status: 'open', priority: 'urgent', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), regClass: 'error_notice', firstNoticeAt: new Date().toISOString(), dueAt,
    ...over,
  });
  const viewer = { partnerId: 'p1', phone: PHONE };
  const o = { transferId: 'T_x00001', reused: false, providerLine: 'Payments by Acme, licensed by Regulator' };

  it('renders caseOpenedReply for the viewer’s own classed case on this transfer', () => {
    expect(caseBannerFor(ticket(), viewer, o)).toBe(
      caseOpenedReply({ caseId: 'tk_abc123', dueAt, providerLine: o.providerLine, reused: false, surface: 'page' }),
    );
    expect(caseBannerFor(ticket(), viewer, { ...o, reused: true, providerLine: null })).toBe(
      caseOpenedReply({ caseId: 'tk_abc123', dueAt, providerLine: null, reused: true, surface: 'page' }),
    );
  });

  it('null for another customer, another partner, another transfer, an unclassed ticket or none (no leak)', () => {
    expect(caseBannerFor(ticket({ customerPhone: OTHER_PHONE }), viewer, o)).toBeNull();
    expect(caseBannerFor(ticket({ partnerId: 'p2' }), viewer, o)).toBeNull();
    expect(caseBannerFor(ticket({ transferId: 'T_other1' }), viewer, o)).toBeNull();
    expect(caseBannerFor(ticket({ transferId: undefined }), viewer, o)).toBeNull();
    expect(caseBannerFor(ticket({ regClass: undefined }), viewer, o)).toBeNull();
    expect(caseBannerFor(ticket({ dueAt: undefined }), viewer, o)).toBeNull();
    expect(caseBannerFor(ticket({ dueAt: 'not a date' }), viewer, o)).toBeNull();
    expect(caseBannerFor(null, viewer, o)).toBeNull();
  });
});

describe('portal report (P11, T14)', { retry: 0 }, () => {
  const pfd = (reason: string, key = newRequestKey()) => fd({ reason, requestKey: key });

  it('portal: a consumer transfer opens the case; a replay returns the same text', async () => {
    const t = await delivered(3);
    const f = pfd('not_received');
    const r1 = await requestRecallPortalAction(t.id, null, f);
    const [tk] = await ticketsOf(t.id);
    expect(tk.regClass).toBe('error_notice');
    const text = caseOpenedReply({ caseId: tk.id, dueAt: tk.dueAt!, providerLine: null, reused: false, surface: 'page' });
    expect(r1).toEqual({ notice: 'portal.report.opened', text });
    expect(await requestRecallPortalAction(t.id, null, f)).toEqual(r1);
    expect(await ticketsOf(t.id)).toHaveLength(1);
    // A new request key on the same transfer reuses the case.
    expect(await requestRecallPortalAction(t.id, null, pfd('wrong_amount'))).toEqual({
      notice: 'portal.report.opened',
      text: caseOpenedReply({ caseId: tk.id, dueAt: tk.dueAt!, providerLine: null, reused: true, surface: 'page' }),
    });
  });

  it('portal: paid 10 minutes ago -> the case opens, the cancel stays', async () => {
    const t = await paid(10);
    const r = await requestRecallPortalAction(t.id, null, pfd('wrong_recipient'));
    const [tk] = await ticketsOf(t.id);
    expect(r).toEqual({
      notice: 'portal.report.opened',
      text: caseOpenedReply({ caseId: tk.id, dueAt: tk.dueAt!, providerLine: null, reused: false, surface: 'page' }),
    });
    expect(refundDisposition((await store.getTransfer(t.id))!, Date.now()).kind).toBe('cancellable');
  });

  it("portal: b2b keeps today's keys", async () => {
    const inside = await delivered(0, { transferType: 'b2b', deliveredAt: new Date(Date.now() - 3600_000).toISOString() });
    expect(await requestRecallPortalAction(inside.id, null, pfd('not_received'))).toEqual({ notice: 'portal.report.opened' });
    expect((await ticketsOf(inside.id))[0].regClass).toBeUndefined();
    const outside = await delivered(3, { transferType: 'b2b' });
    expect(await requestRecallPortalAction(outside.id, null, pfd('not_received'))).toEqual({ error: 'portal.report.ineligible' });
    for (let i = 0; i < 5; i++) {
      await repo.createTicket({ id: `tk_capp${i}`, partnerId: 'p1', kind: 'customer', customerPhone: PHONE, subject: 's', body: 'b' });
    }
    const capped = await delivered(0, { transferType: 'b2b', deliveredAt: new Date(Date.now() - 3600_000).toISOString() });
    expect(await requestRecallPortalAction(capped.id, null, pfd('not_received'))).toEqual({ error: 'portal.report.cap' });
    expect(await requestRecallPortalAction(capped.id, null, pfd('x'))).toEqual({ error: 'portal.report.bad_reason' });
  });
});

describe('privacy of the report surfaces', { retry: 0 }, () => {
  it('nothing of the customer reaches the audit row or the redirect URL', async () => {
    const t = await delivered(3);
    const url = await redirectOf(requestRecallAction(fd({ transferId: t.id, reason: 'wrong_recipient' })));
    const [tk] = await ticketsOf(t.id);
    const audits = await regAudits();
    expect(audits).toHaveLength(1);
    const { meta } = audits[0];
    // Random ids and times by FORMAT (PR7 DEVIATIONS O10); the forbidden list only on the rest.
    expect(audits[0].subject_id).toMatch(/^tk_[A-Za-z0-9_-]+$/);
    expect(meta.transferId).toBe(t.id);
    expect(Number.isFinite(Date.parse(String(meta.dueAt)))).toBe(true);
    expect(url).toBe(`/account/receipt/${t.id}?case=${tk.id}`);
    const rest = JSON.stringify({ ...meta, transferId: undefined, dueAt: undefined });
    for (const bad of [PHONE, PHONE.slice(-4), 'Mom', '919876543210', 'mom@upi', 'Sent to the wrong recipient', '100', '8520']) {
      expect(rest, bad).not.toContain(bad);
    }
    expect(Object.keys(meta).sort()).toEqual(['code', 'dueAt', 'regClass', 'reused', 'stamped', 'transferId']);
  });
});
