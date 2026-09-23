// partner-invite-email — the partner-application invite email, shared by the
// landing form (src/app/partners-action.ts) and the staff resend
// (src/app/admin-dashboard/partner-requests/actions.ts) so the text cannot
// drift (Program-Fix 39). Pure: no I/O, no secrets.
//
// The link itself is NEVER in the text: it is the {{apply_link}} placeholder,
// rendered by the worker from a field-crypto SEALED value at send time
// (src/lib/sealed-text.ts, fix 11). Callers put the sealed link under
// `sealed[INVITE_LINK_PLACEHOLDER]` in the outbox payload.

/** The sealed-value name the invite text references. */
export const INVITE_LINK_PLACEHOLDER = 'apply_link';

/** Dedupe-key prefixes of the two partner-lead emails. */
export type EmailDedupePrefix = 'preq' | 'partner_app_invite';

/** Subject + text of the invite (the link is a placeholder, see above). */
export function buildInviteEmail(): { subject: string; text: string } {
  return {
    subject: 'Complete your SmartRemit partner application',
    text:
      `Hi,\n\n` +
      `Thanks for your interest in partnering with SmartRemit. Please complete your detailed application here:\n\n` +
      `{{${INVITE_LINK_PLACEHOLDER}}}\n\n` +
      `This secure link is unique to you and expires in 30 days.\n\n` +
      `— The SmartRemit team`,
  };
}

/** The original invite's dedupe key (the landing form). */
export function inviteDedupeKey(requestId: string): string {
  return `partner_app_invite:${requestId}`;
}

/**
 * A staff resend's dedupe key: unique per issued token (the first 12 hex of the
 * new token's HASH, never the token), so it cannot collide with the original
 * `partner_app_invite:<id>` key or with another resend.
 */
export function inviteResendDedupeKey(requestId: string, tokenHash: string): string {
  return `${inviteDedupeKey(requestId)}:r${tokenHash.slice(0, 12)}`;
}

const PREQ_ID = /^preq_[A-Za-z0-9_-]+$/;

/**
 * Parse an 'email.send' row's dedupe key into its prefix and the partner-request
 * id it concerns: `preq:<id>`, `partner_app_invite:<id>` or
 * `partner_app_invite:<id>:r<hex>` (the resend suffix is stripped). Anything
 * else yields nulls, never a guess.
 */
export function parseEmailDedupeKey(key: string | null | undefined): {
  prefix: EmailDedupePrefix | null;
  subjectId: string | null;
} {
  if (!key) return { prefix: null, subjectId: null };
  const [head, id] = key.split(':');
  if (head !== 'preq' && head !== 'partner_app_invite') return { prefix: null, subjectId: null };
  return { prefix: head, subjectId: id && PREQ_ID.test(id) ? id : null };
}

/** What the staff detail page says about the newest invite email. */
export type InviteEmailStatus = 'sent' | 'skipped' | 'queued' | 'failed' | 'unknown';

/**
 * Derive the newest invite email's status from its outbox row (null when the
 * row is gone) and the `email.skipped` audit rows for this request (each
 * carrying the outbox id it skipped). Only skips are audited, so a 'done' row
 * with no skip referencing it was sent.
 */
export function deriveInviteEmailStatus(
  newestInvite: { id: number; status: string } | null,
  skips: ReadonlyArray<{ outboxId: number | null }>,
): InviteEmailStatus {
  if (!newestInvite) return 'unknown';
  switch (newestInvite.status) {
    case 'done':
      return skips.some((s) => s.outboxId === newestInvite.id) ? 'skipped' : 'sent';
    case 'dead':
      return 'failed';
    case 'pending':
    case 'processing':
    case 'failed':
      return 'queued';
    default:
      return 'unknown';
  }
}
