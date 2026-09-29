import { isReservedStaffUsername } from './partner-staff-policy';
import { INVITE_ROLES } from './staff-invite-input';
import type { StaffInvite } from './staff-invite-store';
import { isValidNewStaffUsername } from './staff-username';
import type { Staff } from './types';

// staff-invite-accept — UI redesign M3-9. The re-checks an invite must pass when the link is opened
// (after peek) and again when it is accepted (after consume). Everything comes from the STORED invite
// record, never from the request. Every refusal is the same `false`: the caller renders ONE dead
// sheet, so the invitee learns nothing about why (no oracle). A lookup that throws propagates; it is
// never read as "redeemable".

export interface RedeemDeps {
  getPartner: (id: string) => Promise<{ status: string } | null>;
  getStaff: (username: string) => Promise<Staff | null>;
  /** The seed (owner) admin's username; never available to an invite. */
  seedName: string;
}

export async function inviteRedeemable(inv: StaffInvite, deps: RedeemDeps): Promise<boolean> {
  if (!inv.partnerId) return false;
  if (!(INVITE_ROLES as readonly string[]).includes(inv.role)) return false;
  if (!isValidNewStaffUsername(inv.username) || isReservedStaffUsername(inv.username, deps.seedName)) return false;

  const partner = await deps.getPartner(inv.partnerId);
  if (!partner || partner.status !== 'active') return false;

  // #421 review (MEDIUM): the inviter must STILL be an active admin of the SAME tenant, so the
  // invites of a removed, suspended or demoted admin die with their authority.
  const inviter = await deps.getStaff(inv.invitedBy);
  if (!inviter || inviter.role !== 'admin' || inviter.status === 'suspended' || inviter.partnerId !== inv.partnerId) return false;

  // A fast pre-check only: the atomic guarantee is createStaff's SET NX at accept time.
  if (await deps.getStaff(inv.username)) return false;
  return true;
}
