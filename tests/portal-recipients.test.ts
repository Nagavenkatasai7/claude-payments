import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac, hkdfSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditEvents, schedules } from '@/db/schema';
import { createRecipientRepo } from '@/db/repos/aux-repos';
import { createScheduleRepo } from '@/db/repos/schedule-repo';
import { auditSubjectId } from '@/lib/customer-ref';
import { newTransferId } from '@/lib/id';
import {
  RECIPIENT_RID_INFO,
  deleteRecipientWithSchedules,
  deriveRecipientRidKey,
  findByRid,
  isRid,
  recipientRid,
  recordRecipientAudit,
  scheduleCountsByRecipient,
  validateAddInput,
  validateEditInput,
  validateRecipientName,
} from '@/lib/portal-recipients';
import { ACCOUNT_CONFIRM_MISMATCH, ACCOUNT_CONFIRM_REQUIRED } from '@/lib/payout-format';
import type { Recipient, Schedule, ScheduleStatus } from '@/lib/types';
import { freshDb, seedPartner } from './helpers-db';

// UI redesign M2-8, Tasks 8.1 and 8.3 (the library half): the opaque recipient id, the edge
// validation, the tenant-scoped lookup and the delete that also cancels the recipient's schedules
// (owner O12), each step audited without values.

const SENDER = '14155550101';
const SENDER_2 = '14155550202';
const RP = '919000000001';
const ACCOUNT = '123456789012';

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe('recipientRid (Task 8.1)', () => {
  const KEY = Buffer.alloc(32, 9);

  it('is 32 lowercase hex chars and stable per (tenant, sender, recipient)', () => {
    const a = recipientRid('pa', SENDER, RP, KEY);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(recipientRid('pa', SENDER, RP, KEY)).toBe(a);
    expect(isRid(a)).toBe(true);
  });

  it('differs across tenants and senders for the same phones', () => {
    const a = recipientRid('pa', SENDER, RP, KEY);
    expect(recipientRid('pb', SENDER, RP, KEY)).not.toBe(a);
    expect(recipientRid('pa', SENDER_2, RP, KEY)).not.toBe(a);
    expect(recipientRid('pa', SENDER, '919000000002', KEY)).not.toBe(a);
  });

  it('carries no phone digits and is a keyed HMAC under its OWN HKDF label (fixed-key vector)', () => {
    const rid = recipientRid('pa', SENDER, RP, KEY);
    expect(rid).not.toContain(RP);
    expect(rid).not.toContain(SENDER);
    const master = Buffer.alloc(32, 7);
    const k = deriveRecipientRidKey(master);
    const expected = Buffer.from(hkdfSync('sha256', master, '', 'recipient-rid-v1', 32));
    expect(RECIPIENT_RID_INFO).toBe('recipient-rid-v1');
    expect(k.equals(expected)).toBe(true);
    expect(recipientRid('pa', SENDER, RP, k)).toBe(
      createHmac('sha256', expected).update(`pa|${SENDER}|${RP}`).digest('hex').slice(0, 32),
    );
    // never the audit-subject key (a different label)
    expect(k.equals(Buffer.from(hkdfSync('sha256', master, '', 'smartremit/audit-subject/v1', 32)))).toBe(false);
  });

  it('the default key works (FIELD_ENCRYPTION_KEY)', () => {
    expect(recipientRid('pa', SENDER, RP)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('isRid refuses anything but 32 lowercase hex', () => {
    for (const v of ['', 'x', 'A'.repeat(32), '0'.repeat(31), '0'.repeat(33), `${'0'.repeat(31)}/`, 42, null]) expect(isRid(v)).toBe(false);
  });
});

describe('edge validation', () => {
  it('validateRecipientName: 1-80 chars, trimmed, no control or bidi characters', () => {
    expect(validateRecipientName('  Asha  ')).toBe('Asha');
    expect(validateRecipientName('')).toBeNull();
    expect(validateRecipientName('   ')).toBeNull();
    expect(validateRecipientName('a'.repeat(81))).toBeNull();
    expect(validateRecipientName('a'.repeat(80))).toBe('a'.repeat(80));
    expect(validateRecipientName('Asha\nSharma')).toBeNull();
    expect(validateRecipientName('Asha\u0000')).toBeNull();
    expect(validateRecipientName('Asha‮')).toBeNull();
    expect(validateRecipientName(42)).toBeNull();
  });

  it('validateAddInput: an Indian bank recipient composes the pay-page destination', () => {
    const r = validateAddInput(fd({ name: 'Asha', recipientPhone: '+91 90000 00001', country: 'IN', accountNumber: ACCOUNT, accountNumberConfirm: ACCOUNT, ifsc: 'HDFC0001234' }));
    expect(r).toEqual({ ok: true, value: { name: 'Asha', recipientPhone: RP, payoutMethod: 'bank', payoutDestination: `HDFC0001234 ${ACCOUNT}` } });
  });

  it('validateAddInput: bad phone, a phone from another country, a bad IFSC and an unknown country are refused', () => {
    const bad = validateAddInput(fd({ name: 'Asha', recipientPhone: '12', country: 'IN', accountNumber: ACCOUNT, accountNumberConfirm: ACCOUNT, ifsc: 'HDFC0001234' }));
    expect(bad.ok === false && bad.errors.recipientPhone).toBe('portal.recipients.phone_invalid');
    const mismatch = validateAddInput(fd({ name: 'Asha', recipientPhone: '+14155550999', country: 'IN', accountNumber: ACCOUNT, accountNumberConfirm: ACCOUNT, ifsc: 'HDFC0001234' }));
    expect(mismatch.ok === false && mismatch.errors.recipientPhone).toBe('portal.recipients.phone_country');
    const ifsc = validateAddInput(fd({ name: 'Asha', recipientPhone: RP, country: 'IN', accountNumber: ACCOUNT, accountNumberConfirm: ACCOUNT, ifsc: 'HDFC123' }));
    expect(ifsc.ok === false && ifsc.errors.bank?.ifsc).toBeTruthy();
    const country = validateAddInput(fd({ name: 'Asha', recipientPhone: RP, country: 'ZZ' }));
    expect(country.ok === false && country.errors.country).toBe('portal.recipients.country_invalid');
    const name = validateAddInput(fd({ name: '', recipientPhone: RP, country: 'IN', accountNumber: ACCOUNT, accountNumberConfirm: ACCOUNT, ifsc: 'HDFC0001234' }));
    expect(name.ok === false && name.errors.name).toBe('portal.recipients.name_invalid');
  });

  it('validateAddInput: the re-entered account number must match (Raj, Oct 7)', () => {
    const missing = validateAddInput(fd({ name: 'Asha', recipientPhone: RP, country: 'IN', accountNumber: ACCOUNT, ifsc: 'HDFC0001234' }));
    expect(missing.ok === false && missing.errors.bank?.accountNumberConfirm).toBe(ACCOUNT_CONFIRM_REQUIRED);
    const wrong = validateAddInput(fd({ name: 'Asha', recipientPhone: RP, country: 'IN', accountNumber: ACCOUNT, accountNumberConfirm: `${ACCOUNT}9`, ifsc: 'HDFC0001234' }));
    expect(wrong.ok === false && wrong.errors.bank?.accountNumberConfirm).toBe(ACCOUNT_CONFIRM_MISMATCH);
    expect(wrong.ok === false && wrong.errors.bank?.accountNumber).toBeUndefined();
  });

  it('validateEditInput: a new account number must be re-entered; blank fields still keep the current account', () => {
    const existing: Recipient = { name: 'Asha', recipientPhone: RP, payoutMethod: 'bank', payoutDestination: `HDFC0001234 ${ACCOUNT}`, lastUsedAt: '2026-06-01T00:00:00.000Z' };
    const wrong = validateEditInput(fd({ name: 'Asha', accountNumber: '999988887777', accountNumberConfirm: '999988887770', ifsc: 'ICIC0004321' }), existing);
    expect(wrong.ok === false && wrong.errors.bank?.accountNumberConfirm).toBe(ACCOUNT_CONFIRM_MISMATCH);
    const keep = validateEditInput(fd({ name: 'Asha', accountNumberConfirm: '' }), existing);
    expect(keep.ok && keep.value.payoutDestination).toBe(`HDFC0001234 ${ACCOUNT}`);
  });

  it('validateEditInput: blank bank fields keep the current account; the changed field names are listed', () => {
    const existing: Recipient = { name: 'Asha', recipientPhone: RP, payoutMethod: 'bank', payoutDestination: `HDFC0001234 ${ACCOUNT}`, lastUsedAt: '2026-06-01T00:00:00.000Z' };
    expect(validateEditInput(fd({ name: 'Asha S' }), existing)).toEqual({
      ok: true,
      value: { name: 'Asha S', payoutMethod: 'bank', payoutDestination: `HDFC0001234 ${ACCOUNT}`, fields: ['name'] },
    });
    expect(validateEditInput(fd({ name: 'Asha', accountNumber: '999988887777', accountNumberConfirm: '999988887777', ifsc: 'ICIC0004321' }), existing)).toEqual({
      ok: true,
      value: { name: 'Asha', payoutMethod: 'bank', payoutDestination: 'ICIC0004321 999988887777', fields: ['destination'] },
    });
    const partial = validateEditInput(fd({ name: 'Asha', accountNumber: '999988887777' }), existing);
    expect(partial.ok === false && partial.errors.bank?.ifsc).toBeTruthy();
    // a recipientPhone in the body is ignored: the key comes from the stored row
    const r = validateEditInput(fd({ name: 'Asha', recipientPhone: '919999999999' }), existing);
    expect(r.ok && r.value.fields).toEqual([]);
  });
});

describe('findByRid, delete and audit (Task 8.3 core)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, 'pa', 'Partner A');
    await seedPartner(db, 'pb', 'Partner B');
  });

  const rec = (recipientPhone: string, dest: string): Recipient => ({ name: 'Test Recipient', recipientPhone, payoutMethod: 'bank', payoutDestination: dest, lastUsedAt: new Date().toISOString() });
  const sched = (partnerId: string, phone: string, recipientPhone: string, status: ScheduleStatus): Schedule => ({
    id: `s_${newTransferId()}`, phone, amountUsd: 25, recipientName: 'Test Recipient', recipientPhone, payoutMethod: 'bank',
    payoutDestination: `HDFC0001234 ${ACCOUNT}`, fundingMethod: 'bank_transfer', frequency: 'monthly', dayOfMonth: 1, status,
    createdAt: new Date().toISOString(), partnerId, sourceCurrency: 'USD', amountSource: 25,
  });

  it('findByRid resolves only within (tenant, sender); a random or foreign rid is null', async () => {
    const repo = createRecipientRepo(db);
    await repo.upsertRecipient('pa', SENDER, rec(RP, `HDFC0001234 ${ACCOUNT}`));
    await repo.upsertRecipient('pb', SENDER, rec(RP, `ICIC0001234 ${ACCOUNT}`));
    const ridA = recipientRid('pa', SENDER, RP);
    const ridB = recipientRid('pb', SENDER, RP);
    expect((await findByRid(db, 'pa', SENDER, ridA))?.payoutDestination).toBe(`HDFC0001234 ${ACCOUNT}`);
    expect(await findByRid(db, 'pa', SENDER, ridB)).toBeNull();
    expect(await findByRid(db, 'pb', SENDER, ridA)).toBeNull();
    expect(await findByRid(db, 'pa', SENDER_2, ridA)).toBeNull();
    expect(await findByRid(db, 'pa', SENDER, '0'.repeat(32))).toBeNull();
    expect(await findByRid(db, 'pa', SENDER, 'not-a-rid')).toBeNull();
  });

  it('delete: an active and a paused schedule are cancelled, the tombstone exists, 3 audit rows; B and other senders untouched', async () => {
    const repo = createRecipientRepo(db);
    const srepo = createScheduleRepo(db);
    await repo.upsertRecipient('pa', SENDER, rec(RP, `HDFC0001234 ${ACCOUNT}`));
    await repo.upsertRecipient('pb', SENDER, rec(RP, `ICIC0001234 ${ACCOUNT}`));
    await repo.upsertRecipient('pa', SENDER_2, rec(RP, `SBIN0001234 ${ACCOUNT}`));
    const active = sched('pa', SENDER, RP, 'active');
    const paused = sched('pa', SENDER, RP, 'paused');
    const done = sched('pa', SENDER, RP, 'cancelled');
    const other = sched('pa', SENDER, '919000000002', 'active');
    const bSame = sched('pb', SENDER, RP, 'active');
    const sender2Same = sched('pa', SENDER_2, RP, 'active');
    for (const s of [active, paused, done, other, bSame, sender2Same]) await srepo.saveSchedule(s);

    const r = await deleteRecipientWithSchedules(db, 'pa', SENDER, recipientRid('pa', SENDER, RP));
    expect(r).toEqual({ ok: true, schedulesCancelled: 2 });

    const status = async (id: string) => (await db.select().from(schedules).where(eq(schedules.id, id)))[0].status;
    expect(await status(active.id)).toBe('cancelled');
    expect(await status(paused.id)).toBe('cancelled');
    expect(await status(other.id)).toBe('active');
    expect(await status(bSame.id)).toBe('active');
    expect(await status(sender2Same.id)).toBe('active');
    expect(await repo.isTombstoned('pa', SENDER, RP)).toBe(true);
    expect(await repo.isTombstoned('pb', SENDER, RP)).toBe(false);
    expect(await repo.isTombstoned('pa', SENDER_2, RP)).toBe(false);

    const audit = await db.select().from(auditEvents).orderBy(auditEvents.id);
    expect(audit.map((a) => a.action)).toEqual(['schedule.cancel', 'schedule.cancel', 'recipient.delete']);
    for (const a of audit) {
      expect(a.partnerId).toBe('pa');
      expect(a.actor).toBe('system:customer-portal');
      expect(a.subjectId).toBe(auditSubjectId('pa', SENDER));
      const meta = JSON.stringify(a.meta);
      expect(meta).not.toContain(ACCOUNT.slice(-6));
      expect(meta).not.toContain(RP);
      expect(meta).not.toContain(SENDER);
    }
    expect(audit[2].meta).toEqual({ rid: recipientRid('pa', SENDER, RP), schedulesCancelled: 2 });
    expect(audit.slice(0, 2).map((a) => a.meta)).toEqual(
      expect.arrayContaining([{ scheduleId: active.id, via: 'recipient_delete' }, { scheduleId: paused.id, via: 'recipient_delete' }]),
    );
  });

  it("delete of another tenant's rid, a random rid, or an already-deleted recipient changes nothing", async () => {
    const repo = createRecipientRepo(db);
    await repo.upsertRecipient('pb', SENDER, rec(RP, `ICIC0001234 ${ACCOUNT}`));
    await createScheduleRepo(db).saveSchedule(sched('pb', SENDER, RP, 'active'));
    expect(await deleteRecipientWithSchedules(db, 'pa', SENDER, recipientRid('pb', SENDER, RP))).toEqual({ ok: false });
    expect(await deleteRecipientWithSchedules(db, 'pa', SENDER, '0'.repeat(32))).toEqual({ ok: false });
    expect(await repo.isTombstoned('pb', SENDER, RP)).toBe(false);
    expect(await db.select().from(auditEvents)).toEqual([]);
    expect(await deleteRecipientWithSchedules(db, 'pb', SENDER, recipientRid('pb', SENDER, RP))).toEqual({ ok: true, schedulesCancelled: 1 });
    expect(await deleteRecipientWithSchedules(db, 'pb', SENDER, recipientRid('pb', SENDER, RP))).toEqual({ ok: false });
  });

  it('recordRecipientAudit takes only the allow-listed meta keys (ids, field names, counts; never values)', async () => {
    const rid = '0'.repeat(32);
    const bad = [{ rid, note: SENDER }, { rid, dest: ACCOUNT }, { rid: ACCOUNT }, { rid, fields: [ACCOUNT] }, { rid, schedulesCancelled: '2' }, { scheduleId: 's_1', via: ACCOUNT }];
    for (const meta of bad) {
      await expect(recordRecipientAudit(db, { partnerId: 'pa', phone: SENDER, action: 'recipient.update', meta: meta as never })).rejects.toThrow();
    }
    await expect(recordRecipientAudit(db, { partnerId: 'pa', phone: SENDER, action: 'recipient.update', meta: { rid, fields: ['name', 'destination'] } })).resolves.toBeUndefined();
    expect(await db.select().from(auditEvents)).toHaveLength(1);
  });

  it('scheduleCountsByRecipient counts only active and paused schedules, keyed by the normalized phone', () => {
    const m = scheduleCountsByRecipient([sched('pa', SENDER, RP, 'active'), sched('pa', SENDER, `+${RP}`, 'paused'), sched('pa', SENDER, RP, 'cancelled')]);
    expect(m.get(RP)).toBe(2);
  });
});
