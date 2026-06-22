import type { Db } from '@/db/client';
import { createOutboxRepo, type OutboxRepo, type OutboxRow } from '@/db/repos/outbox-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { triageSuggest } from '@/lib/ticket-ai';
import { eligibleAgents, pickLeastLoaded } from '@/lib/ticket-balancer';
import {
  buildSettlementInstruction,
  signBody,
} from '@/lib/providers/http-payment-provider';
import { getFundingProvider, type FundingProvider } from '@/lib/providers/funding-provider';
import { sendEmail as sendEmailDefault, type EmailMessage } from '@/lib/email';
import { buildRefundMessage, completePaymentStage2, recipientTemplateParams, recipientDeliveredFallbackText } from '@/lib/payment';
import { resolvePartnerBranding } from '@/lib/partner-config';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import { env } from '@/lib/env';
import type { Store } from '@/lib/store';
import type { WaCreds } from '@/lib/whatsapp';
import type { Staff, TurnContext } from '@/lib/types';

// outbox-worker — the durability engine (Stage 2b). Every external effect is an
// outbox row written transactionally with the state change that implies it;
// this worker drains them with retries → backoff → dead-letter (+ ops alert).
// Vercel after() is reduced to a best-effort POKE of /api/worker; the GitHub
// Actions 5-minute heartbeat is the delivery GUARANTEE.
//
// Handlers are dispatch-by-kind, DI'd so PGlite tests run them without any
// network. Every handler is IDEMPOTENT by construction (dedupe keys upstream +
// forward-only state machine downstream), so at-least-once delivery is safe.

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
  ) => Promise<string>;
  /**
   * The funds-capture seam for refunds (DI'd like the other effects; absent ⇒
   * getFundingProvider(), so routes need no wiring while tests can inject a
   * failing provider to exercise the retry/dead-letter machinery).
   */
  fundingProvider?: FundingProvider;
  /**
   * Email sender for the 'email.send' effect (partner-lead notifications).
   * Optional — defaults to the real Resend sender (which itself no-ops when
   * RESEND_API_KEY is unset); tests inject a mock to assert recipients.
   */
  sendEmail?: (msg: EmailMessage) => Promise<void>;
  /**
   * The staff roster for the ticket load-balancer (ticket.triage auto-assign).
   * DI'd so PGlite tests inject a roster without touching the Redis auth store;
   * the worker route wires `() => getAuthStore().listStaff()`.
   */
  listStaff: () => Promise<Staff[]>;
}

type Payload = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

async function partnerContext(deps: WorkerDeps, partnerId: string) {
  const partner = await createPartnerRepo(deps.db).getPartner(partnerId);
  const integrations = await createIntegrationsRepo(deps.db).getIntegrations(partnerId);
  return {
    brand: resolvePartnerBranding(partner).brand,
    waCreds: waCredsFrom(integrations),
    integrations,
  };
}

async function handle(deps: WorkerDeps, row: OutboxRow): Promise<void> {
  const p = row.payload as Payload;
  switch (row.kind) {
    // ── Plain customer-facing sends (the transactional message outbox) ──────
    case 'whatsapp.text': {
      const creds = p.creds as WaCreds | undefined;
      await deps.sendText(str(p.to), str(p.body), creds);
      return;
    }
    case 'whatsapp.template': {
      const creds = p.creds as WaCreds | undefined;
      await deps.sendTemplate(
        str(p.to),
        str(p.template),
        str(p.lang),
        (p.params as string[]) ?? [],
        creds,
      );
      return;
    }

    // ── The mock rail's stage 2 (was a 120s after() sleep — now durable) ────
    case 'mock.settle': {
      const transferId = str(p.transferId);
      const { brand, waCreds } = await partnerContext(deps, str(p.partnerId) || 'default');
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
      const { integrations } = await partnerContext(deps, partnerId);
      const webhookSecret = integrations.payment.webhookSecret ?? '';
      const callbackBody = JSON.stringify({ reference, status: 'paid_out' });
      const res = await deps.fetchFn(`${env.appBaseUrl}/api/payment-webhook/simulator`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(webhookSecret ? { 'x-signature': signBody(callbackBody, webhookSecret) } : {}),
        },
        body: callbackBody,
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
      const { refundRef } = await (deps.fundingProvider ?? getFundingProvider()).refund(transfer);
      // The customer-facing message rides the OWNING partner's number — the
      // brand the sender talks to — NEVER the settlement partner's.
      const { waCreds } = await partnerContext(deps, transfer.partnerId);
      await deps.db.transaction(async (tx) => {
        const updated = await createTransferRepo(tx).updateRefund(transferId, {
          refundStatus: 'completed',
          refundRef,
          refundedAt: new Date().toISOString(),
        });
        // Guarded transition refused (a concurrent drain already completed it)
        // ⇒ that drain owns the message; enqueueing here would race it.
        if (!updated) return;
        await createOutboxRepo(tx).enqueue(
          'whatsapp.text',
          { to: transfer.phone, body: buildRefundMessage(transfer), creds: waCreds },
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
    // Durable: the real sender no-ops when RESEND_API_KEY is unset (no retry
    // storm); with a key, a Resend error throws and rides the backoff/dead-letter.
    case 'email.send': {
      await (deps.sendEmail ?? sendEmailDefault)({
        to: Array.isArray(p.to) ? (p.to as unknown[]).map(str).filter(Boolean) : [],
        subject: str(p.subject),
        text: str(p.text),
        ...(typeof p.html === 'string' ? { html: p.html } : {}),
      });
      return;
    }

    // ── One durable agent turn (was the webhook's best-effort after()) ──────
    case 'agent.turn': {
      const phone = str(p.phone);
      const routedPartnerId = str(p.routedPartnerId);
      // Re-resolve the routing partner's outbound creds at RUN time (the
      // payload never carries tokens; rotation is picked up automatically).
      const waCreds = routedPartnerId
        ? (await partnerContext(deps, routedPartnerId)).waCreds
        : undefined;
      const reply = await deps.runAgentTurn(
        phone,
        str(p.messageText),
        (p.turn ?? {}) as TurnContext,
        waCreds,
      );
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
}

/** One drain pass: claim → execute → settle. Time-boxed by the caller. */
export async function drainOnce(
  deps: WorkerDeps,
  workerId: string,
  batchSize = 10,
): Promise<DrainResult> {
  const outbox: OutboxRepo = createOutboxRepo(deps.db);
  const rows = await outbox.claimBatch(batchSize, workerId);
  const result: DrainResult = { processed: 0, failed: 0, dead: 0 };
  for (const row of rows) {
    try {
      await handle(deps, row);
      await outbox.markDone(row.id);
      result.processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      const status = await outbox.markFailed(row.id, row.attempts, message);
      if (status === 'dead') {
        result.dead++;
        // Exactly one alert per dead row (dedupe key), never recursive.
        if (row.kind !== 'ops.alert') {
          await outbox.enqueue(
            'ops.alert',
            { message: `⚠️ SmartRemit ops: outbox #${row.id} (${row.kind}) DEAD after ${row.attempts} attempts: ${message.slice(0, 140)}` },
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
