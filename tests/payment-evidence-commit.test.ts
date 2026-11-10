import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { captureQueries, freshDb, seedPartner } from './helpers-db';
import { approveDisclosureForTest } from './helpers-live';
import { testEvidence } from './helpers-pay-evidence';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { commitPaymentEvidence } from '@/lib/payment-evidence';
import { payloadHashFor } from '@/lib/payment-auth-evidence';
import { resolvePartnerDisclosure, type ResolvedDisclosure } from '@/lib/partner-config';
import { buildDisclosureSnapshot, parseDisclosureSnapshot } from '@/lib/remittance-disclosure';
import { DISCLOSURE_DRAFT_VERSION } from '@/lib/legal/disclosure-drafts';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Fix pack 4 T8 (C8, C17): "authorise, then capture". The customer's evidence
// (otp.verified, the moved remittance.disclosure_ack, the disclosure snapshot)
// is committed in ONE transaction on the LOCKED awaiting row, before any charge.

// The C4 snapshot writer can be made to miss (the guarded UPDATE matching no row).
const toggle = vi.hoisted(() => ({ snapshotMiss: false }));
vi.mock('@/db/repos/transfer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/transfer-repo')>();
  return {
    ...real,
    createTransferRepo: (...a: Parameters<typeof real.createTransferRepo>) => {
      const r = real.createTransferRepo(...a);
      return toggle.snapshotMiss ? { ...r, setDisclosureSnapshotIfAwaiting: async () => false } : r;
    },
  };
});

const SENDER = '15551230000';
const RECIPIENT_PHONE = '919876543210';
const RECIPIENT_NAME = 'Anita';
const DEST = '123456789012|HDFC0001234';

function fixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'tr_ev1', phone: SENDER, amountUsd: 200, feeUsd: 1.99, totalChargeUsd: 201.99, fxRate: 85.2,
    amountInr: 17040, recipientName: RECIPIENT_NAME, recipientPhone: RECIPIENT_PHONE,
    payoutMethod: 'bank', payoutDestination: DEST, fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'acme',
    amountSource: 200, feeSource: 1.99, totalChargeSource: 201.99, ...over,
  };
}

type AuditRow = { partner_id: string | null; actor: string; actor_type: string; action: string; subject_id: string | null; meta: Record<string, unknown> };
async function auditRows(): Promise<AuditRow[]> {
  const r = (await db.execute(
    sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events
        WHERE action IN ('otp.verified', 'remittance.disclosure_ack') ORDER BY id`,
  )) as unknown as { rows: AuditRow[] };
  return r.rows;
}
async function rawSnapshot(id: string): Promise<unknown> {
  const r = (await db.execute(sql`SELECT disclosure_snapshot AS s FROM transfers WHERE id = ${id}`)) as unknown as { rows: Array<{ s: unknown }> };
  return r.rows[0]?.s ?? null;
}

let db: Db;
let disclosure: ResolvedDisclosure;
beforeEach(async () => {
  db = await freshDb();
  toggle.snapshotMiss = false;
  await seedPartner(db, 'acme');
  await approveDisclosureForTest(db, 'acme');
  disclosure = resolvePartnerDisclosure(await createPartnerRepo(db).getPartner('acme'));
  await createTransferRepo(db).saveTransfer(fixture());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('commitPaymentEvidence (C8)', () => {
  it('auth and ack both null -> { kind: nothing } and no SQL', async () => {
    const stop = captureQueries();
    const r = await commitPaymentEvidence(db, fixture(), { auth: null, disclosureAck: null, disclosureSnapshot: null }, disclosure);
    expect(r).toEqual({ kind: 'nothing' });
    expect(stop()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it('auth only -> written: ONE otp.verified row with exactly the C17 meta', async () => {
    const ev = testEvidence({ routeId: 'tr_ev1', ack: false });
    const masked = await createTransferRepo(db).getTransfer('tr_ev1');
    expect(await commitPaymentEvidence(db, fixture(), ev, disclosure)).toEqual({ kind: 'written' });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: 'acme', actor: 'pay-page', actor_type: 'system', action: 'otp.verified', subject_id: 'tr_ev1' });
    const a = ev.auth!;
    expect(rows[0].meta).toEqual({
      surface: 'transfer',
      channel: 'wa',
      issuedAt: new Date(a.issuedAt!).toISOString(),
      verifiedAt: new Date(a.verifiedAt).toISOString(),
      attempt: 1,
      ipHash: null,
      uaHash: null,
      disclosureVersion: null,
      payloadHash: payloadHashFor(masked!),
      routeId: 'tr_ev1',
    });
    expect(String(rows[0].meta.payloadHash)).toMatch(/^ph1:[0-9a-f]{64}$/);
    expect(await rawSnapshot('tr_ev1')).toBeNull();
  });

  it('issuedAt null stays null', async () => {
    const ev = testEvidence({ routeId: 'tr_ev1', ack: false });
    ev.auth = { ...ev.auth!, issuedAt: null, attempt: null, channel: null };
    await commitPaymentEvidence(db, fixture(), ev, disclosure);
    expect((await auditRows())[0].meta).toMatchObject({ issuedAt: null, attempt: null, channel: null });
  });

  it('auth + ack + snapshot + disclosure -> two rows in ONE insert statement and the snapshot of the LOCKED row', async () => {
    const shown = disclosure.hash;
    const ev = testEvidence({ routeId: 'tr_ev1', shownHash: shown });
    const now = Date.now();
    // The caller's object is stale (other figures): the snapshot follows the locked row.
    const stale = fixture({ amountSource: 999, totalChargeSource: 999 });
    const stop = captureQueries();
    expect(await commitPaymentEvidence(db, stale, ev, disclosure, now)).toEqual({ kind: 'written' });
    const inserts = stop().filter((q) => /insert into "audit_events"/.test(q.sql));
    expect(inserts).toHaveLength(1);
    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual(['otp.verified', 'remittance.disclosure_ack']);
    expect(rows[0].meta.disclosureVersion).toBe(DISCLOSURE_DRAFT_VERSION);
    expect(rows[1]).toMatchObject({ partner_id: 'acme', actor: 'pay-page', actor_type: 'system', subject_id: 'tr_ev1' });
    expect(rows[1].meta).toEqual({ version: DISCLOSURE_DRAFT_VERSION, providerKind: 'configured', shownHash: shown, routeId: 'tr_ev1' });
    const locked = await createTransferRepo(db).getTransfer('tr_ev1');
    const expected = parseDisclosureSnapshot(buildDisclosureSnapshot({ transfer: locked!, disclosure, input: ev.disclosureSnapshot!, now }));
    const stored = await createTransferRepo(db).getDisclosureSnapshot('tr_ev1', 'acme');
    expect(stored).toEqual(expected);
    expect(stored?.figures.amountSource).toBe(200);
    expect(stored?.provider).toMatchObject({ kind: 'configured', approved: true });
  });

  it('ack with disclosure null -> ack providerKind null and no snapshot', async () => {
    await commitPaymentEvidence(db, fixture(), testEvidence({ routeId: 'tr_ev1' }), null);
    const rows = await auditRows();
    expect(rows[1].meta).toMatchObject({ providerKind: null });
    expect(await rawSnapshot('tr_ev1')).toBeNull();
  });

  it('ack without disclosureSnapshot input -> no snapshot', async () => {
    const ev = { ...testEvidence({ routeId: 'tr_ev1' }), disclosureSnapshot: null };
    await commitPaymentEvidence(db, fixture(), ev, disclosure);
    expect((await auditRows()).map((r) => r.action)).toEqual(['otp.verified', 'remittance.disclosure_ack']);
    expect(await rawSnapshot('tr_ev1')).toBeNull();
  });

  it('ack only (no auth) -> the ack row alone', async () => {
    const ev = { ...testEvidence({ routeId: 'tr_ev1' }), auth: null };
    expect(await commitPaymentEvidence(db, fixture(), ev, disclosure)).toEqual({ kind: 'written' });
    expect((await auditRows()).map((r) => r.action)).toEqual(['remittance.disclosure_ack']);
  });

  it.each([
    ['paid', { status: 'paid' as const }],
    ['in_review', { status: 'in_review' as const }],
    ['cancelled', { status: 'cancelled' as const }],
  ])('not_awaiting: a %s row -> nothing written', async (_label, over) => {
    await createTransferRepo(db).saveTransfer(fixture({ id: 'tr_moved', ...over }));
    const r = await commitPaymentEvidence(db, fixture({ id: 'tr_moved' }), testEvidence({ routeId: 'tr_moved' }), disclosure);
    expect(r).toEqual({ kind: 'not_awaiting' });
    expect(await auditRows()).toEqual([]);
    expect(await rawSnapshot('tr_moved')).toBeNull();
  });

  it('not_awaiting: a missing id or another tenant\'s id -> nothing written', async () => {
    expect(await commitPaymentEvidence(db, fixture({ id: 'tr_none' }), testEvidence(), disclosure)).toEqual({ kind: 'not_awaiting' });
    await seedPartner(db, 'beta');
    // The row is acme's: a caller naming tenant beta never sees or writes it.
    expect(await commitPaymentEvidence(db, fixture({ partnerId: 'beta' }), testEvidence({ routeId: 'tr_ev1' }), disclosure)).toEqual({ kind: 'not_awaiting' });
    expect(await auditRows()).toEqual([]);
    expect(await rawSnapshot('tr_ev1')).toBeNull();
  });

  it('the row is locked FOR UPDATE with the partner id', async () => {
    const stop = captureQueries();
    await commitPaymentEvidence(db, fixture(), testEvidence({ routeId: 'tr_ev1' }), disclosure);
    const locks = stop().filter((q) => /for update/i.test(q.sql) && /"transfers"/.test(q.sql));
    expect(locks).toHaveLength(1);
    expect(locks[0].sql).toMatch(/"partner_id"/);
    expect(locks[0].params).toEqual(expect.arrayContaining(['tr_ev1', 'acme']));
  });

  it('an audit insert that fails -> throws; no snapshot written', async () => {
    await db.execute(sql.raw(`CREATE FUNCTION fail_ev_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'audit-leak %', NEW.subject_id; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER fail_ev_audit BEFORE INSERT ON audit_events FOR EACH ROW
      WHEN (NEW.action = 'otp.verified') EXECUTE FUNCTION fail_ev_audit()`));
    // freshDb truncates tables but keeps triggers: drop it for the next test.
    onTestFinished(async () => {
      await db.execute(sql.raw('DROP TRIGGER IF EXISTS fail_ev_audit ON audit_events'));
      await db.execute(sql.raw('DROP FUNCTION IF EXISTS fail_ev_audit()'));
    });
    await expect(commitPaymentEvidence(db, fixture(), testEvidence({ routeId: 'tr_ev1' }), disclosure)).rejects.toThrow();
    expect(await auditRows()).toEqual([]);
    expect(await rawSnapshot('tr_ev1')).toBeNull();
  });

  it('a snapshot write that fails (trigger on transfers UPDATE) -> throws; no audit row', async () => {
    await db.execute(sql.raw(`CREATE FUNCTION fail_ev_snap() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'snap-leak'; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER fail_ev_snap BEFORE UPDATE ON transfers FOR EACH ROW
      EXECUTE FUNCTION fail_ev_snap()`));
    onTestFinished(async () => {
      await db.execute(sql.raw('DROP TRIGGER IF EXISTS fail_ev_snap ON transfers'));
      await db.execute(sql.raw('DROP FUNCTION IF EXISTS fail_ev_snap()'));
    });
    await expect(commitPaymentEvidence(db, fixture(), testEvidence({ routeId: 'tr_ev1' }), disclosure)).rejects.toThrow();
    expect(await auditRows()).toEqual([]);
    expect(await rawSnapshot('tr_ev1')).toBeNull();
  });

  it('setDisclosureSnapshotIfAwaiting false -> throws, rolled back', async () => {
    toggle.snapshotMiss = true;
    await expect(commitPaymentEvidence(db, fixture(), testEvidence({ routeId: 'tr_ev1' }), disclosure)).rejects.toThrow(
      'disclosure_snapshot_not_written',
    );
    expect(await auditRows()).toEqual([]);
  });

  it('no PII: the rows carry no phone, recipient name, recipient phone or destination', async () => {
    await commitPaymentEvidence(db, fixture(), testEvidence({ routeId: 'tr_ev1', shownHash: disclosure.hash }), disclosure);
    const json = JSON.stringify(await auditRows());
    for (const v of [SENDER, RECIPIENT_PHONE, RECIPIENT_NAME, '123456789012', 'HDFC0001234']) expect(json).not.toContain(v);
    const snap = JSON.stringify(await rawSnapshot('tr_ev1'));
    for (const v of [SENDER, RECIPIENT_PHONE, RECIPIENT_NAME, '123456789012', 'HDFC0001234']) expect(snap).not.toContain(v);
  });

  it('payloadHash is null when FIELD_ENCRYPTION_KEY is unset and the row is still written (C6: never a refusal)', async () => {
    vi.stubEnv('FIELD_ENCRYPTION_KEY', '');
    expect(await commitPaymentEvidence(db, fixture(), testEvidence({ routeId: 'tr_ev1', ack: false }), disclosure)).toEqual({ kind: 'written' });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta.payloadHash).toBeNull();
  });

  it('a later attempt on the same awaiting row writes new rows and overwrites the snapshot', async () => {
    const now = Date.now();
    await commitPaymentEvidence(db, fixture(), testEvidence({ routeId: 'tr_ev1' }), disclosure, now - 120_000);
    const first = await createTransferRepo(db).getDisclosureSnapshot('tr_ev1', 'acme');
    const ev2 = testEvidence({ routeId: 'tr_ev1', shownHash: disclosure.hash });
    await commitPaymentEvidence(db, fixture(), ev2, disclosure, now);
    expect((await auditRows()).map((r) => r.action)).toEqual([
      'otp.verified', 'remittance.disclosure_ack', 'otp.verified', 'remittance.disclosure_ack',
    ]);
    const second = await createTransferRepo(db).getDisclosureSnapshot('tr_ev1', 'acme');
    expect(first?.shownHash).toBeNull();
    expect(second?.shownHash).toBe(disclosure.hash);
  });
});
