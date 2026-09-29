import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff, Transfer } from '@/lib/types';

// UI redesign M3-15b: the delivery log + failed-instruction sections of
// /partner/integrations/webhooks. The SESSION tenant's rows only (as the rail owner), keyset-paged
// 50 at a time on a strict id cursor; no URL, payload, last_error or customer field ever reaches
// the HTML; a SmartRemit-managed rail shows neither section.

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
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(db) };
});

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { auditEvents, partnerWebhookDeliveries } from '@/db/schema';
import { createStore } from '@/lib/store';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import { t } from '@/lib/i18n';
import WebhooksPage from '@/app/partner/(app)/integrations/webhooks/page';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
async function signInAs(o: Partial<Staff>): Promise<void> {
  const s: Staff = { username: 'pa-admin', name: 'A', role: 'admin', permissions: perms, passwordHash: 'x', createdAt: new Date().toISOString(), partnerId: 'pa', ...o };
  await getAuthStore().saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
}
const decode = (html: string) => html.replaceAll('&amp;', '&').replaceAll('&#x27;', "'").replaceAll('&quot;', '"');
const render = async (sp: Record<string, string | string[] | undefined> = {}) => decode(renderToStaticMarkup(await WebhooksPage({ searchParams: Promise.resolve(sp) })));
const rail = (providerType: 'http' | 'simulator' = 'http'): PartnerIntegrations => ({
  kyc: {},
  payment: { providerType, credentials: { settlementUrl: 'https://rail-a.example.com/instruct', signingSecret: 'S'.repeat(64) }, webhookSecret: 'W'.repeat(64) },
  whatsapp: {},
});
function transfer(id: string, partnerId: string): Transfer {
  return {
    id, phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita Recipient', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 3_600_000).toISOString(), paidAt: new Date(Date.now() - 3_000_000).toISOString(), partnerId,
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
  } as Transfer;
}
const delivery = (partnerId: string, i: number, extra: Partial<typeof partnerWebhookDeliveries.$inferInsert> = {}) =>
  db.insert(partnerWebhookDeliveries).values({ partnerId, kind: 'settlement.instruct', subjectId: `${partnerId}_tr_${i}`, outboxId: 7000 + i, attempt: 2, outcome: 'http_error', httpStatus: 503, latencyMs: 321, ...extra });
async function deadRow(transferId: string, key: string): Promise<number> {
  await createOutboxRepo(db).enqueue('settlement.instruct', { transferId }, { dedupeKey: key });
  const r = (await db.execute(sql`UPDATE outbox SET status = 'dead', attempts = 8, last_error = 'LAST-ERROR-MARKER 919876543210' WHERE dedupe_key = ${key} RETURNING id`)) as unknown as { rows: Array<{ id: number }> };
  return Number(r.rows[0].id);
}

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
  await createPartnerIntegrationsStore(db).saveIntegrations('pa', rail());
  await createPartnerIntegrationsStore(db).saveIntegrations('pb', rail());
});

describe('/partner/integrations/webhooks: the delivery log (M3-15b)', () => {
  it("shows A's instruction deliveries (transfer id, outcome, status, latency, attempt), never B's, never a URL or outbox id", async () => {
    await delivery('pa', 1, { outcome: 'ok', httpStatus: 200, latencyMs: 87, attempt: 1 });
    await delivery('pa', 2);
    await delivery('pb', 3, { httpStatus: 418 });
    await signInAs({});
    const html = await render();
    expect(html).toContain(t('partner.webhooks.log.title'));
    expect(html).toContain('pa_tr_1');
    expect(html).toContain('pa_tr_2');
    expect(html.indexOf('pa_tr_2')).toBeLessThan(html.indexOf('pa_tr_1')); // newest first
    expect(html).toContain('>503<');
    expect(html).toContain('321 ms');
    expect(html).toContain(t('partner.webhooks.outcome.http_error'));
    expect(html).not.toContain('pb_tr_3');
    expect(html).not.toContain('>418<');
    expect(html).not.toContain('7001');
    expect(html).not.toContain(t('partner.webhooks.log.empty'));
  });

  it('pages 50 at a time: Older links a strict id cursor; the next page shows the rest and a Newest link', async () => {
    for (let i = 0; i < 52; i++) await delivery('pa', i);
    await signInAs({});
    const first = await render();
    expect(first).toContain('pa_tr_51');
    expect(first).toContain('pa_tr_2');
    expect(first).not.toContain('pa_tr_1<');
    const m = first.match(/href="\/partner\/integrations\/webhooks\?before=(\d+)#delivery-log"/);
    expect(m).not.toBeNull();
    const second = await render({ before: m![1] });
    expect(second).toContain('pa_tr_1<');
    expect(second).toContain('pa_tr_0<');
    expect(second).not.toContain('pa_tr_2<');
    expect(second).toContain('href="/partner/integrations/webhooks#delivery-log"');
    expect(second).not.toContain('?before=');
  });

  it('a hostile cursor is ignored (first page); B-only positions show nothing of B', async () => {
    await delivery('pa', 1);
    await delivery('pb', 2);
    await signInAs({});
    for (const before of ['abc', '-1', '0', "1' OR 1=1", ['5', '6']] as Array<string | string[]>) {
      const html = await render({ before });
      expect(html).toContain('pa_tr_1');
      expect(html).not.toContain('pb_tr_2');
    }
  });

  it('empty: the log empty state', async () => {
    await signInAs({});
    expect(await render()).toContain(t('partner.webhooks.log.empty'));
  });
});

describe('/partner/integrations/webhooks: failed instructions + Replay (M3-15b)', () => {
  it("lists A's dead instructions (id, attempts) with a Replay control; never B's, the payload or last_error", async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(transfer('t_pa', 'pa'));
    await store.saveTransfer(transfer('t_pb', 'pb'));
    const paRow = await deadRow('t_pa', 'instruct:t_pa');
    const pbRow = await deadRow('t_pb', 'instruct:t_pb');
    await signInAs({});
    const html = await render();
    expect(html).toContain(t('partner.webhooks.dead.title'));
    // Named by the TRANSFER id (the rail owner already has it), never the global sequential outbox id.
    expect(html).toContain(t('partner.webhooks.dead.item', { ref: 't_pa' }));
    expect(html).not.toContain(`#${paRow}`);
    expect(html).not.toContain(`#${pbRow}`);
    expect(html).toContain(t('partner.webhooks.replay'));
    for (const leak of ['LAST-ERROR-MARKER', '919876543210', 'Anita', '123456789012', 't_pb']) expect(html).not.toContain(leak);
  });

  it('empty: the no-failed-instructions state, and no Replay control', async () => {
    await signInAs({});
    const html = await render();
    expect(html).toContain(t('partner.webhooks.dead.empty'));
    expect(html).not.toContain(`>${t('partner.webhooks.replay')}<`);
  });

  it('a SmartRemit-managed rail never runs the delivery or dead-letter queries', async () => {
    await createPartnerIntegrationsStore(db).saveIntegrations('pa', rail('simulator'));
    await signInAs({});
    const stop = captureQueries();
    await render();
    const q = stop().map((x) => x.sql.toLowerCase());
    expect(q.some((x) => x.includes('partner_webhook_deliveries') && x.includes('settlement.instruct'))).toBe(false);
    expect(q.some((x) => x.includes('from "outbox"'))).toBe(false);
  });

  it('a SmartRemit-managed rail shows neither section', async () => {
    await createPartnerIntegrationsStore(db).saveIntegrations('pa', rail('simulator'));
    await delivery('pa', 1);
    await signInAs({});
    const html = await render();
    expect(html).not.toContain(t('partner.webhooks.log.title'));
    expect(html).not.toContain(t('partner.webhooks.dead.title'));
    expect(html).not.toContain('pa_tr_1');
  });

  it('viewing writes no audit row and changes no outbox row', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(transfer('t_pa', 'pa'));
    await deadRow('t_pa', 'instruct:t_pa');
    await signInAs({});
    await render();
    expect(await db.select().from(auditEvents)).toEqual([]);
    const r = (await db.execute(sql`SELECT status FROM outbox WHERE dedupe_key = 'instruct:t_pa'`)) as unknown as { rows: Array<{ status: string }> };
    expect(r.rows[0].status).toBe('dead');
  });
});
