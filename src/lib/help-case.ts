import type { Db, DbOrTx } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { newTransferId } from './id';
import { pokeWorker } from './outbox';
import { HUMAN_HELP_CATEGORY, HUMAN_HELP_SUBJECT } from './ticket-category';
import { boundUntrustedText } from './untrusted-text';
import type { PartnerId } from './types';

/**
 * help-case (R43) — the ONE way a help case is opened: the request_human_help
 * tool (tools.ts) and the HELP keyword router (turn-router.ts, run by the
 * worker and the web chat) both call it. R26 (the paused menu) and R44 (Reg E
 * error notices) call it too.
 *
 * openHelpCase(tx) writes, in the CALLER's transaction:
 *  - the ticket (reused when the customer already has an open help case under
 *    this tenant: findOpenHumanHelpCase is tenant-scoped in SQL);
 *  - the ticket.triage outbox row (deduped triage:<id>);
 *  - one ops.alert (deduped help:<id>), carrying the tenant, the case id and the
 *    fixed reason only: never the phone or the customer's words;
 *  - on a REUSED case, a new and more serious reason (an unauthorised payment
 *    after a plain HELP, say) is not folded in silently: a fixed staff-only note
 *    ("Also reported: <reason>.", never the customer's text), an alert deduped
 *    help:<id>:<reason> and a fresh triage (triage:<id>:<reason>), so staff see
 *    the escalation. The same reason again adds nothing.
 * The caller pokes the worker AFTER its commit (openHelpCaseAndPoke does both),
 * so the worker never wakes for rows that may still roll back.
 *
 * Find-then-create is not locked: on WhatsApp the per-phone turn lock
 * (Program-Fix 34A) serialises it, and the web chat route holds its own
 * per-customer in-flight lock (portal-chat.ts).
 */

/** The reasons the model may pass to request_human_help (its schema enum). */
export const HELP_REASONS = ['question', 'complaint', 'payment_problem', 'account_access', 'other'] as const;
export type HelpReason = (typeof HELP_REASONS)[number];
/** Every reason a case can be opened with: the tool's, plus the keyword router's own. */
export type HelpCaseReason = HelpReason | 'unauthorised' | 'cancel_request';
export type HelpCaseChannel = 'whatsapp' | 'telegram' | 'web';

export interface OpenHelpCaseInput {
  /** The tenant the turn runs under (never inferred from the phone). */
  partnerId: PartnerId;
  phone: string;
  reason: HelpCaseReason;
  channel: HelpCaseChannel;
  /** 'tool': the model asked (its one-line summary is kept, bounded). 'keyword': the router matched (fixed text only). */
  source: 'tool' | 'keyword';
  /** The model's summary (tool only). Ignored for a keyword case: the message body never enters a ticket (crypto-06). */
  summary?: string;
}

export interface HelpCaseResult {
  caseId: string;
  partnerId: PartnerId;
  /** false ⇒ the open case was reused. */
  created: boolean;
}

const HELP_SUMMARY_MAX = 300;

/**
 * How serious a reason is. A reused case escalates only for a reason above a
 * plain question that the case has not recorded yet.
 */
const REASON_RANK: Readonly<Record<HelpCaseReason, number>> = {
  question: 0,
  other: 0,
  cancel_request: 1,
  complaint: 2,
  account_access: 3,
  payment_problem: 4,
  unauthorised: 5,
};
const FIRST_REASON = /^Reason: ([a-z_]+)\./;
const ALSO_REPORTED = /^Also reported: ([a-z_]+)\./;

/** The reasons a case already records: its opening message and every escalation note. */
async function recordedReasons(tx: DbOrTx, ticketId: string): Promise<Set<string>> {
  const messages = await createTicketRepo(tx).listMessages(ticketId, { includeInternal: true });
  const out = new Set<string>();
  messages.forEach((m, i) => {
    // The opening message's fixed prefix, then only OUR notes (never a customer or staff reply).
    const hit = i === 0 ? FIRST_REASON.exec(m.body) : m.actorType === 'system' ? ALSO_REPORTED.exec(m.body) : null;
    if (hit) out.add(hit[1]);
  });
  return out;
}

function caseBody(input: OpenHelpCaseInput): string {
  if (input.source === 'keyword') {
    return `Reason: ${input.reason}. Opened by the ${input.channel} chat when the customer asked for help. The customer's message is not copied here; read it in the conversation log.`;
  }
  const summary = boundUntrustedText(input.summary, HELP_SUMMARY_MAX);
  return summary ? `Reason: ${input.reason}. ${summary}` : `Reason: ${input.reason}.`;
}

/** Open (or reuse) the customer's help case inside the caller's transaction. Does NOT poke the worker. */
export async function openHelpCase(tx: DbOrTx, input: OpenHelpCaseInput): Promise<HelpCaseResult> {
  const tickets = createTicketRepo(tx);
  const open = await tickets.findOpenHumanHelpCase(input.partnerId, input.phone);
  const ticket =
    open ??
    (await tickets.createTicket({
      id: `tk_${newTransferId()}`,
      partnerId: input.partnerId,
      kind: 'customer',
      customerPhone: input.phone,
      subject: HUMAN_HELP_SUBJECT,
      body: caseBody(input),
      category: HUMAN_HELP_CATEGORY,
    }));
  // Enqueued on BOTH paths with dedupe keys: a crash between an older
  // non-transactional insert and its enqueues is healed by the next request,
  // and a repeat adds nothing (the outbox dedupe index is not partial on status).
  const outbox = createOutboxRepo(tx);
  await outbox.enqueue('ticket.triage', { ticketId: ticket.id }, { dedupeKey: `triage:${ticket.id}` });
  await outbox.enqueue(
    'ops.alert',
    { message: `🙋 SmartRemit ops: a customer asked for a person — case ${ticket.id} (${ticket.partnerId}) is in the Tickets queue. Reason: ${input.reason}.` },
    { dedupeKey: `help:${ticket.id}` },
  );
  if (open && REASON_RANK[input.reason] > REASON_RANK.question && !(await recordedReasons(tx, ticket.id)).has(input.reason)) {
    await tickets.appendMessage({
      ticketId: ticket.id,
      actorType: 'system',
      actorId: 'system',
      internal: true,
      body: `Also reported: ${input.reason}. The ${input.channel} chat matched a new request on this open case. The customer's message is not copied here; read it in the conversation log.`,
    });
    await outbox.enqueue('ticket.triage', { ticketId: ticket.id }, { dedupeKey: `triage:${ticket.id}:${input.reason}` });
    await outbox.enqueue(
      'ops.alert',
      { message: `🙋 SmartRemit ops: open case ${ticket.id} (${ticket.partnerId}) has a new report. Reason: ${input.reason}.` },
      { dedupeKey: `help:${ticket.id}:${input.reason}` },
    );
  }
  return { caseId: ticket.id, partnerId: ticket.partnerId, created: !open };
}

/** openHelpCase in its own transaction, then a worker poke once it has committed. */
export async function openHelpCaseAndPoke(db: Db, input: OpenHelpCaseInput): Promise<HelpCaseResult> {
  const result = await db.transaction((tx) => openHelpCase(tx, input));
  pokeWorker();
  return result;
}

/** How many of the customer's newest transfers the cancel check reads. */
const CANCEL_LOOKBACK = 5;

/**
 * Owner decision Q-R43.1: a cancel request is recorded for a person when the
 * customer has a transfer it can be about (paid or held, not refunded); the bot
 * then continues (a paid transfer inside the 30-minute window goes to the
 * sender-cancel path through request_refund). A cancel with only a draft or an
 * unpaid card is the bot's cancel_draft and needs no case. Tenant-scoped (the
 * transfer repo's listByPhone has partner_id AND phone in its WHERE).
 */
export async function cancelCaseWanted(db: DbOrTx, partnerId: PartnerId, phone: string): Promise<boolean> {
  const { items } = await createTransferRepo(db).listByPhone(partnerId, phone, { limit: CANCEL_LOOKBACK });
  return items.some((t) => (t.status === 'paid' || t.status === 'in_review') && (t.refundStatus ?? 'none') === 'none');
}
