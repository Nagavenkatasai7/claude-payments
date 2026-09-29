import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createStore, type Store } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { seedPartnerTransfer, seedTwoTenants } from './helpers-partner-app';
import { createOutboxRepo, LEASE_MS, type OutboxRepo } from '@/db/repos/outbox-repo';
import { createPartnerReportRepo } from '@/db/repos/partner-report-repo';
import { outbox as outboxTable, partnerReportJobs } from '@/db/schema';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { buildReportCsv, openReportCsv, runPartnerReportJob } from '@/lib/partner-report-worker';
import { MAX_REPORT_ROWS, REPORT_MIN_BUDGET_MS, TRANSFER_EXPORT_COLUMNS } from '@/lib/partner-reports';
import { STATEMENT_COLUMNS } from '@/lib/settlement-statement';
import { decryptField } from '@/lib/field-crypto';
import { ctx as cryptoCtx } from '@/lib/crypto-context';
import type { Db } from '@/db/client';

// UI redesign M3-16, Task 16.3: the 'partner.report' outbox effect.

let db: Db;
let store: Store;
let outbox: OutboxRepo;

function deps(): WorkerDeps {
  return {
    db,
    store,
    sendText: vi.fn(async () => {}) as unknown as WorkerDeps['sendText'],
    sendTemplate: vi.fn(async () => {}) as unknown as WorkerDeps['sendTemplate'],
    fetchFn: vi.fn() as unknown as typeof fetch,
    recipientTemplateName: 't',
    recipientTemplateLang: 'en',
    listStaff: async () => [],
    runAgentTurn: vi.fn(async () => '') as unknown as WorkerDeps['runAgentTurn'],
  };
}

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  outbox = createOutboxRepo(db);
  await seedTwoTenants(db);
});

const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const WINDOW = () => ({ from: new Date(Date.now() - 20 * 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() });

async function newJob(partnerId: string, kind: 'settlements' | 'transfers' | 'fees_monthly', params: Record<string, unknown>) {
  const id = randomUUID();
  await createPartnerReportRepo(db).createJob(partnerId, { id, kind, params, requestedBy: 'u1' });
  await outbox.enqueue('partner.report', { jobId: id }, { dedupeKey: `report:${id}` });
  return id;
}
const jobRow = async (id: string) => (await db.select().from(partnerReportJobs).where(eq(partnerReportJobs.id, id)))[0];
const outboxRow = async (id: string) => (await db.select().from(outboxTable).where(eq(outboxTable.dedupeKey, `report:${id}`)))[0];

async function seedBoth() {
  await seedPartnerTransfer(db, { id: 'tx_pa1', partnerId: 'pa', createdAt: day(2), paidAt: day(2), status: 'paid', paymentProviderRef: 'rail-1', phone: '14155557777' });
  await seedPartnerTransfer(db, { id: 'tx_pa2', partnerId: 'pa', createdAt: day(3), paidAt: day(3), status: 'delivered', paymentProviderRef: 'rail-2' });
  await seedPartnerTransfer(db, { id: 'tx_pb1', partnerId: 'pb', createdAt: day(2), paidAt: day(2), status: 'paid', paymentProviderRef: 'rail-3' });
}

describe('partner.report through drainOnce', () => {
  it('a pa settlements job contains pa rows only; the content is sealed, bound to the job', async () => {
    await seedBoth();
    const id = await newJob('pa', 'settlements', WINDOW());
    const r = await drainOnce(deps(), 'w1', 10, { hardStopAt: Date.now() + 60_000 });
    expect(r.processed).toBe(1);
    const job = await jobRow(id);
    expect(job.status).toBe('ready');
    expect(job.rowCount).toBe(2);
    expect(job.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(job.contentEnc!.startsWith('v2.')).toBe(true);
    expect(job.contentEnc).not.toContain('tx_pa1');
    // Bound to (tenant, job): the other tenant's context does not open it.
    expect(() => decryptField(job.contentEnc!, undefined, cryptoCtx.partnerReport('pb', id))).toThrow();
    const csv = openReportCsv(job);
    expect(csv.split('\r\n')[0]).toBe(STATEMENT_COLUMNS.join(','));
    expect(csv).toContain('tx_pa1');
    expect(csv).toContain('tx_pa2');
    expect(csv).not.toContain('tx_pb1');
    expect((await outboxRow(id)).status).toBe('done');
  });

  it('a transfers job carries no full phone, destination or legal name', async () => {
    await seedBoth();
    const id = await newJob('pa', 'transfers', { ...WINDOW(), environment: 'live' });
    await drainOnce(deps(), 'w1', 10, { hardStopAt: Date.now() + 60_000 });
    const job = await jobRow(id);
    expect(job.status).toBe('ready');
    const csv = openReportCsv(job);
    expect(csv.split('\r\n')[0]).toBe(TRANSFER_EXPORT_COLUMNS.join(','));
    expect(csv).toContain('****7777');
    for (const pii of ['14155557777', '14155550101', '919876543210', '000011112222', 'HDFC0001111', 'Samplesurname']) expect(csv).not.toContain(pii);
    expect(csv).not.toContain('tx_pb1');
    expect(csv.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '')).not.toMatch(/\d{10,}/);
  });

  it('a fees job aggregates the month', async () => {
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    await seedPartnerTransfer(db, { id: 'tx_f1', partnerId: 'pa', createdAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12)).toISOString(), status: 'paid', feeSource: 2, feeUsd: 2 });
    const id = await newJob('pa', 'fees_monthly', { month });
    await drainOnce(deps(), 'w1', 10, { hardStopAt: Date.now() + 60_000 });
    const csv = openReportCsv(await jobRow(id));
    expect(csv).toContain('day,source_currency,transfers,amount_source,fee_source,fee_usd');
    expect(csv).toContain('"USD",1,100,2,2');
  });

  it('a generation failure → failed with a fixed code, the outbox row done (no retry storm)', async () => {
    const id = await newJob('pa', 'settlements', { from: 'not-a-date', to: 'x' });
    await drainOnce(deps(), 'w1', 10, { hardStopAt: Date.now() + 60_000 });
    const job = await jobRow(id);
    expect(job.status).toBe('failed');
    expect(job.errorCode).toBe('invalid_params');
    expect(job.contentEnc).toBeNull();
    expect((await outboxRow(id)).status).toBe('done');
  });

  it('with < 20 s of budget left: no claim, the job stays queued, the row is deferred UNCHARGED', async () => {
    await seedBoth();
    const id = await newJob('pa', 'settlements', WINDOW());
    const r = await drainOnce(deps(), 'w1', 10, { hardStopAt: Date.now() + REPORT_MIN_BUDGET_MS - 1_000 });
    expect(r.released).toBe(1);
    const job = await jobRow(id);
    expect(job.status).toBe('queued');
    expect(job.claimedAt).toBeNull();
    const row = await outboxRow(id);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('a stale running job (killed worker) is reclaimed and completed exactly once', async () => {
    await seedBoth();
    const id = await newJob('pa', 'settlements', WINDOW());
    await db.update(partnerReportJobs).set({ status: 'running', claimedAt: new Date(Date.now() - LEASE_MS - 5_000) }).where(eq(partnerReportJobs.id, id));
    await drainOnce(deps(), 'w1', 10, { hardStopAt: Date.now() + 60_000 });
    expect((await jobRow(id)).status).toBe('ready');
    // A replay (e.g. a lost markDone) finds it ready: nothing is rebuilt, the row completes.
    const before = (await jobRow(id)).contentEnc;
    expect(await runPartnerReportJob(db, id, { hardStopAt: Date.now() + 60_000 })).toBe('skipped');
    expect((await jobRow(id)).contentEnc).toBe(before);
  });

  it('a fresh running job (claimed elsewhere) is a retryable failure, the job untouched', async () => {
    const id = await newJob('pa', 'settlements', WINDOW());
    const claimedAt = new Date();
    await db.update(partnerReportJobs).set({ status: 'running', claimedAt }).where(eq(partnerReportJobs.id, id));
    const r = await drainOnce(deps(), 'w1', 10, { hardStopAt: Date.now() + 60_000 });
    expect(r.failed).toBe(1);
    expect((await jobRow(id))).toMatchObject({ status: 'running', claimedAt });
    expect((await outboxRow(id)).lastError).toBe('report_busy');
  });
});

describe('buildReportCsv limits', () => {
  it('honours the row cap and flags truncated', async () => {
    await seedBoth();
    const job = { id: randomUUID(), partnerId: 'pa', kind: 'transfers', params: { ...WINDOW(), environment: 'live' } };
    const r = await buildReportCsv(db, job, { maxRows: 1 });
    expect(r.rowCount).toBe(1);
    expect(r.truncated).toBe(true);
    expect(r.csv.trim().split('\r\n')).toHaveLength(2);
    const full = await buildReportCsv(db, job, {});
    expect(full).toMatchObject({ rowCount: 2, truncated: false });
    expect(MAX_REPORT_ROWS).toBe(10_000);
  });

  it('honours the byte cap', async () => {
    await seedBoth();
    const job = { id: randomUUID(), partnerId: 'pa', kind: 'transfers', params: { ...WINDOW(), environment: 'live' } };
    const header = TRANSFER_EXPORT_COLUMNS.join(',').length + 2;
    const r = await buildReportCsv(db, job, { maxBytes: header + 10 });
    expect(r).toMatchObject({ rowCount: 0, truncated: true });
  });

  it('the wall-time box truncates between pages', async () => {
    await seedBoth();
    const job = { id: randomUUID(), partnerId: 'pa', kind: 'transfers', params: { ...WINDOW(), environment: 'live' } };
    let t = 0;
    const r = await buildReportCsv(db, job, { pageSize: 1, wallMs: 10, now: () => (t += 11) });
    expect(r).toMatchObject({ rowCount: 1, truncated: true });
  });
});
