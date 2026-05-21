'use server';

import { revalidatePath } from 'next/cache';
import { getStore } from '@/lib/store';
import { getAuthStore } from '@/lib/auth-store';
import { sendText } from '@/lib/whatsapp';
import {
  cancelTransfer,
  assignTransfer,
  resendPaymentLink,
} from '@/lib/dashboard-ops';
import { requireStaff } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import type { StaffPermissions } from '@/lib/types';

async function requirePermission(
  permission: keyof StaffPermissions,
): Promise<void> {
  const staff = await requireStaff();
  if (!hasPermission(staff, permission)) {
    throw new Error('You do not have permission to perform this action.');
  }
}

export async function cancelTransferAction(formData: FormData): Promise<void> {
  await requirePermission('canCancel');
  const id = formData.get('id') as string;
  await cancelTransfer(getStore(), id);
  revalidatePath('/dashboard');
}

export async function assignTransferAction(formData: FormData): Promise<void> {
  await requirePermission('canAssign');
  const id = formData.get('id') as string;
  const assignee = (formData.get('assignee') as string) ?? '';
  const note = (formData.get('note') as string) ?? '';
  // Only allow assigning to a real staff account.
  if (!(await getAuthStore().getStaff(assignee))) {
    throw new Error('Cannot assign: unknown staff member.');
  }
  await assignTransfer(getStore(), id, assignee, note);
  revalidatePath('/dashboard');
}

export async function resendPaymentLinkAction(
  formData: FormData,
): Promise<void> {
  await requirePermission('canResend');
  const id = formData.get('id') as string;
  await resendPaymentLink(getStore(), sendText, id);
  revalidatePath('/dashboard');
}
