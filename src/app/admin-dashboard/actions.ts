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
import { scopeOf, canSee } from '@/lib/staff-scope';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getDb } from '@/db/client';
import type { Staff, StaffPermissions } from '@/lib/types';

async function requirePermission(
  permission: keyof StaffPermissions,
): Promise<Staff> {
  const staff = await requireStaff();
  if (!hasPermission(staff, permission)) {
    throw new Error('You do not have permission to perform this action.');
  }
  return staff;
}

/**
 * Load a transfer by form-supplied id AND enforce the caller's partner scope.
 *
 * Every action below is a public POST endpoint, so page-level gating is not
 * enough: a partner-scoped staff member could `curl` it with another tenant's
 * transfer id. We resolve the transfer and reject (with a generic message, to
 * avoid disclosing the existence of out-of-scope records) before any mutation.
 * Platform staff (no partnerId) pass `canSee` for every partner; a partner-admin
 * only for their own. Closes the H1/H2 cross-tenant write holes.
 */
async function getScopedTransfer(staff: Staff, id: string) {
  if (!id) throw new Error('Missing transfer id');
  const store = getStore();
  const transfer = await store.getTransfer(id);
  if (!transfer || !canSee(scopeOf(staff), transfer.partnerId)) {
    throw new Error('Transfer not found');
  }
  return { store, transfer };
}

export async function cancelTransferAction(formData: FormData): Promise<void> {
  const staff = await requirePermission('canCancel');
  const id = String(formData.get('id') ?? '');
  const { store } = await getScopedTransfer(staff, id);
  await cancelTransfer(store, id);
  // 'layout' revalidates every page under /admin-dashboard (transactions, schedules,
  // compliance, etc.), not just the root — so the change shows up wherever the
  // viewer happens to be.
  revalidatePath('/admin-dashboard', 'layout');
}

export async function assignTransferAction(formData: FormData): Promise<void> {
  const staff = await requirePermission('canAssign');
  const id = String(formData.get('id') ?? '');
  const assignee = String(formData.get('assignee') ?? '');
  const note = String(formData.get('note') ?? '').slice(0, 500); // L3: bound stored string
  const { store, transfer } = await getScopedTransfer(staff, id);
  // Only allow assigning to a real staff account…
  const assigneeStaff = await getAuthStore().getStaff(assignee);
  if (!assigneeStaff) {
    throw new Error('Cannot assign: unknown staff member.');
  }
  // …who can actually see this transfer's tenant (M2: no cross-partner assignment)…
  if (!canSee(scopeOf(assigneeStaff), transfer.partnerId)) {
    throw new Error('Cannot assign: staff member is outside this transfer’s scope.');
  }
  // …and who is still active (don't orphan work on a suspended account).
  if (assigneeStaff.status === 'suspended') {
    throw new Error('Cannot assign: staff member is inactive.');
  }
  await assignTransfer(store, id, assignee, note);
  revalidatePath('/admin-dashboard', 'layout');
}

export async function resendPaymentLinkAction(
  formData: FormData,
): Promise<void> {
  const staff = await requirePermission('canResend');
  const id = String(formData.get('id') ?? '');
  const { store } = await getScopedTransfer(staff, id);
  await resendPaymentLink(store, sendText, id);
  revalidatePath('/admin-dashboard', 'layout');
}

/**
 * Release a held (in_review) transfer — triggers stage-2 delivery.
 * Requires admin role (high-stakes compliance decision) AND partner scope:
 *   (a) requireAdmin — only staff with role:'admin'
 *   (b) getScopedTransfer — the transfer must be in the caller's scope (H2 fix:
 *       a partner-admin can no longer release another tenant's held transfer)
 *   (c) releaseTransfer re-verifies status === 'in_review'
 */
export async function releaseTransferAction(formData: FormData): Promise<void> {
  const staff = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  const { store } = await getScopedTransfer(staff, id);
  await releaseTransfer(store, id);
  revalidatePath('/admin-dashboard', 'layout');
}

/**
 * Reject a held (in_review) transfer — cancels it (mock refund, adminNote set).
 * Requires admin role + partner scope (see releaseTransferAction).
 */
export async function rejectTransferAction(formData: FormData): Promise<void> {
  const staff = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  const { store } = await getScopedTransfer(staff, id);
  await rejectTransfer(store, id);
  revalidatePath('/admin-dashboard', 'layout');
}

/**
 * Reveal the FULL payout destination of one transfer (Stage 3 audited reveal).
 * List reads are masked at the repo layer (****last4), so this action is the
 * ONLY path from a staff view to the decrypted value — self-gated (staff
 * session + partner scope) and every call writes an append-only audit_events
 * row. The decrypted value is returned to the caller, never logged.
 */
export async function revealDestinationAction(
  transferId: string,
): Promise<{ destination: string } | { error: string }> {
  const staff = await requireStaff();
  try {
    const { store, transfer } = await getScopedTransfer(staff, transferId);
    const full = await store.getTransferDecrypted(transferId);
    if (!full) return { error: 'Transfer not found' };
    await createAuditRepo(getDb()).record({
      partnerId: transfer.partnerId,
      actor: staff.username,
      actorType: 'staff',
      action: 'pii.reveal',
      subjectId: transferId,
      meta: { field: 'payout_destination' },
    });
    return { destination: full.payoutDestination };
  } catch {
    // Out-of-scope reads collapse to the same generic shape as missing ones.
    return { error: 'Transfer not found' };
  }
}
