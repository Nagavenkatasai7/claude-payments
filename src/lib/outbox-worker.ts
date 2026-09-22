import type { Db } from '@/db/client';
import { createOutboxRepo, LEASE_MS, MAX_ATTEMPTS, type OutboxRepo, type OutboxRow } from '@/db/repos/outbox-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { triageSuggest } from '@/lib/ticket-ai';
import { eligibleAgents, pickLeastLoaded } from '@/lib/ticket-balancer';
import {
  buildSettlementInstruction,
  buildReverseInstruction,
  signBody,
  RAIL_TIMEOUT_MS,
} from '@/lib/providers/http-payment-provider';
import { getFundingProvider, type FundingProvider } from '@/lib/providers/funding-provider';
import { isPartnerPulled } from '@/lib/funding-method';
import { sendEmail as sendEmailDefault, type EmailMessage } from '@/lib/email';
import { buildRefundMessage, completePaymentStage2, recipientTemplateParams, recipientDeliveredFallbackText } from '@/lib/payment';
import { resolvePartnerBranding } from '@/lib/partner-config';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import { renderSealedText } from '@/lib/sealed-text';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import { env } from '@/lib/env';
import { logWarn } from '@/lib/log';
import type { Store } from '@/lib/store';
import type { WaCreds } from '@/lib/whatsapp';
import type { PartnerId, Staff, TurnContext } from '@/lib/types';

// outbox-worker — the durability engine (Stage 2b). Every external effect is an
// outbox row written transactionally with the state change that implies it;
// this worker drains them with retries → backoff → dead-letter (+ ops alert).
// Vercel after() is reduced to a best-effort POKE of /api/worker; the GitHub
// Actions 5-minute heartbeat is the delivery GUARANTEE.
//
// Handlers are dispatch-by-kind, DI'd so PGlite tests run them without any
// network. Every handler is IDEMPOTENT by construction (dedupe keys upstream +
// forward-only state machine downstream), so at-least-once delivery is safe.
//
// Rows are LEASED (LEASE_MS) at claim; an expired lease is reclaimed by the
// next drain and the handlers' idempotency makes the re-run safe — except
// agent.turn, which is terminal on a row deadline. Every outbound fetch carries
// an AbortSignal deadline.

export interface WorkerDeps {
  db: Db;
  store: Store;
  sendText: (to: string, text: string, creds?: WaCreds) => Promise<void>;
  sendTemplate: (
    to: string,
    template: string,
    lang: string,
    params: string[],
    creds?: WaCreds,
  ) => Promise<void>;
  fetchFn: typeof fetch;
  recipientTemplateName: string;
  recipientTemplateLang: string;
  /**
   * Run one conversational agent turn and return the reply text (Stage 2c —
   * the inbound webhook enqueues 'agent.turn' instead of running the agent in
   * a best-effort after()). DI'd: the route wires the real createAgent+Ollama;
   * tests stub it.
   */
  runAgentTurn: (
    phone: string,
    message: string,
    turn: TurnContext,
    waCreds?: WaCreds,
    opts?: {
      /** Cooperative row deadline (fix 7) — the agent stops between tool rounds when it fires. */
      signal?: AbortSignal;
      /** The tenant that owns the receiving number (null ⇒ the shared/default number) — fix 1. */
      routedPartnerId?: PartnerId | null;
    },
  ) => Promise<string>;
  /**
   * The funds-capture seam for refunds (DI'd like the other effects; absent ⇒
   * getFundingProvider(), so routes need no wiring while tests can inject a
   * failing provider to exercise the retry/dead-letter machinery).
   */
  fundingProvider?: FundingProvider;
  /**
   * Email sender for the 'email.send' effect (partner-lead notifications).
   * Optional — defaults to the real SMTP sender (which itself no-ops when SMTP
   * creds are unset); tests inject a mock to assert recipients.
   */
  sendEmail?: (msg: EmailMessage) => Promise<void>;
  /**
   * The staff roster for the ticket load-balancer (ticket.triage auto-assign).
   * DI'd so PGlite tests inject a roster without touching the Redis auth store;
   * the worker route wires `() => getAuthStore().listStaff()`.
   */
  listStaff: () => Promise<Staff[]>;
}

/**
 * Hard per-row wall clock. Money handlers are bounded by RAIL_TIMEOUT_MS (15s)
 * far inside this. It exists for agent.turn and ticket.triage — and the
 * honest budget arithmetic is: an agent turn may run MAX_TOOL_ROUNDS (6) tool
 * rounds, each up to 2 × OLLAMA_TIMEOUT_MS (chatWithRetry) = 40s, i.e. up to
 * 240s for a legitimate long turn. Nothing that long fits a 60s function, so
 * the deadline is enforced COOPERATIVELY: the agent.turn branch hands
 * runAgentTurn an AbortSignal that fires at (rowDeadlineMs − COOP_GRACE_MS);
 * agent.ts threads it into every deps.chat call and checks signal.aborted
 * before each tool round, so the turn ends inside the grace with the agent's
 * own FALLBACK_REPLY ("send that again") and its history saved — BEFORE the
 * race timer below gives up on the row. Must stay under TIME_BUDGET_MS (45s)
 * and maxDuration (60s) in src/app/api/worker/route.ts.
 *
 * A RowDeadlineError is RETRYABLE (markFailed, backoff floored at LEASE_MS) for every
 * kind EXCEPT agent.turn, where it is TERMINAL (dead + the deduped dead:<id>
 * alert). Reason: withRowDeadline ABANDONS the handler promise, and an agent
 * turn is not idempotent — send_approve_picker creates a draft + sends a
 * cta_url card, create_transfer/create_schedule mint fresh ids with no
 * idempotency key, sendText has no dedupe key — so a retry running beside a
 * turn that ignored its signal (a hung tool) would double-mint and double-send.
 * The abandoned turn's late reply is dropped by the `abandoned` check in `handle`.
 */
export const ROW_DEADLINE_MS = 40_000;

/**
 * Cooperative grace: the signal a handler receives fires THIS much BEFORE the
 * row's hard deadline. If both fired at the same instant, `signal.aborted`
 * would be true on the cooperative path too (the agent's catch does
 * saveConversation I/O before returning FALLBACK_REPLY), so the fallback would
 * always arrive after the race lost — every deadline terminal, no fallback
 * ever sent. 5s covers the agent's catch path with margin.
 */
export const COOP_GRACE_MS = 5_000;

/**
 * The per-row signal handed to `handle`: an AbortSignal that fires at
 * (deadline − COOP_GRACE_MS) for handlers that can stop cooperatively, plus
 * `abandoned`, set by withRowDeadline ONLY when ITS timer won the race. That
 * flag — never `.aborted` — is the discriminator for dropping a late reply:
 * `.aborted` alone means "stop now; your reply still counts".
 */
export type RowSignal = AbortSignal & { abandoned: boolean };

function newRowSignal(rowDeadlineMs: number): RowSignal {
  const coopMs = Math.max(1, rowDeadlineMs - COOP_GRACE_MS); // tests shrink rowDeadlineMs; never a non-positive timeout
  return Object.assign(AbortSignal.timeout(coopMs), { abandoned: false });
}

export class RowDeadlineError extends Error {
  constructor(ms: number) {
    super(`outbox row deadline exceeded (${ms}ms)`);
    this.name = 'RowDeadlineError';
  }
}

/** Kinds whose handler is NOT idempotent: a deadline is terminal, never a retry. */
const TERMINAL_ON_DEADLINE: ReadonlySet<string> = new Set(['agent.turn']);

/**
 * Race `work` against the row deadline. The handler already holds `signal`
 * (cooperative — it fired COOP_GRACE_MS earlier); the timer here is the
 * backstop for handlers that ignore it, and it marks the row `abandoned` when
 * it fires so a late completion of the abandoned promise can be told apart
 * from a cooperative one that finished inside the grace.
 */
async function withRowDeadline<T>(work: Promise<T>, ms: number, signal: RowSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      signal.abandoned = true;
      reject(new RowDeadlineError(ms));
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Payload = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface PartnerCtx {
  brand: string;
  waCreds: WaCreds | undefined;
  integrations: PartnerIntegrations;
}

/** The drain-time resolver every handler uses for a partner's brand + WhatsApp creds + rail config. */
export type PartnerResolver = (partnerId: string) => Promise<PartnerCtx>;

async function partnerContext(deps: WorkerDeps, partnerId: string): Promise<PartnerCtx> {
  // Pure reads, repeatable on every attempt. No row / a half-configured channel
  // ⇒ waCreds undefined ⇒ the shared env number — never a throw, so a customer
  // message cannot dead-letter on a tenant-config gap. A transient DB error
  // throws and rides the ordinary backoff (no token is in the error: the token
  // is never in scope until getIntegrations returns).
  const partner = await createPartnerRepo(deps.db).getPartner(partnerId);
  const integrations = await createIntegrationsRepo(deps.db).getIntegrations(partnerId);
  return {
    brand: resolvePartnerBranding(partner).brand,
    waCreds: waCredsFrom(integrations),
    integrations,
  };
}

/**
 * One resolver per drain BATCH (fix 11): whatsapp.text/template now resolve
 * creds per row, so N rows for one partner must cost ONE partner + ONE
 * integrations read, not 2N. A rejected resolution is evicted so the next row
 * re-reads instead of inheriting it. Scope is the batch, never the process — a
 * rotated token is picked up by the next drain with no re-enqueue.
 */
export function memoizedPartnerContext(deps: WorkerDeps): PartnerResolver {
  const cache = new Map<string, Promise<PartnerCtx>>();
  return (partnerId) => {
    const hit = cache.get(partnerId);
    if (hit) return hit;
    const fresh = partnerContext(deps, partnerId);
    cache.set(partnerId, fresh);
    fresh.catch(() => cache.delete(partnerId));
    return fresh;
  };
}

/**
 * Creds for a plain customer-facing send. `payload.partnerId` is the
 * AUTHORITATIVE tenant (a ledger value written by the producer — never inferred
 * from `to`); its creds are resolved NOW, so a DB dump holds no bearer token
 * and a rotated token needs no re-enqueue. No partnerId ⇒ shared env number.
 *
 * TRANSITION SHIM (Task 8, wave 4, deletes it): a row the PREVIOUS release
 * enqueued carries `creds` and no `partnerId`; honour it so the deploy→migrate
 * window drains on the right number. drizzle/0016_scrub_outbox_secrets
 * back-fills partnerId from the phone number id and strips creds where that is
 * safe — but it deliberately LEAVES an UNSENT row whose number matches no
 * current partner (stripping it would move the send to the shared number), and
 * a stale old-deployment writer can add rows after it runs. So applying 0016
 * alone does NOT make this branch unreachable: remove it only once
 * `scripts/outbox-status.ts` "SECRETS AT REST" prints `none` on prod.
 */
async function resolveSendCreds(p: Payload, partner: PartnerResolver): Promise<WaCreds | undefined> {
  const partnerId = str(p.partnerId);
  if (partnerId) return (await partner(partnerId)).waCreds;
  const legacy = p.creds as Partial<WaCreds> | null | undefined;
  if (legacy && typeof legacy.phoneNumberId === 'string' && typeof legacy.token === 'string') {
    return { phoneNumberId: legacy.phoneNumberId, token: legacy.token };
  }
  return undefined;
}

async function handle(
  deps: WorkerDeps,
  row: OutboxRow,
  signal: RowSignal,
  partner: PartnerResolver,
): Promise<void> {
  const p = row.payload as Payload;
  switch (row.kind) {
    // ── Plain customer-facing sends (the transactional message outbox) ──────
    // Payloads carry the OWNING partnerId, never creds (fix 11 / F49·F54·F58).
    case 'whatsapp.text': {
      await deps.sendText(str(p.to), str(p.body), await resolveSendCreds(p, partner));
      return;
    }
    case 'whatsapp.template': {
      await deps.sendTemplate(
        str(p.to),
        str(p.template),
        str(p.lang),
        (p.params as string[]) ?? [],
        await resolveSendCreds(p, partner),
      );
      return;
    }

    // ── The mock rail's stage 2 (was a 120s after() sleep — now durable) ────
    case 'mock.settle': {
      const transferId = str(p.transferId);
      const { brand, waCreds } = await partner(str(p.partnerId) || 'default');
      const stage2 = await completePaymentStage2(deps.store, transferId, { brand });
      for (const msg of stage2.senderMessages) {
        await deps.sendText(stage2.transfer.phone, msg, waCreds);
      }
      if (stage2.senderMessages.length > 0 && stage2.transfer.recipientPhone) {
        const recipientPhone = stage2.transfer.recipientPhone;
        // Template-first, but degrade to a free-form text if Meta rejects the
        // template — otherwise the recipient silently gets nothing.
        try {
          await deps.sendTemplate(
            recipientPhone,
            deps.recipientTemplateName,
            deps.recipientTemplateLang,
            recipientTemplateParams(stage2.transfer),
            waCreds,
          );
        } catch (err) {
          console.warn('mock.settle: recipient template failed; falling back to text:', err);
          await deps.sendText(
            recipientPhone,
            recipientDeliveredFallbackText(stage2.transfer, brand),
            waCreds,
          );
        }
      }
      return;
    }

    // ── POST the SIGNED settlement instruction to the partner's rail ────────
    case 'settlement.instruct': {
      const transferId = str(p.transferId);
      const transferRepo = createTransferRepo(deps.db);
      const transfer = await transferRepo.getTransfer(transferId, { decrypt: true });
      if (!transfer) return; // gone ⇒ nothing to instruct (idempotent no-op)
      // DEFENCE IN DEPTH: instruct only money the LEDGER still says is payable.
      //  • definitively NOT going out (cancelled / delivered, or a refund that
      //    is pending / completed) ⇒ skip: mark DONE with a log — retrying
      //    can never help and paying out would move money twice;
      //  • paid with a refund merely REQUESTED (or a failed refund), or any
      //    other unexpected status ⇒ THROW (retryable): the row backs off and,
      //    if it dies, the dead-row ops alert fires. Never silently done — a
      //    request staff later dismiss must still be paid out.
      const refund = transfer.refundStatus ?? 'none';
      if (
        transfer.status === 'cancelled' ||
        transfer.status === 'delivered' ||
        refund === 'pending' ||
        refund === 'completed'
      ) {
        logWarn('outbox.instruct-skipped', 'transfer not payable; instruction not sent', {
          transferId,
          status: transfer.status,
          refundStatus: refund,
        });
        return;
      }
      if (transfer.status !== 'paid' || refund !== 'none') {
        throw new Error(
          `Settlement instruction held: transfer is ${transfer.status} with refund ${refund} — retrying`,
        );
      }
      // Best-rate routing: the RAIL is the settlement partner's when routed
      // (settlementPartnerId set) — their endpoint, their signing secret, and
      // their id in the instruction (the rail verifies with the partner_id it
      // carries). Unrouted ⇒ the owning partner, exactly as before.
      const railPartnerId = transfer.settlementPartnerId ?? transfer.partnerId;
      const integrations = await createIntegrationsRepo(deps.db).getIntegrations(railPartnerId);
      const settlementUrl = integrations.payment.credentials?.settlementUrl ?? '';
      const signingSecret = integrations.payment.credentials?.signingSecret ?? '';
      if (!settlementUrl) throw new Error('Settlement endpoint not configured.');
      const rawBody = JSON.stringify({
        ...buildSettlementInstruction(transfer),
        partner_id: railPartnerId,
      });
      const res = await deps.fetchFn(settlementUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(signingSecret ? { 'x-signature': signBody(rawBody, signingSecret) } : {}),
        },
        body: rawBody,
        signal: AbortSignal.timeout(RAIL_TIMEOUT_MS), // rail-09: a hung rail is a RETRYABLE failure, never a stuck row
      });
      if (!res.ok) {
        throw new Error(`Settlement instruction rejected (${res.status})`);
      }
      let providerRef = `rail-${transferId}`;
      try {
        const parsed = (await res.json()) as { providerRef?: unknown };
        if (typeof parsed.providerRef === 'string' && parsed.providerRef !== '') {
          providerRef = parsed.providerRef;
        }
      } catch {
        /* non-JSON 2xx ack — keep deterministic ref */
      }
      await transferRepo.setProviderRef(transferId, providerRef); // write-once
      return;
    }

    // ── The hosted reference rail's settle callback (was a 12s after()) ─────
    case 'rail.callback': {
      const reference = str(p.reference);
      const partnerId = str(p.partner_id) || str(p.partnerId);
      const { integrations } = await partner(partnerId);
      const webhookSecret = integrations.payment.webhookSecret ?? '';
      // fix 8: the reference rail's one failure mode rides the same row —
      // `status` (default paid_out) and an optional `reason` pass through.
      const cbStatus = str(p.status) || 'paid_out';
      const cbReason = str(p.reason);
      const callbackBody = JSON.stringify({ reference, status: cbStatus, ...(cbReason ? { reason: cbReason } : {}) });
      const res = await deps.fetchFn(`${env.appBaseUrl}/api/payment-webhook/simulator`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(webhookSecret ? { 'x-signature': signBody(callbackBody, webhookSecret) } : {}),
        },
        body: callbackBody,
        signal: AbortSignal.timeout(RAIL_TIMEOUT_MS), // rail-09: a hung rail is a RETRYABLE failure, never a stuck row
      });
      if (!res.ok) throw new Error(`Rail status callback rejected (${res.status})`);
      return;
    }

    // ── Return the sender's money (rejected / undeliverable transfers) ──────
    case 'funding.refund': {
      const transferId = str(p.transferId);
      const transfer = await createTransferRepo(deps.db).getTransfer(transferId);
      if (!transfer) return; // gone ⇒ nothing to refund (idempotent no-op)
      // Replay after completion (retry of a row that actually succeeded, ops
      // double-enqueue) is a clean no-op: the provider is never re-asked and
      // the customer never hears about it twice.
      if ((transfer.refundStatus ?? 'none') === 'completed') return;
      // Idempotent by transfer id on the provider side; a throw here rethrows
      // into the outbox machinery (backoff → dead-letter → existing ops alert).
      // refundStatus stays 'pending' through retries/death — recovery is the
      // ops dead-letter Retry (re-runs this handler) or the funding webhook's
      // refund_failed (pending → failed, surfacing the ops Refunds queue).
      let refundRef: string;
      if (isPartnerPulled(transfer.fundingMethod)) {
        // NON-CUSTODIAL reverse: SmartRemit captured nothing on a partner-pulled
        // transfer (ach_pull / bank_pull), so there is no funds-provider charge to
        // refund. Instead we POST a SIGNED REVERSE instruction to the partner's
        // rail — it debited the payer, so it owns the return. Reuses the
        // settlement.instruct POST+sign recipe.
        const full = await createTransferRepo(deps.db).getTransfer(transferId, { decrypt: true });
        if (!full) return; // gone ⇒ nothing to reverse (idempotent no-op)
        const railPartnerId = full.settlementPartnerId ?? full.partnerId;
        const integrations = await createIntegrationsRepo(deps.db).getIntegrations(railPartnerId);
        const settlementUrl = integrations.payment.credentials?.settlementUrl ?? '';
        const signingSecret = integrations.payment.credentials?.signingSecret ?? '';
        if (!settlementUrl) throw new Error('Settlement endpoint not configured.');
        const rawBody = JSON.stringify({ ...buildReverseInstruction(full), partner_id: railPartnerId });
        const res = await deps.fetchFn(settlementUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(signingSecret ? { 'x-signature': signBody(rawBody, signingSecret) } : {}),
          },
          body: rawBody,
          signal: AbortSignal.timeout(RAIL_TIMEOUT_MS), // rail-09: a hung rail is a RETRYABLE failure, never a stuck row
        });
        if (!res.ok) throw new Error(`Reverse instruction rejected (${res.status})`);
        refundRef = `reverse-${transferId}`;
        try {
          const parsed = (await res.json()) as { providerRef?: unknown };
          if (typeof parsed.providerRef === 'string' && parsed.providerRef !== '') {
            refundRef = parsed.providerRef;
          }
        } catch {
          /* non-JSON 2xx ack — keep the deterministic ref */
        }
      } else {
        ({ refundRef } = await (deps.fundingProvider ?? getFundingProvider()).refund(transfer));
      }
      await deps.db.transaction(async (tx) => {
        const updated = await createTransferRepo(tx).updateRefund(transferId, {
          refundStatus: 'completed',
          refundRef,
          refundedAt: new Date().toISOString(),
        });
        // Guarded transition refused (a concurrent drain already completed it)
        // ⇒ that drain owns the message; enqueueing here would race it.
        if (!updated) return;
        // The customer-facing message rides the OWNING partner's number — the
        // brand the sender talks to — NEVER the settlement partner's. Only the
        // id is persisted (fix 11 / F54); creds resolve when THIS row drains.
        await createOutboxRepo(tx).enqueue(
          'whatsapp.text',
          { to: transfer.phone, body: buildRefundMessage(transfer), partnerId: transfer.partnerId },
          { dedupeKey: `refundmsg:${transferId}` },
        );
      });
      return;
    }

    // ── AI auto-triage of a freshly-created CUSTOMER ticket (out-of-band) ────
    // The copilot's one-shot triageSuggest runs HERE, never inline at ticket
    // creation — a synchronous Ollama call must never block the customer-facing
    // redirect. The model's output is CLAMPED to the closed lists inside
    // triageSuggest, so setTriage always gets a safe shape. Idempotent: setTriage
    // is a plain re-settable write, so an at-least-once redelivery just re-sets
    // the same value. A model/Ollama outage throws and rides the worker's
    // retry/backoff; a permanent failure dead-letters like any other kind,
    // leaving the ticket un-triaged for staff to hand-sort (acceptable).
    case 'ticket.triage': {
      const ticketId = str(p.ticketId);
      const repo = createTicketRepo(deps.db);
      const ticket = await repo.getTicket(ticketId);
      if (!ticket || ticket.kind !== 'customer') return; // gone / not a customer ticket ⇒ no-op
      const messages = await repo.listMessages(ticketId, { includeInternal: false });
      const firstMessage = messages.find((m) => !m.internal)?.body ?? '';
      const { category, priority } = await triageSuggest(ticket.subject, firstMessage);
      await repo.setTriage(ticketId, { category, priority });
      await createAuditRepo(deps.db).record({
        partnerId: ticket.partnerId,
        actor: 'system',
        actorType: 'system',
        action: 'ticket.triage',
        subjectId: ticket.id,
        meta: { source: 'copilot', category, priority },
      });

      // ── AI-assisted load-balancer: auto-assign to the least-loaded agent ────
      // Runs AFTER triage but is INDEPENDENT of its outcome (deterministic — it
      // still assigns if triageSuggest fell back to defaults). assignIfUnassigned
      // is the atomic guard: idempotent on replay, and never overrides a manual
      // assignment that landed first. No eligible agents ⇒ left unassigned for
      // support/admin to pick up.
      if (!ticket.assignedTo) {
        const agents = eligibleAgents(await deps.listStaff(), ticket.partnerId);
        const chosen = pickLeastLoaded(agents, await repo.openTicketCountsByAssignee());
        if (chosen && (await repo.assignIfUnassigned(ticketId, chosen.username))) {
          await createAuditRepo(deps.db).record({
            partnerId: ticket.partnerId,
            actor: 'system',
            actorType: 'system',
            action: 'ticket.assign',
            subjectId: ticket.id,
            meta: { assignee: chosen.username, source: 'load-balancer' },
          });
        }
      }
      return;
    }

    // ── Stuck-money / dead-letter alerts to the ops phone ───────────────────
    case 'ops.alert': {
      const to = env.opsAlertPhone;
      if (!to) return; // unconfigured ⇒ drop silently (dashboard still shows it)
      await deps.sendText(to, str(p.message));
      return;
    }

    // ── Transactional email (partner-lead notifications) ────────────────────
    // Durable: the real sender no-ops when SMTP is unconfigured (no retry storm);
    // when configured, a send failure throws and rides the backoff/dead-letter.
    // `sealed` (optional) maps {{placeholders}} in text/html to field-crypto
    // blobs — the partner-application invite link (fix 11 / F66). Opened at SEND
    // time only; the row stays ciphertext. A missing blob throws naming the
    // placeholder, never a value.
    case 'email.send': {
      await (deps.sendEmail ?? sendEmailDefault)({
        to: Array.isArray(p.to) ? (p.to as unknown[]).map(str).filter(Boolean) : [],
        subject: str(p.subject),
        text: renderSealedText(str(p.text), p.sealed),
        ...(typeof p.html === 'string' ? { html: renderSealedText(p.html, p.sealed) } : {}),
      });
      return;
    }

    // ── One durable agent turn (was the webhook's best-effort after()) ──────
    case 'agent.turn': {
      const phone = str(p.phone);
      const requested = str(p.routedPartnerId);
      // The payload's routedPartnerId is an IDENTITY input (fix 1, D4): assert
      // it names an existing AND ACTIVE partner before a turn runs under it.
      // FAIL CLOSED: an unknown or inactive (e.g. suspended) partner still holds
      // a valid Meta app secret, so its signed webhook could name ANY `from`
      // phone — running that turn under the default tenant would let it act as
      // (and inject history into) another tenant's customer. The row is
      // finished with NO agent run and NO reply, and ONE deduped ops alert is
      // raised (keyed on the row id, so retries never re-alert).
      let routedPartnerId: PartnerId | null = null;
      if (requested) {
        const known = await createPartnerRepo(deps.db).getPartner(requested);
        if (!known || known.status !== 'active') {
          logWarn('worker.agent', 'agent.turn routedPartnerId names no ACTIVE partner — turn dropped', { id: row.id, kind: row.kind });
          await createOutboxRepo(deps.db).enqueue(
            'ops.alert',
            { message: `⚠️ SmartRemit ops: outbox #${row.id} (agent.turn) carried an unknown or inactive routedPartnerId; the turn was dropped. Check the inbound routing config.` },
            { dedupeKey: `badtenant:${row.id}` },
          );
          return;
        }
        routedPartnerId = requested;
      }
      // Re-resolve the routing partner's outbound creds at RUN time (the
      // payload never carries tokens; rotation is picked up automatically).
      const waCreds = routedPartnerId ? (await partner(routedPartnerId)).waCreds : undefined;
      const reply = await deps.runAgentTurn(
        phone,
        str(p.messageText),
        (p.turn ?? {}) as TurnContext,
        waCreds,
        { signal, routedPartnerId }, // the tenant the turn runs under (fix 1) + fix 7's cooperative deadline
      );
      // A turn that outlived its HARD deadline was ABANDONED by withRowDeadline
      // and the row is already dead — never send its late reply (a second
      // customer message for the same inbound). The COOPERATIVE path is not
      // abandoned: the agent saw `signal.aborted` at (deadline − COOP_GRACE_MS),
      // returned FALLBACK_REPLY and saved history inside the grace — but
      // `signal.aborted` is true there too, so the discriminator is `abandoned`
      // (set only by the race timer), never `aborted`.
      if (signal.abandoned) {
        logWarn('worker.agent', 'agent.turn reply dropped: row deadline already passed', { id: row.id, kind: row.kind });
        return;
      }
      if (reply.trim()) await deps.sendText(phone, reply, waCreds);
      return;
    }

    default:
      throw new Error(`Unknown outbox kind: ${row.kind}`);
  }
}

export interface DrainResult {
  processed: number;
  failed: number;
  dead: number;
  /** Rows claimed but handed back unstarted because `stopAfter` passed. */
  released: number;
}

export interface DrainOptions {
  /** Epoch ms after which no further claimed row is STARTED; the rest are released. */
  stopAfter?: number;
  /** Per-row wall clock (tests shrink it); defaults to ROW_DEADLINE_MS. */
  rowDeadlineMs?: number;
  /**
   * Epoch ms when the platform will KILL this invocation (route: started +
   * maxDuration − margin). A NON-idempotent row (TERMINAL_ON_DEADLINE) that
   * could still be running then is released unstarted rather than started:
   * killed mid-turn it would be reclaimed after LEASE_MS and RE-RUN beside its
   * own ghost — the double-mint invariant 5 forbids. Money rows (15s rail
   * deadline) still start; stopAfter bounds them.
   */
  hardStopAt?: number;
}

/** One drain pass: claim → execute → settle. Time-boxed by the caller. */
export async function drainOnce(
  deps: WorkerDeps,
  workerId: string,
  batchSize = 10,
  opts: DrainOptions = {},
): Promise<DrainResult> {
  const outbox: OutboxRepo = createOutboxRepo(deps.db);
  const rows = await outbox.claimBatch(batchSize, workerId);
  const partner = memoizedPartnerContext(deps); // one drain-time creds resolver per BATCH (fix 11)
  const rowDeadlineMs = opts.rowDeadlineMs ?? ROW_DEADLINE_MS;
  const result: DrainResult = { processed: 0, failed: 0, dead: 0, released: 0 };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (opts.stopAfter !== undefined && Date.now() >= opts.stopAfter) {
      // Out of budget: give the unstarted remainder back NOW (attempt refunded)
      // rather than parking it under a 5-minute lease.
      result.released += await outbox.releaseUnstarted(rows.slice(i).map((r) => r.id), workerId);
      break;
    }
    if (
      opts.hardStopAt !== undefined &&
      TERMINAL_ON_DEADLINE.has(row.kind) &&
      Date.now() + rowDeadlineMs > opts.hardStopAt
    ) {
      // Cannot finish before the platform kills us: hand the non-idempotent
      // row back unstarted (attempt refunded) for the next invocation.
      result.released += await outbox.releaseUnstarted([row.id], workerId);
      continue;
    }
    // One COOPERATIVE signal per row (fires COOP_GRACE_MS before the hard
    // deadline): handlers that can stop cooperatively (agent.turn) get it; the
    // timer inside withRowDeadline is the backstop for the ones that cannot,
    // and it flags the row `abandoned` when it fires.
    const signal = newRowSignal(rowDeadlineMs);
    try {
      await withRowDeadline(handle(deps, row, signal, partner), rowDeadlineMs, signal);
      if (await outbox.markDone(row.id, workerId)) {
        result.processed++;
      } else {
        // Our lease was reclaimed while we ran (we outlived LEASE_MS): the new
        // owner's outcome wins. Ids/kinds only — never the payload.
        logWarn('worker.lease', 'markDone refused: lease no longer ours', { id: row.id, kind: row.kind });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      // TERMINAL deadline: an abandoned non-idempotent handler (agent.turn) must
      // never be retried beside its own ghost — force the dead ceiling so the
      // ordinary dead-letter path (one deduped dead:<id> alert) handles it.
      const deadline = err instanceof RowDeadlineError;
      const terminal = deadline && TERMINAL_ON_DEADLINE.has(row.kind);
      // A RETRYABLE deadline: the abandoned handler may still be running in this
      // invocation (withRowDeadline cannot cancel it). Park the row for a full
      // LEASE_MS — past maxDuration — so no other worker runs it concurrently
      // (duplicate send, double mock.settle, double refund).
      const status = await outbox.markFailed(
        row.id,
        terminal ? MAX_ATTEMPTS : row.attempts,
        message,
        workerId,
        deadline ? { minBackoffSec: Math.ceil(LEASE_MS / 1000) } : {},
      );
      if (status === 'lost') {
        logWarn('worker.lease', 'markFailed refused: lease no longer ours', { id: row.id, kind: row.kind });
        continue;
      }
      if (status === 'dead') {
        result.dead++;
        // Exactly one alert per dead row (dedupe key), never recursive.
        if (row.kind !== 'ops.alert') {
          await outbox.enqueue(
            'ops.alert',
            // A terminal deadline is dead at attempt 1 — say so, or ops goes looking for 8 attempts.
            { message: `⚠️ SmartRemit ops: outbox #${row.id} (${row.kind}) ${terminal ? 'DEAD (terminal: row deadline exceeded)' : `DEAD after ${row.attempts} attempts`}: ${message.slice(0, 140)}` },
            { dedupeKey: `dead:${row.id}` },
          );
        }
      } else {
        result.failed++;
      }
    }
  }
  return result;
}
