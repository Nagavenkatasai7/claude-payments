'use server';

import { revalidatePath } from 'next/cache';
import { requireStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { pokeWorker } from '@/lib/outbox';
import type { Staff } from '@/lib/types';

// Operations actions (Stage 5). Self-gated (every server action is a public
// POST endpoint): PLATFORM staff only — the ops surface is cross-tenant by
// nature, so partner-scoped staff are refused outright. Every mutation writes
// an append-only audit_events row.

async function requirePlatformStaff(): Promise<Staff> {
  const staff = await requireStaff();
  if (staff.partnerId) throw new Error('Not available.');
  return staff;
}

function idFrom(formData: FormData): number {
  const id = Number(String(formData.get('id') ?? ''));
  if (!Number.isInteger(id) || id <= 0) throw new Error('id is required.');
  return id;
}

/** Resurrect a dead outbox row for a fresh attempt cycle (and drain it now). */
export async function retryDeadAction(formData: FormData): Promise<void> {
  const staff = await requirePlatformStaff();
  const id = idFrom(formData);
  await createOutboxRepo(getDb()).retryDead(id);
  await createAuditRepo(getDb()).record({
    actor: staff.username,
    actorType: 'staff',
    action: 'ops.outbox.retry',
    subjectId: String(id),
  });
  pokeWorker();
  revalidatePath('/admin-dashboard/ops');
}

/** Permanently dismiss a dead row (marks it done — it will never run). */
export async function dismissDeadAction(formData: FormData): Promise<void> {
  const staff = await requirePlatformStaff();
  const id = idFrom(formData);
  await createOutboxRepo(getDb()).markDone(id);
  await createAuditRepo(getDb()).record({
    actor: staff.username,
    actorType: 'staff',
    action: 'ops.outbox.dismiss',
    subjectId: String(id),
  });
  revalidatePath('/admin-dashboard/ops');
}
