'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { PARTNER_OPS } from '@/lib/partner-access';
import { getDb } from '@/db/client';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { openCustomerRef } from '@/lib/customer-ref';
import { recordStaffEsignWithdrawal } from '@/lib/esign-staff-withdraw';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { ActionResult } from '../../../action-result';

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/**
 * Fix pack 6 truth check TC-T1: record that one of THIS tenant's customers asked the provider to
 * withdraw the E-SIGN consent (the consent text's "contact the provider named on your receipt").
 * In order: the partner-site host guard, then PARTNER_OPS (admin and agent, the gate of this
 * page's revealCustomerFieldAction; support and finance are refused), outside any try; the sealed
 * ref is opened and re-scoped to the SESSION tenant (a posted partner id or phone is never read; a
 * missing, foreign or junk ref is the same not-found result); the customer is read with the session
 * tenant in the WHERE; the "confirm" tick (the customer asked for it) is required; then ONE
 * transaction writes the withdrawal and the `customer.consent.esign` audit row
 * { version, on: false, via: 'staff', actorScope: 'partner' } (recordStaffEsignWithdrawal).
 * Nothing on file or already withdrawn: ok, nothing written.
 * No step-up: recording a withdrawal weakens no control, it only makes the next pay-page payment
 * ask the customer again. Errors log the error NAME only (never an error object, phone or name).
 */
export async function recordEsignWithdrawalAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_OPS);
  const notFound: ActionResult = { ok: false, error: t('partner.customers.notFound') };

  const ref = formData.get('ref');
  if (typeof ref !== 'string' || ref === '') return notFound;
  const opened = openCustomerRef(ref);
  if (!opened || opened.partnerId !== ctx.partnerId) return notFound;
  try {
    // The SESSION tenant in the WHERE: the same phone at another partner is a different customer.
    const customer = await getCustomerStore(getStore()).getCustomer(ctx.partnerId, opened.phone);
    if (!customer || customer.partnerId !== ctx.partnerId) return notFound;
    if (formData.get('confirm') !== 'on') return { ok: false, error: t('partner.customers.esign.confirmRequired') };
    await recordStaffEsignWithdrawal(getDb(), {
      partnerId: ctx.partnerId,
      phone: customer.senderPhone,
      actor: ctx.username,
      actorScope: 'partner',
    });
  } catch (err) {
    logWarn('partner.customers.esign', errName(err), { partnerId: ctx.partnerId });
    return { ok: false, error: t('partner.common.failed') };
  }
  // The literal page path (the ref is an opaque sealed token, never a phone).
  revalidatePath(`/partner/customers/${ref}`);
  return { ok: true };
}
