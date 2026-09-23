import { parseIncoming, parseStatusEvent, sendText, type WaCreds } from '@/lib/whatsapp';
import {
  isOptOutKeyword,
  isResumeKeyword,
  OPT_OUT_REPLY,
  OPT_IN_REPLY,
  optOutReminder,
  MEDIA_REPLY,
} from '@/lib/consent';
import { parseButtonId } from '@/lib/whatsapp-buttons';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { deriveTier } from '@/lib/tier-rules';
import { getDb } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { pokeWorker } from '@/lib/outbox';
import { logWarn, scrub } from '@/lib/log';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { waMessageRef } from '@/lib/wa-message-ref';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { getRedis } from '@/lib/redis';
import { checkInboundThrottle, SLOW_DOWN_REPLY } from '@/lib/inbound-throttle';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { getPartnerStore } from '@/lib/partner-store';
import { resolvePartnerBranding, DEFAULT_BRAND } from '@/lib/partner-config';
import type { ButtonTap, PartnerId, TurnContext } from '@/lib/types';

// whatsapp-inbound — the shared post-signature inbound pipeline (WL2). Both the
// legacy shared webhook (/api/whatsapp) and the per-partner webhook
// (/api/whatsapp/[partnerId]) run THIS after their own signature gate:
//   status events → parse → dedup → consent → customer resolve/create UNDER THE
//   ROUTED TENANT → agent turn ENQUEUED (durable outbox).
// A tenant-signed webhook proves the TENANT, not the sender (fix 1 / F44): every
// customer read/write below is keyed (tenant, phone), where tenant is the partner
// that OWNS the receiving number and the shared/default number IS the default
// tenant. An existing row under another partner is never touched or moved.
// `waCreds` are that partner's outbound credentials so every reply leaves FROM
// the number the customer messaged.

export interface InboundContext {
  routedPartnerId: PartnerId | null;
  waCreds?: WaCreds;
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

/** Returns the JSON-able response body; the route wraps it in NextResponse. */
export async function processInboundWebhook(
  body: unknown,
  ctx: InboundContext,
): Promise<{ ok: boolean }> {
  const { routedPartnerId, waCreds } = ctx;

  // Message-STATUS callbacks (sent/delivered/read/failed). Meta delivers these as
  // a `statuses` event with no `messages`. We don't map wamid → transfer yet, so
  // the deliverable is structured logging. Runs AFTER the signature gate.
  const statusEvents = parseStatusEvent(body);
  if (statusEvents) {
    for (const ev of statusEvents) {
      // Program-Fix 26: the message id is never logged or stored raw — only its
      // keyed reference (src/lib/wa-message-ref.ts).
      const msgRef = waMessageRef(ev.wamid);
      if (ev.status === 'failed') {
        // Stage 3: structured + PII-scrubbed (recipientId is a phone number).
        logWarn('whatsapp.delivery_failed', `code=${ev.errorCode ?? 'n/a'} (${ev.errorTitle ?? ''})`, {
          recipient: ev.recipientId,
          msgRef: msgRef.slice(0, 16),
        });
        // Program-Fix 26: persist the failure (no wamid→transfer map yet). Meta's
        // code + title only — NEVER the recipient number, not even masked; the
        // subject is the keyed message reference, never the raw id. A DB
        // error must not turn this webhook into a non-200 (Meta would redeliver).
        try {
          await createAuditRepo(getDb()).record({
            partnerId: routedPartnerId ?? DEFAULT_PARTNER_ID,
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
      } else {
        console.debug(`WhatsApp status ${ev.status} — msgRef=${msgRef.slice(0, 16)}`);
      }
    }
    return { ok: true };
  }

  const incoming = parseIncoming(body);
  if (!incoming) return { ok: true };

  const store = getStore();
  const isNew = await store.markMessageSeen(incoming.messageId);
  if (!isNew) return { ok: true };

  const customerStore = getCustomerStore(store);
  // The shared number (routedPartnerId null) is the default tenant's channel.
  const tenantId: PartnerId = routedPartnerId ?? DEFAULT_PARTNER_ID;

  // STOP / START consent short-circuit (order intentional — see consent.ts).
  // Keywords are TEXT only (a template quick-reply parses to text, so its
  // "Unsubscribe" lands here too); the opted-out STATE applies to EVERY kind —
  // a button tap or a photo from an opted-out customer never reaches the
  // agent (Program-Fix 49A, whatsapp-10a).
  if (incoming.kind === 'text') {
    if (isResumeKeyword(incoming.text)) {
      await customerStore.clearOptedOut(tenantId, incoming.from);
      await sendText(incoming.from, OPT_IN_REPLY, waCreds);
      return { ok: true };
    }
    if (isOptOutKeyword(incoming.text)) {
      // Program-Fix 49A (whatsapp-10c): a STOP from a phone with no row must
      // not be lost. ensureCustomer creates the row WITHOUT opt-in (never
      // upsertOnFirstInbound, which would stamp consent on a STOP), then the
      // opt-out lands on it. An existing row is untouched by ensureCustomer.
      await customerStore.ensureCustomer(tenantId, incoming.from);
      await customerStore.setOptedOut(tenantId, incoming.from);
      await sendText(incoming.from, OPT_OUT_REPLY, waCreds);
      return { ok: true };
    }
  }
  const existing = await customerStore.getCustomer(tenantId, incoming.from);
  if (existing?.optedOutAt) {
    // The rate check runs BEFORE the brand read, so a burst of taps costs one
    // Redis INCR each and nothing else.
    if (await reminderAllowed(tenantId, incoming.from)) {
      await sendText(incoming.from, optOutReminder(await tenantBrand(tenantId)), waCreds);
    }
    return { ok: true };
  }

  // Program-Fix 34A: per-(tenant, phone) inbound throttle — 20 a minute, 300 a
  // day. AFTER consent (STOP/START always work) and BEFORE any enqueue: over
  // the limit nothing is queued, and one short note goes out per window. The
  // throttle never throws (fails open); the note send has its own catch so a
  // Meta error can never turn a refused message back into a queued turn.
  const throttle = await checkInboundThrottle(getRedis(), tenantId, incoming.from);
  if (!throttle.allowed) {
    logWarn('whatsapp.throttled', `inbound over the ${throttle.window} limit — not enqueued`, { tenant: tenantId });
    if (throttle.notify) {
      try {
        await sendText(incoming.from, SLOW_DOWN_REPLY, waCreds);
      } catch {
        logWarn('whatsapp.throttled', 'slow-down note failed to send', { tenant: tenantId });
      }
    }
    return { ok: true };
  }

  // Program-Fix 49A (whatsapp-08): media the bot cannot read gets ONE honest
  // reply (the wamid dedup above makes a redelivery silent) and no agent turn.
  // Never downloaded. A direct send like the other consent replies; a Meta
  // error is logged, never thrown (Meta would redeliver a non-200).
  if (incoming.kind === 'unsupported') {
    logWarn('whatsapp.unsupported_type', incoming.mediaType, { tenant: tenantId });
    try {
      await sendText(incoming.from, MEDIA_REPLY, waCreds);
    } catch {
      logWarn('whatsapp.unsupported_type', 'media reply failed to send', { tenant: tenantId });
    }
    return { ok: true };
  }

  // D12: the "is this a new conversation" marker is per (tenant, phone) too —
  // a customer of another tenant messaging THIS number starts fresh here.
  const lastInboundAt = await store.getLastInboundAt(tenantId, incoming.from);
  const isNewConversation = lastInboundAt === null;
  await store.recordInboundNow(tenantId, incoming.from);

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

  // Stage 2c: the agent turn is a DURABLE outbox row (wamid-deduped), not a
  // best-effort after() — a killed function or an Ollama blip can no longer eat
  // a customer message; the worker retries with backoff. The payload carries
  // routedPartnerId (NOT the creds themselves) so the worker re-resolves the
  // partner's WhatsApp credentials at run time — no token copied to rest.
  await createOutboxRepo(getDb()).enqueue(
    'agent.turn',
    { phone: incoming.from, messageText, turn, routedPartnerId },
    { dedupeKey: `wamid:${incoming.messageId}` },
  );
  pokeWorker(); // fast path — the per-minute cron drains it regardless

  return { ok: true };
}
