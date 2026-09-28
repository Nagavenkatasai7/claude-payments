import { describe, it, expect, vi, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditEvents, outbox, ticketMessages } from '@/db/schema';
import { freshDb } from './helpers-db';
import { fakeRedis, type FakeRedis } from './helpers';
import { seedTwoPartners, type TwoPartnerFixture } from './helpers-portal-two-partner';

// UI redesign M2-12, Task 12.2: the customer portal's Help & tickets actions and reads. Real portal
// session store (fakeRedis) + PGlite + the shared two-partner fixture (ONE phone, partners pa and pb).
// Every action is a PUBLIC POST endpoint: host gate first, then the host-bound session; identity is
// (host partner, session phone), never a form field; foreign and missing ticket ids are the same 404.

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
    redisProxy: null as unknown,
    db: null as unknown,
    store: null as unknown,
    supportOff: new Set<string>(),
    revalidated: [] as string[],
  };
  state.redisProxy = new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => state.redis[k](...a) });
  return state;
});

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'acme.smartremit.ai' }),
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
  notFound: () => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => h.revalidated.push(p) }));
vi.mock('@/lib/portal-site', () => ({
  getPortalSite: async () => h.site,
  requirePortalSite: async () => {
    if (!h.site) throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
    return h.site;
  },
}));
vi.mock('@/lib/redis', () => ({ getRedis: () => h.redisProxy }));
vi.mock('@/db/client', () => ({ getDb: () => h.db }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => h.store }));
vi.mock('@/lib/customer-store', async () => {
  const { createCustomerRepo } = await import('@/db/repos/customer-repo');
  return { getCustomerStore: () => createCustomerRepo(h.db as never, async () => null) };
});
vi.mock('@/lib/partner-store', async (orig) => {
  const mod = await orig<typeof import('@/lib/partner-store')>();
  const { createPartnerStore } = mod;
  return {
    ...mod,
    getPartnerStore: () => {
      const real = createPartnerStore(h.db as never);
      return {
        ...real,
        getPartner: async (id: string) => {
          const p = await real.getPartner(id);
          return p && h.supportOff.has(id) ? { ...p, supportConfig: { ...(p.supportConfig ?? {}), enableSupportPortal: false } } : p;
        },
      };
    },
  };
});
vi.mock('@/lib/outbox', () => ({ pokeWorker: () => {} }));

import { createStore } from '@/lib/store';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createPortalSessionStore, PORTAL_SESSION_COOKIE } from '@/lib/portal-session-store';
import { newRequestKey } from '@/lib/portal-request-key';
import { auditSubjectId } from '@/lib/customer-ref';
import { createPortalTicketAction, replyPortalTicketAction } from '@/app/portal/help/tickets/actions';
import { listPortalTicketMessages, getPortalTicket, listPortalTickets, portalSupportEnabled, ticketStatusView } from '@/lib/portal-tickets';

let db: Db;
let redis: FakeRedis;
let A: TwoPartnerFixture;
let B: TwoPartnerFixture;
let phone: string;

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const VALID = { subject: 'Where is my money', message: 'My transfer has not arrived yet.' };
const REDIRECT_TICKET = /^REDIRECT:\/portal\/help\/tickets\/(tk_[A-Za-z0-9_-]+)$/;

async function signIn(partnerId: string) {
  const { token } = await createPortalSessionStore(redis).create(partnerId, phone, 'Safari on iOS');
  h.jar.set(PORTAL_SESSION_COOKIE, token);
}
async function createdId(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: Error) => e,
  );
  const m = err?.message.match(REDIRECT_TICKET);
  if (!m) throw new Error(`expected a ticket redirect, got ${String(err?.message ?? 'a return value')}`);
  return m[1];
}
async function audits(partnerId: string, action: string) {
  return db.select().from(auditEvents).where(and(eq(auditEvents.partnerId, partnerId), eq(auditEvents.action, action)));
}
const repo = () => createTicketRepo(db);

beforeEach(async () => {
  db = await freshDb();
  ({ A, B, phone } = await seedTwoPartners(db));
  redis = fakeRedis();
  h.redis = redis as never;
  h.db = db;
  h.store = createStore(redis, db);
  h.site = SITE('pa', 'acme');
  h.jar = new Map();
  h.supportOff = new Set();
  h.revalidated = [];
});

describe('createPortalTicketAction', () => {
  it('creates the ticket under the HOST partner and SESSION phone; hostile fields are ignored', async () => {
    await signIn('pa');
    const id = await createdId(
      createPortalTicketAction(null, fd({ ...VALID, requestKey: newRequestKey(), partnerId: 'pb', customerPhone: '14155550000' })),
    );
    const t = await repo().getTicket(id);
    expect(t).toMatchObject({ partnerId: 'pa', customerPhone: phone, kind: 'customer', subject: VALID.subject, status: 'open' });
    const msgs = await repo().listMessages(id, { includeInternal: false });
    expect(msgs.map((m) => m.body)).toEqual([VALID.message]);
  });

  it('writes a ticket.create audit row (no subject or body) and the triage outbox row', async () => {
    await signIn('pa');
    const id = await createdId(createPortalTicketAction(null, fd({ ...VALID, requestKey: newRequestKey() })));
    const rows = await audits('pa', 'ticket.create');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'system:customer-portal', actorType: 'system', subjectId: auditSubjectId('pa', phone) });
    expect(rows[0].meta).toEqual({ ticketId: id });
    expect(JSON.stringify(rows[0])).not.toContain(VALID.message);
    expect(JSON.stringify(rows[0])).not.toContain(VALID.subject);
    const tri = await db.select().from(outbox).where(eq(outbox.kind, 'ticket.triage'));
    expect(tri.map((r) => (r.payload as { ticketId: string }).ticketId)).toContain(id);
  });

  it('a double submit with the same request key makes ONE ticket (the replay redirects to it)', async () => {
    await signIn('pa');
    const key = newRequestKey();
    const first = await createdId(createPortalTicketAction(null, fd({ ...VALID, requestKey: key })));
    const second = await createdId(createPortalTicketAction(null, fd({ ...VALID, requestKey: key })));
    expect(second).toBe(first);
    expect(await repo().listByCustomerInTenant('pa', phone)).toHaveLength(2); // the fixture's + one
    expect(await audits('pa', 'ticket.create')).toHaveLength(1);
  });

  it('a missing or malformed request key is refused with the expired copy', async () => {
    await signIn('pa');
    expect(await createPortalTicketAction(null, fd({ ...VALID }))).toEqual({ error: 'portal.help.error.expired' });
    expect(await createPortalTicketAction(null, fd({ ...VALID, requestKey: 'nope' }))).toEqual({ error: 'portal.help.error.expired' });
    expect(await repo().listByCustomerInTenant('pa', phone)).toHaveLength(1);
  });

  it('validation mirrors the legacy rules', async () => {
    await signIn('pa');
    const k = () => newRequestKey();
    expect(await createPortalTicketAction(null, fd({ subject: 'ab', message: VALID.message, requestKey: k() }))).toEqual({ error: 'portal.help.error.subject' });
    expect(await createPortalTicketAction(null, fd({ subject: VALID.subject, message: 'short', requestKey: k() }))).toEqual({ error: 'portal.help.error.message' });
  });

  it("links one of the customer's OWN last transfers on this partner; B's transfer id is refused", async () => {
    await signIn('pa');
    const id = await createdId(createPortalTicketAction(null, fd({ ...VALID, transferId: A.transferIds[0], requestKey: newRequestKey() })));
    expect((await repo().getTicket(id))?.transferId).toBe(A.transferIds[0]);
    expect(await createPortalTicketAction(null, fd({ ...VALID, transferId: B.transferIds[0], requestKey: newRequestKey() }))).toEqual({
      error: 'portal.help.error.transfer',
    });
  });

  it('caps open tickets at 5 per customer on THIS partner (B does not count)', async () => {
    await signIn('pa');
    for (let i = 0; i < 4; i++) await createdId(createPortalTicketAction(null, fd({ ...VALID, requestKey: newRequestKey() })));
    expect(await createPortalTicketAction(null, fd({ ...VALID, requestKey: newRequestKey() }))).toEqual({ error: 'portal.help.error.cap' });
    // B still has room for the same phone.
    h.site = SITE('pb', 'bravo');
    await signIn('pb');
    await createdId(createPortalTicketAction(null, fd({ ...VALID, requestKey: newRequestKey() })));
  });

  it('a cap refusal does not stick to the request key: after a ticket is resolved the same form goes through', async () => {
    await signIn('pa');
    for (let i = 0; i < 4; i++) await createdId(createPortalTicketAction(null, fd({ ...VALID, requestKey: newRequestKey() })));
    const key = newRequestKey();
    expect(await createPortalTicketAction(null, fd({ ...VALID, requestKey: key }))).toEqual({ error: 'portal.help.error.cap' });
    await repo().updateStatus(A.ticketIds[0], 'resolved');
    await createdId(createPortalTicketAction(null, fd({ ...VALID, requestKey: key })));
  });

  it("the partner's support kill switch refuses the POST (hiding the page is not the gate)", async () => {
    await signIn('pa');
    h.supportOff.add('pa');
    expect(await createPortalTicketAction(null, fd({ ...VALID, requestKey: newRequestKey() }))).toEqual({ error: 'portal.help.error.support_off' });
    expect(await repo().listByCustomerInTenant('pa', phone)).toHaveLength(1);
  });

  it("A's session on B's host is signed out (redirect to sign-in), nothing is written", async () => {
    await signIn('pa');
    h.site = SITE('pb', 'bravo');
    await expect(createPortalTicketAction(null, fd({ ...VALID, requestKey: newRequestKey() }))).rejects.toThrow('REDIRECT:/portal/login');
    expect(await repo().listByCustomerInTenant('pb', phone)).toHaveLength(1);
  });

  it('apex → 404 before any session read or write', async () => {
    await signIn('pa');
    h.site = null;
    await expect(createPortalTicketAction(null, fd({ ...VALID, requestKey: newRequestKey() }))).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });
});

describe('replyPortalTicketAction', () => {
  it("appends to the customer's own ticket, reopens a pending one and audits ticket.reply (no body)", async () => {
    await signIn('pa');
    const id = A.ticketIds[0];
    await repo().updateStatus(id, 'pending');
    await expect(replyPortalTicketAction(id, null, fd({ message: 'Any update please?', requestKey: newRequestKey() }))).rejects.toThrow(
      `REDIRECT:/portal/help/tickets/${id}`,
    );
    const msgs = await repo().listMessages(id, { includeInternal: false });
    expect(msgs.at(-1)).toMatchObject({ actorType: 'customer', body: 'Any update please?' });
    expect((await repo().getTicket(id))?.status).toBe('open');
    const rows = await audits('pa', 'ticket.reply');
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({ ticketId: id });
    expect(JSON.stringify(rows[0])).not.toContain('Any update');
  });

  it("B's ticket id on A's host is the SAME 404 as a missing id; nothing is appended to B's ticket", async () => {
    await signIn('pa');
    const before = (await db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, B.ticketIds[0]))).length;
    for (const id of [B.ticketIds[0], 'tk_does_not_exist', '../x', '']) {
      await expect(replyPortalTicketAction(id, null, fd({ message: 'Hello there', requestKey: newRequestKey() }))).rejects.toThrow(
        'NEXT_HTTP_ERROR_FALLBACK;404',
      );
    }
    expect((await db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, B.ticketIds[0]))).length).toBe(before);
  });

  it('the same request key twice appends ONE message; a new key appends another', async () => {
    await signIn('pa');
    const id = A.ticketIds[0];
    const count = async () => (await repo().listMessages(id, { includeInternal: true })).length;
    const start = await count();
    const key = newRequestKey();
    for (let i = 0; i < 2; i++) {
      await expect(replyPortalTicketAction(id, null, fd({ message: 'Same reply', requestKey: key }))).rejects.toThrow('REDIRECT:');
    }
    expect(await count()).toBe(start + 1);
    await expect(replyPortalTicketAction(id, null, fd({ message: 'Second reply', requestKey: newRequestKey() }))).rejects.toThrow('REDIRECT:');
    expect(await count()).toBe(start + 2);
  });

  it('a closed ticket is read-only; an empty reply is refused', async () => {
    await signIn('pa');
    const id = A.ticketIds[0];
    expect(await replyPortalTicketAction(id, null, fd({ message: '   ', requestKey: newRequestKey() }))).toEqual({ error: 'portal.help.error.reply' });
    await repo().updateStatus(id, 'closed');
    expect(await replyPortalTicketAction(id, null, fd({ message: 'Hello', requestKey: newRequestKey() }))).toEqual({ error: 'portal.help.error.closed' });
  });

  it("A's session on B's host → sign-in redirect, even with B's own ticket id", async () => {
    await signIn('pa');
    h.site = SITE('pb', 'bravo');
    await expect(replyPortalTicketAction(B.ticketIds[0], null, fd({ message: 'Hello', requestKey: newRequestKey() }))).rejects.toThrow(
      'REDIRECT:/portal/login',
    );
  });

  it('the kill switch refuses replies', async () => {
    await signIn('pa');
    h.supportOff.add('pa');
    expect(await replyPortalTicketAction(A.ticketIds[0], null, fd({ message: 'Hello', requestKey: newRequestKey() }))).toEqual({
      error: 'portal.help.error.support_off',
    });
  });
});

describe('portal-tickets reads', () => {
  it("list and open are (partner, phone) scoped; a malformed id never reaches the DB", async () => {
    const owner = { partnerId: 'pa', phone };
    expect((await listPortalTickets(owner)).map((t) => t.id)).toEqual(A.ticketIds);
    expect((await getPortalTicket(owner, A.ticketIds[0]))?.id).toBe(A.ticketIds[0]);
    expect(await getPortalTicket(owner, B.ticketIds[0])).toBeNull();
    expect(await getPortalTicket(owner, "tk_x' OR 1=1")).toBeNull();
  });

  it('the thread view hides internal notes and never carries the staff id', async () => {
    const id = A.ticketIds[0];
    await repo().appendMessage({ ticketId: id, actorType: 'staff', actorId: 'agent.smith', body: 'Public staff reply' });
    await repo().appendMessage({ ticketId: id, actorType: 'staff', actorId: 'agent.smith', body: 'SECRET internal note', internal: true });
    const view = await listPortalTicketMessages(id);
    expect(view.map((m) => m.body)).toEqual(['Fixture ticket body', 'Public staff reply']);
    expect(view.map((m) => m.mine)).toEqual([true, false]);
    expect(JSON.stringify(view)).not.toContain('agent.smith');
    expect(JSON.stringify(view)).not.toContain('SECRET');
  });

  it('support is on by default and off with the kill switch', async () => {
    expect(await portalSupportEnabled('pa')).toBe(true);
    h.supportOff.add('pa');
    expect(await portalSupportEnabled('pa')).toBe(false);
    expect(await portalSupportEnabled('no-such-partner')).toBe(false);
  });

  it('every status has a label and a tone', () => {
    for (const s of ['open', 'pending', 'waiting_admin', 'resolved', 'closed'] as const) {
      expect(ticketStatusView(s).label).toMatch(/^portal\.help\.status\./);
    }
    expect(ticketStatusView('pending').label).toBe('portal.help.status.pending');
  });
});
