import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { seedTwoTenants, signInAs } from './helpers-partner-app';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';

// UI redesign M3-21: the platform side of onboarding. Two platform-admin actions:
//   - approveGoLiveAction (/admin-dashboard/partners/[id]): approves a REQUESTED go-live;
//   - createPartnerFromRequestAction (/admin-dashboard/partner-requests/[id]): an APPROVED request
//     becomes a partner (sandbox-only: a go-live row NOT approved) plus a sealed partner-ADMIN invite.
// Real gate (requirePlatformAdmin over the real auth store on a fake Redis), real repos on PGlite.
const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
let pgPartnerStore: PartnerStore;
const pokeWorkerMock = vi.hoisted(() => vi.fn());

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
vi.mock('@/lib/outbox', () => ({ pokeWorker: () => pokeWorkerMock() }));
// A switch that makes a transaction COMMIT and then throw (a driver error after COMMIT: the client
// sees a failure although everything was written).
const throwAfterCommit = vi.hoisted(() => ({ on: false }));
function dbThrowingAfterCommit(real: Db): Db {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'transaction') {
        return async (fn: Parameters<Db['transaction']>[0]) => {
          await target.transaction(fn);
          throw new Error('connection lost after COMMIT');
        };
      }
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
vi.mock('@/db/client', async (orig) => ({
  ...(await orig<typeof import('@/db/client')>()),
  getDb: () => (throwAfterCommit.on ? dbThrowingAfterCommit(db) : db),
}));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis) };
});
// A switch that makes the outbox enqueue report a dedupe miss (the rollback path).
const failEnqueue = vi.hoisted(() => ({ on: false }));
vi.mock('@/db/repos/outbox-repo', async (orig) => {
  const actual = await orig<typeof import('@/db/repos/outbox-repo')>();
  return {
    ...actual,
    createOutboxRepo: (d: Parameters<typeof actual.createOutboxRepo>[0]) => {
      const repo = actual.createOutboxRepo(d);
      return { ...repo, enqueue: (async (...a: Parameters<typeof repo.enqueue>) => (failEnqueue.on ? null : repo.enqueue(...a))) as typeof repo.enqueue };
    },
  };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});

import { approveGoLiveAction } from '@/app/admin-dashboard/partners/go-live-actions';
import { createPartnerFromRequestAction } from '@/app/admin-dashboard/partner-requests/actions';
import { wizardCreatePartnerAction } from '@/app/admin-dashboard/partners/actions';
import { auditEvents, outbox, partnerGoLive, partners, apiKeys } from '@/db/schema';
import { createAuthStore } from '@/lib/auth-store';
import { createPartnerRequestRepo } from '@/db/repos/aux-repos';
import { getGoLive, isLiveApproved, requestGoLive } from '@/db/repos/partner-go-live-repo';
import { createStaffInviteStore } from '@/lib/staff-invite-store';
import { inviteRedeemable } from '@/lib/staff-invite-accept';
import { decryptField } from '@/lib/field-crypto';
import { outboxSealedCtx } from '@/lib/crypto-context';
import { partnerIdForRequest } from '@/lib/partner-from-request';
import { seedOnboardingComplete } from './helpers-partner-onboarding';

const REQ = 'preq_GoLiveReq1';
const NEW_PID = partnerIdForRequest(REQ);
const REQ_EMAIL = 'ops@acme-remit.test';
const REASON = 'Licence and AML documents reviewed';

const invites = () => createStaffInviteStore(redis);
const auditRows = (action?: string) =>
  action
    ? db.select().from(auditEvents).where(eq(auditEvents.action, action)).orderBy(auditEvents.id)
    : db.select().from(auditEvents).orderBy(auditEvents.id);
const emailRows = () => db.select().from(outbox).where(eq(outbox.kind, 'email.send')).orderBy(outbox.id);
const goLiveRows = () => db.select().from(partnerGoLive).orderBy(partnerGoLive.partnerId);
const partnerRows = () => db.select({ id: partners.id }).from(partners).orderBy(partners.id);
const inviteKeys = () => [...redis.dump.keys()].filter((k) => k.startsWith('staffinvite')).sort();

function configureSmtp(): void {
  vi.stubEnv('SMTP_HOST', 'smtp.example.test');
  vi.stubEnv('SMTP_USER', 'mailer@example.test');
  vi.stubEnv('SMTP_PASS', 'not-a-real-password');
}

async function asPlatformAdmin() {
  return signInAs(redis, cookieJar, { username: 'root', role: 'admin', partnerId: undefined });
}
async function asPartnerAdmin() {
  return signInAs(redis, cookieJar, { username: 'pa-owner', role: 'admin', partnerId: 'pa' });
}

async function run(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (m.startsWith('REDIRECT:')) return m.slice('REDIRECT:'.length);
    throw e;
  }
  throw new Error('expected a redirect');
}

function goLiveForm(id: string, reason = REASON): FormData {
  const f = new FormData();
  f.set('id', id);
  f.set('reason', reason);
  return f;
}

function createForm(o: Record<string, string> = {}): FormData {
  const f = new FormData();
  const v = { id: REQ, reason: REASON, username: 'acme-owner', name: 'Acme Owner', ...o };
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
}

async function setRequestStatus(status: string) {
  await db.execute(sql`UPDATE partner_requests SET application_status = ${status} WHERE id = ${REQ}`);
}

beforeEach(async () => {
  redis.dump.clear();
  for (const k of [...redis.sets.keys()]) await redis.del(k);
  cookieJar.clear();
  pokeWorkerMock.mockReset();
  failEnqueue.on = false;
  throwAfterCommit.on = false;
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await db.execute(sql`TRUNCATE partner_requests, partner_applications RESTART IDENTITY CASCADE`);
  await seedTwoTenants(db);
  await createPartnerRequestRepo(db).savePartnerRequest({
    id: REQ,
    companyName: 'Acme Remit',
    email: REQ_EMAIL,
    phone: '+1 555 0100',
    corridors: ['CA', 'IN', 'GB'],
    capturedAt: new Date().toISOString(),
  });
  await setRequestStatus('approved');
  configureSmtp();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ── approveGoLiveAction ──────────────────────────────────────────────────────
describe('approveGoLiveAction', () => {
  it('anonymous → /login; a partner admin (even of the same tenant) → /admin-dashboard, nothing written', async () => {
    await requestGoLive(db, 'pa', 'pa-owner');
    const before = JSON.stringify([await goLiveRows(), await auditRows()]);
    expect(await run(approveGoLiveAction(goLiveForm('pa')))).toBe('/login');
    await asPartnerAdmin();
    expect(await run(approveGoLiveAction(goLiveForm('pa')))).toBe('/admin-dashboard');
    await signInAs(redis, cookieJar, { username: 'plat-agent', role: 'agent', partnerId: undefined });
    expect(await run(approveGoLiveAction(goLiveForm('pa')))).toBe('/admin-dashboard');
    expect(JSON.stringify([await goLiveRows(), await auditRows()])).toBe(before);
    expect(await isLiveApproved(db, 'pa')).toBe(false);
  });

  it('approval without a request → refused (no row, a pending row), nothing written', async () => {
    await asPlatformAdmin();
    expect(await run(approveGoLiveAction(goLiveForm('pa')))).toBe('/admin-dashboard/partners/pa?golive=not_requested');
    await db.insert(partnerGoLive).values({ partnerId: 'pb' }); // an empty (pending) row
    expect(await run(approveGoLiveAction(goLiveForm('pb')))).toBe('/admin-dashboard/partners/pb?golive=not_requested');
    expect(await isLiveApproved(db, 'pa')).toBe(false);
    expect(await isLiveApproved(db, 'pb')).toBe(false);
    expect(await auditRows()).toEqual([]);
  });

  it('a reason under 10 characters → refused before any write', async () => {
    await requestGoLive(db, 'pa', 'pa-owner');
    await asPlatformAdmin();
    for (const r of ['', 'short']) {
      expect(await run(approveGoLiveAction(goLiveForm('pa', r)))).toBe('/admin-dashboard/partners/pa?golive=reason_required');
    }
    expect(await isLiveApproved(db, 'pa')).toBe(false);
    expect(await auditRows()).toEqual([]);
  });

  it('an unknown partner → not found', async () => {
    await asPlatformAdmin();
    await expect(approveGoLiveAction(goLiveForm('nope'))).rejects.toThrow('NOT_FOUND');
    await expect(approveGoLiveAction(goLiveForm(''))).rejects.toThrow('NOT_FOUND');
  });

  it('a requested go-live whose checklist (steps 1-6) is incomplete → refused, nothing written', async () => {
    for (const omit of ['whatsapp', 'templates', 'sandboxKey', 'sandboxTransfer', 'webhook', 'branding'] as const) {
      db = await freshDb();
      pgPartnerStore = createPartnerStore(db);
      await seedTwoTenants(db);
      redis.dump.clear();
      await seedOnboardingComplete(db, redis, 'pa', undefined, { omit: [omit] });
      await requestGoLive(db, 'pa', 'pa-owner');
      await asPlatformAdmin();
      expect(await run(approveGoLiveAction(goLiveForm('pa')))).toBe('/admin-dashboard/partners/pa?golive=incomplete');
      expect(await isLiveApproved(db, 'pa')).toBe(false);
      expect(await auditRows('partner.go_live.approve')).toEqual([]);
    }
  });

  it('a partner that is not active → refused even with a complete checklist and a request', async () => {
    await seedOnboardingComplete(db, redis, 'pa');
    await requestGoLive(db, 'pa', 'pa-owner');
    await db.update(partners).set({ status: 'suspended' }).where(eq(partners.id, 'pa'));
    await asPlatformAdmin();
    expect(await run(approveGoLiveAction(goLiveForm('pa')))).toBe('/admin-dashboard/partners/pa?golive=not_active');
    expect(await isLiveApproved(db, 'pa')).toBe(false);
    expect(await auditRows('partner.go_live.approve')).toEqual([]);
  });

  it('success: approves the requested go-live and writes ONE audit row {reason, actorScope}; a repeat is a no-op', async () => {
    await seedOnboardingComplete(db, redis, 'pa');
    await requestGoLive(db, 'pa', 'pa-owner');
    await requestGoLive(db, 'pb', 'pb-owner');
    await asPlatformAdmin();
    const f = goLiveForm('pa');
    f.set('partnerId', 'pb'); // forged fields are never read
    f.set('partner', 'pb');
    expect(await run(approveGoLiveAction(f))).toBe('/admin-dashboard/partners/pa?golive=approved');
    expect(await isLiveApproved(db, 'pa')).toBe(true);
    expect((await getGoLive(db, 'pa'))?.approvedBy).toBe('root');
    expect(await isLiveApproved(db, 'pb')).toBe(false);
    const rows = await auditRows('partner.go_live.approve');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'root', actorType: 'staff', subjectId: 'pa' });
    expect(rows[0].meta).toEqual({ reason: REASON, actorScope: 'platform' });

    expect(await run(approveGoLiveAction(goLiveForm('pa')))).toBe('/admin-dashboard/partners/pa?golive=already');
    expect(await auditRows('partner.go_live.approve')).toHaveLength(1);
  });
});

// ── createPartnerFromRequestAction ───────────────────────────────────────────
describe('createPartnerFromRequestAction', () => {
  const snapshot = async () =>
    JSON.stringify([await partnerRows(), await goLiveRows(), await auditRows(), await emailRows(), inviteKeys()]);

  it('anonymous → /login; a partner admin → /admin-dashboard, nothing written', async () => {
    const before = await snapshot();
    expect(await run(createPartnerFromRequestAction(createForm()))).toBe('/login');
    await asPartnerAdmin();
    expect(await run(createPartnerFromRequestAction(createForm()))).toBe('/admin-dashboard');
    expect(await snapshot()).toBe(before);
  });

  it('a request that is not approved → refused, nothing written', async () => {
    await asPlatformAdmin();
    const before = await snapshot();
    for (const s of ['invited', 'completed', 'rejected']) {
      await setRequestStatus(s);
      expect(await run(createPartnerFromRequestAction(createForm()))).toBe(`/admin-dashboard/partner-requests/${REQ}?create=not_approved`);
    }
    expect(await snapshot()).toBe(before);
  });

  it('an unknown or malformed request id → not found / refused', async () => {
    await asPlatformAdmin();
    await expect(createPartnerFromRequestAction(createForm({ id: 'preq_Nope' }))).rejects.toThrow('NOT_FOUND');
    await expect(createPartnerFromRequestAction(createForm({ id: "x' OR 1=1" }))).rejects.toThrow(/invalid/i);
  });

  it('invalid input (reason, username, name) and an unconfigured mailer → refused before any write', async () => {
    await asPlatformAdmin();
    const before = await snapshot();
    const page = `/admin-dashboard/partner-requests/${REQ}`;
    expect(await run(createPartnerFromRequestAction(createForm({ reason: 'short' })))).toBe(`${page}?create=reason_required`);
    expect(await run(createPartnerFromRequestAction(createForm({ username: 'Bad Name' })))).toBe(`${page}?create=invalid_username`);
    expect(await run(createPartnerFromRequestAction(createForm({ name: '' })))).toBe(`${page}?create=invalid_name`);
    await createAuthStore(redis).saveStaff({
      username: 'taken-name', name: 'T', role: 'agent', permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: 'x', createdAt: new Date().toISOString(), partnerId: 'pb',
    });
    const beforeTaken = await snapshot();
    expect(await run(createPartnerFromRequestAction(createForm({ username: 'taken-name' })))).toBe(`${page}?create=username_taken`);
    expect(await snapshot()).toBe(beforeTaken);
    vi.stubEnv('SMTP_HOST', '');
    expect(await run(createPartnerFromRequestAction(createForm()))).toBe(`${page}?create=unconfigured`);
    configureSmtp();
    expect(JSON.stringify(JSON.parse(await snapshot()).slice(0, 4))).toBe(JSON.stringify(JSON.parse(before).slice(0, 4)));
  });

  it('success → one partner, one admin invite, one sealed email, one go-live row NOT approved, no API key', async () => {
    await asPlatformAdmin();
    const f = createForm();
    f.set('email', 'attacker@evil.test'); // the recipient is the request's address, never a form field
    f.set('partnerId', 'pa');
    expect(await run(createPartnerFromRequestAction(f))).toBe(`/admin-dashboard/partner-requests/${REQ}?create=created`);

    // One partner, from the request (wizard defaults), active.
    const created = (await partnerRows()).map((r) => r.id).filter((id) => id !== 'pa' && id !== 'pb' && id !== 'default');
    expect(created).toEqual([NEW_PID]);
    const p = await pgPartnerStore.getPartner(NEW_PID);
    expect(p).toMatchObject({ name: 'Acme Remit', countries: ['CA', 'GB'], status: 'active', kycMode: 'ours' });

    // One go-live row, NOT approved (and not requested).
    const gl = await getGoLive(db, NEW_PID);
    expect(gl).not.toBeNull();
    expect(gl?.approvedAt).toBeNull();
    expect(gl?.requestedAt).toBeNull();
    expect(await isLiveApproved(db, NEW_PID)).toBe(false);

    // No key of any kind (the go-live gate).
    expect(await db.select().from(apiKeys).where(eq(apiKeys.partnerId, NEW_PID))).toEqual([]);

    // One invite, role admin, into the NEW tenant, from the platform admin.
    const pending = await invites().listForPartner(NEW_PID);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ partnerId: NEW_PID, username: 'acme-owner', name: 'Acme Owner', role: 'admin', invitedBy: 'root' });
    expect(await invites().listForPartner('pa')).toEqual([]);

    // One email, to the request's address, the link sealed (never in the text).
    const mails = await emailRows();
    expect(mails).toHaveLength(1);
    const payload = mails[0].payload as { to: string[]; text: string; sealed: Record<string, string> };
    expect(payload.to).toEqual([REQ_EMAIL]);
    expect(payload.text).not.toMatch(/\/partner\/invite\//);
    const link = decryptField(payload.sealed.staff_invite_link, undefined, outboxSealedCtx('staff_invite_link'));
    expect(link).toMatch(/\/partner\/invite\/[A-Za-z0-9_-]{43}$/);
    const token = link.slice(link.lastIndexOf('/') + 1);
    const inv = await invites().peek(token);
    expect(inv).toMatchObject({ partnerId: NEW_PID, role: 'admin' });
    // The invite is redeemable end to end (the M3-9 accept re-checks, real deps).
    const auth = createAuthStore(redis);
    expect(await inviteRedeemable(inv!, { getPartner: (id) => pgPartnerStore.getPartner(id), getStaff: (u) => auth.getStaff(u), seedName: 'admin' })).toBe(true);
    expect(pokeWorkerMock).toHaveBeenCalled();

    // Audits: partner.create_from_request + staff.invite.create, platform-scoped, no email anywhere.
    const createRows = await auditRows('partner.create_from_request');
    expect(createRows).toHaveLength(1);
    expect(createRows[0]).toMatchObject({ partnerId: NEW_PID, actor: 'root', actorType: 'staff', subjectId: REQ });
    expect(createRows[0].meta).toEqual({ reason: REASON, requestId: REQ, actorScope: 'platform' });
    const inviteRows = await auditRows('staff.invite.create');
    expect(inviteRows).toHaveLength(1);
    expect(inviteRows[0]).toMatchObject({ partnerId: NEW_PID, actor: 'root', subjectId: pending[0].id });
    expect(inviteRows[0].meta).toEqual({ username: 'acme-owner', role: 'admin', actorScope: 'platform' });
    expect(JSON.stringify(await auditRows())).not.toContain(REQ_EMAIL);
    expect(JSON.stringify(await auditRows())).not.toContain(token);
  });

  it('double submit (sequential and concurrent) → still ONE partner, ONE invite, ONE email', async () => {
    await asPlatformAdmin();
    expect(await run(createPartnerFromRequestAction(createForm()))).toBe(`/admin-dashboard/partner-requests/${REQ}?create=created`);
    expect(await run(createPartnerFromRequestAction(createForm({ username: 'acme-owner2' })))).toBe(
      `/admin-dashboard/partner-requests/${REQ}?create=exists`,
    );
    const outcomes = await Promise.all([
      run(createPartnerFromRequestAction(createForm({ username: 'acme-owner3' }))),
      run(createPartnerFromRequestAction(createForm({ username: 'acme-owner4' }))),
    ]);
    expect(outcomes.every((o) => o.endsWith('?create=exists'))).toBe(true);
    expect((await partnerRows()).filter((r) => r.id === NEW_PID)).toHaveLength(1);
    expect(await invites().listForPartner(NEW_PID)).toHaveLength(1);
    expect(await emailRows()).toHaveLength(1);
    expect(await auditRows('partner.create_from_request')).toHaveLength(1);
  });

  it('a concurrent first submit → exactly one partner and one live invite (the loser revokes its invite)', async () => {
    await asPlatformAdmin();
    const outcomes = await Promise.all([
      run(createPartnerFromRequestAction(createForm({ username: 'race-one' }))),
      run(createPartnerFromRequestAction(createForm({ username: 'race-two' }))),
    ]);
    expect(outcomes.filter((o) => o.endsWith('?create=created'))).toHaveLength(1);
    expect((await partnerRows()).filter((r) => r.id === NEW_PID)).toHaveLength(1);
    expect(await invites().listForPartner(NEW_PID)).toHaveLength(1);
    expect(await emailRows()).toHaveLength(1);
  });

  it('a failed commit rolls everything back and revokes the minted invite (no live link left)', async () => {
    await asPlatformAdmin();
    failEnqueue.on = true;
    expect(await run(createPartnerFromRequestAction(createForm()))).toBe(`/admin-dashboard/partner-requests/${REQ}?create=failed`);
    expect(await pgPartnerStore.getPartner(NEW_PID)).toBeNull();
    expect(await getGoLive(db, NEW_PID)).toBeNull();
    expect(await emailRows()).toEqual([]);
    expect(await auditRows()).toEqual([]);
    expect(await invites().listForPartner(NEW_PID)).toEqual([]);
    expect(inviteKeys().filter((k) => k.startsWith('staffinvite:'))).toEqual([]);
    expect(pokeWorkerMock).not.toHaveBeenCalled();
    // A retry then succeeds.
    failEnqueue.on = false;
    expect(await run(createPartnerFromRequestAction(createForm()))).toBe(`/admin-dashboard/partner-requests/${REQ}?create=created`);
  });

  it('an error AFTER the commit keeps the committed partner and its already-emailed invite (no revoke)', async () => {
    await asPlatformAdmin();
    throwAfterCommit.on = true;
    const out = await run(createPartnerFromRequestAction(createForm()));
    throwAfterCommit.on = false;
    expect(out).toBe(`/admin-dashboard/partner-requests/${REQ}?create=created`);
    expect(await pgPartnerStore.getPartner(NEW_PID)).not.toBeNull();
    expect(await emailRows()).toHaveLength(1);
    // The emailed link still works: the invite was NOT revoked.
    const payload = (await emailRows())[0].payload as { sealed: Record<string, string> };
    const link = decryptField(payload.sealed.staff_invite_link, undefined, outboxSealedCtx('staff_invite_link'));
    expect(await invites().peek(link.slice(link.lastIndexOf('/') + 1))).not.toBeNull();
    expect(await invites().listForPartner(NEW_PID)).toHaveLength(1);
  });
});

// Review fix: the wizard (?fromRequest=) and the create card must never both create a partner.
describe('wizard fromRequest + create-from-request: one partner per request', () => {
  const wizard = (o: Partial<Parameters<typeof wizardCreatePartnerAction>[0]> = {}) =>
    wizardCreatePartnerAction({ name: 'Acme Remit', countries: ['CA'], fromRequest: REQ, ...o });
  const fromRequestPartners = async () => (await partnerRows()).filter((r) => r.id === NEW_PID);

  it('create-from-request first, then the wizard for the same request → refused, still one partner', async () => {
    await asPlatformAdmin();
    expect(await run(createPartnerFromRequestAction(createForm()))).toBe(`/admin-dashboard/partner-requests/${REQ}?create=created`);
    const before = (await partnerRows()).length;
    await expect(wizard()).rejects.toThrow(/already/i);
    expect((await partnerRows()).length).toBe(before);
    expect(await fromRequestPartners()).toHaveLength(1);
    expect(await db.select().from(apiKeys).where(eq(apiKeys.partnerId, NEW_PID))).toEqual([]);
  });

  it('the wizard first (it uses the request-derived id), then create-from-request → exists, no invite', async () => {
    await asPlatformAdmin();
    const r = await wizard();
    expect(r.id).toBe(NEW_PID);
    expect(await isLiveApproved(db, NEW_PID)).toBe(true); // a wizard partner is approved at creation
    expect(await run(createPartnerFromRequestAction(createForm()))).toBe(`/admin-dashboard/partner-requests/${REQ}?create=exists`);
    expect(await fromRequestPartners()).toHaveLength(1);
    expect(await invites().listForPartner(NEW_PID)).toEqual([]);
    expect(await emailRows()).toEqual([]);
    await expect(wizard()).rejects.toThrow(/already/i); // a second wizard run too
  });

  it('a wizard fromRequest that is malformed, unknown or not approved → refused, nothing written', async () => {
    await asPlatformAdmin();
    const before = (await partnerRows()).length;
    await expect(wizard({ fromRequest: "x' OR 1=1" })).rejects.toThrow(/request/i);
    await expect(wizard({ fromRequest: 'preq_Unknown' })).rejects.toThrow(/request/i);
    await setRequestStatus('completed');
    await expect(wizard()).rejects.toThrow(/request/i);
    expect((await partnerRows()).length).toBe(before);
  });

  it('a wizard WITHOUT fromRequest is unchanged (a fresh random id every time)', async () => {
    await asPlatformAdmin();
    const a = await wizardCreatePartnerAction({ name: 'Plain A', countries: ['US'] });
    const b = await wizardCreatePartnerAction({ name: 'Plain B', countries: ['US'] });
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe(NEW_PID);
  });
});
