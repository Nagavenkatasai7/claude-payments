import { PARTNER_OPS, type PartnerCtx, type PartnerRole } from './partner-access';
import { hasPermission } from './permissions';

// partner-reveal-policy (lost-features restore, review BL-1): the ONE rule for every click-to-reveal
// on /partner, so the transfer page, the customer page and both reveal actions can never disagree.
//   identity    (sender legal name and phone, recipient name and phone, customer name, date of
//                birth, nationality, address, phone): admin and agent, with enrolled two-step
//                verification. No canRevealPii: the old dashboard showed these to both roles.
//   destination (the full payout account): the same, plus canRevealPii (an admin always has it).
//   support and finance: never, for either class.
// PURE: the caller supplies the viewer. Pages use revealCapabilities to decide whether to offer a
// Show control (it depends on the viewer only, never on the record: no oracle). Actions call
// revealDecision and, when allowed, still take a unit of the shared reveal throttle
// (takeRevealBudget) and write ONE `pii.reveal` audit row before returning a value.

export type RevealClass = 'identity' | 'destination';

/** Every identity field any /partner reveal may return (customer and transfer pages). */
export const IDENTITY_REVEAL_FIELDS = Object.freeze([
  'full_name',
  'phone',
  'date_of_birth',
  'nationality',
  'residential_address',
  'recipient_name',
  'recipient_phone',
] as const);
export const DESTINATION_REVEAL_FIELDS = Object.freeze(['payout_destination'] as const);

/** The class of a field name, or null for anything that is not revealable at all. */
export function revealClassOf(field: string): RevealClass | null {
  if (typeof field !== 'string') return null;
  if ((DESTINATION_REVEAL_FIELDS as readonly string[]).includes(field)) return 'destination';
  if ((IDENTITY_REVEAL_FIELDS as readonly string[]).includes(field)) return 'identity';
  return null;
}

export interface RevealViewer {
  role: PartnerRole;
  /** Enrolled staff two-step verification (getStaffMfaStore().isEnrolled). */
  mfaEnrolled: boolean;
  /** hasPermission(staff, 'canRevealPii'): true for every admin, the flag for an agent. */
  canRevealPii: boolean;
}

export type RevealRefusal = 'role' | 'permission' | 'mfa';
export type RevealDecision = { ok: true } | { ok: false; reason: RevealRefusal };

/** The viewer as the session describes it. The permission goes through hasPermission, never the raw flag. */
export function revealViewer(ctx: Pick<PartnerCtx, 'role' | 'staff'>, mfaEnrolled: boolean): RevealViewer {
  return { role: ctx.role, mfaEnrolled, canRevealPii: hasPermission(ctx.staff, 'canRevealPii') };
}

export function revealDecision(viewer: RevealViewer, cls: RevealClass): RevealDecision {
  if (!PARTNER_OPS.roles.includes(viewer.role)) return { ok: false, reason: 'role' };
  if (cls !== 'identity' && cls !== 'destination') return { ok: false, reason: 'role' };
  // A missing permission comes first: enrolling would not unlock it, so the hint must not say so.
  if (cls === 'destination' && !viewer.canRevealPii) return { ok: false, reason: 'permission' };
  if (!viewer.mfaEnrolled) return { ok: false, reason: 'mfa' };
  return { ok: true };
}

/** Which Show controls a page may render for this viewer. */
export function revealCapabilities(viewer: RevealViewer): { identity: boolean; destination: boolean } {
  return { identity: revealDecision(viewer, 'identity').ok, destination: revealDecision(viewer, 'destination').ok };
}
