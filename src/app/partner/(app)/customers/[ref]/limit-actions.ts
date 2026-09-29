'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { PARTNER_ADMIN } from '@/lib/partner-access';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getStore } from '@/lib/store';
import { createCustomerStore, getCustomerStore } from '@/lib/customer-store';
import { getPartnerStore } from '@/lib/partner-store';
import { auditSubjectId, openCustomerRef } from '@/lib/customer-ref';
import { boundReason } from '@/lib/send-limits';
import { partnerMayWriteOverride, validatePartnerCustomerLimit, type ValidatedPartnerCustomerLimit } from '@/lib/partner-send-limits';
import { isPartnerNoteShaped } from '@/lib/partner-transfers';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { SendLimitOverride } from '@/lib/types';
import type { ActionResult } from '../../../action-result';

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/** Thrown INSIDE the transaction when a live SmartRemit override is found under the row lock: rolls the write back. */
class SetBySmartRemitError extends Error {
  constructor() {
    super('set_by_smartremit');
    this.name = 'SetBySmartRemitError';
  }
}

/** Thrown INSIDE the transaction when the row vanished between the read and the lock: nothing written. */
class CustomerGoneError extends Error {
  constructor() {
    super('customer_gone');
    this.name = 'CustomerGoneError';
  }
}

/**
 * Set or clear the send limit of one of THIS tenant's customers (UI redesign M3-12, SPEC §3.4).
 * A MONEY-path write, in order:
 *  1. the partner-site host guard, then the PARTNER_ADMIN gate (outside any try);
 *  2. the sealed ref from the form is opened and re-scoped to the SESSION tenant (any posted
 *     partnerId is never read); a missing, foreign or junk ref is the same not-found result;
 *  3. the input is validated (reason first, whole USD, future expiry; no phone-shaped reason:
 *     audit meta is immutable) and CLAMPED to the platform ladder and any live SmartRemit
 *     partner-level limit; T0 is never set per customer;
 *  4. ONE transaction: the single-column writer reads the previous value FOR UPDATE; a live
 *     override not marked 'partner' (every SmartRemit raise) throws a sentinel, so nothing is
 *     written; else the server-built value { caps, expiresAt, setBy, setAt, setScope: 'partner' }
 *     (or null) and ONE audit row (hashed customer subject, actorScope 'partner').
 * Only the dollar caps move; the resolver re-clamps partner-set entries at read
 * (send-limits.ts resolveEffectiveSendLimits). Sanctions, EDD, the tier gates and the velocity
 * counters are untouched.
 */
export async function setCustomerLimitAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ADMIN);
  const notFound: ActionResult = { ok: false, error: t('partner.customers.notFound') };

  const ref = formData.get('ref');
  if (typeof ref !== 'string' || ref === '') return notFound;
  const opened = openCustomerRef(ref);
  if (!opened || opened.partnerId !== ctx.partnerId) return notFound;
  // The SESSION tenant in the WHERE, never the ref's alone: the same phone at another partner is a
  // different customer.
  const customer = await getCustomerStore(getStore()).getCustomer(ctx.partnerId, opened.phone);
  if (!customer || customer.partnerId !== ctx.partnerId) return notFound;

  const rawReason = boundReason(formData.get('reason'));
  if (!rawReason) return { ok: false, error: t('partner.limits.reasonRequired') };
  if (!isPartnerNoteShaped(rawReason)) return { ok: false, error: t('partner.limits.reasonHasNumber') };

  const now = new Date();
  const partner = await getPartnerStore().getPartner(ctx.partnerId);
  let validated: ValidatedPartnerCustomerLimit;
  try {
    validated = validatePartnerCustomerLimit(
      {
        perTransferUsd: String(formData.get('perTransferUsd') ?? ''),
        t1DailyUsd: String(formData.get('t1DailyUsd') ?? ''),
        t0DailyUsd: '', // never per customer
        expiresAt: String(formData.get('expiresAt') ?? ''),
        reason: rawReason,
        clear: formData.get('clear') === 'on',
      },
      partner ? { sendLimits: partner.sendLimits } : null,
      now,
    );
  } catch {
    return { ok: false, error: t('partner.limits.invalid') };
  }

  const value: SendLimitOverride | null =
    validated.value === null
      ? null
      : { ...validated.value, setBy: ctx.username, setAt: now.toISOString(), setScope: 'partner' };
  const subjectId = auditSubjectId(ctx.partnerId, customer.senderPhone);
  try {
    await getDb().transaction(async (tx) => {
      // tx-bound repos ONLY inside the transaction.
      const { found, previous } = await createCustomerStore(tx, getStore()).setSendLimitOverride(
        ctx.partnerId,
        customer.senderPhone,
        value,
      );
      if (!found) throw new CustomerGoneError(); // raced a delete: nothing written
      if (!partnerMayWriteOverride(previous, now)) throw new SetBySmartRemitError();
      await createAuditRepo(tx).record({
        partnerId: ctx.partnerId,
        actor: ctx.username,
        actorType: 'staff',
        action: value === null ? 'send_limits.clear' : 'send_limits.set',
        subjectId,
        meta: {
          scope: 'customer',
          setScope: 'partner',
          actorScope: 'partner',
          // A replaced (expired) SmartRemit entry is recorded without the platform staff username.
          old: previous && previous.setScope !== 'partner' && previous.setBy ? { ...previous, setBy: 'smartremit' } : previous,
          new: value,
          reason: validated.reason,
          expiresAt: validated.expiresAt ?? null,
          clamped: validated.clamped,
        },
      });
    });
  } catch (err) {
    if (err instanceof SetBySmartRemitError) return { ok: false, error: t('partner.limits.setBySmartRemit') };
    if (err instanceof CustomerGoneError) return notFound;
    // The error NAME only: a failed query's message carries its bound params.
    logWarn('partner.customers.limit', errName(err), { partnerId: ctx.partnerId });
    return { ok: false, error: t('partner.common.failed') };
  }
  // The literal page path (the ref is an opaque sealed token, never a phone).
  revalidatePath(`/partner/customers/${ref}`);
  return { ok: true };
}
