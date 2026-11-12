import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { createPartnerCorridorRepo } from '@/db/repos/partner-corridor-repo';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { corridorRowHash, type CorridorInput, type CorridorRow } from '@/lib/corridor-register';
import { IN_MTSS_V1 } from '@/lib/corridor-pack';
import {
  US_STATE_CODES,
  licenceMatrixHash,
  type LicenceMatrix,
  type ResidenceSource,
  type UsStateCode,
} from '@/lib/licence-matrix';
import { regDueAt, type RegClass } from '@/lib/reg-clocks';
import type { CountryCode, PartnerId, Ticket, TransferPurpose, TransferStatus } from '@/lib/types';
import { seedPartner } from './helpers-db';
import { certifyPartnerForTest, seedRealMoneyRail } from './helpers-live';
import { seedPartnerTransfer } from './helpers-partner-app';

// Fix pack 8 (P39): shared fixtures. Dates relative. T27 extends certifyPartnerForTest (licence 'open', corridors 'all'); never hand-write live_controls.licence or a register row in a test that is not about the parser.

const DAY = 86_400_000;
const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

/** One fictional test phone (a reserved 555 number): the default sender of regCaseFor and packTransfer. */
export const P8_TEST_PHONE = '15555550123';

/**
 * A licence matrix: every US state (or `states`), origins ['US'] (or `origins`), effective
 * yesterday, expiring in 365 days, attested with licenceMatrixHash unless `attested: false`.
 */
export function openLicenceMatrix(
  o: { states?: UsStateCode[]; origins?: CountryCode[]; attested?: boolean } = {},
): LicenceMatrix {
  const from = isoDay(-1);
  const to = isoDay(365);
  const m: LicenceMatrix = {
    version: 1,
    states: (o.states ?? [...US_STATE_CODES]).map((code) => ({
      code,
      licenceRef: `test-licence-${code}`,
      effectiveFrom: from,
      expiresAt: to,
    })),
    origins: (o.origins ?? ['US']).map((country) => ({ country, effectiveFrom: from, expiresAt: to })),
    evidenceRef: 'test-evidence',
    recordedBy: 'test-admin',
    recordedAt: new Date(Date.now() - 60_000).toISOString(),
  };
  if (o.attested !== false) {
    m.attestation = { by: 'test-partner-admin', at: new Date(Date.now() - 30_000).toISOString(), hash: licenceMatrixHash(m) };
  }
  return m;
}

/** Every pack purpose mapped to a P13NN-style code. */
function packPurposeCodes(): Partial<Record<TransferPurpose, string>> {
  const out: Partial<Record<TransferPurpose, string>> = {};
  IN_MTSS_V1.allowedPurposes.forEach((p, i) => {
    out[p] = `P13${String(i + 1).padStart(2, '0')}`;
  });
  return out;
}

/** The recorded input of a register row (active, re-attest +180 days). */
function corridorInputFor(cc: CountryCode, pack: boolean): CorridorInput {
  return {
    destinationCountry: cc,
    status: 'active',
    rulePack: pack && cc === 'IN' ? 'IN-MTSS-v1' : null,
    purposeCodeMap: pack && cc === 'IN' ? packPurposeCodes() : { family_support: 'P1301' },
    attestationRef: `test-attestation-${cc}`,
    attestationSha256: null,
    recipientNotices: false,
    travelDobFromUsd: null,
    travelFullFromUsd: null,
    reattestDue: isoDay(180),
  };
}

/**
 * An in-memory register row: partner 'p8', IN, active, reattestDue +180 days, attested with
 * corridorRowHash AFTER the overrides are applied. `pack: true` -> IN-MTSS-v1 with every pack
 * purpose mapped.
 */
export function corridorRow(o: Partial<CorridorRow> & { pack?: boolean } = {}): CorridorRow {
  const { pack = false, ...over } = o;
  const recordedAt = new Date(Date.now() - 60_000).toISOString();
  const base: CorridorRow = {
    ...corridorInputFor('IN', pack),
    partnerId: 'p8',
    recordedBy: 'test-admin',
    recordedAt,
    attestedBy: 'test-partner-admin',
    attestedAt: new Date(Date.now() - 30_000).toISOString(),
    attestedHash: null,
    ...over,
  };
  return { ...base, attestedHash: over.attestedHash !== undefined ? over.attestedHash : corridorRowHash(base) };
}

/**
 * A certified partner on a real-money (http) rail with a licence matrix and attested register
 * rows (default id 'p8', destinations ['IN'], licence 'open'); the IN row carries the India pack
 * when `pack`. Returns the partner id.
 */
export async function certifiedPack8Partner(
  db: Db,
  o: { id?: PartnerId; pack?: boolean; licence?: 'open' | 'none' | 'unattested'; destinations?: CountryCode[] } = {},
): Promise<PartnerId> {
  const id = o.id ?? 'p8';
  await seedPartner(db, id);
  await seedRealMoneyRail(db, id);
  await certifyPartnerForTest(db, id);
  const licence = o.licence ?? 'open';
  if (licence !== 'none') {
    const json = JSON.stringify(openLicenceMatrix({ attested: licence === 'open' }));
    const r = await db.execute(
      sql`UPDATE partners SET live_controls = jsonb_set(live_controls, '{licence}', ${json}::jsonb, true) WHERE id = ${id} RETURNING id`,
    );
    if ((r as unknown as { rows: unknown[] }).rows.length !== 1) throw new Error(`certifiedPack8Partner: no partner row '${id}'`);
  }
  const repo = createPartnerCorridorRepo(db);
  for (const cc of o.destinations ?? ['IN']) {
    await repo.upsertRecorded(id, cc, corridorInputFor(cc, !!o.pack), 'test-admin');
    const row = await repo.get(id, cc);
    if (!row) throw new Error(`certifiedPack8Partner: register row ${cc} not written`);
    const res = await repo.attest(id, cc, corridorRowHash(row), 'test-partner-admin');
    if (res !== 'attested') throw new Error(`certifiedPack8Partner: register row ${cc} not attested (${res})`);
  }
  return id;
}

/** A KYC-verified US customer with a verified state of residence (default NY, staff_verified). */
export async function residentCustomer(
  db: Db,
  partnerId: PartnerId,
  phone: string,
  state: UsStateCode = 'NY',
  source: Extract<ResidenceSource, 'partner_attested' | 'staff_verified'> = 'staff_verified',
): Promise<void> {
  const repo = createCustomerRepo(db, async () => null);
  const at = new Date(Date.now() - 60 * 60_000).toISOString();
  await repo.saveCustomer({
    senderPhone: phone,
    firstSeenAt: at,
    kycStatus: 'verified',
    senderCountry: 'US',
    partnerId,
    createdAt: at,
    updatedAt: at,
  });
  const r = await repo.setResidenceState(partnerId, phone, { state, source, at: new Date(Date.now() - 60_000) });
  if (r !== 'set') throw new Error(`residentCustomer: residence not set (${r})`);
}

/** An urgent, classed customer case (transfer bound when given); dueAt = now + dueInMs, else regDueAt. */
export async function regCaseFor(
  db: Db,
  partnerId: PartnerId,
  o: { transferId?: string; regClass: RegClass; dueInMs?: number; phone?: string },
): Promise<Ticket> {
  const now = Date.now();
  const dueAt = new Date(o.dueInMs !== undefined ? now + o.dueInMs : regDueAt(o.regClass, now));
  return createTicketRepo(db).createTicket({
    id: `tk_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    partnerId,
    kind: 'customer',
    customerPhone: o.phone ?? P8_TEST_PHONE,
    ...(o.transferId ? { transferId: o.transferId } : {}),
    subject: 'Recall request: other',
    body: 'test case',
    category: 'refund',
    regClass: o.regClass,
    firstNoticeAt: new Date(now),
    dueAt,
  });
}

/**
 * A live IN transfer inserted directly (count tests): sender P8_TEST_PHONE unless `phone`;
 * `bidx` is written to payout_dest_bidx by a raw UPDATE (T39 adds the Transfer field later).
 * Returns the id.
 */
export async function packTransfer(
  db: Db,
  partnerId: PartnerId,
  o: {
    id?: string;
    phone?: string;
    recipientPhone?: string;
    bidx?: string;
    status?: TransferStatus;
    environment?: 'live' | 'test';
    createdAt?: Date;
  } = {},
): Promise<string> {
  const id = o.id ?? `tr_p8_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await seedPartnerTransfer(db, {
    id,
    partnerId,
    phone: o.phone ?? P8_TEST_PHONE,
    ...(o.recipientPhone ? { recipientPhone: o.recipientPhone } : {}),
    status: o.status ?? 'paid',
    environment: o.environment ?? 'live',
    createdAt: (o.createdAt ?? new Date()).toISOString(),
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
  });
  if (o.bidx !== undefined) {
    await db.execute(sql`UPDATE transfers SET payout_dest_bidx = ${o.bidx} WHERE id = ${id} AND partner_id = ${partnerId}`);
  }
  return id;
}
