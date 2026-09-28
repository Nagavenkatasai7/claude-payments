// partner-support-contact — the ONE writer for partners.support_contact from a partner surface
// (UI redesign M3-17, Branding). The contact is shown to customers and can reach bot copy, so it
// is validated with the EXISTING rules only (no new format rules):
//   - at most SUPPORT_CONTACT_MAX characters, checked on the raw value (boundUntrustedText would
//     silently truncate, so the length is refused first);
//   - the boundUntrustedText form must equal the trimmed input: a value the clamp would rewrite
//     (zero-width or control characters, brackets, fullwidth forms) is refused, never "cleaned";
//   - no rule-override phrase (hasOverridePhrase);
//   - exactly one of: an https URL (isHttpsUrl), an email (normalizePortalEmail, ≤ 254), or a
//     customer-service phone (isDisclosurePhone).
//
// Tenant scoping: one partnerId, `id = $1` in the WHERE. Callers derive partnerId from the
// authenticated session, never a request body. The audit meta records only the KIND of contact,
// never the value (a phone or an address is not written to the append-only audit log).
import { eq } from 'drizzle-orm';
import { partners } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { isDisclosurePhone, isHttpsUrl } from '@/lib/partner-config';
import { normalizePortalEmail } from '@/lib/portal-email-verify';
import { boundUntrustedText, hasOverridePhrase } from '@/lib/untrusted-text';
import { SUPPORT_CONTACT_MAX } from '@/lib/partner-branding';
import type { PartnerId } from '@/lib/types';

export { SUPPORT_CONTACT_MAX };

export type SupportContactKind = 'url' | 'email' | 'phone';
export type SupportContactCheck = { ok: true; value: string; kind: SupportContactKind } | { ok: false };
export type SetSupportContactResult = { ok: true } | { ok: false; reason: 'invalid' | 'not_found' };

/** Pure: the accepted, trimmed contact and its kind, or a refusal. */
export function validateSupportContact(raw: unknown): SupportContactCheck {
  if (typeof raw !== 'string' || [...raw].length > SUPPORT_CONTACT_MAX) return { ok: false };
  const value = raw.trim();
  if (value === '' || boundUntrustedText(raw, SUPPORT_CONTACT_MAX) !== value) return { ok: false };
  if (hasOverridePhrase(value)) return { ok: false };
  if (isHttpsUrl(value)) return { ok: true, value, kind: 'url' };
  if (normalizePortalEmail(value) === value) return { ok: true, value, kind: 'email' };
  if (isDisclosurePhone(value)) return { ok: true, value, kind: 'phone' };
  return { ok: false };
}

type TxRunner = { transaction?: <T>(fn: (tx: DbOrTx) => Promise<T>) => Promise<T> };
/** Run `fn` in a transaction when holding a Db; inside an existing tx, share it. */
function inTx<T>(db: DbOrTx, fn: (tx: DbOrTx) => Promise<T>): Promise<T> {
  const maybeTx = db as TxRunner;
  return maybeTx.transaction ? maybeTx.transaction(fn) : fn(db);
}

/**
 * Validate, then in ONE transaction: a single-column UPDATE of partners.support_contact for this
 * partner (0 rows → not_found, nothing else written) and a `partner.support_contact.update` audit
 * row. `opts.actorScope` is session-derived by the caller.
 */
export async function setPartnerSupportContact(
  db: DbOrTx,
  partnerId: PartnerId,
  raw: unknown,
  actor: string,
  opts: { actorScope?: 'platform' | 'partner' } = {},
): Promise<SetSupportContactResult> {
  const v = validateSupportContact(raw);
  if (!v.ok) return { ok: false, reason: 'invalid' };
  return inTx(db, async (tx) => {
    const updated = await tx
      .update(partners)
      .set({ supportContact: v.value, updatedAt: new Date() })
      .where(eq(partners.id, partnerId))
      .returning({ id: partners.id });
    if (updated.length === 0) return { ok: false, reason: 'not_found' } as const;
    await createAuditRepo(tx).record({
      partnerId,
      actor,
      actorType: 'staff',
      action: 'partner.support_contact.update',
      subjectId: partnerId,
      meta: { kind: v.kind, ...(opts.actorScope ? { actorScope: opts.actorScope } : {}) },
    });
    return { ok: true } as const;
  });
}
