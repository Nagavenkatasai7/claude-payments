import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Db } from '@/db/client';
import { auditEvents, outbox } from '@/db/schema';
import { freshDb, seedPartner } from './helpers-db';
import { fakeRedis, type FakeRedis } from './helpers';
import { TWO_PARTNER_PHONE } from './helpers-portal-two-partner';

// UI redesign M2-13, Task 13.2: the Privacy page behind CUSTOMER_DATA_RIGHTS_ENABLED (off by
// default). Only the REQUEST flow (§6b / X9): step-up, the retention copy, a typed reason (checked
// again on the server), runOnce, one audit row and one deduped ops alert. No job, no erasure, no table.

const SITE = (partnerId: string, slug: string) => ({
  partnerId,
  slug,
  brand: `Brand ${slug}`,
  logo: null,
  theme: { primary: '#0c5bd2', accent: '#0e7490', primaryFromPartner: false, accentFromPartner: false },
});

const h = vi.hoisted(() => ({
  site: null as null | Record<string, unknown>,
  jar: new Map<string, string>(),
  redis: null as unknown,
  db: null as unknown,
  pokes: 0,
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'acme.smartremit.ai' }),
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    set: (n: string, v: string, o?: Record<string, unknown>) => {
      if (o?.maxAge === 0) h.jar.delete(n);
      else h.jar.set(n, v);
    },
    delete: (n: string) => h.jar.delete(n),
  }),
}));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  redirect: (u: string) => {
    throw new Error(`REDIRECT:${u}`);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/portal-site', () => ({
  getPortalSite: async () => h.site,
  requirePortalSite: async () => {
    if (!h.site) throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
    return h.site;
  },
}));
vi.mock('@/lib/redis', () => ({
  getRedis: () =>
    new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (h.redis as Record<string, (...x: unknown[]) => unknown>)[k](...a) }),
}));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => h.db }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => ({}) }));
vi.mock('@/lib/customer-store', async () => {
  const { createCustomerRepo } = await import('@/db/repos/customer-repo');
  return { getCustomerStore: () => createCustomerRepo(h.db as never, async () => null) };
});
vi.mock('@/lib/customer-mfa', () => ({ getCustomerMfaStore: () => ({ isEnrolled: async () => false }) }));
vi.mock('@/lib/outbox', async (orig) => ({ ...(await orig<typeof import('@/lib/outbox')>()), pokeWorker: () => void h.pokes++ }));

import { createPortalSessionStore, PORTAL_SESSION_COOKIE } from '@/lib/portal-session-store';
import { newRequestKey } from '@/lib/portal-request-key';
import { auditSubjectId } from '@/lib/customer-ref';
import { requestDataAction } from '@/app/portal/privacy/actions';
import PrivacyPage from '@/app/portal/privacy/page';
import ExportRequestPage from '@/app/portal/privacy/export/page';
import DeleteRequestPage from '@/app/portal/privacy/delete/page';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { PORTAL_PRIVACY_LIMIT, dataRequestDedupeKey } from '@/lib/portal-data-rights';

const PHONE = TWO_PARTNER_PHONE;
const REASON = 'I would like a copy of my data please';
let db: Db;
let redis: FakeRedis;
let now = Date.now();
const FLAG = 'CUSTOMER_DATA_RIGHTS_ENABLED';
const prevFlag = process.env[FLAG];

const sessions = () => createPortalSessionStore(redis, { now: () => now });
const fd = (reason: string) => {
  const f = new FormData();
  f.set('reason', reason);
  return f;
};
async function signIn(partnerId = 'pa') {
  const { token } = await sessions().create(partnerId, PHONE, 'Safari on iPhone');
  h.jar.set(PORTAL_SESSION_COOKIE, token);
}
const auditRows = (partnerId = 'pa') =>
  db.select().from(auditEvents).where(and(eq(auditEvents.partnerId, partnerId), eq(auditEvents.action, 'customer.data_request')));
const alertRows = () => db.select().from(outbox).where(eq(outbox.kind, 'ops.alert'));
const NOT_FOUND = 'NEXT_HTTP_ERROR_FALLBACK;404';

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'pa');
  await seedPartner(db, 'pb');
  redis = fakeRedis();
  h.redis = redis;
  h.db = db;
  h.site = SITE('pa', 'acme');
  h.jar = new Map();
  h.pokes = 0;
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const repo = createCustomerRepo(db, async () => null);
  await repo.upsertOnFirstInbound('pa', PHONE);
  await repo.upsertOnFirstInbound('pb', PHONE);
  process.env[FLAG] = '1';
});
afterEach(() => {
  if (prevFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = prevFlag;
});

describe('flag off (the default)', () => {
  beforeEach(() => {
    delete process.env[FLAG];
  });
  it('the page, both step-1 pages and the action are 404, even for a signed-in customer', async () => {
    await signIn();
    await expect(PrivacyPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(NOT_FOUND);
    await expect(ExportRequestPage()).rejects.toThrow(NOT_FOUND);
    await expect(DeleteRequestPage()).rejects.toThrow(NOT_FOUND);
    for (const kind of ['export', 'delete']) {
      await expect(requestDataAction(kind, newRequestKey(), fd(REASON))).rejects.toThrow(NOT_FOUND);
    }
    expect(await auditRows()).toHaveLength(0);
    expect(await alertRows()).toHaveLength(0);
  });
  it("'true' or 'yes' is not '1': still off", async () => {
    await signIn();
    for (const v of ['true', 'yes', '0', '']) {
      process.env[FLAG] = v;
      await expect(PrivacyPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(NOT_FOUND);
    }
  });
});

describe('the apex (no site) is a neutral 404 before anything else', () => {
  it('page and action', async () => {
    h.site = null;
    await expect(PrivacyPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(NOT_FOUND);
    await expect(ExportRequestPage()).rejects.toThrow(NOT_FOUND);
    await expect(requestDataAction('export', newRequestKey(), fd(REASON))).rejects.toThrow(NOT_FOUND);
  });
});

describe('flag on', () => {
  it('without a session → sign-in', async () => {
    await expect(PrivacyPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('REDIRECT:/portal/login');
    await expect(requestDataAction('export', newRequestKey(), fd(REASON))).rejects.toThrow('REDIRECT:/portal/login');
  });

  it('the consent view renders for a signed-in customer (no phone on the page)', async () => {
    await signIn();
    const html = renderToStaticMarkup(await PrivacyPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('Your consent record');
    expect(html).toContain('Export my data');
    expect(html).toContain('Delete my account');
    expect(html).not.toContain(PHONE);
  });

  it('a stale session: both step-1 pages and the action go through step-up first', async () => {
    await signIn();
    now += 16 * 60_000;
    // M2-14 (#401 L3): the step-up returns to the page the customer was on.
    await expect(ExportRequestPage()).rejects.toThrow('REDIRECT:/portal/verify?next=/portal/privacy/export');
    await expect(DeleteRequestPage()).rejects.toThrow('REDIRECT:/portal/verify?next=/portal/privacy/delete');
    await expect(requestDataAction('delete', newRequestKey(), fd(REASON))).rejects.toThrow('REDIRECT:/portal/verify?next=/portal/privacy/delete');
    expect(await auditRows()).toHaveLength(0);
  });

  it('the step-1 page shows the exact retention copy', async () => {
    await signIn();
    const html = renderToStaticMarkup(await DeleteRequestPage());
    expect(html).toContain(
      'Transfer records and identity-verification and sanctions-screening evidence are kept for the period the law requires (at least 5 years). Everything else is erased or anonymised.',
    );
  });

  it('an unknown kind is a 404 (closed set)', async () => {
    await signIn();
    await expect(requestDataAction('erase_everything', newRequestKey(), fd(REASON))).rejects.toThrow(NOT_FOUND);
  });

  it('a short reason is refused on the SERVER: no audit, no alert', async () => {
    await signIn();
    for (const r of ['', 'too short', '   short   ']) {
      await expect(requestDataAction('export', newRequestKey(), fd(r))).rejects.toThrow('REDIRECT:/portal/privacy?status=reason');
    }
    expect(await auditRows()).toHaveLength(0);
    expect(await alertRows()).toHaveLength(0);
  });

  it('a valid request: one audit row + one ops alert with no phone; the request key replays', async () => {
    await signIn();
    const key = newRequestKey();
    await expect(requestDataAction('export', key, fd(REASON))).rejects.toThrow('REDIRECT:/portal/privacy?status=requested');
    await expect(requestDataAction('export', key, fd(REASON))).rejects.toThrow('REDIRECT:/portal/privacy?status=requested');
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0].meta).toEqual({ kind: 'export' });
    expect(audits[0].subjectId).toBe(auditSubjectId('pa', PHONE));
    const alerts = await alertRows();
    expect(alerts).toHaveLength(1);
    const message = String((alerts[0].payload as { message: string }).message);
    expect(message).toBe(`SmartRemit ops: customer data request (export) for partner pa, subject ${auditSubjectId('pa', PHONE)}`);
    expect(JSON.stringify(alerts[0].payload)).not.toContain(PHONE);
    expect(JSON.stringify(audits)).not.toContain(PHONE);
    expect(JSON.stringify(audits)).not.toContain(REASON); // the free-text reason is not stored
    expect(alerts[0].dedupeKey).toBe(dataRequestDedupeKey(auditSubjectId('pa', PHONE), 'export', now));
    expect(h.pokes).toBe(1);
  });

  it('a second same-day request of the same kind: a second audit row, still ONE alert (deduped)', async () => {
    await signIn();
    await expect(requestDataAction('delete', newRequestKey(), fd(REASON))).rejects.toThrow('status=requested');
    await expect(requestDataAction('delete', newRequestKey(), fd(REASON))).rejects.toThrow('status=requested');
    expect(await auditRows()).toHaveLength(2);
    expect(await alertRows()).toHaveLength(1);
    await expect(requestDataAction('export', newRequestKey(), fd(REASON))).rejects.toThrow('status=requested');
    expect(await alertRows()).toHaveLength(2); // another kind is another alert
  });

  it(`rate limit: ${PORTAL_PRIVACY_LIMIT.limit} requests per day per customer`, async () => {
    expect(PORTAL_PRIVACY_LIMIT).toEqual({ scope: 'portal-privacy', limit: 3, windowSec: 86_400 });
    await signIn();
    for (let i = 0; i < 3; i++) {
      await expect(requestDataAction('export', newRequestKey(), fd(REASON))).rejects.toThrow('status=requested');
    }
    await expect(requestDataAction('export', newRequestKey(), fd(REASON))).rejects.toThrow('status=rate_limited');
    expect(await auditRows()).toHaveLength(3);
    // The same phone under partner B is another customer with its own budget.
    h.site = SITE('pb', 'bravo');
    await signIn('pb');
    await expect(requestDataAction('export', newRequestKey(), fd(REASON))).rejects.toThrow('status=requested');
    expect(await auditRows('pb')).toHaveLength(1);
  });

  it('M2-14 (#401 L4): a request whose write fails does not burn the daily budget', async () => {
    await signIn();
    const real = h.db as Db;
    h.db = new Proxy(real, {
      get(t, k) {
        if (k === 'transaction') return async () => { throw new Error('db down'); };
        return Reflect.get(t, k);
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 4; i++) {
        await expect(requestDataAction('export', newRequestKey(), fd(REASON))).rejects.toThrow('status=failed');
      }
    } finally {
      h.db = real;
      warn.mockRestore();
    }
    for (let i = 0; i < 3; i++) {
      await expect(requestDataAction('export', newRequestKey(), fd(REASON))).rejects.toThrow('status=requested');
    }
  });

  it('M2-14 (#401 L5): a forged call without FormData is refused cleanly (no 500), nothing written', async () => {
    await signIn();
    for (const bad of [undefined, null, 'x', { reason: 'y'.repeat(40) }]) {
      await expect(requestDataAction('export', newRequestKey(), bad as never)).rejects.toThrow(/status=reason/);
    }
    expect(await auditRows()).toHaveLength(0);
  });

  it('a malformed request key → expired copy, nothing written', async () => {
    await signIn();
    await expect(requestDataAction('export', 'nope', fd(REASON))).rejects.toThrow('REDIRECT:/portal/privacy?status=expired');
    expect(await auditRows()).toHaveLength(0);
  });

  it("A's cookie on B's host cannot file a request", async () => {
    await signIn('pa');
    h.site = SITE('pb', 'bravo');
    await expect(requestDataAction('export', newRequestKey(), fd(REASON))).rejects.toThrow('REDIRECT:/portal/login');
    expect(await auditRows('pb')).toHaveLength(0);
    expect(await auditRows('pa')).toHaveLength(0);
  });
});
