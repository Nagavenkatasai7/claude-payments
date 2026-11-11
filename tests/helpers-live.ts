import { sql } from 'drizzle-orm';
import { LIVE_CAPABILITIES, type LiveCapability, type LiveControls, type OptInRecord } from '@/lib/live-controls';
import type { Db } from '@/db/client';
import { disclosureHash } from '@/lib/disclosure-hash';
import type { PartnerDisclosureConfig, PartnerId } from '@/lib/types';

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
