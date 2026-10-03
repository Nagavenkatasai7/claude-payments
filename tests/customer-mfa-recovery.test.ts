/**
 * lost-features p4 B4 (with the review's BL-3 hardening): the lost-authenticator recovery core.
 * A customer who proved their phone opens ONE fixed-category ticket; staff approve (after an ID
 * document check, or a confirmed recent transfer plus a 24-hour wait) or decline. The approval
 * clears the factor, resolves the ticket and writes the audit rows and the notices in one
 * transaction, then signs the customer out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { auditEvents, outbox, tickets } from '@/db/schema';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { EnvKeyProvider, encryptField } from '@/lib/field-crypto';
import { customerEmailCtx } from '@/lib/crypto-context';
import { emailVerifiedTag, markEmailVerified } from '@/lib/portal-prefs';
import { customerMfaKeys } from '@/lib/customer-mfa';
import { MFA_RECOVERY_CATEGORY } from '@/lib/ticket-category';
import type { Db } from '@/db/client';
import type { Customer, Ticket } from '@/lib/types';

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
vi.mock('@/lib/field-crypto', async () => {
  const actual = await vi.importActual<typeof import('@/lib/field-crypto')>('@/lib/field-crypto');
  return { ...actual, defaultProvider: () => provider };
});

import {
  MFA_RECOVERY_BODY,
  MFA_RECOVERY_SUBJECT,
  RECOVERY_COOL_OFF_MS,
  RECOVERY_DAILY_CAP,
  approveMfaRecovery,
  declineMfaRecovery,
  isRecoveryTicket,
  openMfaRecoveryRequest,
  parseDeclineReason,
  parseRecoveryChecks,
  recoveryApprovableAt,
  recoveryTimeLabel,
  type RecoveryDeps,
} from '@/lib/customer-mfa-recovery';

const PID = 'pa';
const PHONE = '15550004321';
const WHO = { partnerId: PID, phone: PHONE };
const redis = fakeRedis();
let db: Db;
let clock: number;
let deps: RecoveryDeps;
let revokedPortal: Array<[string, string]>;
let revokedLegacy: string[];
let pokes: number;

const customers = () => createCustomerRepo(db, async () => null, provider);

function customer(partnerId = PID, email?: string): Customer {
  const now = '2026-09-01T00:00:00.000Z';
  return {
    senderPhone: PHONE,
    partnerId,
    firstSeenAt: now,
    kycStatus: 'not_started',
    senderCountry: 'US',
    createdAt: now,
    updatedAt: now,
    ...(email ? { email: encryptField(email, provider, customerEmailCtx({ partnerId, senderPhone: PHONE })) } : {}),
  } as Customer;
}

async function enrolled(partnerId = PID, email?: string): Promise<void> {
  await customers().saveCustomer(customer(partnerId, email));
  expect(await customers().enableMfa(partnerId, PHONE, 'JBSWY3DPEHPK3PXP')).toBe(true);
}

async function rows<T extends typeof outbox | typeof auditEvents | typeof tickets>(table: T) {
  return (await db.select().from(table as typeof outbox)) as unknown[];
}
const outboxRows = async () => (await db.select().from(outbox)).map((r) => ({ kind: r.kind, dedupeKey: r.dedupeKey, payload: r.payload as Record<string, unknown> }));
const auditRows = async (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));
const recoveryTickets = async (partnerId = PID) =>
  db.select().from(tickets).where(and(eq(tickets.partnerId, partnerId), eq(tickets.category, MFA_RECOVERY_CATEGORY)));

async function openTicket(): Promise<Ticket> {
  expect(await openMfaRecoveryRequest({ ...WHO, via: 'portal' }, deps)).toBe('opened');
  const [row] = await recoveryTickets();
  return (await createTicketRepo(db).getTicket(row.id))!;
}

const PLATFORM = { username: 'ops.admin', scope: 'platform' as const };
const PARTNER = { username: 'pa.admin', scope: 'partner' as const };

beforeEach(async () => {
  redis.dump.clear();
  db = await freshDb();
  await seedPartner(db, PID);
  await seedPartner(db, 'pb');
  clock = Date.now();
  revokedPortal = [];
  revokedLegacy = [];
  pokes = 0;
  deps = {
    db,
    redis,
    now: () => clock,
    isEnrolled: (k) => customers().isMfaEnrolled(k.partnerId, k.phone),
    poke: () => {
      pokes++;
    },
    revokePortalSessions: async (p, phone) => {
      revokedPortal.push([p, phone]);
      return 1;
    },
    revokeLegacySessions: async (phone) => {
      revokedLegacy.push(phone);
    },
  };
});

describe('pure rules', () => {
  it('parseRecoveryChecks keeps known values once and needs an ID document or a recent transfer', () => {
    expect(parseRecoveryChecks(['recent_transfer', 'recent_transfer', 'bogus', 7])).toEqual(['recent_transfer']);
    expect(parseRecoveryChecks(['callback', 'id_document', 'kyc_name'])).toEqual(['id_document', 'kyc_name', 'callback']);
    expect(parseRecoveryChecks(['kyc_name', 'callback'])).toBeNull();
    expect(parseRecoveryChecks([])).toBeNull();
  });

  it('the 24-hour wait applies unless an ID document was checked', () => {
    const at = '2026-10-01T10:00:00.000Z';
    expect(recoveryApprovableAt(at, ['id_document'])).toBe(Date.parse(at));
    expect(recoveryApprovableAt(at, ['recent_transfer', 'kyc_name'])).toBe(Date.parse(at) + RECOVERY_COOL_OFF_MS);
    expect(RECOVERY_COOL_OFF_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('recoveryTimeLabel is a fixed UTC label (the server and every viewer agree)', () => {
    expect(recoveryTimeLabel(Date.parse('2026-10-03T14:05:00.000Z'))).toBe('Oct 3, 2026, 2:05 PM UTC');
  });

  it('parseDeclineReason accepts the closed list only', () => {
    expect(parseDeclineReason('not_verified')).toBe('not_verified');
    expect(parseDeclineReason('no_response')).toBe('no_response');
    expect(parseDeclineReason('duplicate')).toBe('duplicate');
    expect(parseDeclineReason('because')).toBeNull();
    expect(parseDeclineReason(null)).toBeNull();
  });

  it('isRecoveryTicket is the category on a customer ticket', () => {
    expect(isRecoveryTicket({ kind: 'customer', category: MFA_RECOVERY_CATEGORY })).toBe(true);
    expect(isRecoveryTicket({ kind: 'customer', category: 'billing' })).toBe(false);
    expect(isRecoveryTicket({ kind: 'customer' })).toBe(false);
    expect(isRecoveryTicket({ kind: 'internal', category: MFA_RECOVERY_CATEGORY })).toBe(false);
  });
});

describe('openMfaRecoveryRequest', () => {
  it('not enrolled: nothing is written', async () => {
    await customers().saveCustomer(customer());
    expect(await openMfaRecoveryRequest({ ...WHO, via: 'portal' }, deps)).toBe('not_enrolled');
    expect(await rows(tickets)).toHaveLength(0);
    expect(await rows(outbox)).toHaveLength(0);
    expect(await rows(auditEvents)).toHaveLength(0);
  });

  it('enrolled: one urgent fixed ticket, one keyed audit row, one WhatsApp notice, no AI triage', async () => {
    await enrolled();
    expect(await openMfaRecoveryRequest({ ...WHO, via: 'account' }, deps)).toBe('opened');
    const [t] = await recoveryTickets();
    expect(t).toMatchObject({ kind: 'customer', partnerId: PID, customerPhone: PHONE, subject: MFA_RECOVERY_SUBJECT, priority: 'urgent', status: 'open' });
    expect(t.id).toMatch(/^tk_/);
    const msgs = await createTicketRepo(db).listMessages(t.id, { includeInternal: true });
    expect(msgs.map((m) => m.body)).toEqual([MFA_RECOVERY_BODY]);

    const audit = await auditRows('customer.mfa.recovery.request');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ partnerId: PID, actorType: 'system', actor: 'customer-portal' });
    expect(audit[0].subjectId).toMatch(/^cust:[0-9a-f]{64}$/);
    expect(audit[0].meta).toEqual({ ticketId: t.id, via: 'account' });
    expect(JSON.stringify(audit[0])).not.toContain(PHONE);

    const out = await outboxRows();
    expect(out.map((o) => o.kind)).toEqual(['whatsapp.text']);
    expect(out[0].dedupeKey).toBe(`mfarecreq:${t.id}`);
    expect(out[0].payload).toMatchObject({ to: PHONE, partnerId: PID, category: 'essential' });
    expect(pokes).toBe(1);
  });

  it('the portal request is audited under the portal actor', async () => {
    await enrolled();
    await openTicket();
    expect((await auditRows('customer.mfa.recovery.request'))[0].actor).toBe('system:customer-portal');
  });

  it('a verified email on file gets the notice too; an unverified one does not', async () => {
    await enrolled(PID, 'cust@example.com');
    await markEmailVerified(db, PID, PHONE, emailVerifiedTag(PID, PHONE, 'cust@example.com'));
    const t = await openTicket();
    const mail = (await outboxRows()).filter((o) => o.kind === 'email.send');
    expect(mail).toHaveLength(1);
    expect(mail[0].dedupeKey).toBe(`mfarecreqmail:${t.id}`);
    expect(mail[0].payload.to).toEqual(['cust@example.com']);

    // Unverified (the tag is for another address): no email.
    await enrolled('pb', 'other@example.com');
    await markEmailVerified(db, 'pb', PHONE, emailVerifiedTag('pb', PHONE, 'old@example.com'));
    expect(await openMfaRecoveryRequest({ partnerId: 'pb', phone: PHONE, via: 'portal' }, deps)).toBe('opened');
    expect((await outboxRows()).filter((o) => o.kind === 'email.send')).toHaveLength(1);
  });

  it('a repeat while one is open reuses it: no second ticket, no second notice', async () => {
    await enrolled();
    await openTicket();
    expect(await openMfaRecoveryRequest({ ...WHO, via: 'portal' }, deps)).toBe('already_open');
    expect(await recoveryTickets()).toHaveLength(1);
    expect(await outboxRows()).toHaveLength(1);
    expect(await auditRows('customer.mfa.recovery.request')).toHaveLength(1);
  });

  it('two concurrent requests open one ticket', async () => {
    await enrolled();
    const out = await Promise.all([
      openMfaRecoveryRequest({ ...WHO, via: 'portal' }, deps),
      openMfaRecoveryRequest({ ...WHO, via: 'portal' }, deps),
    ]);
    expect(out.sort()).toEqual(['already_open', 'opened']);
    expect(await recoveryTickets()).toHaveLength(1);
  });

  it('the same phone at another tenant is a separate customer', async () => {
    await enrolled();
    await enrolled('pb');
    await openTicket();
    expect(await openMfaRecoveryRequest({ partnerId: 'pb', phone: PHONE, via: 'portal' }, deps)).toBe('opened');
    expect(await recoveryTickets('pb')).toHaveLength(1);
  });

  it(`at most ${RECOVERY_DAILY_CAP} requests per customer per day`, async () => {
    await enrolled();
    for (let i = 0; i < RECOVERY_DAILY_CAP; i++) {
      const t = await openTicket();
      expect(await declineMfaRecovery(t, PLATFORM, 'not_verified', deps)).toBe('declined');
    }
    expect(await openMfaRecoveryRequest({ ...WHO, via: 'portal' }, deps)).toBe('limited');
    expect(await recoveryTickets()).toHaveLength(RECOVERY_DAILY_CAP);
    clock += 24 * 60 * 60 * 1000;
    expect(await openMfaRecoveryRequest({ ...WHO, via: 'portal' }, deps)).toBe('opened');
  });
});

describe('approveMfaRecovery', () => {
  it('clears the factor, resolves the ticket, writes both audit rows and the notice, then signs the customer out', async () => {
    await enrolled();
    const t = await openTicket();
    await redis.set(customerMfaKeys.last(WHO), '123');
    expect(await approveMfaRecovery(t, PLATFORM, ['id_document', 'kyc_name'], deps)).toBe('approved');

    expect(await customers().isMfaEnrolled(PID, PHONE)).toBe(false);
    expect((await createTicketRepo(db).getTicket(t.id))!.status).toBe('resolved');
    const msgs = await createTicketRepo(db).listMessages(t.id, { includeInternal: true });
    expect(msgs.filter((m) => m.internal).map((m) => m.actorType)).toEqual(['system']);
    expect(msgs.filter((m) => m.internal)[0].body).toContain('ops.admin');
    expect(msgs.filter((m) => !m.internal && m.actorType === 'staff')).toHaveLength(1);

    const reset = await auditRows('customer.mfa.reset');
    expect(reset).toHaveLength(1);
    expect(reset[0]).toMatchObject({ partnerId: PID, actor: 'ops.admin', actorType: 'staff' });
    expect(reset[0].subjectId).toMatch(/^cust:/);
    expect(reset[0].meta).toEqual({ via: 'support_review', ticketId: t.id, wasOn: true });
    const approve = await auditRows('customer.mfa.recovery.approve');
    expect(approve).toHaveLength(1);
    expect(approve[0]).toMatchObject({ partnerId: PID, actor: 'ops.admin', actorType: 'staff', subjectId: t.id });
    expect(approve[0].meta).toEqual({ checks: ['id_document', 'kyc_name'], actorScope: 'platform' });

    expect((await outboxRows()).find((o) => o.dedupeKey === `mfarecok:${t.id}`)?.payload).toMatchObject({ to: PHONE, partnerId: PID, category: 'essential' });
    expect(redis.dump.has(customerMfaKeys.last(WHO))).toBe(false);
    expect(revokedPortal).toEqual([[PID, PHONE]]);
    expect(revokedLegacy).toEqual([PHONE]);
  });

  it('without an ID document check it waits 24 hours from the request', async () => {
    await enrolled();
    const t = await openTicket();
    clock = Date.parse(t.createdAt) + RECOVERY_COOL_OFF_MS - 60_000;
    expect(await approveMfaRecovery(t, PARTNER, ['recent_transfer'], deps)).toBe('cool_off');
    expect(await customers().isMfaEnrolled(PID, PHONE)).toBe(true);
    expect(await auditRows('customer.mfa.recovery.approve')).toHaveLength(0);
    clock = Date.parse(t.createdAt) + RECOVERY_COOL_OFF_MS;
    expect(await approveMfaRecovery(t, PARTNER, ['recent_transfer'], deps)).toBe('approved');
    expect((await auditRows('customer.mfa.recovery.approve'))[0].meta).toEqual({ checks: ['recent_transfer'], actorScope: 'partner' });
  });

  it('refuses checks without an ID document or a recent transfer', async () => {
    await enrolled();
    const t = await openTicket();
    expect(await approveMfaRecovery(t, PLATFORM, ['kyc_name', 'callback'], deps)).toBe('checks');
    expect(await customers().isMfaEnrolled(PID, PHONE)).toBe(true);
  });

  it('a verified email on file gets the approval notice too', async () => {
    await enrolled(PID, 'cust@example.com');
    await markEmailVerified(db, PID, PHONE, emailVerifiedTag(PID, PHONE, 'cust@example.com'));
    const t = await openTicket();
    expect(await approveMfaRecovery(t, PLATFORM, ['id_document'], deps)).toBe('approved');
    expect((await outboxRows()).filter((o) => o.dedupeKey === `mfarecokmail:${t.id}`)).toHaveLength(1);
  });

  it('refuses anything that is not an open recovery ticket', async () => {
    await enrolled();
    const t = await openTicket();
    const base = { ...t };
    for (const bad of [
      { ...base, category: 'billing' },
      { ...base, subject: 'Something else' },
      { ...base, kind: 'internal' as const },
      { ...base, customerPhone: '' },
      { ...base, status: 'resolved' as const },
      { ...base, status: 'closed' as const },
    ]) {
      expect(await approveMfaRecovery(bad, PLATFORM, ['id_document'], deps)).toBe('not_recovery');
    }
    expect(await customers().isMfaEnrolled(PID, PHONE)).toBe(true);
  });

  it('a partner approval refuses a ticket escalated to SmartRemit (checked in the UPDATE); the platform may approve it', async () => {
    await enrolled();
    const t = await openTicket();
    await createTicketRepo(db).updateStatus(t.id, 'waiting_admin');
    // The partner surface read the ticket before the escalation landed (status still 'open').
    expect(await approveMfaRecovery(t, PARTNER, ['id_document'], deps)).toBe('stale');
    expect(await customers().isMfaEnrolled(PID, PHONE)).toBe(true);
    expect(await auditRows('customer.mfa.recovery.approve')).toHaveLength(0);
    expect(await approveMfaRecovery(t, PLATFORM, ['id_document'], deps)).toBe('approved');
  });

  it('a racing double approve clears once and writes one audit pair', async () => {
    await enrolled();
    const t = await openTicket();
    const out = await Promise.all([
      approveMfaRecovery(t, PLATFORM, ['id_document'], deps),
      approveMfaRecovery(t, PLATFORM, ['id_document'], deps),
    ]);
    expect(out.sort()).toEqual(['approved', 'stale']);
    expect(await auditRows('customer.mfa.reset')).toHaveLength(1);
    expect(await auditRows('customer.mfa.recovery.approve')).toHaveLength(1);
  });

  it('already off: the ticket still resolves and wasOn is false', async () => {
    await enrolled();
    const t = await openTicket();
    await customers().clearMfa(PID, PHONE);
    expect(await approveMfaRecovery(t, PLATFORM, ['id_document'], deps)).toBe('already_off');
    expect((await createTicketRepo(db).getTicket(t.id))!.status).toBe('resolved');
    expect((await auditRows('customer.mfa.reset'))[0].meta).toMatchObject({ wasOn: false });
  });

  it('never touches the same phone at another tenant', async () => {
    await enrolled();
    await enrolled('pb');
    const t = await openTicket();
    expect(await approveMfaRecovery(t, PLATFORM, ['id_document'], deps)).toBe('approved');
    expect(await customers().isMfaEnrolled('pb', PHONE)).toBe(true);
  });
});

describe('declineMfaRecovery', () => {
  it('keeps the factor, resolves the ticket, audits the reason and tells the customer', async () => {
    await enrolled();
    const t = await openTicket();
    expect(await declineMfaRecovery(t, PARTNER, 'no_response', deps)).toBe('declined');
    expect(await customers().isMfaEnrolled(PID, PHONE)).toBe(true);
    expect((await createTicketRepo(db).getTicket(t.id))!.status).toBe('resolved');
    const rowsDecline = await auditRows('customer.mfa.recovery.decline');
    expect(rowsDecline).toHaveLength(1);
    expect(rowsDecline[0]).toMatchObject({ actor: 'pa.admin', actorType: 'staff', subjectId: t.id });
    expect(rowsDecline[0].meta).toEqual({ reason: 'no_response', actorScope: 'partner' });
    expect((await outboxRows()).filter((o) => o.dedupeKey === `mfarecno:${t.id}`)).toHaveLength(1);
    expect(revokedPortal).toEqual([]);
    // A second decline (or an approve) of the same ticket is refused.
    expect(await declineMfaRecovery(t, PARTNER, 'no_response', deps)).toBe('stale');
    expect(await approveMfaRecovery(t, PARTNER, ['id_document'], deps)).toBe('stale');
  });

  it('refuses a non-recovery ticket', async () => {
    await enrolled();
    const t = await openTicket();
    expect(await declineMfaRecovery({ ...t, category: 'billing' }, PLATFORM, 'duplicate', deps)).toBe('not_recovery');
  });
});
