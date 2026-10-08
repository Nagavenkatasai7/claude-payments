'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { addPayee, PaymentLinkOpsError } from '@/lib/payment-link-ops';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { PARTNER_ROUTES } from '../../routes';

// Batch B2: add a company (payee) at THIS tenant. A public POST endpoint: the partner-site host
// guard, then the PARTNER_ADMIN gate (outside any try), then payment-link-ops.addPayee with the
// SESSION's tenant and username (a tenant field in the form is never read). The service screens
// both names, seals the bank details and writes the payee and its audit row in one transaction.
// Field errors come back as the validator's fixed text; nothing typed is echoed back.

export type AddPayeeState =
  | { ok: true; message: string }
  | { ok: false; error: string; fieldErrors?: Partial<Record<string, string>> };

const FIELDS = ['legalName', 'accountHolder', 'ifsc', 'accountNumber', 'accountNumberConfirm'] as const;

export async function addPayeeAction(formData: FormData): Promise<AddPayeeState> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.payees.policy);
  const raw = Object.fromEntries(FIELDS.map((k) => [k, formData.get(k)]));
  try {
    await addPayee(getDb(), { partnerId: ctx.partnerId, username: ctx.username, role: ctx.role }, raw);
  } catch (e) {
    if (e instanceof PaymentLinkOpsError) {
      if (e.code === 'invalid') return { ok: false, error: t('partner.payees.add.invalid'), fieldErrors: e.fieldErrors };
      if (e.code === 'refused') return { ok: false, error: t('partner.payees.add.refused') };
      return { ok: false, error: t('partner.common.failed') };
    }
    logWarn('partner.payees.add', e instanceof Error ? e.name : 'error', { partnerId: ctx.partnerId });
    return { ok: false, error: t('partner.common.failed') };
  }
  revalidatePath(PARTNER_ROUTES.payees.href);
  revalidatePath(PARTNER_ROUTES.paymentLinks.href);
  return { ok: true, message: t('partner.payees.add.done') };
}
