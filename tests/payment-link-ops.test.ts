import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// Batch B2 service: payees (add, approve / reject / suspend, audited reveal)
// and links (one, CSV, cancel). Every call stays inside the actor's tenant;
// another tenant's ids read as not found; only admins act.

const screenPayee = vi.hoisted(() => ({ fn: null as null | ReturnType<typeof vi.fn> }));
vi.mock('@/lib/payees', async (orig) => {
  const real = await orig<typeof import('@/lib/payees')>();
  screenPayee.fn = vi.fn(real.screenPayee);
  return { ...real, screenPayee: (...a: Parameters<typeof real.screenPayee>) => screenPayee.fn!(...a) };
});

import {
  addPayee, cancelLink, checkBulk, createBulk, createLink, decidePayee, PaymentLinkOpsError, revealPayeeBank,
  type PartnerActor, type PlatformActor,
} from '@/lib/payment-link-ops';
import { createPaymentLinkRepo } from '@/db/repos/payment-link-repo';

const ACME: PartnerActor = { partnerId: 'acme', username: 'acme-admin', role: 'admin' };
const OTHER: PartnerActor = { partnerId: 'other', username: 'other-admin', role: 'admin' };
const ADMIN: PlatformActor = { username: 'root', role: 'admin' };
const PAYEE = { legalName: 'Sunrise Public School', accountHolder: 'Sunrise School Trust', ifsc: 'HDFC0001234', accountNumber: '50100123456789', accountNumberConfirm: '50100123456789' };
const LINK = { name: 'Asha Patel', phone: '14155550100', amount: '25000', reference: 'INV-1', purpose: 'education' };

let db: Db;

const rows = async <T,>(q: string) => ((await db.execute(sql.raw(q))) as unknown as { rows: T[] }).rows;
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof PaymentLinkOpsError) return e.code;
    throw e;
  }
};

async function approvedPayee(actor = ACME) {
  const p = await addPayee(db, actor, PAYEE);
  await decidePayee(db, ADMIN, p.id, 'approve');
  return p.id;
}

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
  await seedPartner(db, 'other');
});

describe('payees', () => {
  it('a partner admin adds a pending payee; bank details sealed; screening evidence and a create audit row', async () => {
    const p = await addPayee(db, ACME, PAYEE);
    expect(p).toMatchObject({ partnerId: 'acme', legalName: 'Sunrise Public School', status: 'pending', screening: 'clear', payoutLast4: '6789' });
    const [raw] = await rows<{ account_holder_enc: string; payout_destination_enc: string }>(`SELECT account_holder_enc, payout_destination_enc FROM payees WHERE id = '${p.id}'`);
    expect(raw.account_holder_enc).not.toContain('Sunrise');
    expect(raw.payout_destination_enc).not.toContain('50100123456789');
    const audits = await rows<{ action: string }>(`SELECT action FROM audit_events WHERE subject_id = '${p.id}' ORDER BY id`);
    expect(audits.map((a) => a.action)).toEqual(['sanctions.screen', 'payee.create']);
  });

  it('bad input is refused with field errors; a non-admin role is forbidden', async () => {
    const err = await addPayee(db, ACME, { ...PAYEE, accountNumberConfirm: '1' }).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentLinkOpsError);
    expect(err.fieldErrors.accountNumberConfirm).toBeTruthy();
    expect(await code(addPayee(db, { ...ACME, role: 'agent' }, PAYEE))).toBe('forbidden');
  });

  it('a watchlist match is refused and NOT saved', async () => {
    expect(await code(addPayee(db, ACME, { ...PAYEE, legalName: 'Test Blocked' }))).toBe('refused');
    expect(await rows(`SELECT id FROM payees`)).toEqual([]);
    expect(await rows(`SELECT 1 FROM audit_events WHERE action = 'payee.refused'`)).toHaveLength(1);
  });

  it('approve re-screens: clear approves; a possible match refuses the approval; suspend and re-approve; reject is final', async () => {
    const p = await addPayee(db, ACME, PAYEE);
    screenPayee.fn!.mockResolvedValueOnce({ verdict: 'review' });
    expect(await code(decidePayee(db, ADMIN, p.id, 'approve'))).toBe('review');
    const [r1] = await rows<{ status: string; screening: string }>(`SELECT status, screening FROM payees WHERE id = '${p.id}'`);
    expect(r1).toEqual({ status: 'pending', screening: 'review' });
    expect((await decidePayee(db, ADMIN, p.id, 'approve')).status).toBe('approved');
    expect((await decidePayee(db, ADMIN, p.id, 'suspend')).status).toBe('suspended');
    expect((await decidePayee(db, ADMIN, p.id, 'approve')).status).toBe('approved');
    expect(await code(decidePayee(db, ADMIN, p.id, 'approve'))).toBe('not_allowed');
    expect((await decidePayee(db, ADMIN, p.id, 'suspend')).status).toBe('suspended');
    expect((await decidePayee(db, ADMIN, p.id, 'reject')).status).toBe('rejected');
    expect(await code(decidePayee(db, ADMIN, p.id, 'approve'))).toBe('not_allowed');
  });

  it('an approve that now matches the watchlist rejects the payee', async () => {
    const p = await addPayee(db, ACME, PAYEE);
    screenPayee.fn!.mockResolvedValueOnce({ verdict: 'match' });
    expect(await code(decidePayee(db, ADMIN, p.id, 'approve'))).toBe('refused');
    expect((await rows<{ status: string }>(`SELECT status FROM payees WHERE id = '${p.id}'`))[0].status).toBe('rejected');
  });

  it('only a platform admin decides or reveals; a partner-scoped admin is forbidden', async () => {
    const p = await addPayee(db, ACME, PAYEE);
    expect(await code(decidePayee(db, { username: 'x', role: 'admin', partnerId: 'acme' }, p.id, 'approve'))).toBe('forbidden');
    expect(await code(decidePayee(db, { username: 'x', role: 'agent' }, p.id, 'approve'))).toBe('forbidden');
    expect(await code(revealPayeeBank(db, { username: 'x', role: 'admin', partnerId: 'acme' }, p.id))).toBe('forbidden');
    expect(await code(decidePayee(db, ADMIN, 'pye_missing', 'approve'))).toBe('not_found');
  });

  it('the reveal returns the bank details and writes one pii.reveal row', async () => {
    const p = await addPayee(db, ACME, PAYEE);
    expect(await revealPayeeBank(db, ADMIN, p.id)).toEqual({ accountHolder: 'Sunrise School Trust', payoutDestination: expect.stringContaining('50100123456789') });
    const r = await rows<{ actor: string; meta: unknown }>(`SELECT actor, meta FROM audit_events WHERE action = 'pii.reveal' AND subject_id = '${p.id}'`);
    expect(r).toEqual([{ actor: 'root', meta: { field: 'payee_bank_details' } }]);
  });
});

describe('links', () => {
  it('creates a link to an approved payee: purpose copied, 7-day expiry, 128-bit token, audit row', async () => {
    const payeeId = await approvedPayee();
    const l = await createLink(db, ACME, { payeeId, raw: LINK });
    expect(l.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const saved = await createPaymentLinkRepo(db).getForPartner('acme', l.id);
    expect(saved).toMatchObject({ purpose: 'education', amountInr: 25000, reference: 'INV-1', customerName: 'Asha Patel', status: 'open' });
    const days = (saved!.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
    expect(await rows(`SELECT 1 FROM audit_events WHERE action = 'paylink.create' AND subject_id = '${l.id}'`)).toHaveLength(1);
  });

  it('purpose is required; a reference is unique per partner (another partner may reuse it)', async () => {
    const payeeId = await approvedPayee();
    const err = await createLink(db, ACME, { payeeId, raw: { ...LINK, purpose: '' } }).catch((e) => e);
    expect(err.code).toBe('invalid');
    expect(err.fieldErrors.purpose).toBeTruthy();
    await createLink(db, ACME, { payeeId, raw: LINK });
    expect(await code(createLink(db, ACME, { payeeId, raw: LINK }))).toBe('duplicate_reference');
    const otherPayee = await approvedPayee(OTHER);
    expect(await code(createLink(db, OTHER, { payeeId: otherPayee, raw: LINK }))).toBe('ok');
  });

  it('a pending, suspended or other-tenant payee cannot take links', async () => {
    const pending = await addPayee(db, ACME, PAYEE);
    expect(await code(createLink(db, ACME, { payeeId: pending.id, raw: LINK }))).toBe('payee_not_approved');
    const suspended = await approvedPayee();
    await decidePayee(db, ADMIN, suspended, 'suspend');
    expect(await code(createLink(db, ACME, { payeeId: suspended, raw: LINK }))).toBe('payee_not_approved');
    const theirs = await approvedPayee(OTHER);
    expect(await code(createLink(db, ACME, { payeeId: theirs, raw: LINK }))).toBe('not_found');
    expect(await rows(`SELECT id FROM payment_links`)).toEqual([]);
  });

  it('cancel: own open link only; another tenant cannot see it; a cancelled link cannot be cancelled again', async () => {
    const payeeId = await approvedPayee();
    const l = await createLink(db, ACME, { payeeId, raw: LINK });
    expect(await code(cancelLink(db, OTHER, l.id))).toBe('not_found');
    expect(await code(cancelLink(db, ACME, l.id))).toBe('ok');
    expect(await code(cancelLink(db, ACME, l.id))).toBe('not_allowed');
    expect((await createPaymentLinkRepo(db).getForPartner('acme', l.id))?.status).toBe('cancelled');
    expect(await rows(`SELECT 1 FROM audit_events WHERE action = 'paylink.cancel'`)).toHaveLength(1);
  });

  it('CSV: the check saves nothing; create re-checks, skips bad rows (missing purpose, existing reference) and creates the rest', async () => {
    const payeeId = await approvedPayee();
    await createLink(db, ACME, { payeeId, raw: { ...LINK, reference: 'OLD-1' } });
    const csv = [
      'name,phone,amount,reference,purpose',
      'Asha Patel,14155550100,25000,B-1,education',
      'Ravi Kumar,14155550101,1200,B-2,',
      'Meena Shah,14155550102,3000,OLD-1,gift',
      'Lata Rao,14155550103,5000,B-4,family_support',
    ].join('\n');
    const report = await checkBulk(db, ACME, { text: csv, usdPerInr: 1 / 85 });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.rows.map((r) => r.ok)).toEqual([true, false, false, true]);
    expect(report.rows[2].errors.join(' ')).toMatch(/already/);
    expect(await rows(`SELECT id FROM payment_links`)).toHaveLength(1);

    const out = await createBulk(db, ACME, { payeeId, text: csv, usdPerInr: 1 / 85 });
    expect(out.created.map((c) => c.reference)).toEqual(['B-1', 'B-4']);
    expect(out.skipped).toBe(2);
    expect(await rows(`SELECT id FROM payment_links`)).toHaveLength(3);
    // The same file again creates nothing new.
    expect(await code(createBulk(db, ACME, { payeeId, text: csv, usdPerInr: 1 / 85 }))).toBe('nothing_to_create');
  });

  it('CSV: a bad file is refused; another tenant\'s payee is not found', async () => {
    const payeeId = await approvedPayee();
    expect(await code(createBulk(db, ACME, { payeeId, text: '' }))).toBe('bad_file');
    const theirs = await approvedPayee(OTHER);
    expect(await code(createBulk(db, ACME, { payeeId: theirs, text: 'name,phone,amount,reference,purpose\nA B,14155550100,100,X-1,gift' }))).toBe('not_found');
  });
});
