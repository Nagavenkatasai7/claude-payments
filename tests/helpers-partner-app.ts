import { expect } from 'vitest';
import { desc } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditEvents } from '@/db/schema';
import { createAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import type { RedisLike } from '@/lib/store';
import type { Staff, StaffRole, Transfer } from '@/lib/types';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { seedPartner } from './helpers-db';

// helpers-partner-app (UI redesign M3-5, Task 5.0): the SHARED harness for every /partner server
// action test. The caller's test file still repeats the vi.mock block (next/headers cookies backed
// by `cookieJar`, next/navigation redirect → throw 'REDIRECT:<path>', @/lib/redis, @/lib/auth-store
// on the same fake Redis): vi.mock is hoisted per file.

const PERMS = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };

/** Save a staff record and set its session cookie in `cookieJar`. */
export async function signInAs(redis: RedisLike, cookieJar: Map<string, string>, o: Partial<Staff>): Promise<Staff> {
  const store = createAuthStore(redis);
  const s: Staff = {
    username: 'u1',
    name: 'U',
    role: 'admin',
    permissions: PERMS,
    passwordHash: 'x',
    createdAt: new Date().toISOString(),
    ...o,
  };
  await store.saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await store.createSession(s.username));
  return s;
}

/** Partners A ('pa') and B ('pb'). Call after freshDb(). */
export async function seedTwoTenants(db: Db): Promise<void> {
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
}

export interface PartnerActionContract {
  db: Db;
  redis: RedisLike;
  cookieJar: Map<string, string>;
  action: (fd: FormData) => Promise<unknown>;
  /** A valid form targeting `id` (the helper appends the forged tenant fields itself). */
  form: (id: string) => FormData;
  ownId: string;
  foreignId: string;
  allowedRole: StaffRole;
  disallowedRole: StaffRole;
  /** Everything the action could change (rows, counts); compared before and after each refusal. */
  snapshot: () => Promise<unknown>;
}

async function latestAudit(db: Db) {
  const rows = await db.select().from(auditEvents).orderBy(desc(auditEvents.id)).limit(1);
  return rows[0] ?? null;
}

/**
 * The per-action checklist items 1–4 (plus the tenant half of 6) against a real session:
 *  1. anonymous → /login; a platform account → /admin-dashboard;
 *  2. a disallowed role → /partner, nothing changed;
 *  3. partner A acting on B's id → { ok: false }, nothing changed;
 *  4. a form forging partnerId=pb / partner=pb on A's own id → acts on A only.
 */
export async function expectPartnerActionContract(o: PartnerActionContract): Promise<void> {
  // 1. anonymous
  o.cookieJar.clear();
  await expect(o.action(o.form(o.ownId))).rejects.toThrow('REDIRECT:/login');
  // 1b. platform (no partnerId)
  await signInAs(o.redis, o.cookieJar, { username: 'contract-platform', partnerId: undefined, role: 'admin' });
  await expect(o.action(o.form(o.ownId))).rejects.toThrow('REDIRECT:/admin-dashboard');

  // 2. disallowed role
  const before = JSON.stringify(await o.snapshot());
  await signInAs(o.redis, o.cookieJar, { username: 'contract-denied', partnerId: 'pa', role: o.disallowedRole });
  await expect(o.action(o.form(o.ownId))).rejects.toThrow('REDIRECT:/partner');
  expect(JSON.stringify(await o.snapshot())).toBe(before);

  // 3. foreign id (another tenant's row) → the not-found result, nothing written
  await signInAs(o.redis, o.cookieJar, { username: 'contract-allowed', partnerId: 'pa', role: o.allowedRole });
  const auditBefore = await latestAudit(o.db);
  const foreign = (await o.action(o.form(o.foreignId))) as { ok?: boolean };
  expect(foreign.ok).toBe(false);
  expect(JSON.stringify(await o.snapshot())).toBe(before);
  expect((await latestAudit(o.db))?.id ?? null).toBe(auditBefore?.id ?? null);

  // 4. forged tenant fields on A's own id → the write lands on A only
  const fd = o.form(o.ownId);
  fd.append('partnerId', 'pb');
  fd.append('partner', 'pb');
  const own = (await o.action(fd)) as { ok?: boolean };
  expect(own.ok).toBe(true);
  const row = await latestAudit(o.db);
  expect(row).not.toBeNull();
  expect(row!.partnerId).toBe('pa');
  expect(row!.actor).toBe('contract-allowed');
  expect(JSON.stringify(row)).not.toContain('"pb"');
}

/**
 * Seed one transfer for a tenant through the real repo (sealed columns, masked reads). The
 * defaults carry distinctive PII so a page test can assert none of it reaches the HTML.
 */
export async function seedPartnerTransfer(db: Db, o: Partial<Transfer> & { id: string; partnerId: string }): Promise<Transfer> {
  const t: Transfer = {
    phone: '14155550101',
    amountUsd: 100,
    feeUsd: 2,
    totalChargeUsd: 102,
    fxRate: 85,
    amountInr: 8500,
    recipientName: 'Testname Samplesurname',
    recipientPhone: '919876543210',
    payoutMethod: 'bank',
    payoutDestination: '000011112222|HDFC0001111',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'paid',
    createdAt: new Date().toISOString(),
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    amountSource: 100,
    feeSource: 2,
    totalChargeSource: 102,
    ...o,
  };
  await createTransferRepo(db).saveTransfer(t);
  return t;
}
