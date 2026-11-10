import type { FlagRow } from '@/db/repos/feature-flag-repo';
import { FLAG_DEFINITIONS, isKnownFlagKey, parseTenantScopeId, type FlagKey } from './flags';
import { PARTNER_FLAG_KEYS } from './flag-switch';
import { parseDestinationCountry } from './destination-country';
import { feedActorLabel } from './partner-staff-policy';
import { LIVE_CAPABILITIES, type LiveCapability, type LiveControls } from './live-controls';
import type { CountryCode, PartnerId } from './types';

// partner-controls-view — Fix pack 3 T11 (R26, R13; contract 18): the PURE half of
// /partner/controls. No database, no env, no Redis.
//
// controlsView: one entry per partner-operable switch (PARTNER_FLAG_KEYS order). The tenant's OWN
// enabled rows (`tenant:<id>` and, for a corridor key, `tenant:<id>:<CC>`) carry its own staff
// username (only the partner writer, applyPartnerFlagChange, writes `tenant:` rows). Platform rows
// that touch the tenant (global, the plain `partner:<id>` row, any corridor row) are read-only
// lines whose actor is always 'SmartRemit'. Never another tenant's row, a platform username or a
// reason: those fields are simply not copied.
//
// capabilityRows: one row per LIVE_CAPABILITIES from the stored opt-ins, booleans, the approver's
// own username and the date only (never a counsel reference). `open` mirrors capabilityOpen
// (live-gate.ts): an uncertified workspace has every capability open.

export interface ControlsWorkspace {
  on: boolean;
  by?: string;
  at?: string;
}

export interface ControlsCorridor {
  corridor: CountryCode;
  by: string;
  at: string;
}

export interface ControlsPlatformLine {
  scope: 'global' | 'partner' | 'corridor';
  corridor?: CountryCode;
  by: 'SmartRemit';
}

export interface ControlsSwitch {
  key: FlagKey;
  tenantCorridor: boolean;
  workspace: ControlsWorkspace;
  corridors: ControlsCorridor[];
  platform: ControlsPlatformLine[];
}

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

export function controlsView(rows: readonly FlagRow[], partnerId: PartnerId): ControlsSwitch[] {
  const out = PARTNER_FLAG_KEYS.map(
    (key): ControlsSwitch => ({ key, tenantCorridor: FLAG_DEFINITIONS[key].tenantCorridor, workspace: { on: false }, corridors: [], platform: [] }),
  );
  const index = new Map(out.map((s) => [s.key as string, s]));
  for (const r of rows) {
    if (!r.enabled || !isKnownFlagKey(r.key)) continue;
    const s = index.get(r.key);
    if (!s) continue; // not a partner-operable switch
    if (r.scopeType === 'global') {
      s.platform.push({ scope: 'global', by: 'SmartRemit' });
    } else if (r.scopeType === 'corridor') {
      const cc = parseDestinationCountry(r.scopeId);
      if (cc) s.platform.push({ scope: 'corridor', corridor: cc, by: 'SmartRemit' });
    } else if (r.scopeType === 'partner') {
      if (r.scopeId.startsWith('tenant:')) {
        const t = parseTenantScopeId(r.scopeId);
        if (!t || t.partnerId !== partnerId) continue;
        const by = feedActorLabel({ actor: r.updatedBy, actorScope: 'partner' });
        if (t.corridor === undefined) s.workspace = { on: true, by, at: iso(r.updatedAt) };
        else if (s.tenantCorridor) s.corridors.push({ corridor: t.corridor, by, at: iso(r.updatedAt) });
      } else if (r.scopeId === partnerId) {
        s.platform.push({ scope: 'partner', by: 'SmartRemit' });
      }
    }
  }
  return out;
}

/**
 * The switch card's state badge (review round 2 H3). 'paused': the tenant's own pause (whole
 * workspace or any corridor). 'paused_by_smartremit': no own pause, but a platform row (global,
 * partner or corridor) holds the switch. 'running': neither. The tenant's own toggle is unaffected.
 */
export type SwitchBadge = 'paused' | 'paused_by_smartremit' | 'running';

export function switchBadge(s: ControlsSwitch): SwitchBadge {
  if (s.workspace.on || s.corridors.length > 0) return 'paused';
  return s.platform.length > 0 ? 'paused_by_smartremit' : 'running';
}

export interface CapabilityRow {
  cap: LiveCapability;
  /** SmartRemit's counsel review is on record (the reference itself never leaves live_controls). */
  counsel: boolean;
  approved: boolean;
  approvedBy?: string;
  approvedAt?: string;
  /** The feature works for live money (capabilityOpen). */
  open: boolean;
  canApprove: boolean;
  canWithdraw: boolean;
}

export function capabilityRows(lc: LiveControls | undefined, certified: boolean): CapabilityRow[] {
  return LIVE_CAPABILITIES.map((cap): CapabilityRow => {
    const o = lc?.optIns?.[cap];
    const counsel = Boolean(o?.counselRef);
    const approved = Boolean(o?.partnerApprovedAt);
    const row: CapabilityRow = {
      cap,
      counsel,
      approved,
      open: !certified || (counsel && approved),
      canApprove: certified && counsel && !approved,
      canWithdraw: approved,
    };
    if (approved && o?.partnerApprovedBy) row.approvedBy = o.partnerApprovedBy;
    if (approved && o?.partnerApprovedAt) row.approvedAt = o.partnerApprovedAt;
    return row;
  });
}
