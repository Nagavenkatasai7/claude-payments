import type { Db, DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { newTransferId } from './id';
import { pokeWorker } from './outbox';
import { HUMAN_HELP_CATEGORY, HUMAN_HELP_SUBJECT } from './ticket-category';
import { boundUntrustedText } from './untrusted-text';
import { regDueAt, type RegClass } from './reg-clocks';
import type { ReportCode } from './error-notice';
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
 *  - fix pack 8 (R44, P9): the reason 'complaint' gives the case the regulatory
 *    class complaint, 'unauthorised' the class fraud_report: urgent, a first
 *    notice and a due date (reg-clocks), one ticket.reg_case.open audit row
 *    (enum codes, ids and dates only). A reused case WITHOUT a class is stamped
 *    once (first notice = its createdAt when it already recorded that reason,
 *    else now); a reused case WITH a class keeps its first class and only ever
 *    takes the EARLIER due date (tightenDueAt). Every other reason: no class,
 *    today's exact case.
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
  /** Pack 8 (P9): the case's class and due date whenever the case HAS a class (new, stamped or reused). */
  regClass?: RegClass;
  dueAt?: string;
  /** true when THIS call created a classed case or stamped the first class on a reused one (the event trigger of P13). */
  caseCreatedOrStamped?: boolean;
}

/** Pack 8 (P9): the regulatory class of a help-case reason; every other reason has none. */
const CLASS_OF: Partial<Record<HelpCaseReason, RegClass>> = { complaint: 'complaint', unauthorised: 'fraud_report' };
/** The report code of the ticket.reg_case.open audit row (P5's ReportCode spelling). */
const CODE_OF: Partial<Record<HelpCaseReason, ReportCode>> = { complaint: 'complaint', unauthorised: 'unauthorized' };

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
  const cls = CLASS_OF[input.reason];
  const nowMs = Date.now();
  // Fix F2 (FC2): lock the found row and continue with the FRESH row (a class a concurrent report
  // stamped is visible); a case staff resolved or closed after the find means no open case.
  const found = await tickets.findOpenHumanHelpCase(input.partnerId, input.phone);
  const open = found ? await tickets.lockOpenCase(found.id, found.partnerId) : null;
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
      // P9 step 1: a classed case (createTicket forces urgent).
      ...(cls ? { regClass: cls, firstNoticeAt: new Date(nowMs), dueAt: new Date(regDueAt(cls, nowMs)) } : {}),
    }));

  // Pack 8 (P9): the class writes, right after the find/create and before the outbox rows.
  // The reasons are read BEFORE today's escalation note is appended (else the new reason would
  // always look recorded).
  const recorded = open && cls ? await recordedReasons(tx, open.id) : null;
  let classOfCase: RegClass | undefined;
  let dueAt: string | undefined;
  let classStamped = false;
  const recordAudit = async (c: RegClass, due: string, reused: boolean) => {
    await createAuditRepo(tx).record({
      partnerId: ticket.partnerId,
      actor: 'system',
      actorType: 'system',
      action: 'ticket.reg_case.open',
      subjectId: ticket.id,
      meta: { regClass: c, code: CODE_OF[input.reason], dueAt: due, reused, stamped: true },
    });
  };
  if (!open) {
    if (cls) {
      classOfCase = cls;
      dueAt = ticket.dueAt ?? new Date(regDueAt(cls, nowMs)).toISOString();
      classStamped = true;
      await recordAudit(cls, dueAt, false);
    }
  } else if (open.regClass) {
    // P9 step 3: the first class is kept; a classed reason only ever moves the due date EARLIER.
    classOfCase = open.regClass;
    dueAt = open.dueAt;
    if (cls) {
      await tickets.tightenDueAt(open.id, open.partnerId, new Date(regDueAt(cls, nowMs)));
      dueAt = (await tickets.getTicket(open.id))?.dueAt ?? dueAt;
    }
  } else if (cls) {
    // P9 step 2: stamp the first class; the first notice is the case's createdAt when the
    // customer already reported this reason on it (critic P5).
    const firstMs = recorded?.has(input.reason) ? Date.parse(open.createdAt) : nowMs;
    const due = new Date(regDueAt(cls, firstMs));
    if (await tickets.stampRegClass(open.id, open.partnerId, { regClass: cls, firstNoticeAt: new Date(firstMs), dueAt: due })) {
      classOfCase = cls;
      dueAt = due.toISOString();
      classStamped = true;
      await recordAudit(cls, dueAt, true);
    } else {
      // P9 step 2b (fix F1): a concurrent report stamped it first. Its first class is kept, and
      // this call's own clock (from the first notice it computed) can only move the due date EARLIER.
      let now = await tickets.getTicket(open.id);
      if (now?.regClass) {
        await tickets.tightenDueAt(open.id, open.partnerId, due);
        now = await tickets.getTicket(open.id);
      }
      classOfCase = now?.regClass;
      dueAt = now?.dueAt;
    }
  }

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
  if (open && REASON_RANK[input.reason] > REASON_RANK.question && !(recorded ?? (await recordedReasons(tx, ticket.id))).has(input.reason)) {
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
  // P13 case event (T18): enqueueCaseEventIfEligible(tx, ticket) when caseCreatedOrStamped
  return {
    caseId: ticket.id,
    partnerId: ticket.partnerId,
    created: !open,
    // A classless case keeps today's exact result shape.
    ...(classOfCase ? { regClass: classOfCase, ...(dueAt ? { dueAt } : {}) } : {}),
    ...(classStamped ? { caseCreatedOrStamped: true } : classOfCase ? { caseCreatedOrStamped: false } : {}),
  };
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
