import { parseWebhook, type IncomingMessage, type WebhookChange, type WebhookStatusEvent, type DroppedMessage } from '@/lib/whatsapp';
import {
  isOptOutKeyword,
  isResumeKeyword,
  OPT_OUT_REPLY,
  OPT_IN_REPLY,
  optOutReminder,
  MEDIA_REPLY,
} from '@/lib/consent';
import { parseButtonId } from '@/lib/whatsapp-buttons';
import { getStore, type Store } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { deriveTier } from '@/lib/tier-rules';
import { getDb } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { isInfraError } from '@/lib/infra-error';
import { pokeWorker } from '@/lib/outbox';
import { logWarn, scrub } from '@/lib/log';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { waMessageRef } from '@/lib/wa-message-ref';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { getRedis } from '@/lib/redis';
import { recordChannelHealth } from '@/lib/channel-health';
import { checkInboundThrottle, SLOW_DOWN_REPLY } from '@/lib/inbound-throttle';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { getPartnerStore } from '@/lib/partner-store';
import { resolvePartnerBranding, DEFAULT_BRAND } from '@/lib/partner-config';
import type { ButtonTap, PartnerId, TurnContext } from '@/lib/types';

// whatsapp-inbound — the shared post-signature inbound pipeline (WL2). Both the
// legacy shared webhook (/api/whatsapp) and the per-partner webhook
// (/api/whatsapp/[partnerId]) run THIS after their own signature gate, for
// EVERY change and EVERY message in the POST (R1):
//   status events → fast skip (msgq:) → consent → customer resolve/create UNDER
//   THE ROUTED TENANT → exactly ONE durable outbox row per message, keyed
//   `wamid:{id}` (an agent.turn, or a whatsapp.text reply) → the Redis marks.
// R1 durability rule: the `outbox_dedupe` unique index IS the dedup. The Redis
// marks are written only AFTER the insert returned, so a failure anywhere
// before it leaves nothing that would make a retry skip the message. No reply
// is sent from inside the request: replies are outbox rows the worker sends.
// Every write before the insert is convergent (upserts / SETs), so a retry
// repeats them harmlessly.
// A tenant-signed webhook proves the TENANT, not the sender (fix 1 / F44): every
// customer read/write below is keyed (tenant, phone), where tenant is the partner
// that OWNS the receiving number and the shared/default number IS the default
// tenant. An existing row under another partner is never touched or moved.
// `waCreds` are that partner's outbound credentials so every reply leaves FROM
// the number the customer messaged — replies resolve those creds at drain time
// from the row's partnerId (never a token in the payload).

export interface InboundContext {
  routedPartnerId: PartnerId | null;
  /**
   * R1 per-change tenant rule, supplied by the route: may a change addressed to
   * this receiving number (metadata.phone_number_id; null when absent) run
   * under `routedPartnerId`? A rejected change is skipped entirely (logged as
   * `whatsapp.pnid_mismatch`). Absent ⇒ every change is accepted.
   */
  acceptPnid?: (pnid: string | null) => Promise<boolean>;
}

function synthesizeButtonText(tap: ButtonTap): string {
  switch (tap.kind) {
    case 'recipient':      return `[Tapped: Send to recipient ${tap.recipientPhone}]`;
    case 'recipient_new':  return '[Tapped: Someone new]';
    case 'approve':        return '[Tapped: Approve & pay]';
    case 'cancel':         return '[Tapped: Cancel]';
  }
}

/** Program-Fix 49A: one opted-out reminder per (tenant, phone) per hour. */
export const OPT_OUT_REMINDER_SCOPE = 'wa-optout-reminder';
const OPT_OUT_REMINDER_WINDOW_SEC = 60 * 60;

/**
 * Program-Fix 49A: may the opted-out reminder go out now? One per (tenant,
 * phone) per hour — repeated taps on an old card get silence after the first.
 * FAILS OPEN to "send": a limiter outage costs at most an extra reminder, never
 * a silent consent state.
 */
async function reminderAllowed(tenantId: PartnerId, phone: string): Promise<boolean> {
  try {
    const r = await checkIpRateLimit(getRedis(), OPT_OUT_REMINDER_SCOPE, `${tenantId}|${phone}`, {
      limit: 1,
      windowSec: OPT_OUT_REMINDER_WINDOW_SEC,
    });
    return r.allowed;
  } catch {
    return true;
  }
}

/** The tenant's customer-facing brand for the reminder; any read error ⇒ the default. */
async function tenantBrand(tenantId: PartnerId): Promise<string> {
  try {
    return resolvePartnerBranding(await getPartnerStore().getPartner(tenantId)).brand;
  } catch {
    return DEFAULT_BRAND;
  }
}

/** R1: one `whatsapp.inbound_no_phone` audit row per (partner, hour) at most. */
export const NO_PHONE_AUDIT_WINDOW_SEC = 60 * 60;

/** A failed-delivery status: a scrubbed log line + one audit row (Program-Fix 26). */
async function recordStatus(ev: WebhookStatusEvent, tenantId: PartnerId): Promise<void> {
  // Program-Fix 26: the message id is never logged or stored raw — only its
  // keyed reference (src/lib/wa-message-ref.ts).
  const msgRef = waMessageRef(ev.wamid);
  if (ev.status !== 'failed') {
    console.debug(`WhatsApp status ${ev.status} — msgRef=${msgRef.slice(0, 16)}`);
    return;
  }
  // Stage 3: structured + PII-scrubbed (recipientId is a phone number).
  logWarn('whatsapp.delivery_failed', `code=${ev.errorCode ?? 'n/a'} (${ev.errorTitle ?? ''})`, {
    recipient: ev.recipientId,
    msgRef: msgRef.slice(0, 16),
  });
  // Program-Fix 26: persist the failure (no wamid→transfer map yet). Meta's
  // code + title only — NEVER the recipient number, not even masked; the
  // subject is the keyed message reference, never the raw id. A DB error must
  // not turn this webhook into a non-200 (Meta would redeliver).
  try {
    await createAuditRepo(getDb()).record({
      partnerId: tenantId,
      actor: 'whatsapp',
      actorType: 'system',
      action: 'whatsapp.delivery_failed',
      subjectId: msgRef,
      meta: {
        code: ev.errorCode ?? null,
        title: ev.errorTitle ? scrub(ev.errorTitle).slice(0, 200) : null,
      },
    });
  } catch (err) {
    logWarn('whatsapp.delivery_failed', 'audit insert failed', { error: err instanceof Error ? err.name : 'error' });
  }
}

/**
 * R1: a message with no phone (`from` omitted — a BSUID-only sender) cannot be
 * served yet: every identity key is the phone, and the send-to-BSUID shape is
 * unverified. It is recorded, never silently lost: one audit row per (tenant,
 * hour) — SET NX dedupe keeps a flood out of the DB — with booleans only,
 * never the raw BSUID or username. Best effort: a failure is logged, never
 * turned into a non-200 (a retry could not serve the message either).
 */
async function recordNoPhone(d: DroppedMessage, tenantId: PartnerId): Promise<void> {
  logWarn('whatsapp.inbound_no_phone', 'message without a phone number — not processed', { tenant: tenantId });
  // R2a: the partner-visible mark on EVERY such message (Redis only — the
  // hourly audit row below is the ledger record). recordChannelHealth never
  // throws; the default tenant is skipped inside.
  await recordChannelHealth(tenantId, 'no_phone', { audit: false });
  const hour = Math.floor(Date.now() / (NO_PHONE_AUDIT_WINDOW_SEC * 1000));
  const claimKey = `wanophone:${tenantId}:${hour}`;
  let claimed = false;
  try {
    const first = await getRedis().set(claimKey, '1', { ex: NO_PHONE_AUDIT_WINDOW_SEC, nx: true });
    if (first === null) return;
    claimed = true;
    await createAuditRepo(getDb()).record({
      partnerId: tenantId,
      actor: 'whatsapp',
      actorType: 'system',
      action: 'whatsapp.inbound_no_phone',
      ...(d.messageId ? { subjectId: waMessageRef(d.messageId) } : {}),
      meta: { hasBsuid: d.hasBsuid, hasUsername: d.hasUsername },
    });
  } catch (err) {
    logWarn('whatsapp.inbound_no_phone', 'audit insert failed', { error: err instanceof Error ? err.name : 'error' });
    // Release the hourly claim so the next no-phone message can record the row.
    if (claimed) {
      try {
        await getRedis().del(claimKey);
      } catch {
        /* the claim expires on its own within the hour */
      }
    }
  }
}

/**
 * R1: a message whose processing failed for a reason retrying cannot fix (a
 * poison body, a validation error). The webhook acknowledges it (200) so Meta
 * does not redeliver it for days, and records it here: the keyed message
 * reference and the error NAME only — never text, phone or error message.
 */
async function recordDropped(messageId: string, tenantId: PartnerId, err: unknown): Promise<void> {
  const error = err instanceof Error ? err.name : 'error';
  logWarn('whatsapp.inbound_dropped', 'message not processed — acknowledged', { tenant: tenantId, error });
  try {
    await createAuditRepo(getDb()).record({
      partnerId: tenantId,
      actor: 'whatsapp',
      actorType: 'system',
      action: 'whatsapp.inbound_dropped',
      subjectId: waMessageRef(messageId),
      meta: { reason: 'processing_error', error },
    });
  } catch (auditErr) {
    logWarn('whatsapp.inbound_dropped', 'audit insert failed', { error: auditErr instanceof Error ? auditErr.name : 'error' });
  }
}

/** Swallowing wrapper for a Redis write that happens AFTER the durable insert. */
async function afterInsert(what: string, fn: () => Promise<unknown>, tenantId: PartnerId): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logWarn('whatsapp.inbound', `${what} failed after the durable write`, { tenant: tenantId, error: err instanceof Error ? err.name : 'error' });
  }
}

/**
 * R1: Postgres jsonb (and text) reject U+0000, so a NUL in customer text
 * would make the insert fail deterministically. Strip it from every string
 * that goes into an outbox payload.
 */
export function stripNul(value: string): string {
  return value.includes('\u0000') ? value.replace(/\u0000/g, '') : value;
}

interface MessageDeps {
  store: Store;
  outbox: ReturnType<typeof createOutboxRepo>;
  routedPartnerId: PartnerId | null;
  tenantId: PartnerId;
}

/**
 * The ONE durable effect of a reply-only branch: an essential whatsapp.text
 * row keyed by the inbound wamid (`essential` so the worker's opt-out gate
 * can never suppress a STOP confirmation). A routed tenant's row carries its
 * partnerId, exactly as the worker stamps agent-turn replies, so the reply
 * leaves from the number the customer messaged; creds resolve at drain time.
 */
function enqueueReply(deps: MessageDeps, incoming: IncomingMessage, body: string): Promise<boolean> {
  return deps.outbox.enqueue(
    'whatsapp.text',
    {
      to: incoming.from,
      body: stripNul(body),
      category: 'essential',
      ...(deps.routedPartnerId ? { partnerId: deps.routedPartnerId } : {}),
    },
    { dedupeKey: `wamid:${incoming.messageId}` },
  );
}

/** R1: at most one consent-failure ops alert per (tenant, hour). */
export const CONSENT_ALERT_WINDOW_SEC = 60 * 60;

/**
 * R1: a STOP / START that failed for a non-infrastructure reason. The webhook
 * acknowledges it (R7), so it is recorded — best effort, never a throw — as
 * one `whatsapp.consent_failed` audit row (keyed message ref, kind, error
 * NAME; never text or phone) plus an `ops.alert` outbox row deduped per
 * (tenant, hour).
 */
async function recordConsentFailed(
  deps: MessageDeps,
  messageId: string,
  kind: 'start' | 'stop',
  err: unknown,
): Promise<void> {
  const { tenantId } = deps;
  const error = err instanceof Error ? err.name : 'error';
  logWarn('whatsapp.consent_failed', `${kind} not applied — acknowledged`, { tenant: tenantId, error });
  try {
    await createAuditRepo(getDb()).record({
      partnerId: tenantId,
      actor: 'whatsapp',
      actorType: 'system',
      action: 'whatsapp.consent_failed',
      subjectId: waMessageRef(messageId),
      meta: { kind, error },
    });
  } catch (auditErr) {
    logWarn('whatsapp.consent_failed', 'audit insert failed', { error: auditErr instanceof Error ? auditErr.name : 'error' });
  }
  try {
    const hour = Math.floor(Date.now() / (CONSENT_ALERT_WINDOW_SEC * 1000));
    await deps.outbox.enqueue(
      'ops.alert',
      {
        message: `⚠️ SmartRemit ops: a WhatsApp ${kind === 'stop' ? 'STOP' : 'START'} for partner ${tenantId} could not be applied (${error}). See audit whatsapp.consent_failed.`,
      },
      { dedupeKey: `waconsentfail:${tenantId}:${hour}` },
    );
  } catch (alertErr) {
    logWarn('whatsapp.consent_failed', 'ops alert enqueue failed', { error: alertErr instanceof Error ? alertErr.name : 'error' });
  }
}

/**
 * STOP / START. Returns true when the confirmation row now exists; false for
 * a stale START (see below), which changes nothing and queues nothing.
 */
async function applyConsent(
  deps: MessageDeps,
  customerStore: ReturnType<typeof getCustomerStore>,
  incoming: IncomingMessage,
  kind: 'start' | 'stop',
): Promise<boolean> {
  const { tenantId } = deps;
  if (kind === 'start') {
    // Ordering: a START the customer SENT before their stored opt-out (a
    // redelivery, or a retry that lost the race with a later STOP) must not
    // undo it. Meta's timestamp is whole seconds, so compare at that grain —
    // a START in the same second as the opt-out still resumes. No timestamp
    // ⇒ today's behaviour.
    if (incoming.sentAtMs !== undefined) {
      const current = await customerStore.getCustomer(tenantId, incoming.from);
      const optedOutMs = current?.optedOutAt ? Date.parse(current.optedOutAt) : NaN;
      if (Number.isFinite(optedOutMs) && incoming.sentAtMs < Math.floor(optedOutMs / 1000) * 1000) {
        logWarn('whatsapp.consent_stale', 'START older than the stored opt-out — ignored', { tenant: tenantId });
        return false;
      }
    }
    await customerStore.clearOptedOut(tenantId, incoming.from);
    await enqueueReply(deps, incoming, OPT_IN_REPLY);
    return true;
  }
  // Program-Fix 49A (whatsapp-10c): a STOP from a phone with no row must not
  // be lost. ensureCustomer creates the row WITHOUT opt-in (never
  // upsertOnFirstInbound, which would stamp consent on a STOP), then the
  // opt-out lands on it. An existing row is untouched by ensureCustomer.
  await customerStore.ensureCustomer(tenantId, incoming.from);
  // opted_out_at is the STOP's SEND time (else now), so the stale-START check
  // compares send time with send time.
  await customerStore.setOptedOut(
    tenantId,
    incoming.from,
    incoming.sentAtMs !== undefined ? new Date(incoming.sentAtMs) : new Date(),
  );
  await enqueueReply(deps, incoming, OPT_OUT_REPLY);
  return true;
}

/**
 * Process ONE inbound message. Returns true when a durable row now exists for
 * it (inserted here or already present); false for an intentional no-row
 * outcome (fast skip, throttled without a note, reminder not due). Throws on
 * any failure — the caller classifies it.
 */
async function processMessage(deps: MessageDeps, incoming: IncomingMessage): Promise<boolean> {
  const { store, outbox, routedPartnerId, tenantId } = deps;

  // Fast skip: `msgq:` exists only once the durable row does. A Redis error
  // here is not a reason to fail — the unique index still dedups.
  try {
    if (await store.isMessageQueued(incoming.messageId)) return false;
  } catch {
    /* fall through to the DB, which is the real dedup */
  }

  const customerStore = getCustomerStore(store);

  // STOP / START consent short-circuit (order intentional — see consent.ts).
  // Keywords are TEXT only (a template quick-reply parses to text, so its
  // "Unsubscribe" lands here too); the opted-out STATE applies to EVERY kind —
  // a button tap or a photo from an opted-out customer never reaches the
  // agent (Program-Fix 49A, whatsapp-10a).
  if (incoming.kind === 'text' && (isResumeKeyword(incoming.text) || isOptOutKeyword(incoming.text))) {
    const kind = isResumeKeyword(incoming.text) ? 'start' : 'stop';
    try {
      return await applyConsent(deps, customerStore, incoming, kind);
    } catch (err) {
      // R7: 500 ONLY for infrastructure — Meta redelivers and the branch
      // re-applies idempotently. Anything else is deterministic: acknowledge,
      // but never silently — an audit row plus an ops alert, so a consent
      // change that did not land is seen by a human.
      if (isInfraError(err)) throw err;
      await recordConsentFailed(deps, incoming.messageId, kind, err);
      return false;
    }
  }
  const existing = await customerStore.getCustomer(tenantId, incoming.from);
  if (existing?.optedOutAt) {
    // The rate check runs BEFORE the brand read, so a burst of taps costs one
    // Redis INCR each and nothing else.
    if (await reminderAllowed(tenantId, incoming.from)) {
      await enqueueReply(deps, incoming, optOutReminder(await tenantBrand(tenantId)));
      return true;
    }
    return false;
  }

  // Program-Fix 34A: per-(tenant, phone) inbound throttle — 20 a minute, 300 a
  // day. AFTER consent (STOP/START always work) and BEFORE any agent turn:
  // over the limit no turn is queued, and one short note is queued per
  // window. The throttle never throws (fails open).
  const throttle = await checkInboundThrottle(getRedis(), tenantId, incoming.from);
  if (!throttle.allowed) {
    logWarn('whatsapp.throttled', `inbound over the ${throttle.window} limit — not enqueued`, { tenant: tenantId });
    if (throttle.notify) {
      await enqueueReply(deps, incoming, SLOW_DOWN_REPLY);
      return true;
    }
    return false;
  }

  // Program-Fix 49A (whatsapp-08): media the bot cannot read gets ONE honest
  // reply (the wamid dedupe key makes a redelivery silent) and no agent turn.
  // Never downloaded.
  if (incoming.kind === 'unsupported') {
    logWarn('whatsapp.unsupported_type', incoming.mediaType, { tenant: tenantId });
    await enqueueReply(deps, incoming, MEDIA_REPLY);
    return true;
  }

  // D12: the "is this a new conversation" marker is per (tenant, phone) too —
  // a customer of another tenant messaging THIS number starts fresh here. The
  // marker is written AFTER the insert (below), so a retried message still
  // sees the conversation as new.
  const lastInboundAt = await store.getLastInboundAt(tenantId, incoming.from);
  const isNewConversation = lastInboundAt === null;

  // Resolve/create the customer under the ROUTED tenant only — never re-home.
  const { customer, wasCreated } = await customerStore.upsertOnFirstInbound(tenantId, incoming.from);

  if (!customer.optInAt) {
    await customerStore.setOptedIn(tenantId, incoming.from);
  }

  const now = new Date();
  const tier = deriveTier(customer, now);

  let tierReminderDayOfWindow: 1 | 2 | 3 | undefined;
  if (tier === 'T0' && isNewConversation && !wasCreated) {
    const ageMs = now.getTime() - new Date(customer.firstSeenAt).getTime();
    const day = Math.min(3, Math.floor(ageMs / (24 * 60 * 60 * 1000)) + 1) as 1 | 2 | 3;
    tierReminderDayOfWindow = day;
  }

  let messageText: string;
  let buttonTap: ButtonTap | undefined;
  if (incoming.kind === 'text') {
    messageText = incoming.text;
  } else {
    const parsed = parseButtonId(incoming.buttonId);
    if (!parsed) {
      messageText = '(unrecognized button)';
    } else {
      buttonTap = parsed;
      messageText = synthesizeButtonText(parsed);
    }
  }

  const turn: TurnContext = {
    isNewConversation,
    buttonTap,
    isNewCustomer: wasCreated,
    tierReminderDayOfWindow,
  };

  // Stage 2c: the agent turn is a DURABLE outbox row (wamid-deduped). The
  // payload carries routedPartnerId (NOT the creds themselves) so the worker
  // re-resolves the partner's WhatsApp credentials at run time. Never the
  // BSUID / username: those stay in memory.
  await outbox.enqueue(
    'agent.turn',
    { phone: incoming.from, messageText: stripNul(messageText), turn, routedPartnerId },
    { dedupeKey: `wamid:${incoming.messageId}` },
  );
  await afterInsert('lastmsg', () => store.recordInboundNow(tenantId, incoming.from), tenantId);
  return true;
}

/**
 * Process a whole signed webhook POST. Returns `{ ok: true }` once every
 * message has a durable row (inserted or already present) or was deliberately
 * dropped. THROWS the first infrastructure error (DB / Redis unavailable — see
 * isInfraError) so the route answers 500 and Meta redelivers; the redelivery
 * is exactly-once against the `wamid:{id}` unique key. Any other per-message
 * failure is acknowledged and audited (`whatsapp.inbound_dropped`).
 */
export async function processInboundWebhook(
  body: unknown,
  ctx: InboundContext,
): Promise<{ ok: boolean }> {
  const { routedPartnerId, acceptPnid } = ctx;
  // The shared number (routedPartnerId null) is the default tenant's channel.
  const tenantId: PartnerId = routedPartnerId ?? DEFAULT_PARTNER_ID;
  const changes: WebhookChange[] = parseWebhook(body);
  if (changes.length === 0) return { ok: true };

  const deps: MessageDeps = {
    store: getStore(),
    outbox: createOutboxRepo(getDb()),
    routedPartnerId,
    tenantId,
  };
  let queued = false;

  try {
    for (const change of changes) {
      // R1 per-change tenant rule: a change for another tenant's number never
      // runs under this route's tenant (its signature proved THIS tenant only).
      if (acceptPnid && !(await acceptPnid(change.pnid))) {
        logWarn('whatsapp.pnid_mismatch', 'change for another receiving number skipped', { tenant: tenantId });
        continue;
      }

      // Message-STATUS callbacks (sent/delivered/read/failed). We don't map
      // wamid → transfer yet, so the deliverable is structured logging.
      for (const ev of change.statuses) await recordStatus(ev, tenantId);

      for (const e of change.errors) {
        logWarn('whatsapp.webhook_error', `code=${e.code ?? 'n/a'} (${e.title ? scrub(e.title).slice(0, 200) : ''})`, { tenant: tenantId });
      }

      for (const d of change.dropped) await recordNoPhone(d, tenantId);

      for (const incoming of change.messages) {
        let durable: boolean;
        try {
          durable = await processMessage(deps, incoming);
        } catch (err) {
          if (isInfraError(err)) throw err; // → 500; Meta redelivers; the retry is idempotent
          await recordDropped(incoming.messageId, tenantId, err);
          continue;
        }
        if (durable) {
          queued = true;
          await afterInsert('queued mark', () => deps.store.markMessageQueued(incoming.messageId), tenantId);
        }
      }
    }
  } finally {
    // Fast path — the per-minute cron drains it regardless. In a finally so
    // rows queued before a later throw are not left for the cron.
    if (queued) pokeWorker();
  }
  return { ok: true };
}
