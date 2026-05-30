'use server';

import { revalidatePath } from 'next/cache';
import { getStore } from '@/lib/store';
import { getAuthStore } from '@/lib/auth-store';
import { sendText } from '@/lib/whatsapp';
import {
  cancelTransfer,
  assignTransfer,
  resendPaymentLink,
  releaseTransfer,
  rejectTransfer,
} from '@/lib/dashboard-ops';
import { requireStaff, requireAdmin } from '@/lib/auth';
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
  // 'layout' revalidates every page under /dashboard (transactions, schedules,
  // compliance, etc.), not just the root — so the change shows up wherever the
  // viewer happens to be.
  revalidatePath('/dashboard', 'layout');
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
  // 'layout' revalidates every page under /dashboard (transactions, schedules,
  // compliance, etc.), not just the root — so the change shows up wherever the
  // viewer happens to be.
  revalidatePath('/dashboard', 'layout');
}

export async function resendPaymentLinkAction(
  formData: FormData,
): Promise<void> {
  await requirePermission('canResend');
  const id = formData.get('id') as string;
  await resendPaymentLink(getStore(), sendText, id);
  // 'layout' revalidates every page under /dashboard (transactions, schedules,
  // compliance, etc.), not just the root — so the change shows up wherever the
  // viewer happens to be.
  revalidatePath('/dashboard', 'layout');
}

/**
 * Release a held (in_review) transfer — triggers stage-2 delivery.
 * Requires admin role (high-stakes compliance decision).
 * Security checklist:
 *   (a) calls requireAdmin — only staff with role:'admin' can proceed
 *   (b) releaseTransfer loads the transfer from the trusted store and verifies status === 'in_review'
 *   (c) id comes from the trusted FormData arg, not ambient state
 */
export async function releaseTransferAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = formData.get('id') as string;
  if (!id) throw new Error('Missing transfer id');
  await releaseTransfer(getStore(), id);
  revalidatePath('/dashboard', 'layout');
}

/**
 * Reject a held (in_review) transfer — cancels it (mock refund, adminNote set).
 * Requires admin role (high-stakes compliance decision).
 * Security checklist:
 *   (a) calls requireAdmin — only staff with role:'admin' can proceed
 *   (b) rejectTransfer loads the transfer from the trusted store and verifies status === 'in_review'
 *   (c) id comes from the trusted FormData arg, not ambient state
 */
export async function rejectTransferAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = formData.get('id') as string;
  if (!id) throw new Error('Missing transfer id');
  await rejectTransfer(getStore(), id);
  revalidatePath('/dashboard', 'layout');
}
