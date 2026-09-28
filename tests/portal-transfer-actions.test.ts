import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditEvents, customerPortalPrefs, outbox, tickets, transfers } from '@/db/schema';
import { encryptField } from '@/lib/field-crypto';
import { customerEmailCtx } from '@/lib/crypto-context';
import { emailVerifiedTag } from '@/lib/portal-prefs';
import { renderSealedText } from '@/lib/sealed-text';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { newRequestKey } from '@/lib/portal-request-key';
import { freshDb, seedLedgerSpend } from './helpers-db';
import { fakeRedis, type FakeRedis } from './helpers';
import { seedTwoPartners, type TwoPartnerFixture } from './helpers-portal-two-partner';

// UI redesign M2-7, Tasks 7.2-7.4: the customer-portal transfer actions. Public POST endpoints: the
// host gate first, then the session (step-up for cancel/refund/recall), then the tenant+phone
// ownership check (404-never-403), then runOnce (one effect per request key). Cancel reuses the
// locked sender-cancel service; refund and recall reuse the legacy receipt cores.

const h = vi.hoisted(() => ({
  site: null as null | Record<string, unknown>,
  ctx: null as null | Record<string, unknown>,
  stale: false,
  db: null as unknown,
  redis: null as unknown,
  store: null as unknown,
  ps: null as unknown,
  revalidated: [] as string[],
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
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => h.revalidated.push(p) }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'acme.smartremit.ai', 'x-forwarded-for': '203.0.113.9' }) }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => h.db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => h.redis }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => h.store }));
vi.mock('@/lib/partner-store', async (orig) => ({ ...(await orig<typeof import('@/lib/partner-store')>()), getPartnerStore: () => h.ps }));
vi.mock('@/lib/outbox', async (orig) => ({ ...(await orig<typeof import('@/lib/outbox')>()), pokeWorker: () => void h.pokes++ }));
const cancelSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/sender-cancel', async (orig) => {
  const actual = await orig<typeof import('@/lib/sender-cancel')>();
  return {
    ...actual,
    cancelWithinWindow: (...a: Parameters<typeof actual.cancelWithinWindow>) => {
      cancelSpy(...a.slice(1));
      return actual.cancelWithinWindow(...a);
    },
  };
});

import {
  cancelTransferPortalAction,
  emailReceiptAction,
  requestRecallPortalAction,
  requestRefundPortalAction,
} from '@/app/portal/transfers/[id]/actions';
import { filterTransfersAction } from '@/app/portal/transfers/actions';
import { loadTransferFilter } from '@/lib/portal-transfer-filter';

const SITE = (partnerId: string) => ({ partnerId, slug: partnerId, brand: `Brand ${partnerId}`, logo: null, theme: {} });
const EMAIL = 'user@example.com';

let db: Db;
let redis: FakeRedis;
let A: TwoPartnerFixture;
let B: TwoPartnerFixture;
let phone: string;

function signIn(partnerId: string, p: string, email?: string) {
  h.site = SITE(partnerId);
  h.ctx = {
    site: h.site,
    session: { phone: p, sid: 's1' },
    token: 'tok',
    customer: {
      partnerId,
      senderPhone: p,
      ...(email ? { email: encryptField(email, undefined, customerEmailCtx({ partnerId, senderPhone: p })) } : {}),
    },
  };
}

function fd(fields: Record<string, string> = {}): FormData {
  const f = new FormData();
  f.set('requestKey', newRequestKey());
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function outboxRows(kind: string) {
  return db.select().from(outbox).where(eq(outbox.kind, kind));
}

beforeEach(async () => {
  db = await freshDb();
  ({ A, B, phone } = await seedTwoPartners(db));
  redis = fakeRedis();
  h.db = db;
  h.redis = redis;
  h.store = createStore(redis, db);
  h.ps = createPartnerStore(db);
  h.stale = false;
  h.revalidated = [];
  h.pokes = 0;
  cancelSpy.mockClear();
  signIn('pa', phone);
});

describe('gates (every action)', () => {
  const all = [cancelTransferPortalAction, requestRefundPortalAction, requestRecallPortalAction, emailReceiptAction];
  it('apex / portal off → 404 before anything', async () => {
    h.site = null;
    for (const a of all) await expect(a(A.transferIds[0], null, fd())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(cancelSpy).not.toHaveBeenCalled();
  });
  it('signed out → the sign-in page', async () => {
    h.ctx = null;
    for (const a of all) await expect(a(A.transferIds[0], null, fd())).rejects.toThrow('REDIRECT:/portal/login');
  });
  it('a stale session → the step-up page for cancel, refund and recall (nothing runs)', async () => {
    h.stale = true;
    const id = A.transferIds[0];
    for (const a of [cancelTransferPortalAction, requestRefundPortalAction, requestRecallPortalAction]) {
      await expect(a(id, null, fd({ reason: 'not_received' }))).rejects.toThrow(`REDIRECT:/portal/verify?next=/portal/transfers/${id}`);
    }
    expect(cancelSpy).not.toHaveBeenCalled();
    const [row] = await db.select().from(transfers).where(eq(transfers.id, id));
    expect(row.refundStatus).toBe('none');
  });
});

describe('cancelTransferPortalAction', () => {
  it("B's transfer id on A's session → not found, and cancelWithinWindow is NOT called", async () => {
    expect(await cancelTransferPortalAction(B.transferIds[0], null, fd())).toEqual({ error: 'portal.transfer.not_found' });
    expect(cancelSpy).not.toHaveBeenCalled();
  });
  it("another phone's transfer in the same partner → the same not found", async () => {
    const other = await seedLedgerSpend(db, { partnerId: 'pa', phone: '14155550199', amountUsd: 20, status: 'paid' });
    expect(await cancelTransferPortalAction(other, null, fd())).toEqual({ error: 'portal.transfer.not_found' });
    expect(cancelSpy).not.toHaveBeenCalled();
  });
  it("A's own transfer → the locked sender-cancel service under the HOST partner, via 'receipt', mapped to fixed copy", async () => {
    const res = await cancelTransferPortalAction(A.transferIds[0], null, fd());
    expect(cancelSpy).toHaveBeenCalledWith('pa', A.transferIds[0], { via: 'receipt' });
    expect(res).toHaveProperty('notice');
    expect(String((res as { notice: string }).notice)).toMatch(/^portal\.cancel\./);
  });
  it('a double submit with the same request key runs the service once', async () => {
    const f = fd();
    const r1 = await cancelTransferPortalAction(A.transferIds[0], null, f);
    const r2 = await cancelTransferPortalAction(A.transferIds[0], null, f);
    expect(r2).toEqual(r1);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });
  it('a missing or forged request key → expired copy, nothing runs', async () => {
    const f = new FormData();
    f.set('requestKey', 'nope');
    expect(await cancelTransferPortalAction(A.transferIds[0], null, f)).toEqual({ error: 'portal.action.expired' });
    expect(cancelSpy).not.toHaveBeenCalled();
  });
});

describe('requestRefundPortalAction', () => {
  it("A's paid transfer → refund requested (the shared core); a replay returns the same result", async () => {
    const f = fd();
    expect(await requestRefundPortalAction(A.transferIds[0], null, f)).toEqual({ notice: 'portal.refund.requested' });
    expect(await requestRefundPortalAction(A.transferIds[0], null, f)).toEqual({ notice: 'portal.refund.requested' });
    const [row] = await db.select().from(transfers).where(eq(transfers.id, A.transferIds[0]));
    expect(row.refundStatus).toBe('requested');
    // A NEW request key: the guarded flip refuses a second request.
    expect(await requestRefundPortalAction(A.transferIds[0], null, fd())).toEqual({ error: 'portal.refund.ineligible' });
  });
  it("B's transfer → not found; B's row untouched", async () => {
    expect(await requestRefundPortalAction(B.transferIds[0], null, fd())).toEqual({ error: 'portal.transfer.not_found' });
    const [row] = await db.select().from(transfers).where(eq(transfers.id, B.transferIds[0]));
    expect(row.refundStatus).toBe('none');
  });
  it('a delivered transfer → ineligible copy', async () => {
    expect(await requestRefundPortalAction(A.transferIds[1], null, fd())).toEqual({ error: 'portal.refund.ineligible' });
  });
});

describe('requestRecallPortalAction', () => {
  it("A's delivered transfer → one ticket on A (session partner + phone); a replay opens no second", async () => {
    const f = fd({ reason: 'not_received' });
    expect(await requestRecallPortalAction(A.transferIds[1], null, f)).toEqual({ notice: 'portal.recall.opened' });
    expect(await requestRecallPortalAction(A.transferIds[1], null, f)).toEqual({ notice: 'portal.recall.opened' });
    const rows = await db.select().from(tickets).where(eq(tickets.transferId, A.transferIds[1]));
    expect(rows).toHaveLength(1);
    expect(rows[0].partnerId).toBe('pa');
  });
  it('a forged reason → bad-reason copy', async () => {
    expect(await requestRecallPortalAction(A.transferIds[1], null, fd({ reason: 'x' }))).toEqual({ error: 'portal.recall.bad_reason' });
  });
  it("B's transfer → not found", async () => {
    expect(await requestRecallPortalAction(B.transferIds[1], null, fd({ reason: 'not_received' }))).toEqual({ error: 'portal.transfer.not_found' });
  });
  it("the open-ticket cap counts THIS tenant only: 5 open tickets on B do not cap A", async () => {
    const repo = createTicketRepo(db);
    for (let i = 0; i < 5; i++) {
      await repo.createTicket({ id: `tk_capb${i}`, partnerId: 'pb', kind: 'customer', customerPhone: phone, subject: 's', body: 'b' });
    }
    expect(await requestRecallPortalAction(A.transferIds[1], null, fd({ reason: 'not_received' }))).toEqual({ notice: 'portal.recall.opened' });
  });
});

describe('emailReceiptAction', () => {
  const verify = async (pid: string, email = EMAIL) => {
    await db.insert(customerPortalPrefs).values({ partnerId: pid, phone, emailVerifiedAt: new Date(), emailVerifiedTag: emailVerifiedTag(pid, phone, email) });
  };

  it('no verified email → refused, no outbox row', async () => {
    signIn('pa', phone, EMAIL);
    expect(await emailReceiptAction(A.transferIds[0], null, fd())).toEqual({ error: 'portal.receipt.verify_email_first' });
    expect(await outboxRows('email.send')).toHaveLength(0);
  });
  it('an address changed since verification → refused', async () => {
    signIn('pa', phone, 'new@example.com');
    await verify('pa', EMAIL);
    expect(await emailReceiptAction(A.transferIds[0], null, fd())).toEqual({ error: 'portal.receipt.verify_email_first' });
  });
  it('verified → ONE email.send row (sealed body, masked destination), an audit row, a poke; a double submit adds nothing', async () => {
    signIn('pa', phone, EMAIL);
    await verify('pa');
    const f = fd();
    expect(await emailReceiptAction(A.transferIds[0], null, f)).toEqual({ notice: 'portal.receipt.sent' });
    expect(await emailReceiptAction(A.transferIds[0], null, f)).toEqual({ notice: 'portal.receipt.sent' });
    const rows = await outboxRows('email.send');
    expect(rows).toHaveLength(1);
    const p = rows[0].payload as { to: string[]; subject: string; text: string; sealed: Record<string, string> };
    expect(p.to).toEqual([EMAIL]);
    expect(p.subject).toContain('Brand pa');
    // The body is sealed at rest: no recipient name, amount or destination in the payload.
    expect(JSON.stringify(p)).not.toContain('Seeded Recipient');
    const body = renderSealedText(p.text, p.sealed);
    expect(body).toContain('Seeded Recipient');
    expect(body).toContain('****');
    expect(body).not.toContain('000011112222');
    expect(rows[0].dedupeKey).toMatch(new RegExp(`^rcpt:${A.transferIds[0]}:`));
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.action, 'customer.receipt.email'));
    expect(audits).toHaveLength(1);
    expect(audits[0].partnerId).toBe('pa');
    expect(audits[0].meta).toEqual({ transferId: A.transferIds[0] });
    expect(JSON.stringify(audits[0])).not.toContain(EMAIL);
    expect(JSON.stringify(audits[0])).not.toContain(phone);
    expect(h.pokes).toBe(1);
  });
  it("B's transfer → not found, no outbox row", async () => {
    signIn('pa', phone, EMAIL);
    await verify('pa');
    expect(await emailReceiptAction(B.transferIds[0], null, fd())).toEqual({ error: 'portal.transfer.not_found' });
    expect(await outboxRows('email.send')).toHaveLength(0);
  });
  it('rate-limited per customer: 10 per hour, the 11th is refused', async () => {
    signIn('pa', phone, EMAIL);
    await verify('pa');
    for (let i = 0; i < 10; i++) expect(await emailReceiptAction(A.transferIds[0], null, fd())).toEqual({ notice: 'portal.receipt.sent' });
    expect(await emailReceiptAction(A.transferIds[0], null, fd())).toEqual({ error: 'portal.receipt.rate_limited' });
    expect(await outboxRows('email.send')).toHaveLength(10);
  });
});

describe('filterTransfersAction (no name in any URL)', () => {
  it('stores the filter under a customer-bound key and redirects with an opaque id only', async () => {
    const f = new FormData();
    f.set('q', 'Seeded Recipient');
    f.set('status', 'completed');
    let url = '';
    try {
      await filterTransfersAction(f);
    } catch (e) {
      url = String((e as Error).message);
    }
    expect(url).toMatch(/^REDIRECT:\/portal\/transfers\?f=[0-9a-f]{32}$/);
    expect(url).not.toMatch(/Seeded|Recipient/i);
    const id = url.split('f=')[1];
    expect(await loadTransferFilter(redis, { partnerId: 'pa', phone }, id)).toEqual({ status: 'completed', q: 'Seeded Recipient' });
    // Another partner, or another phone, resolves nothing.
    expect(await loadTransferFilter(redis, { partnerId: 'pb', phone }, id)).toBeNull();
    expect(await loadTransferFilter(redis, { partnerId: 'pa', phone: '14155550199' }, id)).toBeNull();
  });
  it('an empty filter redirects to the plain list', async () => {
    await expect(filterTransfersAction(new FormData())).rejects.toThrow(/^REDIRECT:\/portal\/transfers$/);
  });
  it('apex → 404', async () => {
    h.site = null;
    await expect(filterTransfersAction(new FormData())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });
});
