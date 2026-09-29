import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { customers } from '@/db/schema';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { encryptField } from './field-crypto';
import { outboxSealedCtx } from './crypto-context';
import { getPortalPrefs, verifiedReceiptEmail } from './portal-prefs';
import { receiptView, renderReceiptText } from './portal-transfers';
import { resolvePartnerBranding } from './partner-config';
import { t } from './i18n';
import { env } from './env';
import { getPortalSettings } from '@/db/repos/portal-settings-repo';
import { logWarn } from './log';
import type { PartnerId, Transfer } from './types';

/**
 * delivery-receipt — the AUTOMATIC receipt email on delivery (UI redesign M2-11b, plan Task 11.5,
 * owner decision O10). When a customer turned "email me receipts" ON and has a VERIFIED address for
 * the transfer's OWN tenant, the transition to `delivered` enqueues one sealed `email.send` row.
 *
 * Every writer that moves a transfer to `delivered` goes through Store.updateTransferFromWebhook
 * (the rail/simulator callback route and the worker's mock.settle via completePaymentStage2), and
 * that method calls deliverTransfer() below. The only SQL that sets the status is the guarded,
 * forward-only transferRepo.updateTransferFromWebhook, run here unchanged.
 *
 * Review round 1, M7:
 *  - the prefs, the address and the brand are read BEFORE the money transaction, and the body is
 *    rendered and sealed there too. Any failure in that step is logged (transfer id and error name
 *    only) and means "no receipt": the delivery itself is never blocked (fail open for the email);
 *  - inside the transaction there is only the existing guarded UPDATE, then, when it really moved
 *    the row, ONE `INSERT … ON CONFLICT DO NOTHING` outbox row (dedupe `rcpt-auto:<transferId>`), so
 *    the email commits with the status change or not at all, and a replay never adds a second row.
 *    An enqueue error rolls the delivery back, by design (the durability spine: an effect is an
 *    outbox row written with the state change that implies it); the rail retries the callback.
 *
 * The body carries the MASKED destination only (the default masked transfer read) and is sealed
 * with the same placeholder and context as the manual "email me a receipt" (`receipt_body`), so
 * the worker's email.send path (renderSealedText) opens it unchanged. Sandbox (test) transfers
 * never email.
 *
 * Known, accepted: the prefs are a snapshot taken just before the transaction, so a toggle-off or
 * an address change in the milliseconds before the commit can still send ONE receipt to the address
 * that was verified at read time (the price of never reading prefs inside the money transaction).
 */

export const AUTO_RECEIPT_DEDUPE_PREFIX = 'rcpt-auto';

export interface DeliveryReceipt {
  partnerId: PartnerId;
  phone: string;
  to: string;
  subject: string;
  /** The sealed receipt body (field-crypto blob under outboxSealedCtx('receipt_body')). */
  sealedBody: string;
}

/** The customer's sealed email blob on THIS tenant, or null. A narrow read: no KYC PII is opened. */
async function customerEmailBlob(db: Db, partnerId: PartnerId, phone: string): Promise<string | null> {
  const rows = await db
    .select({ emailEnc: customers.emailEnc })
    .from(customers)
    .where(and(eq(customers.partnerId, partnerId), eq(customers.phone, phone)))
    .limit(1);
  return rows[0]?.emailEnc ?? null;
}

/**
 * Everything the in-transaction enqueue needs, or null for "no receipt". Runs OUTSIDE the money
 * transaction and NEVER throws: a read or seal error logs a warning without PII and returns null.
 */
export async function prepareDeliveryReceipt(db: Db, transferId: string): Promise<DeliveryReceipt | null> {
  try {
    const transfer = await createTransferRepo(db).getTransfer(transferId);
    if (!transfer) return null;
    // A delivered (or terminal) row cannot transition; a sandbox transfer never emails.
    if (transfer.status !== 'paid' && transfer.status !== 'awaiting_payment') return null;
    if (transfer.environment === 'test') return null;
    const partnerId = transfer.partnerId;
    const phone = transfer.phone;
    // M2-14 (#417 L2): receipts are a portal feature. The portal switched off (the platform flag, or
    // this partner not enabled) means no receipt, whatever the saved preference says.
    if (!env.customerPortalEnabled) return null;
    if (!(await getPortalSettings(db, partnerId)).portalEnabledAt) return null;
    const prefs = await getPortalPrefs(db, partnerId, phone);
    if (!prefs?.emailReceipts) return null;
    const blob = await customerEmailBlob(db, partnerId, phone);
    const to = await verifiedReceiptEmail(db, { partnerId, senderPhone: phone, email: blob ?? undefined });
    if (!to) return null;
    const brand = resolvePartnerBranding(await createPartnerRepo(db).getPartner(partnerId)).brand;
    return buildDeliveryReceipt(transfer, to, brand);
  } catch (err) {
    logWarn('delivery-receipt.prepare', 'receipt pre-read failed; delivery proceeds without a receipt', {
      transferId,
      error: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  }
}

/** Render + seal the receipt for `transfer` as it will read once delivered. Pure apart from the seal. */
export function buildDeliveryReceipt(transfer: Transfer, to: string, brand: string): DeliveryReceipt {
  // M2-14 (#417 L2): an automatic email says how to stop it.
  const body = `${renderReceiptText(receiptView({ ...transfer, status: 'delivered' }), brand)}\n\n${t('portal.receipt.autoFooter', { brand })}`;
  return {
    partnerId: transfer.partnerId,
    phone: transfer.phone,
    to,
    subject: t('portal.receipt.subject', { brand }),
    sealedBody: encryptField(body, undefined, outboxSealedCtx('receipt_body')),
  };
}

/**
 * The delivered transition. ONE transaction: the guarded UPDATE, then — only when it moved the row,
 * and only for the same tenant and sender the receipt was prepared for — the receipt row, inside a
 * savepoint so a receipt failure never holds back delivery (owner decision 2026-09-28). Returns
 * the UPDATE's result exactly as transferRepo.updateTransferFromWebhook does (non-null ⇒ a real
 * transition), so every caller's notify contract is unchanged.
 */
export async function deliverTransfer(db: Db, transferId: string): Promise<Transfer | null> {
  const receipt = await prepareDeliveryReceipt(db, transferId);
  return db.transaction(async (tx) => {
    const updated = await createTransferRepo(tx).updateTransferFromWebhook(transferId, 'delivered');
    if (updated && receipt && updated.partnerId === receipt.partnerId && updated.phone === receipt.phone) {
      try {
        // Owner decision (2026-09-28): delivery ALWAYS commits. The receipt enqueue runs in a
        // SAVEPOINT, so a failed insert (even a database-level error that would otherwise abort the
        // whole transaction) rolls back only itself; the delivered flip still commits and the
        // receipt is skipped with a PII-free warning. On success the row still commits with the flip.
        await tx.transaction(async (sp) => {
          await createOutboxRepo(sp).enqueue(
            'email.send',
            {
              to: [receipt.to],
              subject: receipt.subject,
              text: '{{receipt_body}}',
              sealed: { receipt_body: receipt.sealedBody },
            },
            { dedupeKey: `${AUTO_RECEIPT_DEDUPE_PREFIX}:${transferId}` },
          );
        });
      } catch (err) {
        // The error NAME only: a query error carries its params (the address).
        logWarn('delivery.receipt', 'receipt enqueue failed; delivery committed without it', {
          transferId,
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
    }
    return updated;
  });
}
