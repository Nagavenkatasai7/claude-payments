import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import { createStore } from '@/lib/store';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { createPartnerApiKeyStore } from '@/lib/partner-api-key';
import { apiKeys } from '@/db/schema';
import type { Db } from '@/db/client';
import type { Staff, Transfer } from '@/lib/types';

// UI redesign M3-3: /partner (home) reads the SESSION tenant's live ledger aggregate, channel
// health, settlement endpoint and API keys. The M3-1 harness (real auth store on a fake Redis,
// real stores on PGlite); every store getter is rebuilt on the current db (the real getters cache
// their first store, which would outlive freshDb()).
const redis = fakeRedis();
let db: Db;
let pgPartnerStore: PartnerStore;
const fail = { summary: false, apiKeys: false };
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers(),
}));
const redirectMock = vi.hoisted(() =>
  vi.fn((p: string) => {
    throw new Error('REDIRECT:' + p);
  }),
);
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return {
    ...actual,
    getStore: () => {
      const s = actual.createStore(redis, db);
      // Only the ledger aggregate fails, so the other cards (WhatsApp reads the same store) must hold.
      if (fail.summary) s.transfersSummary = async () => Promise.reject(new Error('ledger unavailable 15559990000'));
      return s;
    },
  };
});
vi.mock('@/lib/partner-integrations-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-integrations-store')>('@/lib/partner-integrations-store');
  return { ...actual, getPartnerIntegrationsStore: () => actual.createPartnerIntegrationsStore(db) };
});
vi.mock('@/lib/partner-api-key', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-api-key')>('@/lib/partner-api-key');
  return {
    ...actual,
    getPartnerApiKeyStore: () => {
      const s = actual.createPartnerApiKeyStore(db);
      if (fail.apiKeys) s.list = async () => Promise.reject(new Error('keys down'));
      return s;
    },
  };
});

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import Home from '@/app/partner/(app)/page';

const PA = 'ptn-alpha3';
const PB = 'ptn-bravo9';
const PHONE = '15551230000'; // the SAME customer phone at both partners
const RECIPIENT = 'Anitaqz';
const RAIL_URL = 'https://rail-bravo.example/settle';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
async function signInAs(o: Partial<Staff>): Promise<void> {
  const s: Staff = {
    username: 'u1',
    name: 'U',
    role: 'admin',
    permissions: perms,
    passwordHash: 'x',
    createdAt: new Date().toISOString(),
    ...o,
  };
  await getAuthStore().saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
}
const render = async () => renderToStaticMarkup(await Home());

function transfer(over: Partial<Transfer>): Transfer {
  return {
    id: 't1', phone: PHONE, amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: RECIPIENT, recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date().toISOString(),
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  redirectMock.mockClear();
  fail.summary = false;
  fail.apiKeys = false;
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedPartner(db, PA, 'Alpha Remit');
  await seedPartner(db, PB, 'Bravo Remit');
  const store = createStore(redis, db);
  // PA: two live transfers today (one delivered: its fee counts), one SANDBOX row (excluded).
  await store.saveTransfer(transfer({ id: 'a1', partnerId: PA, amountUsd: 200, feeUsd: 5, status: 'delivered' }));
  await store.saveTransfer(transfer({ id: 'a2', partnerId: PA, amountUsd: 150, feeUsd: 4 }));
  await store.saveTransfer(transfer({ id: 'a3', partnerId: PA, amountUsd: 900, feeUsd: 9, environment: 'test', status: 'delivered' }));
  // PB: five live transfers (one held for review) for the same phone; a working http rail, a
  // recently used live key and a WhatsApp dead-send mark. None of it may reach PA's page.
  for (let n = 1; n <= 5; n++) {
    await store.saveTransfer(
      transfer({ id: `b${n}`, partnerId: PB, amountUsd: 1000, feeUsd: 7, status: n === 1 ? 'in_review' : 'delivered' }),
    );
  }
  await createPartnerIntegrationsStore(db).saveIntegrations(PB, {
    kyc: {},
    payment: { providerType: 'http', credentials: { settlementUrl: RAIL_URL, signingSecret: 's' }, webhookSecret: 'w' },
    whatsapp: {},
  });
  await db.insert(apiKeys).values({ id: 'pk_live_bravo1', partnerId: PB, keyHash: 'h-b1', last4: 'b1b1', lastUsedAt: daysAgo(1) });
  await redis.set(`wahealth:${PB}`, JSON.stringify({ dead_send: { at: new Date().toISOString(), count: 3 } }));
});

describe('/partner home: gate', () => {
  it('anonymous → /login; platform → /admin-dashboard', async () => {
    await expect(Home()).rejects.toThrow('REDIRECT:/login');
    await signInAs({ partnerId: undefined });
    await expect(Home()).rejects.toThrow('REDIRECT:/admin-dashboard');
  });
});

describe('/partner home: tenant isolation', { retry: 0 }, () => {
  it('shows only the session tenant’s live figures, never partner B’s', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    const html = await render();
    expect(html).toContain('data-kpi="countToday">2<'); // PA live only; sandbox excluded
    expect(html).toMatch(/data-kpi="volumeToday">(<[^>]+>)*\$350\.00</);
    expect(html).toMatch(/data-kpi="feesToday">(<[^>]+>)*\$5\.00</); // delivered only
    expect(html).not.toContain('data-action="holds"'); // PB's hold is not PA's
    expect(html).not.toContain('$5,000.00');
  });

  it('health is PA’s own: PB’s rail, key and WhatsApp mark never colour PA’s cards', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    const html = await render();
    expect(html).toContain('data-health="whatsapp" data-state="ok"');
    expect(html).toContain('data-health="webhooks" data-state="off"');
    expect(html).toContain('data-health="api" data-state="off"');
    expect(html).toContain('data-action="webhooks"');
    expect(html).toContain('data-action="no_live_key"');
  });

  it('PB’s staff see PB’s figures, their hold and their channel mark', async () => {
    await signInAs({ username: 'u2', partnerId: PB, role: 'agent' });
    const html = await render();
    expect(html).toContain('data-kpi="countToday">5<');
    expect(html).toContain('data-action="holds"');
    expect(html).toContain('data-health="whatsapp" data-state="attention"');
    expect(html).toContain('data-health="webhooks" data-state="ok"');
    expect(html).toContain('data-health="api" data-state="ok"');
  });

  it('renders no PII, no secrets and no other tenant id', async () => {
    for (const [pid, u] of [[PA, 'u1'], [PB, 'u2']] as const) {
      await signInAs({ username: u, partnerId: pid, role: 'admin' });
      const html = await render();
      for (const needle of [PHONE, '1230000', RECIPIENT, '919876543210', '123456789012', 'HDFC', RAIL_URL, 'rail-bravo', 'pk_live_bravo1', 'h-b1', PA, PB]) {
        expect(html, needle).not.toContain(needle);
      }
    }
  });
});

describe('/partner home: flagged today and all-time totals (p3 B11, B13)', () => {
  it('flagged today is a bare count; admin and agent get a Reviews link, finance gets the count only', async () => {
    await createStore(redis, db).saveTransfer(
      transfer({ id: 'a4', partnerId: PA, amountUsd: 50, feeUsd: 1, complianceStatus: 'flagged', complianceReasons: ['watchlist'] }),
    );
    await signInAs({ partnerId: PA, role: 'admin' });
    let html = await render();
    expect(html).toContain('data-kpi="flaggedToday">1<');
    expect(html).toContain('href="/partner/reviews"');
    expect(html).not.toContain('watchlist');
    await signInAs({ username: 'u4', partnerId: PA, role: 'agent' });
    expect(await render()).toContain('href="/partner/reviews"');
    await signInAs({ username: 'u5', partnerId: PA, role: 'finance' });
    html = await render();
    expect(html).toContain('data-kpi="flaggedToday">1<');
    expect(html).not.toContain('href="/partner/reviews"');
  });

  it('no flagged transfer → 0 and no link', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    const html = await render();
    expect(html).toContain('data-kpi="flaggedToday">0<');
    expect(html).not.toContain('href="/partner/reviews"');
  });

  it('all-time totals are the session tenant’s live rows only', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    const html = await render();
    expect(html).toContain('data-kpi="countAll">2<'); // sandbox a3 and PB's five excluded
    expect(html).toMatch(/data-kpi="volumeAll">(<[^>]+>)*\$350\.00</);
    expect(html).toMatch(/data-kpi="feesAll">(<[^>]+>)*\$5\.00</);
  });
});

describe('/partner home: roles', () => {
  it('agent sees the money KPIs; support sees health and actions, no money KPIs', async () => {
    await signInAs({ partnerId: PA, role: 'agent' });
    expect(await render()).toContain('data-kpi="countToday"');
    await signInAs({ username: 'u3', partnerId: PA, role: 'support' });
    const html = await render();
    expect(html).not.toContain('data-kpi=');
    expect(html).toContain('data-health="api"');
    expect(html).toContain('data-action="webhooks"');
  });

  it('one h1, a link to account security, and every href stays inside /partner', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    const html = await render();
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain('href="/partner/security"');
    for (const m of html.matchAll(/href="([^"]*)"/g)) expect(m[1]).toMatch(/^\/partner(\/|$)/);
  });
});

describe('/partner home: fail-soft per card', () => {
  it('a failing ledger read shows an error on the KPI card only; health still renders', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    fail.summary = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const html = await render();
    expect(html).toContain('data-card-error="kpis"');
    expect(html).not.toContain('data-kpi=');
    expect(html).toContain('data-health="webhooks" data-state="off"');
    expect(html).toContain('data-health="whatsapp" data-state="ok"');
    expect(html).toContain('data-actions-incomplete');
    const logged = warn.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('partner.home');
    expect(logged).not.toContain('15559990000');
    warn.mockRestore();
    expect(html).not.toContain('ledger unavailable');
    expect(html).not.toContain('15559990000');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });

  it('a failing key read marks only the API health as unavailable', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    fail.apiKeys = true;
    const html = await render();
    expect(html).toContain('data-health="api" data-state="error"');
    expect(html).toContain('data-health="whatsapp" data-state="ok"');
    expect(html).toContain('data-kpi="countToday">2<');
    expect(html).not.toContain('keys down');
  });

  it('only test keys → API needs attention (a test key is not a live integration)', async () => {
    await db.insert(apiKeys).values({ id: 'pk_test_alpha1', partnerId: PA, keyHash: 'h-a1', last4: 'a1a1', lastUsedAt: daysAgo(1) });
    await signInAs({ partnerId: PA, role: 'admin' });
    const html = await render();
    expect(html).toContain('data-health="api" data-state="attention"');
    expect(html).not.toContain('data-action="no_live_key"');
  });
});

describe('/partner home: A12 team questions waiting (admins only)', () => {
  beforeEach(async () => {
    const { createTicketRepo } = await import('@/db/repos/ticket-repo');
    const repo = createTicketRepo(db);
    const q = (id: string, partnerId: string, openedBy: string, category?: string) =>
      repo.createTicket({ id, partnerId, kind: 'internal', openedBy, subject: `s ${id}`, body: `b ${id}`, ...(category ? { category } : {}) });
    await q('tk_q1', PA, 'sup1', 'team_question');
    await q('tk_q2', PA, 'sup2', 'team_question');
    await q('tk_q3', PA, 'u1', 'team_question'); // the admin's own question
    await q('tk_q4', PA, 'sup1'); // addressed to SmartRemit
    await q('tk_q5', PB, 'pbsup', 'team_question'); // another tenant
    await repo.updateStatus('tk_q2', 'resolved');
  });
  it("an admin sees their tenant's waiting team questions, not their own, SmartRemit's or another tenant's", async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    const html = await render();
    expect(html).toContain('data-action="team_questions"');
    expect(html).toContain('Team questions waiting for an answer: 1');
  });
  it('agent and support never get the item', async () => {
    for (const role of ['agent', 'support'] as const) {
      await signInAs({ partnerId: PA, role, username: `x-${role}` });
      expect(await render(), role).not.toContain('data-action="team_questions"');
    }
  });
});
