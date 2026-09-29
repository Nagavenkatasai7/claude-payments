'use server';

// UI redesign M3-21: the platform side of go-live. A partner REQUESTS go-live from its onboarding
// checklist (M3-20, requestGoLive); a SmartRemit platform admin approves it here, and only then may
// the partner hold LIVE API keys (partner-go-live-repo.ts isLiveApproved).
//
// A server action is a public POST endpoint (CLAUDE.md), so this one refuses on a partner-site host
// FIRST, gates on requirePlatformAdmin() BEFORE any read, takes the target ONLY from the `id` field
// (the page's route param; any partnerId / partner field is never read), checks the partner exists,
// validates the reason, and writes the approval and its audit row in ONE transaction. redirect() and
// notFound() are never inside a try (next/dist/docs/01-app/03-api-reference/04-functions/redirect.md).
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { requirePlatformAdmin } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { approveGoLive, getGoLiveForUpdate } from '@/db/repos/partner-go-live-repo';
import { createPartnerStore } from '@/lib/partner-store';
import { requireStaffReason } from '@/lib/send-limits';

export type GoLiveApprovalOutcome = 'approved' | 'already' | 'not_requested' | 'reason_required';

export async function approveGoLiveAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();

  const id = String(formData.get('id') ?? '').trim();
  if (!id) notFound();
  const partner = await createPartnerStore(getDb()).getPartner(id);
  if (!partner) notFound();
  const page = `/admin-dashboard/partners/${encodeURIComponent(id)}`;

  let reason: string | null = null;
  try {
    reason = requireStaffReason(formData.get('reason')); // ≥ 10 characters, bounded
  } catch {
    reason = null;
  }
  if (reason === null) redirect(`${page}?golive=reason_required`);
  const why: string = reason;

  const outcome = await getDb().transaction(async (tx): Promise<GoLiveApprovalOutcome> => {
    // The row lock serialises two approvers, so exactly one audit row is written.
    const row = await getGoLiveForUpdate(tx, id);
    if (!row || !row.requestedAt) return 'not_requested';
    if (row.approvedAt) return 'already';
    if (!(await approveGoLive(tx, id, staff.username))) return 'not_requested';
    await createAuditRepo(tx).record({
      partnerId: id,
      actor: staff.username,
      actorType: 'staff',
      action: 'partner.go_live.approve',
      subjectId: id,
      // The reason is platform-internal: the tenant audit view drops every meta key not allowlisted
      // for this action (partner-audit-view.ts DETAIL_KEYS).
      meta: { reason: why, actorScope: 'platform' },
    });
    return 'approved';
  });

  revalidatePath(page);
  redirect(`${page}?golive=${outcome}`);
}
