import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { seedPartnerTransfer } from './helpers-partner-app';
import { seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-16, Task 16.4: requestReportAction (the shared per-action checklist) and the
// download route GET /partner/reports/<id>/download. Real gate over the real auth store on a fake
// Redis, PGlite ledger, the real worker to build the reports.
const redis = fakeRedis();
let db: Db;
const cookieJar = new Map<string, string>();
const host = vi.hoisted(() => ({ value: 'smartremit.ai' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host: host.value }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  },
}));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('next/cache', () => ({ revalidatePath }));
const pokeWorker = vi.hoisted(() => vi.fn());
vi.mock('@/lib/outbox', async (orig) => ({ ...(await orig<typeof import('@/lib/outbox')>()), pokeWorker }));
const auditFault = vi.hoisted(() => ({ on: false }));
vi.mock('@/db/repos/aux-repos', async (orig) => {
  const real = await orig<typeof import('@/db/repos/aux-repos')>();
  return {
    ...real,
    createAuditRepo: (...a: Parameters<typeof real.createAuditRepo>) => {
      const repo = real.createAuditRepo(...a);
      return {
        ...repo,
        record: async (e: Parameters<typeof repo.record>[0]) => {
          if (auditFault.on) throw new Error('boom');
          return repo.record(e);
        },
      };
    },
  };
});
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { auditEvents, outbox, partnerReportJobs } from '@/db/schema';
import { requestReportAction } from '@/app/partner/(app)/reports/actions';
import { GET as download } from '@/app/partner/(app)/reports/[id]/download/route';
import { runPartnerReportJob } from '@/lib/partner-report-worker';
import { DAILY_JOB_CAP, MAX_ACTIVE_JOBS } from '@/lib/partner-reports';

const PA = 'pa';
const PB = 'pb';
const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };

async function signInAs(o: Partial<Staff>): Promise<Staff> {
  const s: Staff = {
    username: 'pa-admin',
    name: 'U',
    role: 'admin',
    permissions: perms,
    passwordHash: 'x',
    createdAt: new Date().toISOString(),
    partnerId: PA,
    ...o,
  };
  await getAuthStore().saveStaff(s);
  cookieJar.clear();
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
  return s;
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}
const settlementsForm = (extra: Record<string, string> = {}) => form({ kind: 'settlements', ...extra });
const transfersForm = (extra: Record<string, string> = {}) => form({ kind: 'transfers', environment: 'live', ...extra });

const audits = () => db.select().from(auditEvents);
const jobs = () => db.select().from(partnerReportJobs);
const outboxRows = () => db.select().from(outbox);
const snapshot = async () => ({ jobs: await jobs(), outbox: await outboxRows(), audits: (await audits()).length });

const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

function expectCleanAuditMeta(meta: unknown) {
  const s = JSON.stringify(meta ?? {});
  expect(s).not.toMatch(/\+?\d{10,}/);
  expect(s).not.toContain('Samplesurname');
  expect(s).not.toContain('000011112222');
}

beforeEach(async () => {
  auditFault.on = false;
  redis.dump.clear();
  cookieJar.clear();
  host.value = 'smartremit.ai';
  db = await freshDb();
  await seedPartner(db, PA, 'Alpha');
  await seedPartner(db, PB, 'Bravo');
  await seedPartnerTransfer(db, { id: 'tx_pa1', partnerId: PA, createdAt: day(2), paidAt: day(2), status: 'paid', paymentProviderRef: 'r1' });
  await seedPartnerTransfer(db, { id: 'tx_pb1', partnerId: PB, createdAt: day(2), paidAt: day(2), status: 'paid', paymentProviderRef: 'r2' });
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe('requestReportAction: per-action checklist', () => {
  it('0. refuses on a partner-site host before anything else', async () => {
    await signInAs({});
    host.value = 'acme.smartremit.ai';
    const before = await snapshot();
    await expect(requestReportAction(settlementsForm())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(await snapshot()).toEqual(before);
  });

  it('1. anonymous → /login; platform staff → /admin-dashboard', async () => {
    await expect(requestReportAction(settlementsForm())).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'plat', partnerId: undefined });
    await expect(requestReportAction(settlementsForm())).rejects.toThrow('REDIRECT:/admin-dashboard');
    expect(await jobs()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
  });

  it('2. support → /partner (any kind); agent → /partner for settlements and fees; nothing written', async () => {
    const before = await snapshot();
    await signInAs({ username: 'pa-support', role: 'support' });
    await expect(requestReportAction(transfersForm())).rejects.toThrow('REDIRECT:/partner');
    await signInAs({ username: 'pa-agent', role: 'agent' });
    await expect(requestReportAction(settlementsForm())).rejects.toThrow('REDIRECT:/partner');
    await expect(requestReportAction(form({ kind: 'fees_monthly', month: '2026-01' }))).rejects.toThrow('REDIRECT:/partner');
    expect(await snapshot()).toEqual(before);
    expect(pokeWorker).not.toHaveBeenCalled();
  });

  it('3+4. a form naming partner B (partnerId, partner, id) creates a job for A only', async () => {
    await signInAs({});
    const r = await requestReportAction(settlementsForm({ partnerId: PB, partner: PB, id: randomUUID() }));
    expect(r).toEqual({ ok: true });
    const all = await jobs();
    expect(all).toHaveLength(1);
    expect(all[0].partnerId).toBe(PA);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0].partnerId).toBe(PA);
    expect(JSON.stringify(rows)).not.toContain(`"${PB}"`);
    expect(JSON.stringify(all)).not.toContain(`"${PB}"`);
  });

  it('5. invalid input → refusal before any write', async () => {
    await signInAs({});
    const before = await snapshot();
    for (const f of [
      form({ kind: 'customers' }),
      form({}),
      settlementsForm({ from: '2026-01-01', to: '2026-02-15' }),
      settlementsForm({ from: 'x', to: 'y' }),
      form({ kind: 'fees_monthly', month: '2999-01' }),
    ]) {
      const r = (await requestReportAction(f)) as { ok: boolean; error?: string };
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    }
    expect(await snapshot()).toEqual(before);
  });

  it('6. success → job + outbox effect + exactly one audit row, in one transaction; the worker is poked', async () => {
    await signInAs({});
    expect(await requestReportAction(settlementsForm({ from: day(10).slice(0, 10), to: day(0).slice(0, 10) }))).toEqual({ ok: true });
    const [job] = await jobs();
    expect(job).toMatchObject({ partnerId: PA, kind: 'settlements', status: 'queued', requestedBy: 'pa-admin' });
    const effects = (await outboxRows()).filter((r) => r.kind === 'partner.report');
    expect(effects).toHaveLength(1);
    expect(effects[0].payload).toEqual({ jobId: job.id });
    expect(effects[0].dedupeKey).toBe(`report:${job.id}`);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: PA, actor: 'pa-admin', actorType: 'staff', action: 'report.request', subjectId: job.id });
    const meta = rows[0].meta as { actorScope?: string; kind?: string; window?: unknown };
    expect(meta.actorScope).toBe('partner');
    expect(meta.kind).toBe('settlements');
    expect(meta.window).toBeTruthy();
    expectCleanAuditMeta(meta);
    expect(pokeWorker).toHaveBeenCalledTimes(1);
    for (const [p] of revalidatePath.mock.calls) expect(String(p)).toMatch(/^\/partner(\/|$)/);
  });

  it('a failure inside the transaction writes nothing (job, effect and audit roll back together)', async () => {
    await signInAs({});
    auditFault.on = true;
    const r = (await requestReportAction(settlementsForm())) as { ok: boolean };
    auditFault.on = false;
    expect(r.ok).toBe(false);
    expect(await jobs()).toHaveLength(0);
    expect((await outboxRows()).filter((x) => x.kind === 'partner.report')).toHaveLength(0);
    expect(pokeWorker).not.toHaveBeenCalled();
  });

  it(`caps active jobs per tenant at ${MAX_ACTIVE_JOBS}; B's jobs do not count; stale queued jobs do not count`, async () => {
    await signInAs({});
    for (let i = 0; i < MAX_ACTIVE_JOBS; i++) expect(await requestReportAction(settlementsForm())).toEqual({ ok: true });
    const r = (await requestReportAction(settlementsForm())) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(await jobs()).toHaveLength(MAX_ACTIVE_JOBS);
    // A stale queued job (its effect died) stops counting after the active window.
    await db.update(partnerReportJobs).set({ createdAt: new Date(Date.now() - 2 * 3_600_000) });
    expect(await requestReportAction(settlementsForm())).toEqual({ ok: true });
    // B is independent.
    await signInAs({ username: 'pb-admin', partnerId: PB });
    expect(await requestReportAction(settlementsForm())).toEqual({ ok: true });
  });

  it(`rate-limits a tenant to ${DAILY_JOB_CAP} requests per 24 h`, async () => {
    await signInAs({});
    const rows = Array.from({ length: DAILY_JOB_CAP }, () => ({
      id: randomUUID(),
      partnerId: PA,
      kind: 'settlements',
      params: {},
      requestedBy: 'x',
      status: 'ready',
    }));
    await db.insert(partnerReportJobs).values(rows);
    const r = (await requestReportAction(settlementsForm())) as { ok: boolean };
    expect(r.ok).toBe(false);
    expect(await jobs()).toHaveLength(DAILY_JOB_CAP);
  });
});

async function requestAndBuild(o: Partial<Staff>, f: FormData): Promise<string> {
  await signInAs(o);
  expect(await requestReportAction(f)).toEqual({ ok: true });
  const [job] = (await jobs()).filter((j) => j.requestedBy === (o.username ?? 'pa-admin')).slice(-1);
  expect(await runPartnerReportJob(db, job.id, { hardStopAt: Date.now() + 60_000 })).toBe('ready');
  return job.id;
}

const call = (id: string) => download(new Request(`https://smartremit.ai/partner/reports/${id}/download`), { params: Promise.resolve({ id }) });
const downloads = async () => (await audits()).filter((a) => a.action === 'report.download');

describe('GET /partner/reports/<id>/download', () => {
  it("pa's ready job → 200 CSV, no-store, attachment, exactly one report.download row", async () => {
    const id = await requestAndBuild({}, settlementsForm());
    const res = await call(id);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="smartremit-settlements-\d{4}-\d{2}-\d{2}\.csv"$/);
    const body = await res.text();
    expect(body).toContain('tx_pa1');
    expect(body).not.toContain('tx_pb1');
    const rows = await downloads();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: PA, actor: 'pa-admin', actorType: 'staff', subjectId: id });
    expect((rows[0].meta as { actorScope?: string }).actorScope).toBe('partner');
  });

  it("pb's job id → 404 and no audit", async () => {
    const id = await requestAndBuild({ username: 'pb-admin', partnerId: PB }, settlementsForm());
    await signInAs({});
    const res = await call(id);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await downloads()).toHaveLength(0);
  });

  it('an expired job → 404 (by status, and by expires_at before the daily sweep), a queued job → 404, a bad id → 404', async () => {
    const id = await requestAndBuild({}, settlementsForm());
    await db.update(partnerReportJobs).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(partnerReportJobs.id, id));
    expect((await call(id)).status).toBe(404);
    await db.update(partnerReportJobs).set({ status: 'expired', contentEnc: null }).where(eq(partnerReportJobs.id, id));
    expect((await call(id)).status).toBe(404);
    expect(await requestReportAction(settlementsForm())).toEqual({ ok: true });
    const queued = (await jobs()).find((j) => j.status === 'queued')!;
    expect((await call(queued.id)).status).toBe(404);
    expect((await call('not-a-uuid')).status).toBe(404);
    expect((await call(randomUUID())).status).toBe(404);
    expect(await downloads()).toHaveLength(0);
  });

  it('every 404 is byte-identical', async () => {
    const other = await requestAndBuild({ username: 'pb-admin', partnerId: PB }, settlementsForm());
    await signInAs({});
    const a = await call(other);
    const b = await call(randomUUID());
    const c = await call('x');
    const texts = await Promise.all([a, b, c].map((r) => r.text()));
    expect(new Set(texts).size).toBe(1);
    expect(new Set([a, b, c].map((r) => JSON.stringify([...r.headers])))).toHaveProperty('size', 1);
  });

  it('an agent: transfers export requested AND downloaded; settlements refused; a finance settlements job id → 404, no audit', async () => {
    const fin = await requestAndBuild({ username: 'pa-fin', role: 'finance' as Staff['role'] }, settlementsForm());
    const tx = await requestAndBuild({ username: 'pa-agent', role: 'agent' }, transfersForm());
    const ok = await call(tx);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('tx_pa1');
    await expect(requestReportAction(settlementsForm())).rejects.toThrow('REDIRECT:/partner');
    const before = (await downloads()).length;
    expect((await call(fin)).status).toBe(404);
    expect(await downloads()).toHaveLength(before);
  });

  it('gate: anonymous → /login, support → /partner, platform → /admin-dashboard; site host → 404', async () => {
    const id = await requestAndBuild({}, settlementsForm());
    cookieJar.clear();
    await expect(call(id)).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'pa-support', role: 'support' });
    await expect(call(id)).rejects.toThrow('REDIRECT:/partner');
    await signInAs({ username: 'plat', partnerId: undefined });
    await expect(call(id)).rejects.toThrow('REDIRECT:/admin-dashboard');
    await signInAs({});
    host.value = 'acme.smartremit.ai';
    await expect(call(id)).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(await downloads()).toHaveLength(0);
  });

  it('a failing audit write → no CSV goes out', async () => {
    const id = await requestAndBuild({}, settlementsForm());
    auditFault.on = true;
    await expect(call(id)).rejects.toThrow('boom');
    auditFault.on = false;
  });
});
