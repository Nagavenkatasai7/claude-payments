'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin, requireScope } from '@/lib/auth';
import { scopeOf, canSee } from '@/lib/staff-scope';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getKycCaseStore } from '@/lib/kyc-case-store';
import { sendGateActive } from '@/lib/kyc-gate';
import { sendVerificationStatus } from '@/lib/whatsapp';
import { getPartnerStore } from '@/lib/partner-store';
import { normalizePhone, isValidPhone } from '@/lib/phone';
import { countryForPhone } from '@/lib/partner-currency';
import { DEFAULT_PARTNER_ID, DEFAULT_SENDER_COUNTRY } from '@/lib/defaults';
import type { CountryCode, KycStatus, PartnerId } from '@/lib/types';

const VALID_COUNTRIES = new Set<CountryCode>(['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN']);

export async function markCustomerVerifiedAction(formData: FormData): Promise<void> {
  const staff = await requireAdmin();
  const phone = String(formData.get('phone') ?? '').trim();
  if (!phone) throw new Error('Phone is required.');

  const cs = getCustomerStore(getStore());
  const customer = await cs.getCustomer(phone);
  // H3 fix: the customer key is global (customer:<phone>), so an unscoped lookup
  // lets a partner-admin flip another tenant's customer. Reject out-of-scope.
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

  const cs = getCustomerStore(getStore());
  const customer = await cs.getCustomer(phone);
  if (!customer || !canSee(scopeOf(staff), customer.partnerId)) {
    throw new Error('Customer not found.');
  }

  // Attribute the reviewer by display name + stable username, e.g. "Main Admin (forextransfer)".
  const reviewer =
    staff.name && staff.name !== staff.username ? `${staff.name} (${staff.username})` : staff.username;
  await getKycCaseStore(getStore()).review(phone, decision, reviewer, reason);
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

  const cs = getCustomerStore(getStore());
  if (await cs.getCustomer(normalized)) {
    throw new Error('A customer with that phone already exists.');
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
  redirect(`/admin-dashboard/customers/${normalized}`);
}

export async function markCustomerRejectedAction(formData: FormData): Promise<void> {
  const staff = await requireAdmin();
  const phone = String(formData.get('phone') ?? '').trim();
  const reason =
    String(formData.get('reason') ?? '').trim().slice(0, 500) || 'Manual rejection by staff';
  if (!phone) throw new Error('Phone is required.');

  const cs = getCustomerStore(getStore());
  const customer = await cs.getCustomer(phone);
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
