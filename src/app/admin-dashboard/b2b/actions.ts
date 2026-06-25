'use server';

import { revalidatePath } from 'next/cache';
import { requireScope } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { newTransferId } from '@/lib/id';
import { DEFAULT_PARTNER_ID, DEFAULT_SOURCE_CURRENCY } from '@/lib/defaults';
import type { B2bInvoice, InvoiceLineItem } from '@/lib/types';

/**
 * B2B admin actions — platform-only. Server actions are public POST endpoints,
 * so this self-gates (requireScope → platform) before touching the store; a
 * partner-scoped staffer who POSTs here is rejected by the explicit scope check
 * below.
 *
 * `seedDemoInvoiceAction` mints a sample UNPAID invoice on the default partner
 * so the WhatsApp B2B test flow has a bill to present (the bot resolves the
 * buyer's open invoice by phone via getUnpaidInvoiceByBuyer).
 */
export async function seedDemoInvoiceAction(formData: FormData): Promise<void> {
  const { scope } = await requireScope();
  if (scope.kind !== 'platform') {
    throw new Error('Forbidden: platform scope required.');
  }

  const businessName = String(formData.get('businessName') ?? '').trim();
  const buyerPhone = String(formData.get('buyerPhone') ?? '').trim();
  const itemDescription = String(formData.get('itemDescription') ?? '').trim();
  const qtyRaw = String(formData.get('qty') ?? '1').trim();
  const unitAmountRaw = String(formData.get('unitAmountUsd') ?? '').trim();

  if (!businessName) throw new Error('Seller business name is required.');
  if (!buyerPhone) throw new Error('Buyer phone is required.');
  if (!itemDescription) throw new Error('A line-item description is required.');

  const qty = Number.parseInt(qtyRaw, 10);
  const unitAmountUsd = Number.parseFloat(unitAmountRaw);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('Quantity must be a positive number.');
  if (!Number.isFinite(unitAmountUsd) || unitAmountUsd <= 0) {
    throw new Error('Unit amount must be a positive number.');
  }

  const lineItems: InvoiceLineItem[] = [
    { description: itemDescription, qty, unitAmountUsd },
  ];
  const amountUsd = lineItems.reduce((sum, li) => sum + li.qty * li.unitAmountUsd, 0);

  const invoice: B2bInvoice = {
    id: newTransferId(),
    partnerId: DEFAULT_PARTNER_ID,
    businessName,
    buyerPhone,
    lineItems,
    amountUsd,
    currency: DEFAULT_SOURCE_CURRENCY,
    status: 'unpaid',
    createdAt: new Date().toISOString(),
  };
  await getStore().saveB2bInvoice(invoice);

  revalidatePath('/admin-dashboard/b2b');
}
