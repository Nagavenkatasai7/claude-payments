'use server';

import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { createRecipientRepo } from '@/db/repos/aux-repos';
import { requirePortalSite } from '@/lib/portal-site';
import { requireFreshPortalAuth } from '@/lib/portal-auth';
import { getRedis } from '@/lib/redis';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { auditSubjectId } from '@/lib/customer-ref';
import { newRequestKey, runOnce, RequestInFlightError } from '@/lib/portal-request-key';
import {
  deleteRecipientWithSchedules,
  findByRid,
  isRid,
  lockRecipientBook,
  PORTAL_RECIPIENT_LIMIT,
  recipientRid,
  recordRecipientAudit,
  validateAddInput,
  validateEditInput,
  type RecipientFormErrors,
} from '@/lib/portal-recipients';
import { normalizePhone } from '@/lib/phone';
import { logWarn } from '@/lib/log';
import type { MessageKey } from '@/lib/i18n';
import type { PartnerId } from '@/lib/types';

/**
 * Customer-portal saved recipients (UI redesign M2-8, Task 8.3). Public POST endpoints: each one
 * runs the host gate FIRST (requirePortalSite), then the 15-minute step-up (requireFreshPortalAuth,
 * which also requires the session), then the per-customer limit. The partner is the HOST's and the
 * phone the SESSION's; a rid comes from the route (bound), is re-validated and resolves only inside
 * (partner, phone), so another customer's or tenant's rid is the same "not found".
 *
 * Add and edit validate BEFORE runOnce, so a refused form is never stored under its request key;
 * every non-success answer carries a FRESH request key, so the corrected resubmit runs. Delete is
 * naturally idempotent (the second one finds no live recipient). Next's Origin/Host check covers
 * these actions (node_modules/next/dist/docs/01-app/02-guides/data-security.md:550).
 */

export interface RecipientFormState {
  requestKey: string;
  error?: MessageKey;
  errors?: RecipientFormErrors;
  /** Echo of the NON-secret inputs only (never bank values), so the form keeps them. */
  values?: { name?: string; recipientPhone?: string; country?: string };
}

const text = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v.slice(0, 200) : '';
};

const echo = (fd: FormData) => ({ name: text(fd, 'name'), recipientPhone: text(fd, 'recipientPhone'), country: text(fd, 'country') });

/** Per customer, 30 changes an hour. Fails OPEN on a limiter error (the step-up already gates it). */
async function withinLimit(partnerId: PartnerId, phone: string): Promise<boolean> {
  try {
    const r = await checkIpRateLimit(getRedis(), PORTAL_RECIPIENT_LIMIT.scope, auditSubjectId(partnerId, phone), {
      limit: PORTAL_RECIPIENT_LIMIT.limit,
      windowSec: PORTAL_RECIPIENT_LIMIT.windowSec,
    });
    return r.allowed;
  } catch {
    logWarn('portal.recipients.limit', 'limiter unavailable');
    return true;
  }
}

const refuse = (fd: FormData, e: Omit<RecipientFormState, 'requestKey' | 'values'>): RecipientFormState => ({
  requestKey: newRequestKey(),
  values: echo(fd),
  ...e,
});

type Outcome = { kind: 'done' | 'exists' | 'not_found' | 'unchanged' };

/** runOnce with the portal's error mapping; null = refused (the returned state says why). */
async function once(
  scope: string,
  partnerId: PartnerId,
  phone: string,
  fd: FormData,
  fn: () => Promise<Outcome>,
): Promise<Outcome | RecipientFormState> {
  try {
    return (await runOnce(getRedis(), scope, partnerId, phone, text(fd, 'requestKey'), fn)).value;
  } catch (err) {
    if (err instanceof RequestInFlightError) return refuse(fd, { error: 'portal.recipients.busy' });
    logWarn('portal.recipients.write', 'write failed');
    return refuse(fd, { error: 'portal.recipients.failed' });
  }
}

/** Add a saved recipient (bank details through the pay page's validator). */
export async function addRecipientAction(_prev: RecipientFormState, formData: FormData): Promise<RecipientFormState> {
  await requirePortalSite();
  const ctx = await requireFreshPortalAuth('/portal/recipients/new');
  const pid = ctx.site.partnerId;
  const phone = ctx.session.phone;
  if (!(await withinLimit(pid, phone))) return refuse(formData, { error: 'portal.recipients.too_many' });
  const v = validateAddInput(formData);
  if (!v.ok) return refuse(formData, { errors: v.errors });
  const input = v.value;
  // The duplicate check runs INSIDE runOnce, so a double submit replays the first run's "done"; an
  // "exists" answer carries a fresh request key, so it is never replayed to a corrected form.
  // M2-14 (PR 398 L5): the check and the write run in ONE transaction under the address-book lock, so
  // two tabs (two request keys) adding the same number can't both pass the check and overwrite.
  const out = await once('portal-recipient-add', pid, phone, formData, async () =>
    getDb().transaction(async (tx) => {
      await lockRecipientBook(tx, pid, phone);
      const repo = createRecipientRepo(tx);
      const live = await repo.listAllForSender(pid, phone);
      if (live.some((r) => normalizePhone(r.recipientPhone) === input.recipientPhone)) return { kind: 'exists' as const };
      const rid = recipientRid(pid, phone, input.recipientPhone);
      await repo.upsertRecipient(pid, phone, { ...input, lastUsedAt: new Date().toISOString() });
      await recordRecipientAudit(tx, { partnerId: pid, phone, action: 'recipient.create', meta: { rid, fields: ['name', 'destination'] } });
      return { kind: 'done' as const };
    }),
  );
  if ('requestKey' in out) return out;
  if (out.kind === 'exists') return refuse(formData, { error: 'portal.recipients.exists' });
  redirect('/portal/recipients?done=added');
}

/** Edit a saved recipient's name and, optionally, its bank account. `rid` is the route's (bound). */
export async function editRecipientAction(rid: string, _prev: RecipientFormState, formData: FormData): Promise<RecipientFormState> {
  await requirePortalSite();
  const ctx = await requireFreshPortalAuth(isRid(rid) ? `/portal/recipients/${rid}/edit` : '/portal/recipients');
  const pid = ctx.site.partnerId;
  const phone = ctx.session.phone;
  if (!(await withinLimit(pid, phone))) return refuse(formData, { error: 'portal.recipients.too_many' });
  const existing = await findByRid(getDb(), pid, phone, rid);
  if (!existing) return refuse(formData, { error: 'portal.recipients.not_found' });
  const v = validateEditInput(formData, existing);
  if (!v.ok) return refuse(formData, { errors: v.errors });
  const change = v.value;

  const out = await once('portal-recipient-edit', pid, phone, formData, async () => {
    return getDb().transaction(async (tx): Promise<Outcome> => {
      await lockRecipientBook(tx, pid, phone); // M2-10: serialized with a portal schedule create
      const current = await findByRid(tx, pid, phone, rid); // deleted before this read → not found
      if (!current) return { kind: 'not_found' };
      if (change.fields.length === 0) return { kind: 'unchanged' };
      // Update-only and live-only: a delete that commits after the read above wins (never un-deleted).
      const updated = await createRecipientRepo(tx).updateLiveRecipient(pid, phone, {
        name: change.name,
        recipientPhone: current.recipientPhone, // the stored key, never a form field
        payoutMethod: change.payoutMethod,
        payoutDestination: change.payoutDestination,
        lastUsedAt: current.lastUsedAt,
      });
      if (!updated) return { kind: 'not_found' };
      await recordRecipientAudit(tx, { partnerId: pid, phone, action: 'recipient.update', meta: { rid: rid, fields: change.fields } });
      return { kind: 'done' };
    });
  });
  if ('requestKey' in out) return out;
  if (out.kind === 'not_found') return refuse(formData, { error: 'portal.recipients.not_found' });
  redirect('/portal/recipients?done=updated');
}

/**
 * Delete a saved recipient: a tombstone (the row is kept, every read hides it) plus the cancel of
 * each active or paused schedule to that person (owner O12), in one audited transaction.
 */
export async function deleteRecipientAction(rid: string, _formData: FormData): Promise<void> {
  await requirePortalSite();
  const ctx = await requireFreshPortalAuth('/portal/recipients');
  const pid = ctx.site.partnerId;
  const phone = ctx.session.phone;
  if (!(await withinLimit(pid, phone))) redirect('/portal/recipients?error=too_many');
  let result: 'deleted' | 'not_found' | 'failed';
  try {
    result = (await deleteRecipientWithSchedules(getDb(), pid, phone, rid)).ok ? 'deleted' : 'not_found';
  } catch {
    logWarn('portal.recipients.delete', 'delete failed');
    result = 'failed';
  }
  redirect(result === 'deleted' ? '/portal/recipients?done=deleted' : `/portal/recipients?error=${result}`);
}
