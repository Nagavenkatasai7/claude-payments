import type { DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { auditSubjectId } from './customer-ref';
import { PORTAL_AUTH_ACTOR } from './portal-auth-audit';
import { decryptField } from './field-crypto';
import { customerEmailCtx } from './crypto-context';
import { maskPhoneLast4 } from './mask';
import { maskEmail } from './portal-email-verify';
import type { MessageKey } from './i18n';
import type { Tone } from './ui/transfer-status';
import type { Customer, PartnerId } from './types';

/**
 * portal-profile — the customer portal's Profile view model and its PII audit rows (UI redesign
 * M2-11, Task 11.1). Everything shown is MASKED here, on the server: the legal name is revealed only
 * through the audited reveal action, the email and phone are never revealed on this page.
 */

const MASK = '•••'; // •••

/** "J••• D•••": the first letter of each word only. Empty → null. */
export function maskLegalName(name: string | undefined | null): string | null {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return words
    .slice(0, 4)
    .map((w) => `${Array.from(w)[0]}${MASK}`)
    .join(' ');
}

/** The customer's email address in the clear, or null (no blob, or a blob that does not open). */
export function openCustomerEmail(customer: Pick<Customer, 'partnerId' | 'senderPhone' | 'email'>): string | null {
  if (!customer.email) return null;
  try {
    return decryptField(customer.email, undefined, customerEmailCtx(customer)) || null;
  } catch {
    return null;
  }
}

export interface KycView {
  label: MessageKey;
  tone: Tone;
  /** Whether "Verify your identity" is offered (never for verified, in-review or rejected rows). */
  canStart: boolean;
}

const IN_REVIEW = new Set(['inquiry_started', 'pending_review', 'needs_review']);

/** The KYC status as the customer sees it (kycStatus is human-moved; the review state refines "pending"). */
export function kycView(c: Pick<Customer, 'kycStatus' | 'kycReviewState'>): KycView {
  if (c.kycStatus === 'verified' || c.kycStatus === 'grandfathered') return { label: 'portal.kyc.status.verified', tone: 'success', canStart: false };
  if (c.kycStatus === 'rejected') return { label: 'portal.kyc.status.rejected', tone: 'danger', canStart: false };
  if (c.kycReviewState && IN_REVIEW.has(c.kycReviewState)) return { label: 'portal.kyc.status.review', tone: 'warning', canStart: false };
  return { label: 'portal.kyc.status.none', tone: 'neutral', canStart: true };
}

export interface ProfileView {
  phone: string;
  legalName: string | null;
  email: string | null;
  kyc: KycView;
  /** The identity fields this render shows (masked): the pii.view audit names these, never values. */
  fields: Array<'phone' | 'full_name' | 'email'>;
}

export function profileView(c: Customer): ProfileView {
  const legalName = maskLegalName(c.fullName);
  const email = openCustomerEmail(c);
  const fields: ProfileView['fields'] = ['phone'];
  if (legalName) fields.push('full_name');
  if (email) fields.push('email');
  return { phone: maskPhoneLast4(c.senderPhone), legalName, email: email ? maskEmail(email) : null, kyc: kycView(c), fields };
}

/**
 * ONE `pii.view` row per Profile render (the customer-identity page rule): actor = the portal, subject
 * = the keyed customer id, meta = the field NAMES and `by: 'customer'`. Awaited and not caught by the
 * page: if the audit write fails, the page fails rather than show identity without a record.
 */
export async function recordPortalPiiView(
  db: DbOrTx,
  partnerId: PartnerId,
  phone: string,
  fields: readonly string[],
  via: 'portal.profile' | 'portal.notifications' = 'portal.profile',
): Promise<void> {
  await createAuditRepo(db).record({
    partnerId,
    actor: PORTAL_AUTH_ACTOR,
    actorType: 'system',
    action: 'pii.view',
    subjectId: auditSubjectId(partnerId, phone),
    meta: { fields: [...fields], by: 'customer', via },
  });
}

/** The audited reveal of the customer's own legal name (`pii.reveal`), written BEFORE the value is returned. */
export async function recordPortalPiiReveal(db: DbOrTx, partnerId: PartnerId, phone: string, field: 'full_name'): Promise<void> {
  await createAuditRepo(db).record({
    partnerId,
    actor: PORTAL_AUTH_ACTOR,
    actorType: 'system',
    action: 'pii.reveal',
    subjectId: auditSubjectId(partnerId, phone),
    meta: { field, by: 'customer' },
  });
}
