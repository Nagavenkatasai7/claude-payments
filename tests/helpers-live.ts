import { sql } from 'drizzle-orm';
import { LIVE_CAPABILITIES, type LiveCapability, type LiveControls, type OptInRecord } from '@/lib/live-controls';
import type { Db } from '@/db/client';
import type { PartnerId } from '@/lib/types';

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
}
