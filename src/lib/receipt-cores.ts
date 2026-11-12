import { sql } from 'drizzle-orm';
import { getDb, type Db, type DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { newTransferId } from './id';
import { enqueueTriage } from './ticket-triage';
import { getPartnerStore } from './partner-store';
import { getStore } from './store';
import { isRecallEligible } from './refund-policy';
import { logWarn } from './log';
import type { StepUpResult } from './customer-mfa';
import { regDueAt, type RegClass } from './reg-clocks';
import type { ReportCode } from './error-notice';
import { alsoReportedNote, caseClassNote } from './legal/error-notice-drafts';
import type { Customer, Partner, PartnerId } from './types';

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

  const reasonLabel = REASON_LABEL[reason] ?? reason;
  // partnerId + customerPhone come from the caller's SESSION; transferId was re-validated above.
  const r = await openRecallTicketLocked(getDb(), {
    partnerId: customer.partnerId,
    phone: customer.senderPhone,
    transferId: transfer.id,
    subject: `Recall request: ${reason}`,
    body:
      `Recall/dispute opened from the receipt page for transfer ${transfer.id}.\n` +
      `Reason: ${reasonLabel} (${reason}).\n` +
      `The customer reports a problem with a delivered transfer within the 24h recall window. ` +
      `Recovery is not guaranteed — please review and follow up.`,
    // M2-14 (PR 397 L1): the portal's cap counts in SQL with the tenant in the WHERE; the legacy
    // receipt keeps counting every ticket on the phone.
    capScope: opts.tenantScopedCap ? 'tenant' : 'phone',
  });
  return r.kind === 'cap' ? { kind: 'cap' } : { kind: 'opened', ticketId: r.ticketId };
}

export type RecallTicketResult = { kind: 'opened'; ticketId: string; reused: boolean } | { kind: 'cap' };

/**
 * M2-14 (PR 397 L2): open ONE recall ticket per transfer, shared by the receipt/portal core and the
 * chat/bot tool. The check and the insert run under a per-transfer advisory lock in ONE transaction,
 * so two tabs, two request keys or a chat racing the portal can't both insert: the second gets the
 * first open ticket back (`reused`). The lock is not a ledger row lock. The subject MUST start with
 * "Recall request:" (findOpenRecallForTransfer matches that prefix). The triage row commits with it.
 *
 * Fix pack 8 (P8, T11): a thin wrapper over `openErrorNoticeCaseLocked` with `regClass: null`
 * (today's lock key, reuse, cap and triage, unchanged); the callers move to the case writer in
 * T13/T14.
 */
export async function openRecallTicketLocked(
  db: Db,
  input: { partnerId: string; phone: string; transferId: string; subject: string; body: string; capScope: 'tenant' | 'phone' },
): Promise<RecallTicketResult> {
  const r = await db.transaction((tx) =>
    openErrorNoticeCaseLocked(tx, { ...input, regClass: null, code: 'other', now: Date.now() }),
  );
  return r.kind === 'cap' ? { kind: 'cap' } : { kind: 'opened', ticketId: r.ticketId, reused: r.reused };
}

export interface ErrorNoticeCaseInput {
  partnerId: PartnerId;
  phone: string;
  transferId: string;
  regClass: RegClass | null;
  code: ReportCode;
  subject: string;
  body: string;
  capScope: 'tenant' | 'phone';
  now: number;
}

export type ErrorNoticeCaseResult =
  | { kind: 'opened'; ticketId: string; reused: boolean; regClass: RegClass | null; dueAt: string | null; classStamped: boolean }
  | { kind: 'cap' };

/**
 * Fix pack 8 (R44, P8): open or reuse the case of ONE transfer, in the CALLER's transaction.
 *
 * `tx` MUST be a transaction: the advisory lock is transaction-scoped (`pg_advisory_xact_lock`) and
 * is what keeps one open case per transfer (and class); there is no unique index (0042).
 *
 * - `regClass` set: a regulatory case (urgent, a first notice and a due date from reg-clocks, never
 *   refused by the open-ticket cap). One open case per transfer and class: a repeat report reuses it
 *   (its class and due date never change) and adds ONE internal `Also reported: <code>.` note. An
 *   open UNCLASSED recall ticket on the transfer is stamped instead, with its own `createdAt` as the
 *   first notice (the customer's earlier report). A case of ANOTHER class is never reused.
 * - `regClass` null: today's recall ticket (the `recall:` lock key, reuse, cap; no class).
 *
 * The subject and body are the caller's; the class goes only in an INTERNAL system note
 * (`Class: <class>.`), written once when a case is created or stamped. The audit row carries enum
 * codes, ids and dates only (never the phone or the customer's words).
 */
export async function openErrorNoticeCaseLocked(tx: DbOrTx, i: ErrorNoticeCaseInput): Promise<ErrorNoticeCaseResult> {
  const { partnerId, phone, transferId, regClass, code } = i;
  const lockKey = regClass ? `regcase:${partnerId}:${transferId}:${regClass}` : `recall:${partnerId}:${transferId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
  const repo = createTicketRepo(tx);

  const addNote = async (ticketId: string) => {
    const note = alsoReportedNote(code);
    const msgs = await repo.listMessages(ticketId, { includeInternal: true });
    if (msgs.some((m) => m.actorType === 'system' && m.body === note)) return;
    await repo.appendMessage({ ticketId, actorType: 'system', actorId: 'system', internal: true, body: note });
  };
  const classNoteAndAudit = async (cls: RegClass, ticketId: string, dueAt: string, reused: boolean) => {
    await repo.appendMessage({ ticketId, actorType: 'system', actorId: 'system', internal: true, body: caseClassNote(cls) });
    await createAuditRepo(tx).record({
      partnerId,
      actor: 'system',
      actorType: 'system',
      action: 'ticket.reg_case.open',
      subjectId: ticketId,
      meta: { regClass: cls, code, transferId, dueAt, reused, stamped: true },
    });
  };

  if (regClass) {
    const found = await repo.findOpenRegCase(partnerId, transferId, regClass);
    if (found) {
      await addNote(found.id);
      return { kind: 'opened', ticketId: found.id, reused: true, regClass, dueAt: found.dueAt ?? null, classStamped: false };
    }
  }

  const open = await repo.findOpenRecallForTransfer(partnerId, phone, transferId);
  if (open && regClass === null) {
    return { kind: 'opened', ticketId: open.id, reused: true, regClass: open.regClass ?? null, dueAt: open.dueAt ?? null, classStamped: false };
  }
  if (open && regClass && !open.regClass) {
    const firstNoticeMs = Date.parse(open.createdAt);
    const dueAt = new Date(regDueAt(regClass, firstNoticeMs));
    const stamped = await repo.stampRegClass(open.id, partnerId, { regClass, firstNoticeAt: new Date(firstNoticeMs), dueAt });
    if (stamped) {
      await addNote(open.id);
      await classNoteAndAudit(regClass, open.id, dueAt.toISOString(), true);
      // P13 case event (T18): enqueueCaseEventIfEligible(tx, ticket) when classStamped
      return { kind: 'opened', ticketId: open.id, reused: true, regClass, dueAt: dueAt.toISOString(), classStamped: true };
    }
    // A concurrent report won the stamp (another class takes another lock key): re-read.
    const reread = await repo.getTicket(open.id);
    if (reread && reread.regClass === regClass) {
      // Same class (fix F1): this call's clock from the case's createdAt only moves the due date EARLIER.
      await repo.tightenDueAt(open.id, partnerId, dueAt);
      const tightened = await repo.getTicket(open.id);
      return { kind: 'opened', ticketId: open.id, reused: true, regClass, dueAt: tightened?.dueAt ?? reread.dueAt ?? null, classStamped: false };
    }
    // Another class: fall through and create a case of this class.
  }
  // An open recall that already has ANOTHER class is never reused: fall through to create.

  if (regClass === null) {
    // The cap applies only to an unclassed ticket; a regulatory case is never refused by it.
    const openCount =
      i.capScope === 'tenant'
        ? await repo.countOpenByCustomerInTenant(partnerId, phone)
        : (await repo.listByCustomer(phone)).filter((t) => OPEN_STATUSES.has(t.status)).length;
    if (openCount >= MAX_OPEN_TICKETS) return { kind: 'cap' };
  }

  const dueAt = regClass ? new Date(regDueAt(regClass, i.now)) : null;
  const ticket = await repo.createTicket({
    id: `tk_${newTransferId()}`,
    partnerId,
    kind: 'customer',
    customerPhone: phone,
    transferId,
    subject: i.subject,
    body: i.body,
    category: 'refund',
    ...(regClass && dueAt ? { regClass, firstNoticeAt: new Date(i.now), dueAt } : {}),
  });
  // Out-of-band AI triage (durable outbox, drained by the worker); never an inline model call.
  await enqueueTriage(tx, ticket.id);
  if (regClass && dueAt) {
    await classNoteAndAudit(regClass, ticket.id, dueAt.toISOString(), false);
    // P13 case event (T18): enqueueCaseEventIfEligible(tx, ticket) when classStamped
    return { kind: 'opened', ticketId: ticket.id, reused: false, regClass, dueAt: dueAt.toISOString(), classStamped: true };
  }
  return { kind: 'opened', ticketId: ticket.id, reused: false, regClass: null, dueAt: null, classStamped: false };
}
