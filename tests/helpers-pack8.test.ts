import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { createPartnerCorridorRepo } from '@/db/repos/partner-corridor-repo';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { isLiveCertified } from '@/lib/live-certified';
import { corridorActive } from '@/lib/corridor-register';
import { IN_MTSS_V1 } from '@/lib/corridor-pack';
import { US_STATE_CODES, licenceMatrixHash, matrixAttested, parseLicenceMatrix } from '@/lib/licence-matrix';
import { regDueAt } from '@/lib/reg-clocks';
import type { Db } from '@/db/client';
import { freshDb } from './helpers-db';
import {
  P8_TEST_PHONE,
  certifiedPack8Partner,
  corridorRow,
  openLicenceMatrix,
  packTransfer,
  regCaseFor,
  residentCustomer,
} from './helpers-pack8';

// Fix pack 8 T9 (P39): each shared pack 8 helper does what the contract says.

type Rows<T> = { rows: T[] };

async function rawLiveControls(db: Db, id: string): Promise<Record<string, unknown>> {
  const r = (await db.execute(sql`SELECT live_controls FROM partners WHERE id = ${id}`)) as unknown as Rows<{ live_controls: unknown }>;
  const v = r.rows[0].live_controls;
  return (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown>;
}

describe('openLicenceMatrix (P39)', () => {
  it('parses, is attested and every state is active today', () => {
    const m = openLicenceMatrix();
    const parsed = parseLicenceMatrix(JSON.parse(JSON.stringify(m)));
    expect(parsed).toBeDefined();
    expect(matrixAttested(parsed)).toBe(true);
    expect(m.attestation!.hash).toBe(licenceMatrixHash(m));
    expect(m.states.map((s) => s.code)).toEqual([...US_STATE_CODES]);
    expect(m.origins.map((o) => o.country)).toEqual(['US']);
    const today = new Date().toISOString().slice(0, 10);
    for (const s of m.states) {
      expect(s.effectiveFrom < today).toBe(true);
      expect(today < s.expiresAt).toBe(true);
    }
  });

  it('{ attested: false } has no attestation; { states: [CA] } has exactly CA; origins override', () => {
    const un = openLicenceMatrix({ attested: false });
    expect(un.attestation).toBeUndefined();
    expect(parseLicenceMatrix(un)).toBeDefined();
    expect(matrixAttested(un)).toBe(false);
    const ca = openLicenceMatrix({ states: ['CA'] });
    expect(ca.states.map((s) => s.code)).toEqual(['CA']);
    expect(matrixAttested(ca)).toBe(true);
    expect(openLicenceMatrix({ origins: ['US', 'GB'] }).origins.map((o) => o.country)).toEqual(['US', 'GB']);
  });
});

describe('corridorRow (P39)', () => {
  it('is corridorActive with no pack by default', () => {
    const r = corridorRow();
    expect(corridorActive(r, new Date())).toBe(true);
    expect(r.rulePack).toBeNull();
    expect(r.purposeCodeMap).toEqual({ family_support: 'P1301' });
  });

  it('{ pack: true } has IN-MTSS-v1 and maps every pack purpose; overrides keep it attested', () => {
    const r = corridorRow({ pack: true });
    expect(r.rulePack).toBe('IN-MTSS-v1');
    for (const p of IN_MTSS_V1.allowedPurposes) expect(r.purposeCodeMap[p]).toMatch(/^P13\d\d$/);
    expect(corridorActive(r, new Date())).toBe(true);
    const gb = corridorRow({ destinationCountry: 'GB', partnerId: 'x' });
    expect(gb.destinationCountry).toBe('GB');
    expect(corridorActive(gb, new Date())).toBe(true);
  });
});

describe('DB helpers (P39)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it('certifiedPack8Partner: certified, http rail, attested licence, one active IN pack row', async () => {
    const id = await certifiedPack8Partner(db, { pack: true });
    expect(id).toBe('p8');
    expect(isLiveCertified(await createPartnerRepo(db).getPartner(id))).toBe(true);
    const rail = (await db.execute(sql`SELECT payment_provider_type FROM partner_integrations WHERE partner_id = ${id}`)) as unknown as Rows<{ payment_provider_type: string }>;
    expect(rail.rows[0].payment_provider_type).toBe('http');
    const lc = await rawLiveControls(db, id);
    const m = parseLicenceMatrix(lc.licence);
    expect(m).toBeDefined();
    expect(matrixAttested(m)).toBe(true);
    const repo = createPartnerCorridorRepo(db);
    const now = new Date();
    expect(await repo.countActive(id, now)).toBe(1);
    expect((await repo.get(id, 'IN'))!.rulePack).toBe('IN-MTSS-v1');
  });

  it("licence 'none' writes no key; 'unattested' writes one without attestation; destinations writes each", async () => {
    const a = await certifiedPack8Partner(db, { id: 'p8a', licence: 'none' });
    expect('licence' in (await rawLiveControls(db, a))).toBe(false);
    const b = await certifiedPack8Partner(db, { id: 'p8b', licence: 'unattested' });
    const mb = parseLicenceMatrix((await rawLiveControls(db, b)).licence);
    expect(mb).toBeDefined();
    expect(mb!.attestation).toBeUndefined();
    const c = await certifiedPack8Partner(db, { id: 'p8c', destinations: ['IN', 'GB'] });
    const repo = createPartnerCorridorRepo(db);
    expect(await repo.activeDestinations(c, new Date())).toEqual(['GB', 'IN']);
    expect((await repo.get(c, 'IN'))!.rulePack).toBeNull();
  });

  it('residentCustomer writes a customer with a verified state of residence', async () => {
    const id = await certifiedPack8Partner(db);
    await residentCustomer(db, id, P8_TEST_PHONE);
    const c = await createCustomerRepo(db, async () => null).getCustomer(id, P8_TEST_PHONE);
    expect(c).not.toBeNull();
    expect(c!.residenceState).toBe('NY');
    expect(c!.residenceStateSource).toBe('staff_verified');
    expect(c!.kycStatus).toBe('verified');
    await residentCustomer(db, id, '15555550199', 'CA', 'partner_attested');
    const d = await createCustomerRepo(db, async () => null).getCustomer(id, '15555550199');
    expect(d!.residenceState).toBe('CA');
    expect(d!.residenceStateSource).toBe('partner_attested');
  });

  it('regCaseFor creates an urgent classed customer case (transfer bound; dueInMs or regDueAt)', async () => {
    const id = await certifiedPack8Partner(db);
    const tid = await packTransfer(db, id, {});
    const before = Date.now();
    const t = await regCaseFor(db, id, { transferId: tid, regClass: 'error_notice' });
    const after = Date.now();
    expect(t.kind).toBe('customer');
    expect(t.priority).toBe('urgent');
    expect(t.regClass).toBe('error_notice');
    expect(t.transferId).toBe(tid);
    expect(t.customerPhone).toBe(P8_TEST_PHONE);
    const first = Date.parse(t.firstNoticeAt!);
    expect(first).toBeGreaterThanOrEqual(before);
    expect(first).toBeLessThanOrEqual(after);
    expect(Date.parse(t.dueAt!)).toBe(regDueAt('error_notice', first));
    const stored = await createTicketRepo(db).getTicket(t.id);
    expect(stored?.regClass).toBe('error_notice');

    const u = await regCaseFor(db, id, { regClass: 'complaint', dueInMs: 60_000, phone: '15555550142' });
    expect(u.transferId).toBeUndefined();
    expect(u.customerPhone).toBe('15555550142');
    expect(Date.parse(u.dueAt!) - Date.parse(u.firstNoticeAt!)).toBe(60_000);
  });

  it('packTransfer inserts a live IN row with the given fields and the blind index', async () => {
    const id = await certifiedPack8Partner(db);
    const createdAt = new Date(Date.now() - 3 * 86_400_000);
    const tid = await packTransfer(db, id, {
      id: 'tr_pack_1', recipientPhone: '919811112222', bidx: 'bidx-test-1', status: 'awaiting_payment', createdAt,
    });
    expect(tid).toBe('tr_pack_1');
    const t = await createTransferRepo(db).getTransfer(tid);
    expect(t).not.toBeNull();
    expect(t!.destinationCountry).toBe('IN');
    expect(t!.status).toBe('awaiting_payment');
    expect(t!.recipientPhone).toBe('919811112222');
    expect(t!.phone).toBe(P8_TEST_PHONE);
    const raw = (await db.execute(sql`SELECT environment, payout_dest_bidx, created_at FROM transfers WHERE id = ${tid}`)) as unknown as Rows<{ environment: string; payout_dest_bidx: string | null; created_at: string | Date }>;
    expect(raw.rows[0].environment).toBe('live');
    expect(raw.rows[0].payout_dest_bidx).toBe('bidx-test-1');
    expect(new Date(raw.rows[0].created_at).getTime()).toBe(createdAt.getTime());

    const t2 = await packTransfer(db, id, { environment: 'test' });
    const raw2 = (await db.execute(sql`SELECT environment, payout_dest_bidx FROM transfers WHERE id = ${t2}`)) as unknown as Rows<{ environment: string; payout_dest_bidx: string | null }>;
    expect(raw2.rows[0].environment).toBe('test');
    expect(raw2.rows[0].payout_dest_bidx).toBeNull();
  });
});
