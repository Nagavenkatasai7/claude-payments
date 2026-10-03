'use server';

import { redirect } from 'next/navigation';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { isValidPhone, normalizePhone } from '@/lib/phone';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { partnerCustomerPath } from '../../customer-link';
import { PARTNER_ROUTES } from '../../routes';
import type { ActionResult } from '../../action-result';

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/**
 * Find one of THIS tenant's customers by full phone (lost-features p2 A11). A POST, so the phone
 * travels in the body only and never reaches a URL, a log or history: a hit redirects to the sealed
 * ref (outside any try; redirect() works by throwing). The tenant is the session's (any posted
 * tenant field is ignored), and the key is (tenant, phone), so "none" only ever describes this
 * tenant. Nothing is disclosed here (the customer page writes pii.view), so no audit row.
 */
export async function findCustomerAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.customers.policy);
  const raw = formData.get('phone');
  const phone = normalizePhone(typeof raw === 'string' ? raw.slice(0, 40) : '');
  if (!isValidPhone(phone)) return { ok: false, error: t('partner.customers.find.invalid') };
  let found = false;
  try {
    const c = await getCustomerStore(getStore()).getCustomer(ctx.partnerId, phone);
    found = c !== null && c.partnerId === ctx.partnerId;
  } catch (err) {
    logWarn('partner.customers.find', errName(err), { partnerId: ctx.partnerId });
    return { ok: false, error: t('partner.common.failed') };
  }
  if (!found) return { ok: false, error: t('partner.customers.find.none') };
  redirect(partnerCustomerPath(ctx.partnerId, phone));
}
