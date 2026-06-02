'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin, requirePlatformAdmin } from '@/lib/auth';
import { scopeOf, canSee } from '@/lib/staff-scope';
import { getPartnerStore } from '@/lib/partner-store';
import { getAuthStore } from '@/lib/auth-store';
import { hashPassword } from '@/lib/password';
import { newTransferId } from '@/lib/id';
import type { Partner, PartnerStatus, PartnerId, StaffRole } from '@/lib/types';

export async function createPartnerAction(formData: FormData): Promise<void> {
  // M5: creating a tenant is platform governance — partner-admins must not reach it.
  await requirePlatformAdmin();
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
  revalidatePath('/admin-dashboard/partners');
  redirect(`/admin-dashboard/partners/${id}`);
}

export async function updatePartnerAction(formData: FormData): Promise<void> {
  const staff = await requireAdmin();
  const id = String(formData.get('id') ?? '').trim();
  if (!id) throw new Error('Partner id is required.');

  const ps = getPartnerStore();
  const existing = await ps.getPartner(id);
  // M4: a partner-admin may edit only their OWN partner's branding; a platform
  // admin may edit any. Generic message — don't disclose out-of-scope partners.
  if (!existing || !canSee(scopeOf(staff), id)) throw new Error('Partner not found.');

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
  revalidatePath('/admin-dashboard/partners');
  revalidatePath(`/admin-dashboard/partners/${id}`);
}

export async function setPartnerStatusAction(formData: FormData): Promise<void> {
  // M4: suspend/reactivate is platform governance (a tenant shouldn't suspend
  // itself, and a partner-admin must not suspend a rival). Platform-admin only.
  await requirePlatformAdmin();
  const id = String(formData.get('id') ?? '').trim();
  const status = String(formData.get('status') ?? '') as PartnerStatus;
  if (status !== 'active' && status !== 'suspended') {
    throw new Error('Status must be active or suspended.');
  }
  const ps = getPartnerStore();
  const existing = await ps.getPartner(id);
  if (!existing) throw new Error('Partner not found.');
  await ps.savePartner({ ...existing, status, updatedAt: new Date().toISOString() });
  if (status === 'suspended') {
    const authStore = getAuthStore();
    const all = await authStore.listStaff();
    const affected = all.filter((s) => s.partnerId === id);
    for (const s of affected) await authStore.deleteAllSessionsFor(s.username);
  }
  revalidatePath('/admin-dashboard/partners');
  revalidatePath(`/admin-dashboard/partners/${id}`);
}

export async function createPartnerStaffAction(
  partnerId: PartnerId,
  formData: FormData,
): Promise<void> {
  await requirePlatformAdmin();
  const username = String(formData.get('username') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const role = String(formData.get('role') ?? 'agent') as StaffRole;
  if (role !== 'admin' && role !== 'agent') throw new Error('Invalid role.');
  if (!username || !name || !password) throw new Error('username, name, and password are required.');

  // Validate partner exists — server actions are POST endpoints callable with
  // any bound partnerId, so the JSX `bind(null, partner.id)` is not a
  // sufficient guard against direct invocation.
  const partner = await getPartnerStore().getPartner(partnerId);
  if (!partner) throw new Error('Partner not found.');

  // Reject username collision. saveStaff would silently overwrite — and the
  // existing reverse-index of sessions for the clobbered username would then
  // resolve to a record now bound to a different partner. addStaffAction in
  // /admin-dashboard/team/actions.ts has the same guard for the same reason.
  const authStore = getAuthStore();
  if (await authStore.getStaff(username)) {
    throw new Error('That username already exists.');
  }

  await authStore.saveStaff({
    username,
    name,
    role,
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    partnerId,                  // taken from URL, not form
  });
  revalidatePath(`/admin-dashboard/partners/${partnerId}`);
}

export async function removePartnerStaffAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const username = String(formData.get('username') ?? '').trim();
  if (!username) throw new Error('username is required.');
  const authStore = getAuthStore();
  const staff = await authStore.getStaff(username);
  if (!staff) return;
  // M3: this is the PARTNER-staff endpoint. Refuse to delete a platform account
  // here — the dedicated team/actions guard protects platform admins, and this
  // twin must not be a bypass. Platform staff are managed from the Team page.
  if (!staff.partnerId) {
    throw new Error('Use the Team page to manage platform staff.');
  }
  await authStore.deleteStaff(username);
  await authStore.deleteAllSessionsFor(username);
  revalidatePath(`/admin-dashboard/partners/${staff.partnerId}`);
}
