import { sql } from 'drizzle-orm';
import { LIVE_CAPABILITIES, type FundingMode, type LiveCapability, type LiveControls, type OptInRecord } from '@/lib/live-controls';
import type { Db } from '@/db/client';
import { disclosureHash } from '@/lib/disclosure-hash';
import type { CountryCode, FundingMethod, PartnerDisclosureConfig, PartnerId, Transfer } from '@/lib/types';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';

// helpers-live — Fix pack 3 (contract 16): a certified partner for money-path
// fixtures. Use certifyPartnerForTest on a PGlite partner row (seedPartner
// first), or certifiedLiveControls() in a hand-built Partner fake. Never
// hand-write live_controls JSON in a test unless the test is about the parser.
//
// Defaults: certified a minute ago, a contract on record, EVERY capability
// opted in (counsel + partner approval), no compliance users and NO posture
// (a signed posture forces KYC-before-send, so it is opt-in: posture: true).
// Dates are relative to now (never hardcoded: CLAUDE.md test fixtures rule).

export interface CertifyOptions {
  optIns?: readonly LiveCapability[];
  posture?: boolean;
  complianceUsers?: string[];
  /** Fix pack 4 T6 (C24): certifyPartnerForTest also writes approvedDisclosureConfig() (approveDisclosureForTest). */
  approvedDisclosure?: boolean;
  /**
   * Fix pack 5 T14 (P32): the owner's live_controls.fundingMode record, which the
   * worker's G14 gate reads. Default 'partner_collected' (so a certified http-rail
   * fixture draining a bank_transfer row with no fundingRef passes G14); null
   * writes no record.
   */
  fundingMode?: FundingMode | null;
}

export function certifiedLiveControls(o: CertifyOptions = {}): LiveControls {
  const now = Date.now();
  const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const optIns: Partial<Record<LiveCapability, OptInRecord>> = {};
  for (const cap of o.optIns ?? LIVE_CAPABILITIES) {
    optIns[cap] = {
      counselRef: `test-counsel-${cap}`,
      counselBy: 'test-admin',
      counselAt: at(-120_000),
      partnerApprovedBy: 'test-partner-admin',
      partnerApprovedAt: at(-90_000),
    };
  }
  const lc: LiveControls = {
    certification: { certifiedAt: at(-60_000), certifiedBy: 'test-admin' },
    contract: {
      ref: 'test-contract',
      signedOn: new Date(now).toISOString().slice(0, 10),
      recordedBy: 'test-admin',
      recordedAt: at(-180_000),
    },
    optIns,
    complianceUsers: [...(o.complianceUsers ?? [])],
  };
  const mode = o.fundingMode === undefined ? 'partner_collected' : o.fundingMode;
  if (mode !== null) lc.fundingMode = { mode, setBy: 'test-admin', setAt: at(-200_000) };
  if (o.posture) {
    lc.posture = {
      version: 1,
      signedBy: 'test-partner-admin',
      signedAt: at(-240_000),
      kycDecider: 'smartremit_procedures',
      holdDecider: 'partner',
      requireKycBeforeSend: true,
      fourEyesNonSanctions: false,
    };
  }
  return lc;
}

/** Writes certifiedLiveControls(o) to the partner row; throws when no row was updated. */
export async function certifyPartnerForTest(db: Db, partnerId: PartnerId, o: CertifyOptions = {}): Promise<void> {
  const json = JSON.stringify(certifiedLiveControls(o));
  const r = await db.execute(sql`UPDATE partners SET live_controls = ${json}::jsonb WHERE id = ${partnerId} RETURNING id`);
  const rows = (r as unknown as { rows: unknown[] }).rows;
  if (rows.length !== 1) throw new Error(`certifyPartnerForTest: no partner row '${partnerId}' (seedPartner first)`);
  if (o.approvedDisclosure) await approveDisclosureForTest(db, partnerId);
}

// Fix pack 4 T6 (C24): a complete provider block (entity, licence id, phone,
// https website, regulator, 1 delivery day) carrying a partner admin's approval
// stamp whose hash matches it, so resolvePartnerDisclosure reads it configured
// and partnerApproved and the provider_block readiness line passes. The stamp
// is 30 s old (relative). Never hand-write approval JSON in a test.
export function approvedDisclosureConfig(o: { entity?: string; regulator?: string } = {}): PartnerDisclosureConfig {
  const block: PartnerDisclosureConfig = {
    licensedEntity: o.entity ?? 'Acme Money Services LLC',
    licenseIds: ['NMLS 000000'],
    phone: '+1 800 555 0100',
    website: 'https://acme.example',
    stateRegulator: { name: o.regulator ?? 'State Department of Financial Services', phone: '+1 800 555 0199', website: 'https://regulator.example' },
    deliveryEstimate: { businessDays: 1 },
  };
  return {
    ...block,
    approval: { by: 'test-partner-admin', at: new Date(Date.now() - 30_000).toISOString(), hash: disclosureHash(block) },
  };
}

/** Writes approvedDisclosureConfig(o) into support_config.disclosure (other keys kept) WITHOUT certifying; throws when no row was updated. */
export async function approveDisclosureForTest(
  db: Db,
  partnerId: PartnerId,
  o: { entity?: string; regulator?: string } = {},
): Promise<void> {
  const json = JSON.stringify(approvedDisclosureConfig(o));
  const r = await db.execute(sql`UPDATE partners
    SET support_config = jsonb_set(coalesce(support_config, '{}'::jsonb), '{disclosure}', ${json}::jsonb, true)
    WHERE id = ${partnerId} RETURNING id`);
  const rows = (r as unknown as { rows: unknown[] }).rows;
  if (rows.length !== 1) throw new Error(`approveDisclosureForTest: no partner row '${partnerId}' (seedPartner first)`);
}

// Fix pack 5 T1 (P32): a real-money (http) rail for a money-path fixture: an
// https settlement URL, a signing secret (unless `signingSecret: null`, for the
// unsigned-rail refusals) and a webhook secret. Saved through
// createIntegrationsRepo (the default test key), which also writes the plain
// payment_provider_type column the real-money gate reads. Certification stays
// certifyPartnerForTest; this helper writes only the rail.
export async function seedRealMoneyRail(
  db: Db,
  partnerId: PartnerId,
  o: { signingSecret?: string | null; webhookSecret?: string; url?: string } = {},
): Promise<void> {
  await createIntegrationsRepo(db).saveIntegrations(partnerId, {
    kyc: {},
    whatsapp: {},
    payment: {
      providerType: 'http',
      credentials: {
        settlementUrl: o.url ?? 'https://rail.acme-test.com/settle',
        ...(o.signingSecret === null ? {} : { signingSecret: o.signingSecret ?? 'test-signing' }),
      },
      webhookSecret: o.webhookSecret ?? 'test-webhook',
    },
  });
}

// Fix pack 5 T14 (P32): a paid, cleared, live b2c row for a real-money instruct
// fixture: paid 20 minutes ago (past reconcile's 15-minute window), a legal
// name on the recipient, the sender saved as a customer (a full name, and the
// originator data seedOriginatorForTest puts on file when `originator` asks), and a
// fresh live screening evidence row (G12 passes). `fundingProvider` is written
// by a raw UPDATE (the insert-only column). The caller still seeds the partner,
// the rail (seedRealMoneyRail) and the certification. Ids and times relative.
export async function paidRealMoneyTransfer(
  db: Db,
  o: {
    id?: string;
    partnerId?: PartnerId;
    routedVia?: PartnerId;
    fundingProvider?: 'mock' | 'stripe' | null;
    fundingRef?: string;
    fundingMethod?: FundingMethod;
    amountUsd?: number;
    destinationCountry?: CountryCode;
    originator?: { address?: boolean; dob?: boolean };
  } = {},
): Promise<Transfer> {
  // Loaded here, not at the top: every money-path test imports this file, and a
  // static import would pull the store and the sanctions modules into files that
  // vi.mock them.
  const { createStore } = await import('@/lib/store');
  const { createCustomerStore } = await import('@/lib/customer-store');
  const { fakeRedis } = await import('./helpers');
  const { seedLiveEvidence } = await import('./helpers-sanctions');
  const now = Date.now();
  const id = o.id ?? `prm_${now.toString(36)}`;
  const partnerId = o.partnerId ?? 'acme';
  const amountUsd = o.amountUsd ?? 200;
  const phone = '15551239876';
  const senderName = 'Test Sender Placeholder';
  const t = {
    id, phone, amountUsd, feeUsd: 5, totalChargeUsd: amountUsd + 5,
    fxRate: 83, amountInr: amountUsd * 83, recipientName: 'Test Recipient', recipientLegalName: 'Test Recipient Legal',
    recipientPhone: '919800000999',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: o.fundingMethod ?? 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(now - 30 * 60_000).toISOString(), paidAt: new Date(now - 20 * 60_000).toISOString(),
    partnerId, transferType: 'b2c', environment: 'live',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: o.destinationCountry ?? 'IN', destinationCurrency: 'INR',
    amountSource: amountUsd, feeSource: 5, totalChargeSource: amountUsd + 5,
    ...(o.routedVia ? { settlementPartnerId: o.routedVia } : {}),
    ...(o.fundingRef ? { fundingRef: o.fundingRef } : {}),
  } as Transfer;
  const store = createStore(fakeRedis(), db);
  await store.saveTransfer(t);
  if (o.fundingProvider) {
    await db.execute(sql`UPDATE transfers SET funding_provider = ${o.fundingProvider} WHERE id = ${id}`);
  }
  await createCustomerStore(db, store).saveCustomer({
    senderPhone: phone,
    partnerId,
    senderCountry: 'US',
    kycStatus: 'verified',
    firstSeenAt: new Date(now - 10 * 86_400_000).toISOString(),
    createdAt: new Date(now - 10 * 86_400_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
    fullName: senderName,
  });
  if (o.originator) await seedOriginatorForTest(db, partnerId, phone, o.originator);
  await seedLiveEvidence(db, { id, partnerId, recipientName: t.recipientName, senderName });
  return (await store.getTransfer(id)) ?? t;
}

// Fix pack 5 T20a (P32): THE one originator fixture helper (no other name).
// Puts the sender's travel-rule data on file for this tenant: ensureCustomer,
// then the T18 set-if-unset setters with invented placeholder values (an
// address '1 Test Street, Testville'; a date of birth 40 years before now,
// YYYY-MM-DD in UTC). Default: the address only. A value already on file is
// kept (the setters never replace). Customer repo loaded dynamically, like
// paidRealMoneyTransfer's imports (some files vi.mock it).
export async function seedOriginatorForTest(
  db: Db,
  partnerId: PartnerId,
  phone: string,
  o: { address?: boolean; dob?: boolean } = { address: true },
): Promise<void> {
  const { createCustomerRepo } = await import('@/db/repos/customer-repo');
  const repo = createCustomerRepo(db, async () => null);
  await repo.ensureCustomer(partnerId, phone);
  if (o.address) await repo.setResidentialAddressIfUnset(partnerId, phone, '1 Test Street, Testville');
  if (o.dob) {
    const dob = new Date(Date.now() - 40 * 365.25 * 86_400_000).toISOString().slice(0, 10);
    await repo.setDateOfBirthIfUnset(partnerId, phone, dob);
  }
}

// Fix pack 5 review round 1 (RC2): a partner-collected refund sends its signed
// reverse only when the row's settle instruction was recorded (rail_messages,
// outbound 'settle') for THIS rail partner at or after its go-live. This writes
// that record, `agoMs` before now (default: now, so after certifyPartnerForTest's
// certification a minute ago). Inserted directly so the time can be placed (the
// table is append-only: no UPDATE); the body is never read by the lookup.
export async function seedSettleRecordForTest(
  db: Db,
  o: { transferId: string; partnerId: PartnerId; railPartnerId?: PartnerId; agoMs?: number },
): Promise<void> {
  const { randomUUID } = await import('node:crypto');
  const { railMessages } = await import('@/db/schema');
  const { RAIL_OUT, railBodySha256 } = await import('@/db/repos/rail-message-repo');
  await db.insert(railMessages).values({
    id: randomUUID(),
    partnerId: o.partnerId,
    railPartnerId: o.railPartnerId ?? o.partnerId,
    transferId: o.transferId,
    direction: RAIL_OUT,
    kind: 'settle',
    bodyEnc: 'not-read-by-the-lookup',
    bodySha256: railBodySha256('{}'),
    signatureHeader: null,
    createdAt: new Date(Date.now() - (o.agoMs ?? 0)),
  });
}
