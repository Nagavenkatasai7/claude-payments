import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { captureQueries, freshDb, seedPartner } from './helpers-db';
import { approveDisclosureForTest, certifyPartnerForTest } from './helpers-live';
import { testEvidence } from './helpers-pay-evidence';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { createCustomerRepo, recordEsignConsent, withdrawEsignConsent } from '@/db/repos/customer-repo';
import { readEsignConsentNeeded } from '@/lib/esign';
import { auditSubjectId } from '@/lib/customer-ref';
import { ESIGN_CONSENT_VERSION } from '@/lib/legal/esign-consent';
import { commitPaymentEvidence } from '@/lib/payment-evidence';
import { setDisclosure } from '@/lib/partner-support-settings';
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
const toggle = vi.hoisted(() => ({ snapshotMiss: false, esignMiss: false }));
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

// Fix pack 6 (P6): the consent writer can be made to miss (0 rows) on every call.
vi.mock('@/db/repos/customer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/customer-repo')>();
  return {
    ...real,
    recordEsignConsent: async (...a: Parameters<typeof real.recordEsignConsent>) =>
      toggle.esignMiss ? false : real.recordEsignConsent(...a),
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
  toggle.esignMiss = false;
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

// Review R1-P3 C2: a mandatory payment's approval is checked again inside the
// evidence transaction, on the OWNER row read FOR SHARE (it serialises with
// setDisclosure's FOR UPDATE), so a SmartRemit save that strips the approval
// between the caller's gate read and this commit refuses before any write.
describe('commitPaymentEvidence: the R18 re-check under the owner lock (review R1-P3 C2)', () => {
  const platform = { username: 'ops-staff', actorScope: 'platform' as const };
  async function stripApproval(): Promise<void> {
    const p = await createPartnerRepo(db).getPartner('acme');
    const block = p!.supportConfig!.disclosure!;
    expect(await setDisclosure(db, 'acme', platform, block)).toEqual({ ok: true });
    expect(resolvePartnerDisclosure(await createPartnerRepo(db).getPartner('acme')).partnerApproved).toBe(false);
  }
  const ownerShareLocks = (qs: Array<{ sql: string; params: unknown[] }>) => qs.filter((q) => /"partners"/.test(q.sql) && /for share/i.test(q.sql));

  beforeEach(async () => {
    await certifyPartnerForTest(db, 'acme');
    expect(disclosure.partnerApproved).toBe(true);
  });

  it('mandatory, approval stripped after the caller resolved it -> refused not_available; no audit row, no snapshot', async () => {
    await stripApproval();
    const ev = testEvidence({ routeId: 'tr_ev1', shownHash: disclosure.hash });
    const r = await commitPaymentEvidence(db, fixture(), ev, disclosure, Date.now(), { mandatory: true });
    expect(r).toEqual({ kind: 'refused', refusal: 'not_available', funded: false });
    expect(await auditRows()).toEqual([]);
    expect(await rawSnapshot('tr_ev1')).toBeNull();
    expect((await createTransferRepo(db).getTransfer('tr_ev1'))?.status).toBe('awaiting_payment');
  });

  it('mandatory, the block changed and re-approved (new hash) -> refused reload_required; nothing written', async () => {
    await approveDisclosureForTest(db, 'acme', { entity: 'Acme Remit Two LLC' });
    const fresh = resolvePartnerDisclosure(await createPartnerRepo(db).getPartner('acme'));
    expect(fresh.partnerApproved).toBe(true);
    expect(fresh.hash).not.toBe(disclosure.hash);
    const ev = testEvidence({ routeId: 'tr_ev1', shownHash: disclosure.hash });
    expect(await commitPaymentEvidence(db, fixture(), ev, disclosure, Date.now(), { mandatory: true })).toEqual({
      kind: 'refused',
      refusal: 'reload_required',
      funded: false,
    });
    expect(await auditRows()).toEqual([]);
    expect(await rawSnapshot('tr_ev1')).toBeNull();
  });

  it('mandatory refusal on a row whose debit was bound after the caller read -> funded from the LOCKED row (review round 2 M3)', async () => {
    await approveDisclosureForTest(db, 'acme', { entity: 'Acme Remit Two LLC' });
    expect(await createTransferRepo(db).bindFundingIntent('tr_ev1', 'acme', 'stripe', 'pi_tr_ev1')).toBeTruthy();
    const callerRead = fixture(); // read before the bind: unfunded
    expect(callerRead.fundingIntentRef ?? null).toBeNull();
    const ev = testEvidence({ routeId: 'tr_ev1', shownHash: disclosure.hash });
    expect(await commitPaymentEvidence(db, callerRead, ev, disclosure, Date.now(), { mandatory: true })).toEqual({
      kind: 'refused',
      refusal: 'reload_required',
      funded: true,
    });
    expect(await auditRows()).toEqual([]);
  });

  it('mandatory, still approved -> written; the owner row is read FOR SHARE after the transfer lock; snapshot approved', async () => {
    const ev = testEvidence({ routeId: 'tr_ev1', shownHash: disclosure.hash });
    const stop = captureQueries();
    expect(await commitPaymentEvidence(db, fixture(), ev, disclosure, Date.now(), { mandatory: true })).toEqual({ kind: 'written' });
    const qs = stop();
    const shares = ownerShareLocks(qs);
    expect(shares).toHaveLength(1);
    expect(shares[0].params).toContain('acme');
    const transferLock = qs.findIndex((q) => /for update/i.test(q.sql) && /"transfers"/.test(q.sql));
    expect(transferLock).toBeGreaterThanOrEqual(0);
    expect(qs.indexOf(shares[0])).toBeGreaterThan(transferLock);
    expect((await auditRows()).map((r) => r.action)).toEqual(['otp.verified', 'remittance.disclosure_ack']);
    const stored = await createTransferRepo(db).getDisclosureSnapshot('tr_ev1', 'acme');
    expect(stored).toMatchObject({ configHash: disclosure.hash, provider: { kind: 'configured', approved: true } });
  });

  it('mandatory: the snapshot is built from the LOCKED read, not the caller\'s object', async () => {
    // The caller passes a disclosure that claims another hash; the locked read wins.
    const callerCopy: ResolvedDisclosure = { ...disclosure, hash: `dh1:${'c'.repeat(64)}` };
    const ev = testEvidence({ routeId: 'tr_ev1' });
    expect(await commitPaymentEvidence(db, fixture(), ev, callerCopy, Date.now(), { mandatory: true })).toEqual({ kind: 'written' });
    const stored = await createTransferRepo(db).getDisclosureSnapshot('tr_ev1', 'acme');
    expect(stored?.configHash).toBe(disclosure.hash);
  });

  it('not mandatory, approval stripped -> written exactly as before (the caller\'s disclosure); no partner lock', async () => {
    await stripApproval();
    const ev = testEvidence({ routeId: 'tr_ev1', shownHash: disclosure.hash });
    const stop = captureQueries();
    expect(await commitPaymentEvidence(db, fixture(), ev, disclosure)).toEqual({ kind: 'written' });
    const qs = stop();
    expect(ownerShareLocks(qs)).toEqual([]);
    expect(qs.filter((q) => /"partners"/.test(q.sql))).toEqual([]);
    const stored = await createTransferRepo(db).getDisclosureSnapshot('tr_ev1', 'acme');
    expect(stored).toMatchObject({ provider: { approved: true } });
  });
});

// Fix pack 6 (P6, P21 row 1, critic C10, critic P7): the E-SIGN consent is
// written inside the same locked transaction: the customer.consent.esign row in
// the ONE recordMany, then the tenant-scoped customers UPDATE after the
// snapshot; a missing customers row is created by ensureCustomer and the write
// retried once; a final miss throws, so nothing is written and nothing charged.
describe('the E-SIGN consent write (pack 6 P6)', () => {
  const V = ESIGN_CONSENT_VERSION;
  type CustRow = {
    partner_id: string; esign_consent_version: string | null; esign_consented_at: Date | string | null;
    esign_withdrawn_at: Date | string | null; opt_in_at: Date | string | null; first_seen_at: Date | string;
  };
  async function customerRow(partnerId: string): Promise<CustRow | undefined> {
    const r = (await db.execute(
      sql`SELECT partner_id, esign_consent_version, esign_consented_at, esign_withdrawn_at, opt_in_at, first_seen_at
          FROM customers WHERE partner_id = ${partnerId} AND phone = ${SENDER}`,
    )) as unknown as { rows: CustRow[] };
    return r.rows[0];
  }
  async function allRows(): Promise<AuditRow[]> {
    const r = (await db.execute(
      sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events
          WHERE action IN ('otp.verified', 'remittance.disclosure_ack', 'customer.consent.esign') ORDER BY id`,
    )) as unknown as { rows: AuditRow[] };
    return r.rows;
  }
  const ms = (v: Date | string | null | undefined) => (v === null || v === undefined ? null : new Date(v).getTime());
  const customersSql = (qs: Array<{ sql: string }>) => qs.filter((q) => /"customers"/.test(q.sql));

  beforeEach(async () => {
    await createCustomerRepo(db, async () => null).ensureCustomer('acme', SENDER);
  });

  it('esignConsent set: ONE recordMany carries otp.verified, remittance.disclosure_ack and customer.consent.esign with the P21 meta; customerRef is the keyed subject', async () => {
    const ev = testEvidence({ routeId: 'tr_ev1', esignVersion: V });
    const stop = captureQueries();
    expect(await commitPaymentEvidence(db, fixture(), ev, disclosure)).toEqual({ kind: 'written' });
    expect(stop().filter((q) => /insert into "audit_events"/.test(q.sql))).toHaveLength(1);
    const rows = await allRows();
    expect(rows.map((r) => r.action)).toEqual(['otp.verified', 'remittance.disclosure_ack', 'customer.consent.esign']);
    const consent = rows[2];
    expect(consent).toMatchObject({ partner_id: 'acme', actor: 'pay-page', actor_type: 'system', subject_id: 'tr_ev1' });
    expect(consent.meta).toEqual({ version: V, surface: 'transfer', on: true, routeId: 'tr_ev1', customerRef: auditSubjectId('acme', SENDER) });
    expect(String(consent.meta.customerRef)).toMatch(/^cust:[0-9a-f]+$/);
    expect(auditSubjectId('beta', SENDER)).not.toBe(consent.meta.customerRef);
  });

  it("the owner's customers row holds the version, consented_at = now, withdrawn_at NULL; another tenant's row with the same phone is unchanged", async () => {
    await seedPartner(db, 'beta');
    await createCustomerRepo(db, async () => null).ensureCustomer('beta', SENDER);
    const now = Date.now() - 1_000;
    expect(await commitPaymentEvidence(db, fixture(), testEvidence({ routeId: 'tr_ev1', esignVersion: V }), disclosure, now)).toEqual({ kind: 'written' });
    const acme = await customerRow('acme');
    expect(acme?.esign_consent_version).toBe(V);
    expect(ms(acme?.esign_consented_at)).toBe(now);
    expect(acme?.esign_withdrawn_at).toBeNull();
    const beta = await customerRow('beta');
    expect(beta).toMatchObject({ esign_consent_version: null, esign_consented_at: null, esign_withdrawn_at: null });
  });

  // Final check X1: a portal withdrawal stamped after the evidence time `now` (it committed while
  // the evidence transaction waited) survives the consent write; the payment's evidence still commits.
  it('a withdrawal newer than the evidence time is kept: written, the consent row is audited, and the next payment asks again', async () => {
    const now = Date.now();
    expect(await recordEsignConsent(db, 'acme', SENDER, V, new Date(now - 60_000))).toBe(true);
    expect(await withdrawEsignConsent(db, 'acme', SENDER, new Date(now + 300))).toBe(V);
    expect(await commitPaymentEvidence(db, fixture(), testEvidence({ routeId: 'tr_ev1', esignVersion: V }), disclosure, now)).toEqual({ kind: 'written' });
    const row = await customerRow('acme');
    expect(ms(row?.esign_consented_at)).toBe(now);
    expect(ms(row?.esign_withdrawn_at)).toBe(now + 300);
    expect(await readEsignConsentNeeded(db, 'acme', SENDER)).toBe(true);
    expect((await allRows()).filter((r) => r.action === 'customer.consent.esign')).toHaveLength(1);
  });

  it("a link evidence (auth.surface 'link') writes surface 'link'", async () => {
    const ev = testEvidence({ routeId: 'pl_1', surface: 'link', esignVersion: V });
    await commitPaymentEvidence(db, fixture(), ev, disclosure);
    const consent = (await allRows()).find((r) => r.action === 'customer.consent.esign');
    expect(consent?.meta).toMatchObject({ surface: 'link', routeId: 'pl_1', on: true });
  });

  it('auth and ack null but esignConsent set -> still written (the consent row and the customers write)', async () => {
    const ev = { auth: null, disclosureAck: null, disclosureSnapshot: null, esignConsent: { version: V, routeId: 'tr_ev1' } };
    expect(await commitPaymentEvidence(db, fixture(), ev, disclosure)).toEqual({ kind: 'written' });
    const rows = await allRows();
    expect(rows.map((r) => r.action)).toEqual(['customer.consent.esign']);
    expect(rows[0].meta).toMatchObject({ surface: 'transfer', routeId: 'tr_ev1' });
    expect((await customerRow('acme'))?.esign_consent_version).toBe(V);
  });

  it('no customers row (critic C10) -> ensureCustomer creates it inside the transaction (no opt_in_at, first_seen_at = the first live transfer) and the consent is recorded', async () => {
    await db.execute(sql`DELETE FROM customers WHERE partner_id = 'acme' AND phone = ${SENDER}`);
    expect(await customerRow('acme')).toBeUndefined();
    const now = Date.now();
    expect(await commitPaymentEvidence(db, fixture(), testEvidence({ routeId: 'tr_ev1', esignVersion: V }), disclosure, now)).toEqual({ kind: 'written' });
    const row = await customerRow('acme');
    expect(row).toBeDefined();
    expect(row?.esign_consent_version).toBe(V);
    expect(ms(row?.esign_consented_at)).toBe(now);
    expect(row?.esign_withdrawn_at).toBeNull();
    expect(row?.opt_in_at).toBeNull();
    const t = await createTransferRepo(db).getTransfer('tr_ev1');
    expect(ms(row?.first_seen_at)).toBe(new Date(t!.createdAt).getTime());
    expect((await allRows()).map((r) => r.action)).toContain('customer.consent.esign');
  });

  it("the update still misses after ensureCustomer -> throws 'esign_consent_not_written'; NOTHING is written (no audit row, no snapshot, no customers row)", async () => {
    await db.execute(sql`DELETE FROM customers WHERE partner_id = 'acme' AND phone = ${SENDER}`);
    toggle.esignMiss = true;
    await expect(
      commitPaymentEvidence(db, fixture(), testEvidence({ routeId: 'tr_ev1', esignVersion: V }), disclosure),
    ).rejects.toThrow('esign_consent_not_written');
    expect(await allRows()).toEqual([]);
    expect(await rawSnapshot('tr_ev1')).toBeNull();
    expect(await customerRow('acme')).toBeUndefined();
  });

  it('the customers UPDATE fails (a BEFORE UPDATE trigger on customers) -> throws; nothing written', async () => {
    await db.execute(sql.raw(`CREATE FUNCTION fail_ev_cust() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'cust-leak'; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER fail_ev_cust BEFORE UPDATE ON customers FOR EACH ROW
      EXECUTE FUNCTION fail_ev_cust()`));
    onTestFinished(async () => {
      await db.execute(sql.raw('DROP TRIGGER IF EXISTS fail_ev_cust ON customers'));
      await db.execute(sql.raw('DROP FUNCTION IF EXISTS fail_ev_cust()'));
    });
    await expect(
      commitPaymentEvidence(db, fixture(), testEvidence({ routeId: 'tr_ev1', esignVersion: V }), disclosure),
    ).rejects.toThrow();
    expect(await allRows()).toEqual([]);
    expect(await rawSnapshot('tr_ev1')).toBeNull();
    expect(await customerRow('acme')).toMatchObject({ esign_consent_version: null, esign_consented_at: null });
  });

  it('mandatory and refused (approval stripped) -> refused; no consent row and the customers row unchanged', async () => {
    await certifyPartnerForTest(db, 'acme');
    const p = await createPartnerRepo(db).getPartner('acme');
    expect(await setDisclosure(db, 'acme', { username: 'ops-staff', actorScope: 'platform' }, p!.supportConfig!.disclosure!)).toEqual({ ok: true });
    const ev = testEvidence({ routeId: 'tr_ev1', shownHash: disclosure.hash, esignVersion: V });
    const stop = captureQueries();
    const r = await commitPaymentEvidence(db, fixture(), ev, disclosure, Date.now(), { mandatory: true });
    expect(r).toMatchObject({ kind: 'refused', refusal: 'not_available' });
    expect(customersSql(stop())).toEqual([]);
    expect(await allRows()).toEqual([]);
    expect(await customerRow('acme')).toMatchObject({ esign_consent_version: null, esign_consented_at: null });
  });

  it('lock order: transfers FOR UPDATE, then (mandatory) partners FOR SHARE, then UPDATE "customers"', async () => {
    await certifyPartnerForTest(db, 'acme');
    const ev = testEvidence({ routeId: 'tr_ev1', shownHash: disclosure.hash, esignVersion: V });
    const stop = captureQueries();
    expect(await commitPaymentEvidence(db, fixture(), ev, disclosure, Date.now(), { mandatory: true })).toEqual({ kind: 'written' });
    const qs = stop();
    const transferLock = qs.findIndex((q) => /for update/i.test(q.sql) && /"transfers"/.test(q.sql));
    const partnerShare = qs.findIndex((q) => /"partners"/.test(q.sql) && /for share/i.test(q.sql));
    const custUpdate = qs.findIndex((q) => /^update "customers"/i.test(q.sql));
    expect(transferLock).toBeGreaterThanOrEqual(0);
    expect(partnerShare).toBeGreaterThan(transferLock);
    expect(custUpdate).toBeGreaterThan(partnerShare);
    expect(qs[custUpdate].params).toEqual(expect.arrayContaining(['acme', SENDER]));
    // The common path is ONE customers statement (no ensureCustomer read).
    expect(customersSql(qs)).toHaveLength(1);
  });

  it('no PII: the consent row carries no phone, name or destination', async () => {
    await commitPaymentEvidence(db, fixture(), testEvidence({ routeId: 'tr_ev1', shownHash: disclosure.hash, esignVersion: V }), disclosure);
    const rows = await allRows();
    expect(rows.map((r) => r.action)).toContain('customer.consent.esign');
    const json = JSON.stringify(rows);
    for (const v of [SENDER, RECIPIENT_PHONE, RECIPIENT_NAME, '123456789012', 'HDFC0001234']) expect(json).not.toContain(v);
  });

  it('esignConsent absent -> byte-identical behaviour: no customers SQL at all and no consent row', async () => {
    const stop = captureQueries();
    expect(await commitPaymentEvidence(db, fixture(), testEvidence({ routeId: 'tr_ev1', shownHash: disclosure.hash }), disclosure)).toEqual({ kind: 'written' });
    expect(customersSql(stop())).toEqual([]);
    expect((await allRows()).map((r) => r.action)).toEqual(['otp.verified', 'remittance.disclosure_ack']);
    expect(await customerRow('acme')).toMatchObject({ esign_consent_version: null });
  });
});
