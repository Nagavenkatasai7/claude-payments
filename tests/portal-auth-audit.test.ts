import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { auditEvents, partners } from '@/db/schema';
import type { Db } from '@/db/client';
import {
  recordPortalAuthEvent,
  recordPortalAuthEventSafe,
  PORTAL_AUTH_ACTOR,
  type PortalAuthEvent,
} from '@/lib/portal-auth-audit';
import { auditSubjectId } from '@/lib/customer-ref';

// Fictitious number (555-01xx; the repository is public). The stored/audited form is
// the normalized one (digits only), which is what every existing auditSubjectId caller passes.
const PHONE = '+1 415 555 0101';
const DIGITS = '14155550101';

describe('recordPortalAuthEvent', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await db.insert(partners).values([{ id: 'pa', name: 'A' }, { id: 'pb', name: 'B' }]);
  });

  it('writes portal.auth.<event> keyed to the HMAC subject, never the phone', async () => {
    await recordPortalAuthEvent(db, { partnerId: 'pa', phone: PHONE, event: 'login_failure', meta: { reason: 'wrong' } });
    const [row] = await db.select().from(auditEvents).where(eq(auditEvents.action, 'portal.auth.login_failure'));
    expect(row.partnerId).toBe('pa');
    expect(row.actor).toBe('system:customer-portal');
    expect(PORTAL_AUTH_ACTOR).toBe('system:customer-portal');
    expect(row.actorType).toBe('system');
    expect(row.subjectId).toBe(auditSubjectId('pa', DIGITS));
    expect(row.meta).toEqual({ reason: 'wrong' });
    expect(JSON.stringify(row)).not.toContain('4155550101');
  });

  it('the subject is tenant-bound: the same phone under two partners gives two subjects', async () => {
    await recordPortalAuthEvent(db, { partnerId: 'pa', phone: PHONE, event: 'otp_sent' });
    await recordPortalAuthEvent(db, { partnerId: 'pb', phone: PHONE, event: 'otp_sent' });
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.action, 'portal.auth.otp_sent'));
    expect(rows).toHaveLength(2);
    const byPartner = Object.fromEntries(rows.map((r) => [r.partnerId, r.subjectId]));
    expect(byPartner.pa).toBe(auditSubjectId('pa', DIGITS));
    expect(byPartner.pb).toBe(auditSubjectId('pb', DIGITS));
    expect(byPartner.pa).not.toBe(byPartner.pb);
  });

  it('records the first-sign-in consent (owner O11) as portal.auth.consent', async () => {
    await recordPortalAuthEvent(db, { partnerId: 'pa', phone: PHONE, event: 'consent', meta: { whatsapp: true, terms: true } });
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.action, 'portal.auth.consent'));
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({ whatsapp: true, terms: true });
  });

  it('writes no meta column when none is given', async () => {
    await recordPortalAuthEvent(db, { partnerId: 'pa', phone: PHONE, event: 'signout' });
    const [row] = await db.select().from(auditEvents).where(eq(auditEvents.action, 'portal.auth.signout'));
    expect(row.meta).toBeNull();
  });

  it.each(['phone', 'code', 'otp', 'ip', 'email', 'Phone', 'EMAIL'])('refuses a meta key named %s (and writes nothing)', async (k) => {
    await expect(
      recordPortalAuthEvent(db, { partnerId: 'pa', phone: PHONE, event: 'otp_sent', meta: { [k]: 'x' } }),
    ).rejects.toThrow();
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });

  it('refuses a meta value that carries the phone', async () => {
    await expect(
      recordPortalAuthEvent(db, { partnerId: 'pa', phone: PHONE, event: 'otp_refused', meta: { note: 'to 1-415-555-0101' } }),
    ).rejects.toThrow();
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });

  it('refuses a non-primitive meta value, an unknown event and an empty phone', async () => {
    await expect(
      recordPortalAuthEvent(db, {
        partnerId: 'pa',
        phone: PHONE,
        event: 'otp_sent',
        meta: { nested: { phone: DIGITS } } as unknown as Record<string, string>,
      }),
    ).rejects.toThrow();
    await expect(
      recordPortalAuthEvent(db, { partnerId: 'pa', phone: PHONE, event: 'bogus' as PortalAuthEvent }),
    ).rejects.toThrow();
    await expect(recordPortalAuthEvent(db, { partnerId: 'pa', phone: '', event: 'otp_sent' })).rejects.toThrow();
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });

  it('the Safe variant writes the same row', async () => {
    await recordPortalAuthEventSafe(db, { partnerId: 'pa', phone: PHONE, event: 'login_success' });
    const [row] = await db.select().from(auditEvents).where(eq(auditEvents.action, 'portal.auth.login_success'));
    expect(row.subjectId).toBe(auditSubjectId('pa', DIGITS));
  });
});

describe('recordPortalAuthEventSafe never throws and never leaks', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());
  const logged = () => [...warn.mock.calls, ...error.mock.calls].map((c) => JSON.stringify(c)).join(' ');

  it('swallows a DB error and logs a fixed message (no phone, no meta value, no driver text)', async () => {
    const db = {
      insert: () => ({
        values: () => Promise.reject(new Error(`insert failed params: ${DIGITS} secret-meta-value`)),
      }),
    } as unknown as Db;
    await expect(
      recordPortalAuthEventSafe(db, { partnerId: 'pa', phone: PHONE, event: 'login_failure', meta: { reason: 'secret-meta-value' } }),
    ).resolves.toBeUndefined();
    const out = logged();
    expect(out).toContain('portal.auth_audit');
    expect(out).not.toContain('4155550101');
    expect(out).not.toContain('secret-meta-value');
  });

  it('is time-bounded: a hanging DB write resolves after the deadline', async () => {
    const db = { insert: () => ({ values: () => new Promise(() => {}) }) } as unknown as Db;
    const t0 = Date.now();
    await expect(
      recordPortalAuthEventSafe(db, { partnerId: 'pa', phone: PHONE, event: 'otp_sent' }, { timeoutMs: 20 }),
    ).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(logged()).toContain('portal.auth_audit');
    expect(logged()).not.toContain('4155550101');
  });

  it('swallows a guard refusal too (a forbidden key never changes the login response)', async () => {
    const db = { insert: () => ({ values: () => Promise.resolve() }) } as unknown as Db;
    await expect(
      recordPortalAuthEventSafe(db, { partnerId: 'pa', phone: PHONE, event: 'otp_sent', meta: { phone: DIGITS } }),
    ).resolves.toBeUndefined();
    expect(logged()).not.toContain('4155550101');
  });
});
