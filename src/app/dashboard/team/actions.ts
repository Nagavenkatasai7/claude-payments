'use server';

import { revalidatePath } from 'next/cache';
import { getAuthStore } from '@/lib/auth-store';
import { requireAdmin } from '@/lib/auth';
import { hashPassword } from '@/lib/password';
import type { Staff } from '@/lib/types';

function readPermissions(formData: FormData) {
  return {
    canCancel: formData.get('canCancel') === 'on',
    canResend: formData.get('canResend') === 'on',
    canAssign: formData.get('canAssign') === 'on',
  };
}

export async function addStaffAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const username = String(formData.get('username') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!username || !name || !password) {
    throw new Error('Name, username, and password are all required.');
  }
  const store = getAuthStore();
  if (await store.getStaff(username)) {
    throw new Error('That username already exists.');
  }
  const staff: Staff = {
    username,
    name,
    role: 'agent',
    permissions: readPermissions(formData),
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  await store.saveStaff(staff);
  revalidatePath('/dashboard/team');
}

export async function updatePermissionsAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const username = String(formData.get('username') ?? '');
  const store = getAuthStore();
  const staff = await store.getStaff(username);
  if (!staff) throw new Error('Staff member not found.');
  if (staff.role === 'admin') return; // admins always have all permissions
  staff.permissions = readPermissions(formData);
  await store.saveStaff(staff);
  revalidatePath('/dashboard/team');
}

export async function removeStaffAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const username = String(formData.get('username') ?? '');
  const store = getAuthStore();
  const staff = await store.getStaff(username);
  if (!staff) return;
  if (staff.role === 'admin') {
    throw new Error('Admin accounts cannot be removed here.');
  }
  await store.deleteStaff(username);
  revalidatePath('/dashboard/team');
}
