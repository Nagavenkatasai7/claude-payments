import type { Db } from '@/db/client';
import { createOutboxRepo, LEASE_MS, MAX_ATTEMPTS, type OutboxRepo, type OutboxRow } from '@/db/repos/outbox-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { triageSuggest } from '@/lib/ticket-ai';
import { HUMAN_HELP_CATEGORY } from '@/lib/ticket-category';
import { eligibleAgents, pickLeastLoaded } from '@/lib/ticket-balancer';
import {
  buildSettlementInstruction,
  buildReverseInstruction,
  RAIL_TIMEOUT_MS,
} from '@/lib/providers/http-payment-provider';
import { signRailHeaders } from '@/lib/providers/rail-signature';
import { loadComplianceBlock } from '@/lib/instruction-compliance';
import { railSecrets } from '@/lib/partner-integrations';
import { getFundingProvider, type FundingProvider } from '@/lib/providers/funding-provider';
import { isPartnerPulled } from '@/lib/funding-method';
import { sendEmail as sendEmailDefault, type EmailMessage, type EmailOutcome } from '@/lib/email';
import { parseEmailDedupeKey } from '@/lib/partner-invite-email';
import { buildRefundMessage, completePaymentStage2, recipientTemplateParams, recipientDeliveredFallbackText } from '@/lib/payment';
import { resolvePartnerBranding } from '@/lib/partner-config';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import { renderSealedText } from '@/lib/sealed-text';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import { env } from '@/lib/env';
import { checkSettlementUrl, safeProviderRef } from '@/lib/settlement-url';
import { logWarn, scrub } from '@/lib/log';
import { FALLBACK_REPLY } from '@/lib/agent-fallback';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { pokeWorker } from '@/lib/outbox';
import { suppressForOptOut } from '@/lib/consent-gate';
import { createCustomerStore } from '@/lib/customer-store';
import type { Store } from '@/lib/store';
import type { WaCreds } from '@/lib/whatsapp';
import { WhatsAppSendError } from '@/lib/whatsapp-errors';
import { sendBusinessInitiated, toTemplateParam } from '@/lib/whatsapp-business-initiated';
import type { PartnerId, Staff, TurnContext } from '@/lib/types';

// outbox-worker — the durability engine (Stage 2b). Every external effect is an
// outbox row written transactionally with the state change that implies it;
// this worker drains them with retries → backoff → dead-letter (+ ops alert).
// Vercel after() is reduced to a best-effort POKE of /api/worker; a Vercel cron
// drains every minute and an hourly GitHub Actions heartbeat backs it up
// (src/lib/worker-cadence.ts).
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
   * Optional — defaults to the real SMTP sender (which reports a skip when SMTP
   * creds are unset); tests inject a mock to assert recipients. A `void` result
   * counts as 'sent' (Program-Fix 39 widened this from Promise<void>).
   */
  sendEmail?: (msg: EmailMessage) => Promise<EmailOutcome | void>;
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
 * Program-Fix 25: kinds whose handler is ONE WhatsApp send, so a PERMANENT Graph
 * rejection (131030 not allow-listed, 132001 no such template, …) is dead at
 * attempt 1 instead of burning 8 retries. NEVER mock.settle: it marks the
 * transfer delivered BEFORE sending, and its retry finishes cleanly through the
 * idempotent stage 2. Accepted trade-off: a recipient allow-listed mid-backoff
 * no longer gets the late retry.
 */
const PERMANENT_DEAD_KINDS: ReadonlySet<string> = new Set(['whatsapp.text', 'whatsapp.template', 'ops.alert']);
const OPS_ALERT_TEMPLATE_LANG = 'en';

/**
 * Program-Fix 34A: how long a turn waits (uncharged) before it is re-tried when
 * an older turn for the same (tenant, phone) is still waiting or running.
 */
export const TURN_BUSY_DEFER_SEC = 3;

/**
 * Program-Fix 34A: the most a turn may spend BLOCKED behind its phone's other
 * turns, measured from the row's created_at (in Postgres). Past it, a blocked
 * turn is answered with FALLBACK_REPLY and one ops alert, then marked done —
 * never dead-lettered. The per-phone lock is SET NX EX 90, so a stuck lock
 * self-heals long before this; the bound catches an older turn stuck in a
 * failure backoff. A turn past the bound that is NOT blocked simply runs.
 */
export const TURN_BUSY_MAX_WAIT_MS = 10 * 60_000;

/**
 * Program-Fix 34A: thrown by the agent.turn handler when the turn cannot START
 * yet (an older turn for the same phone is waiting, or the per-phone lock is
 * held). drainOnce catches it BEFORE markFailed and defers the row UNCHARGED
 * (outbox.deferUncharged) — it is not a failure, spends no attempt, and counts
 * as `released` so the route's release-only-pass stop still ends churn.
 */
export class TurnBusyError extends Error {
  constructor(readonly delaySec: number = TURN_BUSY_DEFER_SEC) {
    super('turn_busy');
    this.name = 'TurnBusyError';
  }
}

const hourBucket = (): number => Math.floor(Date.now() / 3_600_000);

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

/**
 * fix 29: the amount a `rail.callback` row carries (echoed by the reference
 * rail from the verified instruction). Only a {destination, destination_currency}
 * pair of number|string / string passes through; anything else is dropped.
 */
function railCallbackAmount(v: unknown): { destination: number | string; destination_currency: string } | null {
  if (!v || typeof v !== 'object') return null;
  const a = v as Record<string, unknown>;
  const d = a.destination;
  const c = a.destination_currency;
  if ((typeof d !== 'number' && typeof d !== 'string') || typeof c !== 'string') return null;
  return { destination: d, destination_currency: c };
}

/**
 * Fix 22: the SYNC settlement-URL rule, run in the handler BEFORE any fetch.
 * A refusal is a thrown, RETRYABLE handler error (backoff → dead at
 * MAX_ATTEMPTS → the deduped ops alert): never skipped, never followed. The
 * message is the fixed reason code only — it lands in outbox.last_error and the
 * alert text, so it must never carry the URL. No DNS here (ruling 25): the
 * connect-time address check lives in safeFetch, the default fetchFn.
 */
function assertSettlementUrl(settlementUrl: string): void {
  const check = checkSettlementUrl(settlementUrl, { appOrigin: env.appBaseUrl, production: env.isProduction });
  if (!check.ok) throw new Error(`settlement_url_refused:${check.reason}`);
}

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
 * A payload NEVER carries send credentials — they come only from the partner's
 * integrations, resolved here at drain time. The fix 18 transition shim that
 * honoured a pre-fix-11 `creds` object (Program-Fix 12, second PR, removed once
 * `scripts/outbox-status.ts` "SECRETS AT REST" read `none` on prod) is gone.
 * FAIL CLOSED: a row with a non-null `creds` and no resolvable partnerId
 * (missing, null or "" — `str()` ⇒ '') is a legacy row or a regressed producer.
 * Sending it on the persisted token would trust a secret at rest; sending it
 * on the shared number would move a partner's message to the wrong sender. So
 * it throws a FIXED reason code (no value from the payload), rides the ordinary
 * backoff and dead-letters at MAX_ATTEMPTS with the single `dead:<id>` alert.
 * `"creds": null` holds nothing (the same reading as listSecretsAtRest and
 * drizzle 0016) and is not a legacy row; any OTHER non-null value fails closed
 * here even where the detector's jsonb_typeof = 'object' test would not count
 * it — stricter on purpose. A partnerId row ignores any `creds`
 * beside it: the ledger tenant wins, a payload can never pin a token. The
 * regression detectors stay: enqueue's test-only tripwire refuses a creds
 * payload, and listSecretsAtRest / the SECRETS AT REST section count survivors.
 */
async function resolveSendCreds(p: Payload, partner: PartnerResolver): Promise<WaCreds | undefined> {
  const partnerId = str(p.partnerId);
  if (partnerId) return (await partner(partnerId)).waCreds;
  if (p.creds != null) throw new Error('legacy_creds_payload');
  return undefined;
}

/**
 * Program-Fix 49A (whatsapp-10d): the consent gate for a plain customer-facing
 * row. The tenant is the payload's partnerId (the ledger tenant the producer
 * wrote), else the default tenant — the shared number IS the default tenant.
 * Only a `nonessential` row reads the customer; a read error throws and rides
 * the ordinary backoff (never a send to someone who may have opted out).
 */
async function optedOutSkip(deps: WorkerDeps, row: OutboxRow, p: Payload): Promise<boolean> {
  const tenant = str(p.partnerId) || DEFAULT_PARTNER_ID;
  const suppressed = await suppressForOptOut(createCustomerStore(deps.db, deps.store), tenant, str(p.to), p.category);
  if (suppressed) {
    logWarn('worker.optout', 'nonessential message suppressed: customer opted out', { id: row.id, kind: row.kind });
  }
  return suppressed;
}

/**
 * Run one agent turn and return ONLY its reply text (Program-Fix 34A). The
 * routing partner's outbound creds are re-resolved at RUN time (the payload
 * never carries tokens; rotation is picked up automatically) and live only in
 * this scope: they ride the turn for its interactive sends (cards, pickers),
 * while the reply text — model output — is what the caller enqueues. Kept a
 * separate function so the creds never share a scope with an enqueue payload.
 */
async function runTurnForReply(
  deps: WorkerDeps,
  p: Payload,
  signal: RowSignal,
  routedPartnerId: PartnerId | null,
  partner: PartnerResolver,
): Promise<string> {
  const waCreds = routedPartnerId ? (await partner(routedPartnerId)).waCreds : undefined;
  return deps.runAgentTurn(
    str(p.phone),
    str(p.messageText),
    (p.turn ?? {}) as TurnContext,
    waCreds,
    { signal, routedPartnerId }, // the tenant the turn runs under (fix 1) + fix 7's cooperative deadline
  );
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
    // Program-Fix 49A: a `nonessential` row to an opted-out customer completes
    // WITHOUT sending (no retry, no dead letter). No category ⇒ essential, so
    // rows from the previous build deliver exactly as before.
    case 'whatsapp.text': {
      if (await optedOutSkip(deps, row, p)) return;
      await deps.sendText(str(p.to), str(p.body), await resolveSendCreds(p, partner));
      return;
    }
    case 'whatsapp.template': {
      if (await optedOutSkip(deps, row, p)) return;
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
      // fix 29 (money-09): the rail reported a DIFFERENT amount for this row
      // (`railamount:<id>` marker). It is held for staff — never instructed
      // again, whether this is a reconcile `reinstruct:` row or a dead-letter
      // Retry. Done with a log; resolution is cancel/refund by staff.
      if (await createOutboxRepo(deps.db).hasDedupeKey(`railamount:${transferId}`)) {
        logWarn('outbox.instruct-held', 'rail reported a different amount; instruction not sent', { transferId });
        return;
      }
      // Best-rate routing: the RAIL is the settlement partner's when routed
      // (settlementPartnerId set) — their endpoint, their signing secret, and
      // their id in the instruction (the rail verifies with the partner_id it
      // carries). Unrouted ⇒ the owning partner, exactly as before.
      const railPartnerId = transfer.settlementPartnerId ?? transfer.partnerId;
      const integrations = await createIntegrationsRepo(deps.db).getIntegrations(railPartnerId);
      const settlementUrl = integrations.payment.credentials?.settlementUrl ?? '';
      const signingSecrets = railSecrets(integrations.payment, 'signing', new Date());
      if (!settlementUrl) throw new Error('Settlement endpoint not configured.');
      assertSettlementUrl(settlementUrl); // fix 22: fail closed BEFORE the decrypted instruction is built or sent
      // fix 31 (rail-10): the ADDITIVE compliance block goes AFTER every legacy
      // key, so the signature below covers it. Built after the fail-closed URL
      // check; loadComplianceBlock never throws (fail open, originator null).
      const compliance = await loadComplianceBlock(deps.db, transfer);
      const rawBody = JSON.stringify({
        ...buildSettlementInstruction(transfer),
        partner_id: railPartnerId,
        ...(compliance ? { compliance } : {}),
      });
      const res = await deps.fetchFn(settlementUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // fix 29: legacy x-signature (byte-identical) + x-smartremit-signature.
          ...signRailHeaders(rawBody, signingSecrets, Date.now()),
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
        providerRef = safeProviderRef(parsed.providerRef) ?? providerRef; // fix 22: ≤128 chars of [A-Za-z0-9._:-], else the fallback
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
      const webhookSecrets = railSecrets(integrations.payment, 'webhook', new Date());
      // fix 8: the reference rail's one failure mode rides the same row —
      // `status` (default paid_out) and an optional `reason` pass through.
      const cbStatus = str(p.status) || 'paid_out';
      const cbReason = str(p.reason);
      // fix 29: the rail echoes the instruction's amount (checked by the
      // webhook before delivery). A row queued by an older build has none.
      const cbAmount = railCallbackAmount(p.amount);
      const callbackBody = JSON.stringify({
        reference,
        status: cbStatus,
        ...(cbReason ? { reason: cbReason } : {}),
        ...(cbAmount ? { amount: cbAmount } : {}),
      });
      const res = await deps.fetchFn(`${env.appBaseUrl}/api/payment-webhook/simulator`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...signRailHeaders(callbackBody, webhookSecrets, Date.now()),
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
        const signingSecrets = railSecrets(integrations.payment, 'signing', new Date());
        if (!settlementUrl) throw new Error('Settlement endpoint not configured.');
        assertSettlementUrl(settlementUrl); // fix 22: same fail-closed rule as settlement.instruct
        const rawBody = JSON.stringify({ ...buildReverseInstruction(full), partner_id: railPartnerId });
        const res = await deps.fetchFn(settlementUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...signRailHeaders(rawBody, signingSecrets, Date.now()), // fix 29: both headers
          },
          body: rawBody,
          signal: AbortSignal.timeout(RAIL_TIMEOUT_MS), // rail-09: a hung rail is a RETRYABLE failure, never a stuck row
        });
        if (!res.ok) throw new Error(`Reverse instruction rejected (${res.status})`);
        refundRef = `reverse-${transferId}`;
        try {
          const parsed = (await res.json()) as { providerRef?: unknown };
          refundRef = safeProviderRef(parsed.providerRef) ?? refundRef; // fix 22: same rule as the settle ack
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
          // Program-Fix 49A: essential (a refund notice survives STOP).
          { to: transfer.phone, body: buildRefundMessage(transfer), partnerId: transfer.partnerId, category: 'essential' },
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
      const suggested = await triageSuggest(ticket.subject, firstMessage);
      // Program-Fix 34B: a help case the bot opened keeps 'human_help' (the bot
      // finds the open case by it, and staff see it in the queue); triage sets
      // only its priority. Every other ticket takes the suggested category.
      const keepsCategory = ticket.category === HUMAN_HELP_CATEGORY;
      const category = keepsCategory ? HUMAN_HELP_CATEGORY : suggested.category;
      const priority = suggested.priority;
      await repo.setTriage(ticketId, keepsCategory ? { priority } : { category, priority });
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
      // Program-Fix 26: the email/webhook mirror is enqueued FIRST — before the
      // phone check, so it still goes out when OPS_ALERT_PHONE is empty, and
      // before sendText, so a WhatsApp outage cannot stop it. Its dedupe keys
      // (opsmail:/opshook:<row.id>) make a WhatsApp retry re-enqueue nothing.
      await enqueueAlertMirror(deps, row, str(p.message));
      const to = env.opsAlertPhone;
      if (!to) return; // unconfigured ⇒ drop silently (dashboard still shows it)
      // Program-Fix 25: unset ⇒ free-form exactly as before. alertDead skips
      // ops.alert, so a skipped call would be a SILENT alert — never skip here.
      const opsTemplate = env.whatsappOpsAlertTemplate;
      if (!opsTemplate) {
        await deps.sendText(to, str(p.message));
        return;
      }
      const out = await sendBusinessInitiated(
        to,
        {
          template: { name: opsTemplate, lang: OPS_ALERT_TEMPLATE_LANG, params: [toTemplateParam(str(p.message))] },
          fallbackText: str(p.message),
        },
        undefined, // the platform number, as the free-form path
        { partnerId: DEFAULT_PARTNER_ID, store: deps.store, sendText: deps.sendText, sendTemplate: deps.sendTemplate },
      );
      // Rethrow the ORIGINAL Graph error so the catch classifies it (and
      // last_error keeps the parseable message).
      if (!out.ok) throw out.error ?? new Error(`ops.alert not sent: ${out.reason}`);
      return;
    }

    // ── Ops-alert webhook mirror (Program-Fix 26) ───────────────────────────
    // The URL is a bearer secret: it is read from env at SEND time and never
    // stored in the row, last_error or a log line. Unset/invalid now ⇒ drop.
    // deps.fetchFn is safeFetch in the worker route: same-origin 307/308 only,
    // private addresses refused at connect time.
    case 'ops.webhook': {
      const url = opsWebhookUrl(env.opsAlertWebhookUrl);
      if (!url) return;
      let res: Response;
      try {
        res = await deps.fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: str(p.text) }),
          signal: AbortSignal.timeout(OPS_WEBHOOK_TIMEOUT_MS),
        });
      } catch (err) {
        // Fixed text: a fetch error can echo the URL.
        throw new Error(`ops.webhook: request failed (${err instanceof Error ? err.name : 'error'})`);
      }
      if (!res.ok) throw new Error(`ops.webhook: HTTP ${res.status}`); // status only, never the body
      return;
    }

    // ── Transactional email (partner-lead notifications) ────────────────────
    // Durable: when configured, a send failure throws and rides the
    // backoff/dead-letter. `sealed` (optional) maps {{placeholders}} in
    // text/html to field-crypto blobs — the partner-application invite link
    // (fix 11 / F66). Opened at SEND time only; the row stays ciphertext. A
    // missing blob throws naming the placeholder, never a value.
    //
    // Program-Fix 39 (domain-11): a SKIP is recorded, never passed off as a send.
    // The row still ends done (no retry storm while SMTP is intentionally unset),
    // but it writes an `email.skipped` audit row (prefix + outbox id, never an
    // address) and, for 'skipped_unconfigured' only, ONE ops alert per UTC day.
    // The alert is an ops.alert, keyed per UTC day, and a skipped ops-alert
    // email mirror (opsmail:) never raises it, so it cannot loop.
    case 'email.send': {
      const outcome: EmailOutcome | void = await (deps.sendEmail ?? sendEmailDefault)({
        to: Array.isArray(p.to) ? (p.to as unknown[]).map(str).filter(Boolean) : [],
        subject: str(p.subject),
        text: renderSealedText(str(p.text), p.sealed),
        ...(typeof p.html === 'string' ? { html: renderSealedText(p.html, p.sealed) } : {}),
      });
      if (outcome === 'skipped_unconfigured' || outcome === 'skipped_no_recipients') {
        const { prefix, subjectId } = parseEmailDedupeKey(row.dedupeKey);
        const reason = outcome === 'skipped_unconfigured' ? 'unconfigured' : 'no_recipients';
        logWarn('email.skipped', outcome, { id: row.id, kind: row.kind, dedupePrefix: prefix });
        await createAuditRepo(deps.db).record({
          actorType: 'system',
          actor: 'outbox',
          action: 'email.skipped',
          subjectId: subjectId ?? undefined,
          meta: { reason, dedupePrefix: prefix, outboxId: row.id },
        });
        // Not for an ops-alert mirror row (Program-Fix 26's opsmail:): that
        // email IS an alert copy, so alerting on its skip would ping-pong.
        if (outcome === 'skipped_unconfigured' && !isMirrorRow(row)) {
          await createOutboxRepo(deps.db).enqueue(
            'ops.alert',
            { message: 'Email is not configured: partner lead or invite emails are being skipped. See /admin-dashboard/ops.' },
            { dedupeKey: `email-unconfigured:${new Date().toISOString().slice(0, 10)}` },
          );
        }
      }
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
      // ── Program-Fix 34A: one turn at a time per (tenant, phone), in order ──
      // Order of checks: the bound (computed with the FIFO check in ONE query),
      // then the FIFO guard, then the per-phone lock. Blocked ⇒ defer uncharged
      // (TurnBusyError), or — past the bound — the fallback line, never silence.
      const tenant: PartnerId = routedPartnerId ?? DEFAULT_PARTNER_ID;
      const outbox = createOutboxRepo(deps.db);
      // FIFO compares the RAW payload tenant ('' for the shared number's null).
      const gate = await outbox.agentTurnGate(row.id, requested, phone, TURN_BUSY_MAX_WAIT_MS / 1000);
      let blocked = gate.olderWaiting;
      let lockHeld = false;
      if (!blocked) {
        try {
          lockHeld = await deps.store.tryTurnLock(tenant, phone, String(row.id));
          blocked = !lockHeld;
        } catch {
          // FAIL OPEN: a Redis outage must not stop the bot answering. The
          // reply's reply:<id> dedupe still prevents a double answer.
          logWarn('worker.agent', 'turn lock unavailable — running unlocked (fail open)', { id: row.id, kind: row.kind });
        }
      }
      if (blocked) {
        if (!gate.pastBound) throw new TurnBusyError();
        // Waited past the bound: answer with the fallback line (deduped on this
        // row id) and raise ONE hourly alert per (tenant, phone) — counts only,
        // no message content — then finish the row. Never dead-lettered.
        await outbox.enqueue(
          'whatsapp.text',
          // Program-Fix 49A: essential — a reply to the customer's own message.
          { to: phone, body: FALLBACK_REPLY, category: 'essential', ...(routedPartnerId ? { partnerId: routedPartnerId } : {}) },
          { dedupeKey: `reply:${row.id}` },
        );
        await outbox.enqueue(
          'ops.alert',
          { message: `⚠️ SmartRemit ops: an agent.turn (outbox #${row.id}) waited over ${TURN_BUSY_MAX_WAIT_MS / 60_000} minutes behind the same customer's other turns and was answered with the fallback line. Check the outbox for a stuck or failing agent.turn.` },
          { dedupeKey: `turnbusy:${tenant}:${phone}:${hourBucket()}` },
        );
        logWarn('worker.agent', 'agent.turn blocked past the wait bound — fallback reply queued', { id: row.id, kind: row.kind });
        return;
      }
      try {
        const reply = await runTurnForReply(deps, p, signal, routedPartnerId, partner);
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
        // Program-Fix 34A: the reply is its OWN outbox row, deduped on this turn's
        // id — a Meta 5xx retries the SEND, never the model, and a re-run turn
        // can never answer twice. partnerId (never creds) picks the sending
        // number at drain time; none ⇒ the shared number. '' ⇒ a card was the
        // reply (the agent never returns '' otherwise).
        if (reply.trim()) {
          await outbox.enqueue(
            'whatsapp.text',
            { to: phone, body: reply, category: 'essential', ...(routedPartnerId ? { partnerId: routedPartnerId } : {}) },
            { dedupeKey: `reply:${row.id}` },
          );
        }
        if (reply === FALLBACK_REPLY) {
          await outbox.enqueue(
            'ops.alert',
            { message: '⚠️ SmartRemit ops: the WhatsApp bot answered with its fallback line ("having trouble") at least once this hour. Check the model and worker logs.' },
            { dedupeKey: `botfallback:${hourBucket()}` },
          );
        }
        return;
      } finally {
        if (lockHeld) {
          try {
            await deps.store.releaseTurnLock(tenant, phone, String(row.id));
          } catch {
            logWarn('worker.agent', 'turn lock release failed — it expires in 90s', { id: row.id, kind: row.kind });
          }
          // A turn deferred behind this one is due in TURN_BUSY_DEFER_SEC; nudge
          // a drain so it (and this reply row, if the loop has stopped) goes out.
          pokeWorker();
        }
      }
    }

    default:
      throw new Error(`Unknown outbox kind: ${row.kind}`);
  }
}

// ── Program-Fix 26: the ops-alert mirror ──────────────────────────────────────

export const OPS_ALERT_SUBJECT = 'SmartRemit ops alert';
/** Deadline on the ops webhook POST. */
export const OPS_WEBHOOK_TIMEOUT_MS = 5_000;
/** Dedupe-key prefixes of mirror children. A dead mirror row never alerts (no loop). */
const MIRROR_KEY_PREFIXES = ['opsmail:', 'opshook:'] as const;

function isMirrorRow(row: OutboxRow): boolean {
  const key = row.dedupeKey ?? '';
  return MIRROR_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** The ops webhook URL when it is a credential-free https URL; otherwise null. Pure. */
export function opsWebhookUrl(raw: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Enqueue the email / webhook copies of one ops alert. A no-op when neither
 * OPS_ALERT_EMAIL nor OPS_ALERT_WEBHOOK_URL is set. The text is scrub()bed
 * first: dead-row alerts embed a raw handler error, which can echo a phone or
 * an email, and these channels leave our boundary.
 */
async function enqueueAlertMirror(deps: WorkerDeps, row: OutboxRow, message: string): Promise<void> {
  const emails = env.opsAlertEmails;
  const rawHook = env.opsAlertWebhookUrl;
  if (emails.length === 0 && !rawHook) return;
  const text = scrub(message);
  const outbox = createOutboxRepo(deps.db);
  if (emails.length > 0) {
    await outbox.enqueue(
      'email.send',
      { to: emails, subject: OPS_ALERT_SUBJECT, text },
      { dedupeKey: `opsmail:${row.id}` },
    );
  }
  if (rawHook) {
    if (opsWebhookUrl(rawHook)) {
      await outbox.enqueue('ops.webhook', { text }, { dedupeKey: `opshook:${row.id}` });
    } else {
      // Never echo the value: it may be a secret with a typo in it.
      logWarn('ops.webhook', 'OPS_ALERT_WEBHOOK_URL is not a credential-free https URL; webhook mirror skipped', { id: row.id });
    }
  }
}

/** How many due reply rows drainOnce claims right after an agent.turn finishes (review S2). */
const INLINE_REPLY_CLAIM = 5;

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

/**
 * Exactly one ops alert per dead row: every dead-letter path (handler failure at
 * the ceiling, terminal row deadline, poison reclaim) shares the `dead:<id>`
 * dedupe key. Never recursive — a dead ops.alert row (or its mirror copy)
 * does not alert about itself. Ids, kinds, counts and a trimmed error only; never the payload.
 */
async function alertDead(outbox: OutboxRepo, row: OutboxRow, text: string): Promise<void> {
  if (row.kind === 'ops.alert') return;
  // Program-Fix 26: nor does a dead mirror row (email/webhook copy of an alert).
  // Each dead:<id> key is new, so a dead SMTP would otherwise loop forever:
  // dead → alert → mail → dead. The row stays visible on the dashboard.
  if (isMirrorRow(row)) return;
  await outbox.enqueue(
    'ops.alert',
    { message: `⚠️ SmartRemit ops: outbox #${row.id} (${row.kind}) ${text}` },
    { dedupeKey: `dead:${row.id}` },
  );
}

/** One drain pass: claim → execute → settle. Time-boxed by the caller. */
export async function drainOnce(
  deps: WorkerDeps,
  workerId: string,
  batchSize = 10,
  opts: DrainOptions = {},
): Promise<DrainResult> {
  const outbox: OutboxRepo = createOutboxRepo(deps.db);
  // Review S1: run in id order — UPDATE … RETURNING order is not guaranteed,
  // and agent.turn ordering (plus the FIFO gate) assumes oldest first.
  const rows = (await outbox.claimBatch(batchSize, workerId)).sort((a, b) => a.id - b.id);
  const partner = memoizedPartnerContext(deps); // one drain-time creds resolver per BATCH (fix 11)
  const rowDeadlineMs = opts.rowDeadlineMs ?? ROW_DEADLINE_MS;
  const result: DrainResult = { processed: 0, failed: 0, dead: 0, released: 0 };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.attempts > MAX_ATTEMPTS) {
      // POISON RECLAIM (Task 8 / Program-Fix 12). claimBatch has no attempts
      // filter, but markFailed dead-letters at >= MAX_ATTEMPTS and retryDead
      // resets attempts to 0, so a claimed row past the ceiling can only be a
      // reclaim: its every run KILLED the function before markFailed could
      // write. Running it again would kill this one too — dead-letter it
      // WITHOUT the handler, on the ordinary single dead:<id> alert path.
      // Two cheap DB writes, so it runs even past stopAfter (the row was
      // already claimed; a release would only refund one attempt and repeat).
      const status = await outbox.markFailed(
        row.id,
        row.attempts,
        'reclaimed past MAX_ATTEMPTS: killed on every recorded attempt (the last run may have completed) — check the effect before retrying',
        workerId,
      );
      if (status === 'dead') {
        result.dead++;
        await alertDead(outbox, row, `DEAD after ${row.attempts} claims — reclaimed past MAX_ATTEMPTS: killed on every recorded attempt (the last run may have completed) — check the effect before retrying`);
      } else {
        logWarn('worker.lease', 'poison reclaim: markFailed refused, lease no longer ours', { id: row.id, kind: row.kind, status });
      }
      continue;
    }
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
        // Review S2: a finished turn's reply row is sent NEXT, not after every
        // other customer's turn in this batch. It is claimed like any row (lease,
        // attempt, CAS markDone) and runs through this same loop, so the budget,
        // hard-stop and failure paths all apply to it.
        if (row.kind === 'agent.turn') {
          rows.splice(i + 1, 0, ...(await outbox.claimReplies(INLINE_REPLY_CLAIM, workerId)));
        }
      } else {
        // Our lease was reclaimed while we ran (we outlived LEASE_MS): the new
        // owner's outcome wins. Ids/kinds only — never the payload.
        logWarn('worker.lease', 'markDone refused: lease no longer ours', { id: row.id, kind: row.kind });
      }
    } catch (err) {
      // Program-Fix 34A: a busy turn is NOT a failure — hand it back uncharged,
      // due in a few seconds. Checked BEFORE markFailed so waiting can never
      // spend the attempt budget or dead-letter a customer's message.
      if (err instanceof TurnBusyError) {
        if (await outbox.deferUncharged(row.id, workerId, err.delaySec)) {
          result.released++;
        } else {
          logWarn('worker.lease', 'deferUncharged refused: lease no longer ours', { id: row.id, kind: row.kind });
        }
        continue;
      }
      const message = err instanceof Error ? err.message : 'unknown error';
      // TERMINAL deadline: an abandoned non-idempotent handler (agent.turn) must
      // never be retried beside its own ghost — force the dead ceiling so the
      // ordinary dead-letter path (one deduped dead:<id> alert) handles it.
      const deadline = err instanceof RowDeadlineError;
      const terminalDeadline = deadline && TERMINAL_ON_DEADLINE.has(row.kind);
      // Program-Fix 25: a PERMANENT WhatsApp rejection on a single-send row is
      // forced to the dead ceiling too — the same path, one dead:<id> alert.
      const permanentCode =
        err instanceof WhatsAppSendError && err.kind === 'permanent' && PERMANENT_DEAD_KINDS.has(row.kind)
          ? err.code
          : undefined;
      const terminal = terminalDeadline || permanentCode !== undefined;
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
        // A terminal row (deadline / permanent WhatsApp code) is dead at attempt 1 — say so, or ops goes looking for 8 attempts.
        await alertDead(
          outbox,
          row,
          `${
            terminalDeadline
              ? 'DEAD (terminal: row deadline exceeded)'
              : permanentCode !== undefined
                ? `DEAD (terminal: WhatsApp #${permanentCode})`
                : `DEAD after ${row.attempts} attempts`
          }: ${message.slice(0, 140)}`,
        );
      } else {
        result.failed++;
      }
    }
  }
  return result;
}
