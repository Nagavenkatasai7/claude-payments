'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';

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
