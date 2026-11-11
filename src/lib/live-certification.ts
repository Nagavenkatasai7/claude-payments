// live-certification — Fix pack 3 (R15, contract 8): the live money readiness
// checklist. PURE: no database, no env, no Redis. The facts come from
// loadLiveReadinessFacts (src/db/repos/live-certification-facts.ts), which a
// caller loads on the ROOT handle before any transaction.
//
// Twelve lines in a fixed order. Eight are built (six in pack 3, provider_block
// in pack 4 T6, funding in pack 5 T17); the other four are 'not_built' and
// always fail until their pack ships (NOT_BUILT_LINES: PR8, PR9), so `ok` is
// false for EVERY partner until PR9 (pinned in tests/live-certification.test.ts).

import { DEFAULT_PARTNER_ID } from './defaults';
import { EMPTY_LIVE_CONTROLS, postureSigned, type KycDecider } from './live-controls';
import { resolveKycMode, resolvePartnerDisclosure } from './partner-config';
import type { ListFitness } from './sanctions/list-policy';
import type { Partner, PartnerId, StaffRole } from './types';

export const LIVE_READINESS_LINE_IDS = ['go_live', 'sanctions_list', 'posture', 'compliance_users', 'own_whatsapp', 'contract',
  'provider_block', 'funding', 'licence_matrix', 'corridor_register', 'staff_mfa', 'dual_control'] as const;
export type LiveReadinessLineId = (typeof LIVE_READINESS_LINE_IDS)[number];

export const NOT_BUILT_LINES = { licence_matrix: 'PR8', corridor_register: 'PR8', staff_mfa: 'PR9', dual_control: 'PR9' } as const;

export interface LiveReadinessFacts {
  goLiveApproved: boolean;
  listFitness: ListFitness;
  ownWhatsapp: boolean;
  complianceStaff: ReadonlyArray<{ username: string; partnerId?: PartnerId; role: StaffRole; active: boolean; mfaEnrolled: boolean }>;
}

export interface LiveReadinessLine { id: LiveReadinessLineId; state: 'pass' | 'fail' | 'not_built'; ok: boolean; builtIn?: string }
/** Lines in LIVE_READINESS_LINE_IDS order; ok = every line ok. */
export interface LiveReadiness { ok: boolean; lines: LiveReadinessLine[] }

const MIN_COMPLIANCE_USERS = 2;
const COMPLIANCE_ROLES: ReadonlySet<StaffRole> = new Set<StaffRole>(['admin', 'agent']);

function isNotBuilt(id: LiveReadinessLineId): id is keyof typeof NOT_BUILT_LINES {
  return Object.prototype.hasOwnProperty.call(NOT_BUILT_LINES, id);
}

// Fix pack 4 T6 (C23): the stored provider block names the licensed entity, at
// least one licence id, a phone, an https website and a regulator, and a
// partner admin with two-step sign-in approved exactly this block (the stamp's
// hash matches). The default tenant is demo, never configured, so it fails.
function providerBlockReady(p: Pick<Partner, 'id' | 'supportConfig' | 'displayName' | 'brandName'>): boolean {
  const d = resolvePartnerDisclosure(p);
  return d.configured && d.partnerApproved && d.licenseIds.length >= 1 && d.phone !== null && d.website !== null
    && (d.stateRegulator?.name ?? '') !== '';
}

export function liveReadiness(
  p: Pick<Partner, 'id' | 'status' | 'kycMode' | 'requireKycBeforeSend' | 'liveControls' | 'supportConfig' | 'displayName' | 'brandName'>,
  f: LiveReadinessFacts,
): LiveReadiness {
  const lc = p.liveControls ?? EMPTY_LIVE_CONTROLS;
  const mode = p.kycMode ?? 'ours';
  const expectedDecider: KycDecider = mode === 'delegated' ? 'partner' : 'smartremit_procedures';

  // Only a username the partner LISTED counts, once, and only when its staff
  // record is this tenant's, an admin or agent, active and MFA-enrolled.
  const listed = new Set(lc.complianceUsers);
  const qualified = new Set(
    f.complianceStaff
      .filter((s) => listed.has(s.username) && s.partnerId === p.id && COMPLIANCE_ROLES.has(s.role) && s.active && s.mfaEnrolled)
      .map((s) => s.username),
  );

  const built: Record<Exclude<LiveReadinessLineId, keyof typeof NOT_BUILT_LINES>, boolean> = {
    go_live: f.goLiveApproved && p.status === 'active' && p.id !== DEFAULT_PARTNER_ID,
    sanctions_list: f.listFitness === 'live',
    posture: postureSigned(lc) && lc.posture?.kycDecider === expectedDecider && resolveKycMode(p).requireKyc,
    compliance_users: qualified.size >= MIN_COMPLIANCE_USERS,
    own_whatsapp: f.ownWhatsapp,
    contract: lc.contract !== undefined,
    provider_block: providerBlockReady(p),
    // Fix pack 5 T17 (P17): a valid fundingMode record (the parser already dropped a malformed one).
    funding: lc.fundingMode !== undefined,
  };

  const lines: LiveReadinessLine[] = LIVE_READINESS_LINE_IDS.map((id) => {
    if (isNotBuilt(id)) return { id, state: 'not_built', ok: false, builtIn: NOT_BUILT_LINES[id] };
    const ok = built[id];
    return { id, state: ok ? 'pass' : 'fail', ok };
  });
  return { ok: lines.every((l) => l.ok), lines };
}
