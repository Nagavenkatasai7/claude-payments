'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin, requirePlatformAdmin, requireScope } from '@/lib/auth';
import { scopeOf, canSee } from '@/lib/staff-scope';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getStore } from '@/lib/store';
import { createCustomerStore, getCustomerStore } from '@/lib/customer-store';
import { validateSendLimitInput } from '@/lib/send-limits';
import { getKycCaseStore } from '@/lib/kyc-case-store';
import { sendGateActive } from '@/lib/kyc-gate';
import { sendVerificationStatus } from '@/lib/whatsapp';
import { getPartnerStore } from '@/lib/partner-store';
import { normalizePhone, isValidPhone } from '@/lib/phone';
import { countryForPhone } from '@/lib/partner-currency';
import { DEFAULT_PARTNER_ID, DEFAULT_SENDER_COUNTRY } from '@/lib/defaults';
import type { CountryCode, KycStatus, PartnerId } from '@/lib/types';

const VALID_COUNTRIES = new Set<CountryCode>(['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN']);

/**
 * The tenant an admin action targets (fix 1): partner staff are PINNED to their
 * own (the form field is ignored — an identity pin, never an input); platform
 * staff MUST name one. No silent default: a stale or hand-crafted form without
 * a partnerId must never act on the default tenant's row for a multi-tenant
 * phone (the detail page always posts the hidden field).
 */
function targetPartnerId(staff: { partnerId?: string }, formData: FormData): PartnerId {
  if (staff.partnerId) return staff.partnerId;
  const requested = String(formData.get('partnerId') ?? '').trim();
  if (!requested) throw new Error('Partner is required.');
  return requested;
}

export async function markCustomerVerifiedAction(formData: FormData): Promise<void> {
  const staff = await requireAdmin();
  const phone = String(formData.get('phone') ?? '').trim();
  if (!phone) throw new Error('Phone is required.');

  const partnerId = targetPartnerId(staff, formData);
  const cs = getCustomerStore(getStore());
  const customer = await cs.getCustomer(partnerId, phone);
  // H3 fix + fix 1: the read is keyed (tenant, phone) with partner staff pinned;
  // canSee stays as defence-in-depth. Out-of-scope ⇒ not found.
  if (!customer || !canSee(scopeOf(staff), customer.partnerId)) {
    throw new Error('Customer not found.');
  }

  const nowIso = new Date().toISOString();
  await cs.saveCustomer({
    ...customer,
    kycStatus: 'verified',
    kycVerifiedAt: nowIso,
    kycRejectedReason: undefined,
    updatedAt: nowIso,
  });
  revalidatePath('/admin-dashboard/customers');
  revalidatePath(`/admin-dashboard/customers/${phone}`);
}

/**
 * Phase 2 — the canonical, audit-logged KYC review decision (maker-checker-lite).
 * Used by the "Needs KYC Review" queue + customer detail. Approve sets
 * kycStatus:'verified'; reject sets 'rejected' with a MANDATORY reason. Goes
 * through kyc-case-store.review so every decision is appended to the audit log,
 * and notifies the customer fail-soft. Server-action checklist: own auth gate,
 * scope check (the customer key is global), reason guard before any mutation.
 */
export async function reviewKycAction(formData: FormData): Promise<void> {
  const staff = await requireAdmin();
  const phone = String(formData.get('phone') ?? '').trim();
  const decision = String(formData.get('decision') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (decision !== 'approve' && decision !== 'reject') throw new Error('Invalid decision.');
  if (!reason) throw new Error('A review reason is required.');

  const partnerId = targetPartnerId(staff, formData);
  const cs = getCustomerStore(getStore());
  const customer = await cs.getCustomer(partnerId, phone);
  if (!customer || !canSee(scopeOf(staff), customer.partnerId)) {
    throw new Error('Customer not found.');
  }

  // Attribute the reviewer by display name + stable username, e.g. "Main Admin (forextransfer)".
  const reviewer =
    staff.name && staff.name !== staff.username ? `${staff.name} (${staff.username})` : staff.username;
  await getKycCaseStore(getStore()).review(partnerId, phone, decision, reviewer, reason);
  // KYC is partner OPT-IN: the decision + audit above stand regardless, but the
  // customer-facing WhatsApp notify only fires when the partner's
  // verify-before-send gate is ON. Fail-soft — a notify hiccup never voids the review.
  const partner =
    (await getPartnerStore().getPartner(customer.partnerId)) ??
    (await getPartnerStore().ensureDefaultPartner());
  if (sendGateActive(partner)) {
    await sendVerificationStatus(phone, decision === 'approve' ? 'verified' : 'failed', customer.fullName).catch(
      () => {},
    );
  }

  revalidatePath('/admin-dashboard/compliance');
  revalidatePath('/admin-dashboard/customers');
  revalidatePath(`/admin-dashboard/customers/${phone}`);
}

/**
 * Manually create a customer/client record from the admin dashboard.
 *
 * Follows the mandatory server-action security checklist:
 *  1. own auth gate (admins only);
 *  2. validate input (phone via the shared normalize/validate utils);
 *  3. collision check BEFORE write (saveCustomer is an unconditional SET, so an
 *     existing phone would be silently overwritten);
 *  4. identity is authoritative over the form for ownership — a partner-admin is
 *     pinned to their own partner; only a platform-admin may choose a partner.
 */
export async function createCustomerAction(formData: FormData): Promise<void> {
  const { staff } = await requireScope();
  if (staff.role !== 'admin') throw new Error('Not authorized.');

  const normalized = normalizePhone(formData.get('phone'));
  if (!isValidPhone(normalized)) {
    throw new Error('Phone must be 10–15 digits, including country code.');
  }

  // Partner scope: partner-admin → own partner (identity authoritative, form ignored);
  // platform-admin → form choice, verified to exist.
  let partnerId: PartnerId = DEFAULT_PARTNER_ID;
  if (staff.partnerId) {
    partnerId = staff.partnerId;
  } else {
    const requested = String(formData.get('partnerId') ?? '').trim();
    if (requested && requested !== DEFAULT_PARTNER_ID) {
      const partner = await getPartnerStore().getPartner(requested);
      if (!partner) throw new Error('Selected partner not found.');
      partnerId = requested;
    }
  }

  // Collision check is per (tenant, phone) since fix 1 — the same number may
  // legitimately exist under another partner.
  const cs = getCustomerStore(getStore());
  if (await cs.getCustomer(partnerId, normalized)) {
    throw new Error('A customer with that phone already exists.');
  }

  const picked = String(formData.get('senderCountry') ?? '').trim().toUpperCase();
  const senderCountry: CountryCode = VALID_COUNTRIES.has(picked as CountryCode)
    ? (picked as CountryCode)
    : countryForPhone(normalized) ?? DEFAULT_SENDER_COUNTRY;

  const kycChoice = String(formData.get('kycStatus') ?? 'not_started');
  const kycStatus: KycStatus =
    kycChoice === 'verified'
      ? 'verified'
      : kycChoice === 'grandfathered'
        ? 'grandfathered'
        : 'not_started';

  const fullName = String(formData.get('fullName') ?? '').trim() || undefined;
  const now = new Date().toISOString();

  await cs.saveCustomer({
    senderPhone: normalized,
    firstSeenAt: now,
    kycStatus,
    kycVerifiedAt: kycStatus === 'verified' || kycStatus === 'grandfathered' ? now : undefined,
    fullName,
    senderCountry,
    partnerId,
    createdAt: now,
    updatedAt: now,
  });

  revalidatePath('/admin-dashboard/customers');
  redirect(`/admin-dashboard/customers/${normalized}?partner=${encodeURIComponent(partnerId)}`);
}

export async function markCustomerRejectedAction(formData: FormData): Promise<void> {
  const staff = await requireAdmin();
  const phone = String(formData.get('phone') ?? '').trim();
  const reason =
    String(formData.get('reason') ?? '').trim().slice(0, 500) || 'Manual rejection by staff';
  if (!phone) throw new Error('Phone is required.');

  const partnerId = targetPartnerId(staff, formData);
  const cs = getCustomerStore(getStore());
  const customer = await cs.getCustomer(partnerId, phone);
  // H3 fix (see markCustomerVerifiedAction): reject out-of-scope.
  if (!customer || !canSee(scopeOf(staff), customer.partnerId)) {
    throw new Error('Customer not found.');
  }

  const nowIso = new Date().toISOString();
  await cs.saveCustomer({
    ...customer,
    kycStatus: 'rejected',
    kycRejectedReason: reason,
    updatedAt: nowIso,
  });
  revalidatePath('/admin-dashboard/customers');
  revalidatePath(`/admin-dashboard/customers/${phone}`);
}

/**
 * Program fix 16b: the audited PLATFORM-ADMIN raise (or clear) of one sender's
 * send limits. Server-action checklist, in order:
 *  1. requirePlatformAdmin() — partner-scoped staff and support are redirected
 *     with no read, no write and no audit row (a raise is platform governance);
 *  2. validateSendLimitInput — a missing reason throws BEFORE any read, like
 *     reviewKycAction; whole USD in [1, $10,000]; a future expiry only;
 *  3. the target is re-read from the posted (partnerId, phone): a missing row
 *     is "Customer not found." — the write is keyed on THAT row's own key, so a
 *     raise for (A, phone) can never touch (B, phone);
 *  4. ONE transaction: read the old value (FOR UPDATE), the single-column
 *     UPDATE, then the audit_events row (actor, old, new, reason, expiresAt).
 *     If the audit insert fails, the limit write rolls back.
 * Only the dollar caps move: sanctions, EDD and the tier gates are untouched
 * (send-limits.ts resolveEffectiveSendLimits).
 */
export async function setCustomerSendLimitAction(formData: FormData): Promise<void> {
  const staff = await requirePlatformAdmin();
  const validated = validateSendLimitInput({
    perTransferUsd: String(formData.get('perTransferUsd') ?? ''),
    t1DailyUsd: String(formData.get('t1DailyUsd') ?? ''),
    t0DailyUsd: '', // a customer override never carries T0 (the tier gate is never raised per customer)
    expiresAt: String(formData.get('expiresAt') ?? ''),
    reason: String(formData.get('reason') ?? ''),
    clear: formData.get('clear') === 'on',
  });
  const phone = String(formData.get('phone') ?? '').trim();
  if (!phone) throw new Error('Phone is required.');
  const partnerId = targetPartnerId(staff, formData); // platform staff MUST name the tenant

  const customer = await getCustomerStore(getStore()).getCustomer(partnerId, phone);
  if (!customer) throw new Error('Customer not found.');

  const nowIso = new Date().toISOString();
  const value = validated.value === null ? null : { ...validated.value, setBy: staff.username, setAt: nowIso };
  await getDb().transaction(async (tx) => {
    // tx-bound repos ONLY inside the transaction (a root-handle call here would
    // deadlock PGlite's single connection / hold a second Neon pool connection).
    const { found, previous } = await createCustomerStore(tx, getStore()).setSendLimitOverride(
      customer.partnerId, customer.senderPhone, value,
    );
    if (!found) throw new Error('Customer not found.'); // raced a delete ⇒ nothing written
    await createAuditRepo(tx).record({
      partnerId: customer.partnerId,
      actor: staff.username,
      actorType: 'staff',
      action: value === null ? 'send_limits.clear' : 'send_limits.set',
      subjectId: customer.senderPhone,
      meta: { scope: 'customer', old: previous, new: value, reason: validated.reason, expiresAt: validated.expiresAt ?? null },
    });
  });
  revalidatePath('/admin-dashboard/customers');
  revalidatePath(`/admin-dashboard/customers/${phone}`);
}
