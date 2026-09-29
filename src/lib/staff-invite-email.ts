// staff-invite-email — UI redesign M3-8. The email a partner admin's staff invite sends. Pure: no
// I/O, no secrets.
//
// The link is NEVER in the text: it is the {{staff_invite_link}} placeholder, rendered by the
// worker from a field-crypto SEALED value at send time (src/lib/sealed-text.ts, fix 11), sealed
// under outboxSealedCtx(STAFF_INVITE_LINK_PLACEHOLDER). Callers put the sealed link under the
// LITERAL key `sealed: { staff_invite_link: ... }` (the fix-11 scan refuses computed keys).
//
// The copy is constant: nothing a tenant types (a name, a message) is interpolated, so the invite
// cannot be used to send arbitrary text from SmartRemit's mail sender.

/** The sealed-value name the invite text references. */
export const STAFF_INVITE_LINK_PLACEHOLDER = 'staff_invite_link';

export function buildStaffInviteEmail(): { subject: string; text: string } {
  return {
    subject: 'You have been invited to a SmartRemit partner workspace',
    text:
      `Hi,\n\n` +
      `An administrator of your organisation has invited you to join its SmartRemit partner workspace. ` +
      `Set up your account here:\n\n` +
      `{{${STAFF_INVITE_LINK_PLACEHOLDER}}}\n\n` +
      `This link works once and expires in 72 hours. If you were not expecting it, you can ignore this email.\n\n` +
      `— The SmartRemit team`,
  };
}

/** One email per issued invite: the first 12 hex of the token HASH (never the token). */
export function staffInviteDedupeKey(tokenHash: string): string {
  return `staff_invite:${tokenHash.slice(0, 12)}`;
}
