'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import { getPartnerStore } from '@/lib/partner-store';
import { newTransferId } from '@/lib/id';
import type { Partner, PartnerStatus } from '@/lib/types';

export async function createPartnerAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const name = String(formData.get('name') ?? '').trim();
  if (!name) throw new Error('Partner name is required.');

  const countries = formData.getAll('countries').map(String) as Partner['countries'];
  if (countries.length === 0) throw new Error('At least one country is required.');

  const id = newTransferId();
  const now = new Date().toISOString();
  const partner: Partner = {
    id,
    name,
    countries,
    status: 'active',
    brandName: String(formData.get('brandName') ?? '').trim() || undefined,
    primaryColor: String(formData.get('primaryColor') ?? '').trim() || undefined,
    logoUrl: String(formData.get('logoUrl') ?? '').trim() || undefined,
    adminNote: String(formData.get('adminNote') ?? '').trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  await getPartnerStore().savePartner(partner);
  revalidatePath('/dashboard/partners');
  redirect(`/dashboard/partners/${id}`);
}

export async function updatePartnerAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get('id') ?? '').trim();
  if (!id) throw new Error('Partner id is required.');

  const ps = getPartnerStore();
  const existing = await ps.getPartner(id);
  if (!existing) throw new Error('Partner not found.');

  const submittedCountries = formData.getAll('countries').map(String) as Partner['countries'];
  const updated: Partner = {
    ...existing,
    name: String(formData.get('name') ?? existing.name).trim() || existing.name,
    countries: submittedCountries.length > 0 ? submittedCountries : existing.countries,
    brandName: String(formData.get('brandName') ?? '').trim() || undefined,
    primaryColor: String(formData.get('primaryColor') ?? '').trim() || undefined,
    logoUrl: String(formData.get('logoUrl') ?? '').trim() || undefined,
    adminNote: String(formData.get('adminNote') ?? '').trim() || undefined,
    updatedAt: new Date().toISOString(),
  };
  await ps.savePartner(updated);
  revalidatePath('/dashboard/partners');
  revalidatePath(`/dashboard/partners/${id}`);
}

export async function setPartnerStatusAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get('id') ?? '').trim();
  const status = String(formData.get('status') ?? '') as PartnerStatus;
  if (status !== 'active' && status !== 'suspended') {
    throw new Error('Status must be active or suspended.');
  }
  const ps = getPartnerStore();
  const existing = await ps.getPartner(id);
  if (!existing) throw new Error('Partner not found.');
  await ps.savePartner({ ...existing, status, updatedAt: new Date().toISOString() });
  revalidatePath('/dashboard/partners');
  revalidatePath(`/dashboard/partners/${id}`);
}
