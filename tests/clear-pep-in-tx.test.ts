/**
 * Fix pack 7 T9 (P23, P22 bullet 1, R2): clearPepInTx, the partner's PEP clear
 * in the CALLER's transaction, and the stamp kind (screening_watchlist_at).
 * clearPepInTx locks the customer row, refuses (KycScreeningChangedError)
 * unless the locked flags are PEP-only (senderPepOnly) and the locked flag time
 * is the one the decider reviewed, then sets screening_cleared_at and writes
 * ONE customer.screening_hold.clear audit row. It releases nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { fakeRedis } from './helpers';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createKycCaseStore } from '@/lib/kyc-case-store';
import { createCustomerRepo, readSenderScreeningFlags } from '@/db/repos/customer-repo';
import { senderClearForPartnerRelease } from '@/db/repos/transfer-repo';
import { transfers } from '@/db/schema';
import { auditSubjectId } from '@/lib/customer-ref';
import { clearPepInTx, KycScreeningChangedError } from '@/lib/sender-screening';
import { classifyHold } from '@/lib/hold-queue';
import { SENDER_SCREENING_REASON } from '@/lib/compliance-config';
import type { Db } from '@/db/client';
import type { PersonaEvent } from '@/lib/providers/persona-webhook-parse';
import type { Transfer } from '@/lib/types';

const PHONE = '15551239000';
const H = 3_600_000;
let db: Db;

type Rows<T> = { rows: T[] };
type AuditRow = { partner_id: string; actor: string; actor_type: string; subject_id: string; meta: Record<string, unknown> };

async function clears(partnerId = 'pa'): Promise<AuditRow[]> {
  const r = (await db.execute(
    sql`SELECT partner_id, actor, actor_type, subject_id, meta FROM audit_events WHERE action = 'customer.screening_hold.clear' AND partner_id = ${partnerId} ORDER BY id`,
  )) as unknown as Rows<AuditRow>;
  return r.rows;
}
async function row(partnerId = 'pa') {
  const r = (await db.execute(
    sql`SELECT screening_flagged_at AS f, screening_cleared_at AS c, screening_watchlist_at AS w FROM customers WHERE partner_id = ${partnerId} AND phone = ${PHONE}`,
  )) as unknown as Rows<{ f: string | Date | null; c: string | Date | null; w: string | Date | null }>;
  const x = r.rows[0];
  const d = (v: string | Date | null) => (v == null ? null : new Date(v).getTime());
  return x ? { f: d(x.f), c: d(x.c), w: d(x.w) } : null;
}
async function seedSender(partnerId: string, f: { pep?: boolean | null; watchlist?: boolean | null; flagged?: Date | null; cleared?: Date | null; watchlistAt?: Date | null }) {
  await createCustomerRepo(db, async () => null).ensureCustomer(partnerId, PHONE);
  await db.execute(sql`UPDATE customers SET pep_hit = ${f.pep ?? null}, watchlist_hit = ${f.watchlist ?? null},
    screening_flagged_at = ${f.flagged ?? null}, screening_cleared_at = ${f.cleared ?? null}, screening_watchlist_at = ${f.watchlistAt ?? null}
    WHERE partner_id = ${partnerId} AND phone = ${PHONE}`);
}
const input = (reviewed: string, o: Partial<Parameters<typeof clearPepInTx>[1]> = {}): Parameters<typeof clearPepInTx>[1] => ({
  partnerId: 'pa', phone: PHONE, reviewedFlaggedAt: reviewed, actor: 'pa-co', via: 'hold_review', transferId: 'tx_pep_1', ...o,
});
const runClear = (i: Parameters<typeof clearPepInTx>[1]) => db.transaction((tx) => clearPepInTx(tx, i));

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'pa');
  await seedPartner(db, 'pb');
});

describe('clearPepInTx (P23)', { retry: 0 }, () => {
  it('1: pep only, reviewed = the locked flaggedAt: cleared_at set after flagged_at; ONE audit row with the closed meta, no reason key', async () => {
    const flagged = new Date(Date.now() - H);
    await seedSender('pa', { pep: true, flagged });
    await runClear(input(flagged.toISOString()));
    const r = (await row())!;
    expect(r.c).not.toBeNull();
    expect(r.c!).toBeGreaterThan(r.f!);
    const a = await clears();
    expect(a).toHaveLength(1);
    expect(a[0].actor).toBe('pa-co');
    expect(a[0].actor_type).toBe('staff');
    expect(a[0].subject_id).toBe(auditSubjectId('pa', PHONE));
    expect(a[0].meta).toEqual({
      flaggedAt: flagged.toISOString(), previousClearedAt: null, pepHit: true, watchlistHit: false,
      kycStatus: 'not_started', actorScope: 'partner', via: 'hold_review', transferId: 'tx_pep_1',
    });
    expect('reason' in a[0].meta).toBe(false);
    expect(JSON.stringify(a[0].meta)).not.toContain(PHONE);
  });

  it('1b: a reviewed time in another ISO spelling of the same instant is accepted; a PEP hit with no stamp clears on an empty reviewed time', async () => {
    const flagged = new Date(Date.now() - H);
    await seedSender('pa', { pep: true, flagged });
    await runClear(input(flagged.toISOString().replace('Z', '+00:00')));
    expect(await clears()).toHaveLength(1);

    db = await freshDb();
    await seedPartner(db, 'pa');
    await seedSender('pa', { pep: true });
    await runClear(input(''));
    expect((await row())!.c).not.toBeNull();
    expect((await clears())[0].meta).toMatchObject({ flaggedAt: null, previousClearedAt: null });
  });

  it('2: watchlistHit true: KycScreeningChangedError, nothing written (the caller rolls back)', async () => {
    const flagged = new Date(Date.now() - H);
    await seedSender('pa', { pep: true, watchlist: true, flagged });
    const before = await row();
    await expect(runClear(input(flagged.toISOString()))).rejects.toBeInstanceOf(KycScreeningChangedError);
    expect(await row()).toEqual(before);
    expect(await clears()).toEqual([]);
  });

  it('3: the reviewed flaggedAt differs from the locked one (a newer match landed), or is unreadable: KycScreeningChangedError', async () => {
    const flagged = new Date(Date.now() - H);
    await seedSender('pa', { pep: true, flagged });
    const before = await row();
    await expect(runClear(input(new Date(flagged.getTime() - 60_000).toISOString()))).rejects.toBeInstanceOf(KycScreeningChangedError);
    await expect(runClear(input(''))).rejects.toBeInstanceOf(KycScreeningChangedError);
    await expect(runClear(input('not a time'))).rejects.toBeInstanceOf(KycScreeningChangedError);
    expect(await row()).toEqual(before);
    expect(await clears()).toEqual([]);
  });

  it('4: stamp only, pepHit not true: KycScreeningChangedError (an unattributable stamp is SmartRemit\'s)', async () => {
    const flagged = new Date(Date.now() - H);
    await seedSender('pa', { flagged });
    await expect(runClear(input(flagged.toISOString()))).rejects.toBeInstanceOf(KycScreeningChangedError);
    expect((await row())!.c).toBeNull();
    expect(await clears()).toEqual([]);
  });

  it('5: no customer row: KycScreeningChangedError', async () => {
    await expect(runClear(input(''))).rejects.toBeInstanceOf(KycScreeningChangedError);
    expect(await clears()).toEqual([]);
  });

  it("6: tenant: another partner's same-phone row is never read or cleared", async () => {
    const flagged = new Date(Date.now() - H);
    await seedSender('pb', { pep: true, flagged });
    await expect(runClear(input(flagged.toISOString()))).rejects.toBeInstanceOf(KycScreeningChangedError);
    expect((await row('pb'))!.c).toBeNull();
    expect(await clears('pb')).toEqual([]);

    // pa's own PEP row clears; pb's stays as it was.
    await seedSender('pa', { pep: true, flagged });
    await runClear(input(flagged.toISOString()));
    expect((await row('pa'))!.c).not.toBeNull();
    expect((await row('pb'))!.c).toBeNull();
    expect(await clears('pb')).toEqual([]);
  });

  it("7: via 'kyc_decision' without a transferId: the meta has no transferId key", async () => {
    const flagged = new Date(Date.now() - H);
    await seedSender('pa', { pep: true, flagged });
    await runClear(input(flagged.toISOString(), { via: 'kyc_decision', transferId: undefined }));
    const a = await clears();
    expect(a).toHaveLength(1);
    expect(a[0].meta.via).toBe('kyc_decision');
    expect('transferId' in a[0].meta).toBe(false);
  });

  it('a watchlist stamp newer than the last clear (R2): KycScreeningChangedError; one covered by a later clear: cleared', async () => {
    const flagged = new Date(Date.now() - H);
    await seedSender('pa', { pep: true, flagged, watchlistAt: flagged });
    await expect(runClear(input(flagged.toISOString()))).rejects.toBeInstanceOf(KycScreeningChangedError);

    // A platform clear covered the watchlist stamp; a later PEP match re-flagged the row.
    const wl = new Date(Date.now() - 3 * H);
    const cleared = new Date(Date.now() - 2 * H);
    await seedSender('pa', { pep: true, flagged, cleared, watchlistAt: wl });
    await runClear(input(flagged.toISOString()));
    expect((await clears())[0].meta).toMatchObject({ previousClearedAt: cleared.toISOString() });
  });
});

describe('the stamp kind (R2)', { retry: 0 }, () => {
  it("13: stampScreeningFlagged(..., 'watchlist') sets screening_watchlist_at; 'pep' leaves it null; a whole-row saveCustomer never writes it", async () => {
    const repo = createCustomerRepo(db, async () => null);
    await repo.ensureCustomer('pa', PHONE);
    await repo.stampScreeningFlagged('pa', PHONE, new Date(Date.now() - H), 'pep');
    let r = (await row())!;
    expect(r.f).not.toBeNull();
    expect(r.w).toBeNull();
    await repo.stampScreeningFlagged('pa', PHONE, new Date(Date.now() - H), 'watchlist');
    r = (await row())!;
    expect(r.w).not.toBeNull();
    expect(r.w).toBe(r.f); // the same greatest(...) value as the stamp
    const c = (await repo.getCustomer('pa', PHONE))!;
    await repo.saveCustomer({ ...c, watchlistHit: undefined, pepHit: true });
    expect((await row())!.w).toBe(r.w);
    await db.execute(sql`UPDATE customers SET screening_watchlist_at = NULL WHERE partner_id = 'pa' AND phone = ${PHONE}`);
    await repo.saveCustomer({ ...c, watchlistHit: true });
    expect((await row())!.w).toBeNull();
  });

  it('15: readSenderScreeningFlags returns screeningWatchlistAt', async () => {
    const wl = new Date(Date.now() - H);
    await seedSender('pa', { pep: true, flagged: wl, watchlistAt: wl });
    expect(await readSenderScreeningFlags(db, 'pa', PHONE)).toEqual({
      watchlistHit: null, pepHit: true, screeningFlaggedAt: wl, screeningClearedAt: null, screeningWatchlistAt: wl,
    });
    await seedSender('pa', { pep: true });
    expect((await readSenderScreeningFlags(db, 'pa', PHONE))!.screeningWatchlistAt).toBeNull();
  });

  it('14: stale save: a watchlist match after a PEP hit, then a stale copy saved: sender_watchlist, clearPepInTx refuses, the pepClearable twin refuses the claim', async () => {
    const store = createStore(fakeRedis(), db);
    const cs = createCustomerStore(db, store);
    const kyc = createKycCaseStore(fakeRedis(), cs);
    const nowIso = new Date().toISOString();
    await cs.saveCustomer({
      senderPhone: PHONE, firstSeenAt: nowIso, kycStatus: 'pending', senderCountry: 'US', partnerId: 'pa',
      createdAt: nowIso, updatedAt: nowIso, kycReviewState: 'pending_review', kycInquiryId: 'inq_s', pepHit: true,
    });
    await createCustomerRepo(db, async () => null).stampScreeningFlagged('pa', PHONE, new Date(Date.now() - H), 'pep');
    const stale = (await cs.getCustomer('pa', PHONE))!;
    expect(stale.watchlistHit).toBeUndefined();

    const watch: PersonaEvent = {
      eventId: 'evt_wl', name: 'report/watchlist.matched', createdAt: '', inquiryId: 'inq_s', referenceId: null,
      reportId: 'rep_wl', matchKind: 'watchlist', status: 'ready',
    };
    await kyc.applyPersonaEvent('pa', PHONE, watch, { db, store, alertMessage: () => 'kyc match' });
    expect((await row())!.w).not.toBeNull();

    await cs.saveCustomer(stale); // watchlistHit null again, pepHit true
    const flags = (await readSenderScreeningFlags(db, 'pa', PHONE))!;
    expect(flags.watchlistHit).toBeNull();
    expect(flags.pepHit).toBe(true);

    const classes = classifyHold([SENDER_SCREENING_REASON], flags, { queue: true, partnerDecidesKyc: true }, { blocked: false });
    expect(classes.map((c) => c.holdClass)).toEqual(['sender_watchlist']);
    await expect(runClear(input(flags.screeningFlaggedAt!.toISOString()))).rejects.toBeInstanceOf(KycScreeningChangedError);

    await store.saveTransfer(heldTransfer());
    const claim = await db
      .select({ id: transfers.id })
      .from(transfers)
      .where(and(eq(transfers.id, 'cpt_t1'), ...senderClearForPartnerRelease('pa', { pepClearable: true })));
    expect(claim).toHaveLength(0);
  });
});

function heldTransfer(): Transfer {
  const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  return {
    id: 'cpt_t1', phone: PHONE, amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'in_review', complianceStatus: 'flagged', complianceReasons: [SENDER_SCREENING_REASON],
    createdAt: ago(30), paidAt: ago(20), partnerId: 'pa',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
  } as Transfer;
}
