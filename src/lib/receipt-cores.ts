import { getDb } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { newTransferId } from './id';
import { enqueueTriage } from './ticket-triage';
import { getPartnerStore } from './partner-store';
import { getStore } from './store';
import { isRecallEligible } from './refund-policy';
import { logWarn } from './log';
import type { StepUpResult } from './customer-mfa';
import type { Customer, Partner } from './types';

/**
 * receipt-cores — the refund-request and recall cores shared by the legacy /account receipt and the
 * customer portal (UI redesign M2-7, Task 7.4; review round 1, M8). Extracted from
 * src/app/account/receipt/refund-actions.ts and recall-actions.ts with the SAME order of checks and
 * the SAME data access, so the legacy actions keep byte-identical behaviour.
 *
 * NOT a server module: these are plain functions the server actions call after their own gates.
 * They return a result union and never redirect or throw user copy. The step-up runs where the
 * legacy step-up ran (between eligibility and the flip) through the injected `stepUpGate`: the
 * legacy actions pass their TOTP stepUp; the portal passes `async () => 'ok'` because
 * requireFreshPortalAuth has already run.
 *
 * Neither core moves money: a refund request only flags the transfer for ops review, and a recall
 * opens a support ticket a human works.
 */

export type StepUpFailure = Exclude<StepUpResult, 'ok'>;
export type StepUpGate = () => Promise<StepUpResult>;
type Owner = Pick<Customer, 'partnerId' | 'senderPhone'>;

export type RefundCoreResult =
  | { kind: 'requested'; transferId: string }
  | { kind: 'ineligible' }
  | { kind: 'step_up'; failure: StepUpFailure; transferId: string };

/**
 * Flag a paid, not-delivered transfer (refundStatus none) as refund `requested`. Ownership is
 * 404-never-403 (another customer's or a missing transfer is `ineligible`, like an ineligible one);
 * the guarded none→requested flip makes a concurrent or repeated request `ineligible`.
 */
export async function requestRefundFor(customer: Owner, transferId: string, stepUpGate: StepUpGate): Promise<RefundCoreResult> {
  const transfer = await getStore().getTransfer(transferId);
  if (!transfer || transfer.phone !== customer.senderPhone || transfer.partnerId !== customer.partnerId) return { kind: 'ineligible' };

  const refundStatus = transfer.refundStatus ?? 'none'; // lazy-fill: absent ⇒ 'none'
  if (refundStatus !== 'none') return { kind: 'ineligible' };
  if (transfer.status !== 'paid') return { kind: 'ineligible' };

  const gate = await stepUpGate();
  if (gate !== 'ok') return { kind: 'step_up', failure: gate, transferId: transfer.id };

  try {
    const updated = await createTransferRepo(getDb()).updateRefund(transfer.id, { refundStatus: 'requested' });
    if (!updated) return { kind: 'ineligible' };
  } catch (err) {
    logWarn('refund.request', err);
    return { kind: 'ineligible' };
  }
  return { kind: 'requested', transferId: transfer.id };
}

export const MAX_OPEN_TICKETS = 5;
/** Statuses that count against the per-customer open-ticket cap. */
const OPEN_STATUSES = new Set<string>(['open', 'pending', 'waiting_admin']);

/** The recall reasons the receipt forms offer (mirrors the bot tool's enum). */
export const RECALL_REASON_VALUES = ['wrong_recipient', 'wrong_amount', 'not_received', 'unauthorized', 'other'] as const;
export type RecallReason = (typeof RECALL_REASON_VALUES)[number];
const RECALL_REASONS = new Set<string>(RECALL_REASON_VALUES);

const REASON_LABEL: Record<string, string> = {
  wrong_recipient: 'Sent to the wrong recipient',
  wrong_amount: 'Wrong amount sent',
  not_received: 'Recipient did not receive the money',
  unauthorized: 'I did not authorize this transfer',
  other: 'Something else is wrong',
};

/** The customer's partner row (the admin-controlled support kill switch lives on it). */
async function customerPartner(customer: Owner): Promise<Partner> {
  return (await getPartnerStore().getPartner(customer.partnerId)) ?? (await getPartnerStore().ensureDefaultPartner());
}

/** enableSupportPortal defaults to TRUE when supportConfig is absent. */
function portalDisabled(partner: Partner): boolean {
  return partner.supportConfig?.enableSupportPortal === false;
}

export type RecallCoreResult =
  | { kind: 'opened'; ticketId: string }
  | { kind: 'bad_reason' }
  | { kind: 'support_off' }
  | { kind: 'ineligible' }
  | { kind: 'step_up'; failure: StepUpFailure }
  | { kind: 'cap' };

export interface RecallCoreOptions {
  /**
   * Count only this tenant's open tickets toward the cap. The legacy receipt counts every ticket
   * on the phone (listByCustomer is phone-keyed) and keeps doing so; the portal is tenant-scoped.
   */
  tenantScopedCap?: boolean;
}

/**
 * Open a recall/dispute ticket for a delivered transfer inside the 24h window. Same order as the
 * legacy action: reason enum, support kill switch, ownership (404-never-403), eligibility, step-up,
 * open-ticket cap, ticket, triage.
 */
export async function requestRecallFor(
  customer: Owner,
  transferId: string,
  input: { reason: string },
  stepUpGate: StepUpGate,
  opts: RecallCoreOptions = {},
): Promise<RecallCoreResult> {
  const reason = input.reason;
  if (!RECALL_REASONS.has(reason)) return { kind: 'bad_reason' };
  if (portalDisabled(await customerPartner(customer))) return { kind: 'support_off' };

  const transfer = await getStore().getTransfer(transferId);
  if (!transfer || transfer.phone !== customer.senderPhone || transfer.partnerId !== customer.partnerId) return { kind: 'ineligible' };
  if (!isRecallEligible(transfer, Date.now())) return { kind: 'ineligible' };

  const gate = await stepUpGate();
  if (gate !== 'ok') return { kind: 'step_up', failure: gate };

  const repo = createTicketRepo(getDb());
  const mine = await repo.listByCustomer(customer.senderPhone);
  const open = mine.filter((t) => OPEN_STATUSES.has(t.status) && (!opts.tenantScopedCap || t.partnerId === customer.partnerId));
  if (open.length >= MAX_OPEN_TICKETS) return { kind: 'cap' };

  const reasonLabel = REASON_LABEL[reason] ?? reason;
  // partnerId + customerPhone come from the caller's SESSION; transferId was re-validated above.
  const ticket = await repo.createTicket({
    id: `tk_${newTransferId()}`,
    partnerId: customer.partnerId,
    kind: 'customer',
    customerPhone: customer.senderPhone,
    transferId: transfer.id,
    subject: `Recall request: ${reason}`,
    body:
      `Recall/dispute opened from the receipt page for transfer ${transfer.id}.\n` +
      `Reason: ${reasonLabel} (${reason}).\n` +
      `The customer reports a problem with a delivered transfer within the 24h recall window. ` +
      `Recovery is not guaranteed — please review and follow up.`,
    category: 'refund',
  });

  // Out-of-band AI triage (durable outbox, drained by the worker); never an inline model call.
  await enqueueTriage(getDb(), ticket.id);
  return { kind: 'opened', ticketId: ticket.id };
}
