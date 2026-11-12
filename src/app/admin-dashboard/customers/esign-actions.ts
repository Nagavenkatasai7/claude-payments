'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth';
import { scopeOf, canSee } from '@/lib/staff-scope';
import { getDb } from '@/db/client';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { recordStaffEsignWithdrawal } from '@/lib/esign-staff-withdraw';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { logWarn } from '@/lib/log';
import type { PartnerId } from '@/lib/types';

// The detail route pattern (every ref), as in ./actions.ts.
const CUSTOMER_DETAIL_ROUTE = '/admin-dashboard/customers/[ref]';

/**
 * The tenant an admin action targets, exactly as ./actions.ts targetPartnerId: partner staff are
 * PINNED to their own (the form field is ignored); platform staff MUST name one (no silent default).
 */
function targetPartnerId(staff: { partnerId?: string }, formData: FormData): PartnerId {
  if (staff.partnerId) return staff.partnerId;
  const requested = String(formData.get('partnerId') ?? '').trim();
  if (!requested) throw new Error('Partner is required.');
  return requested;
}

/**
 * Fix pack 6 truth check TC-T1: record that a customer asked the provider to withdraw the E-SIGN
 * consent (the consent text's "contact the provider named on your receipt"). In order: the site
 * host guard, requireAdmin(); the tenant pin and keyed read of manualKycDecisionAction
 * (targetPartnerId, getCustomer(partnerId, phone), canSee; out of scope = "Customer not found.");
 * the "confirm" tick (the customer asked for it) is required; then ONE transaction writes the
 * withdrawal and the `customer.consent.esign` audit row { version, on: false, via: 'staff',
 * actorScope } (recordStaffEsignWithdrawal) on the customer's own (partnerId, senderPhone).
 * Nothing on file or already withdrawn: nothing written. Throws an Error for a refusal (this
 * file's convention) and returns void.
 * No step-up: recording a withdrawal weakens no control, it only makes the next pay-page payment
 * ask the customer again. A failed write logs the error NAME only (never an error object or phone).
 */
export async function recordEsignWithdrawalAdminAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requireAdmin();
  const phone = String(formData.get('phone') ?? '').trim();
  const partnerId = targetPartnerId(staff, formData);
  if (!phone) throw new Error('Customer not found.');
  const customer = await getCustomerStore(getStore()).getCustomer(partnerId, phone);
  if (!customer || !canSee(scopeOf(staff), customer.partnerId)) {
    throw new Error('Customer not found.');
  }
  if (formData.get('confirm') !== 'on') throw new Error('Confirm that the customer asked to withdraw this consent.');
  try {
    await recordStaffEsignWithdrawal(getDb(), {
      partnerId: customer.partnerId,
      phone: customer.senderPhone,
      actor: staff.username,
      actorScope: scopeOf(staff).kind,
    });
  } catch (err) {
    logWarn('admin.customers.esign', err instanceof Error ? err.name : 'error', { partnerId: customer.partnerId });
    throw new Error('Something went wrong. Nothing was changed. Try again.');
  }
  revalidatePath(CUSTOMER_DETAIL_ROUTE, 'page');
}
