'use server';

import { revalidatePath } from 'next/cache';
import { requireScope } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { cancelTransfer, reverseB2bSettlement } from '@/lib/dashboard-ops';
import { newTransferId } from '@/lib/id';
import { normalizePhone, isValidPhone } from '@/lib/phone';
import { DEFAULT_PARTNER_ID, DEFAULT_SOURCE_CURRENCY } from '@/lib/defaults';
import type { B2bInvoice, InvoiceLineItem, Staff } from '@/lib/types';

/**
 * B2B admin actions — platform-only. Server actions are public POST endpoints,
 * so EVERY action self-gates (requireScope → platform) before touching the
 * store; a partner-scoped staffer who POSTs here is rejected. The B2B surface
 * crosses no tenant boundary today (single default partner), so platform scope
 * is the bar.
 *
 * NON-CUSTODIAL is sacred across every lifecycle action below: SmartRemit holds
 * no funds, so cancelling a *paid* ACH-pull transfer NEVER does a bare status
 * flip — it routes through reverseB2bSettlement, which enqueues a SIGNED partner
 * reverse-instruction (the worker posts it). The store/repo methods re-guard
 * every status transition; the actions validate existence + type + status up
 * front for a clear message and audit every mutation.
 */

/** Self-gate: resolve the caller and require platform scope. Internal (not a
 *  server action export) — a 'use server' module may only export async actions. */
async function requirePlatformStaff(): Promise<Staff> {
  const { staff, scope } = await requireScope();
  if (scope.kind !== 'platform') {
    throw new Error('Forbidden: platform scope required.');
  }
  return staff;
}

/**
 * `seedDemoInvoiceAction` mints a sample UNPAID invoice on the default partner
 * so the WhatsApp B2B test flow has a bill to present (the bot resolves the
 * buyer's open invoice by phone via getUnpaidInvoiceByBuyer).
 */
export async function seedDemoInvoiceAction(formData: FormData): Promise<void> {
  await requirePlatformStaff();

  const businessName = String(formData.get('businessName') ?? '').trim();
  // Normalize to digits-only so the seeded invoice matches Meta's wa_id (which the
  // bot resolves the bill by). isValidPhone catches the empty/too-short cases, but
  // it can't infer a MISSING country code — the buyer must be entered in full
  // international form (e.g. 1 5551234567) per the form's placeholder/caption, or
  // Meta's country-code-prefixed wa_id will never equal it.
  const buyerPhone = normalizePhone(formData.get('buyerPhone'));
  const itemDescription = String(formData.get('itemDescription') ?? '').trim();
  const qtyRaw = String(formData.get('qty') ?? '1').trim();
  const unitAmountRaw = String(formData.get('unitAmountUsd') ?? '').trim();

  if (!businessName) throw new Error('Seller business name is required.');
  if (!buyerPhone) throw new Error('Buyer phone is required.');
  if (!isValidPhone(buyerPhone)) {
    throw new Error('Enter a valid buyer phone — country code + number, digits only (e.g. 15551234567).');
  }
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

/**
 * Cancel an UNPAID B2B transfer (awaiting_payment or in_review). Non-custodial
 * and safe: nothing has been pulled, so this is a clean status flip via
 * cancelTransfer (the in_review uncharged branch is automatic). A *paid*
 * ach_pull is explicitly steered to Reverse — cancelTransfer would throw there,
 * but we reject earlier with a clear message so staff never see a raw error.
 */
export async function cancelB2bTransferAction(formData: FormData): Promise<void> {
  const staff = await requirePlatformStaff();
  const id = String(formData.get('id') ?? '').trim();
  if (!id) throw new Error('Missing transfer id.');

  const store = getStore();
  const transfer = await store.getTransfer(id);
  // Validate existence AND that it is genuinely a B2B transfer before mutating
  // (this surface only governs B2B; a b2c id POSTed here is rejected).
  if (!transfer || transfer.transferType !== 'b2b') {
    throw new Error('B2B transfer not found.');
  }
  if (transfer.status === 'paid' && transfer.fundingMethod === 'ach_pull') {
    throw new Error('A paid B2B transfer cannot be cancelled — use Reverse (it instructs the partner to return the debit).');
  }
  if (transfer.status !== 'awaiting_payment' && transfer.status !== 'in_review') {
    throw new Error(`Cannot cancel a ${transfer.status} B2B transfer.`);
  }

  await cancelTransfer(store, id);
  await createAuditRepo(getDb()).record({
    partnerId: transfer.partnerId,
    actor: staff.username,
    actorType: 'staff',
    action: 'b2b.transfer.cancel',
    subjectId: id,
    meta: { previousStatus: transfer.status },
  });
  revalidatePath('/admin-dashboard/b2b');
}

/**
 * Reverse a PAID B2B ACH-pull transfer — the staff click IS the approval.
 * NON-CUSTODIAL: SmartRemit captured nothing, so this does NOT do a status flip;
 * reverseB2bSettlement enqueues a durable funding.refund effect the worker turns
 * into a SIGNED partner REVERSE instruction (return the debit). The action is
 * scoped to `paid` only — a delivered transfer is recalled out-of-band via
 * support (the page shows no in-app Reverse for delivered). reverseB2bSettlement
 * re-checks eligibility inside its transaction, so a double-click throws.
 */
export async function reverseB2bTransferAction(formData: FormData): Promise<void> {
  const staff = await requirePlatformStaff();
  const id = String(formData.get('id') ?? '').trim();
  if (!id) throw new Error('Missing transfer id.');

  const store = getStore();
  const transfer = await store.getTransfer(id);
  if (!transfer || transfer.transferType !== 'b2b') {
    throw new Error('B2B transfer not found.');
  }
  if (transfer.fundingMethod !== 'ach_pull') {
    throw new Error('Only ACH-pull B2B transfers can be reversed.');
  }
  if (transfer.status !== 'paid') {
    throw new Error(`Cannot reverse a ${transfer.status} B2B transfer in-app — a delivered transfer is recalled via support.`);
  }

  await reverseB2bSettlement(getDb(), id);
  await createAuditRepo(getDb()).record({
    partnerId: transfer.partnerId,
    actor: staff.username,
    actorType: 'staff',
    action: 'b2b.transfer.reverse',
    subjectId: id,
    meta: { previousStatus: transfer.status },
  });
  revalidatePath('/admin-dashboard/b2b');
}

/**
 * Void an UNPAID invoice (kills the bill). The repo guards unpaid → voided and
 * is partner-scoped, returning null when not eligible (already paid/voided/
 * disputed, or wrong tenant) — we re-fetch first so the failure message can name
 * the actual status instead of a bare "not voidable".
 */
export async function voidB2bInvoiceAction(formData: FormData): Promise<void> {
  const staff = await requirePlatformStaff();
  const id = String(formData.get('id') ?? '').trim();
  if (!id) throw new Error('Missing invoice id.');

  const store = getStore();
  const existing = await store.getB2bInvoiceScoped(id, DEFAULT_PARTNER_ID);
  if (!existing) throw new Error('Invoice not found.');

  const voided = await store.voidB2bInvoice(id, DEFAULT_PARTNER_ID);
  if (!voided) {
    throw new Error(`Cannot void a ${existing.status} invoice — only unpaid invoices are voidable.`);
  }
  await createAuditRepo(getDb()).record({
    partnerId: DEFAULT_PARTNER_ID,
    actor: staff.username,
    actorType: 'staff',
    action: 'b2b.invoice.void',
    subjectId: id,
  });
  revalidatePath('/admin-dashboard/b2b');
}

/**
 * Reissue a VOIDED or DISPUTED invoice as a fresh UNPAID clone (cloned line
 * items) the bot can present again. The repo guards (source must be voided/
 * disputed) and is idempotent on the supplied newId; we re-fetch first so an
 * ineligible source (e.g. unpaid/paid) gives a clear status-named message.
 *
 * NON-DUPLICATING: the newId is DERIVED from the source id, not a random
 * newTransferId(). The foundation reissueInvoice is idempotent on newId
 * (onConflictDoNothing returns the already-minted clone) and explicitly
 * delegates the distinct-newId double-reissue guard to this L2 action — so a
 * double-click (or two racing POSTs) computes the SAME newId and collapses to
 * ONE clone, instead of minting a second open bill the buyer could pay twice.
 * Each dead bill thus revives exactly once; to spawn another, reissue the
 * latest dead clone.
 */
export async function reissueB2bInvoiceAction(formData: FormData): Promise<void> {
  const staff = await requirePlatformStaff();
  const id = String(formData.get('id') ?? '').trim();
  if (!id) throw new Error('Missing invoice id.');

  const store = getStore();
  const existing = await store.getB2bInvoiceScoped(id, DEFAULT_PARTNER_ID);
  if (!existing) throw new Error('Invoice not found.');

  const newId = `reissue-${id}`;
  const reissued = await store.reissueB2bInvoice(id, DEFAULT_PARTNER_ID, newId);
  if (!reissued) {
    throw new Error(`Cannot reissue a ${existing.status} invoice — only voided or disputed invoices can be reissued.`);
  }
  await createAuditRepo(getDb()).record({
    partnerId: DEFAULT_PARTNER_ID,
    actor: staff.username,
    actorType: 'staff',
    action: 'b2b.invoice.reissue',
    subjectId: id,
    meta: { reissuedAs: reissued.id },
  });
  revalidatePath('/admin-dashboard/b2b');
}
