'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin, requireScope } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getPartnerStore } from '@/lib/partner-store';
import { normalizePhone, isValidPhone } from '@/lib/phone';
import { countryForPhone } from '@/lib/partner-currency';
import { DEFAULT_PARTNER_ID, DEFAULT_SENDER_COUNTRY } from '@/lib/defaults';
import type { CountryCode, KycStatus, PartnerId } from '@/lib/types';

const VALID_COUNTRIES = new Set<CountryCode>(['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN']);

export async function markCustomerVerifiedAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const phone = String(formData.get('phone') ?? '').trim();
  if (!phone) throw new Error('Phone is required.');

  const cs = getCustomerStore(getStore());
  const customer = await cs.getCustomer(phone);
  if (!customer) throw new Error('Customer not found.');

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
  await requireAdmin();
  const phone = String(formData.get('phone') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim() || 'Manual rejection by staff';
  if (!phone) throw new Error('Phone is required.');

  const cs = getCustomerStore(getStore());
  const customer = await cs.getCustomer(phone);
  if (!customer) throw new Error('Customer not found.');

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
