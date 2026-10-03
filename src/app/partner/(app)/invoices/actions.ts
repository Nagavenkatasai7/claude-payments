'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { reissueTenantInvoice, voidTenantInvoice, type InvoiceOpResult } from '@/lib/b2b-invoice-ops';
import { isInvoiceId } from '@/lib/partner-invoices';
import type { PartnerCtx } from '@/lib/partner-access';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { PARTNER_ROUTES } from '../../routes';
import type { ActionResult } from '../../action-result';

// /partner/invoices actions (lost-features A6): void an unpaid business invoice, or reissue a voided
// or disputed one as a fresh unpaid bill. Admin only (the route policy). The site-host guard and the
// gate run outside any try; the tenant is the SESSION's (a partnerId / partner form field is never
// read); a malformed, missing or another tenant's id is the same not-found. The shared core
// (b2b-invoice-ops.ts) makes the guarded write and its audit row in ONE transaction. No typed
// reason, as before: neither control moves money.

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

async function run(ctx: PartnerCtx, formData: FormData, op: typeof voidTenantInvoice, scope: string): Promise<ActionResult> {
  const id = formData.get('id');
  if (!isInvoiceId(id)) return { ok: false, error: t('partner.invoices.notFound') };
  let r: InvoiceOpResult;
  try {
    r = await op(getDb(), { partnerId: ctx.partnerId, id, actor: ctx.username, actorScope: 'partner' });
  } catch (err) {
    logWarn(scope, errName(err), { partnerId: ctx.partnerId });
    return { ok: false, error: t('partner.common.failed') };
  }
  if (!r.ok) return { ok: false, error: t(r.reason === 'not_found' ? 'partner.invoices.notFound' : 'partner.invoices.notAllowed') };
  revalidatePath(PARTNER_ROUTES.invoices.href);
  return { ok: true };
}

export async function voidInvoiceAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.invoices.policy);
  return run(ctx, formData, voidTenantInvoice, 'partner.invoices.void');
}

export async function reissueInvoiceAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.invoices.policy);
  return run(ctx, formData, reissueTenantInvoice, 'partner.invoices.reissue');
}
