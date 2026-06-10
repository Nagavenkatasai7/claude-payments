import { parseIncoming, parseStatusEvent, sendText, type WaCreds } from '@/lib/whatsapp';
import {
  isOptOutKeyword,
  isResumeKeyword,
  OPT_OUT_REPLY,
  OPT_IN_REPLY,
  OPT_OUT_REMINDER,
} from '@/lib/consent';
import { parseButtonId } from '@/lib/whatsapp-buttons';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { deriveTier } from '@/lib/tier-rules';
import { getDb } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { pokeWorker } from '@/lib/outbox';
import type { ButtonTap, PartnerId, TurnContext } from '@/lib/types';

// whatsapp-inbound — the shared post-signature inbound pipeline (WL2). Both the
// legacy shared webhook (/api/whatsapp) and the per-partner webhook
// (/api/whatsapp/[partnerId]) run THIS after their own signature gate:
//   status events → parse → dedup → consent → customer upsert (routed to the
//   owning partner; follow-the-number) → agent turn ENQUEUED (durable outbox).
// `routedPartnerId` is the partner that OWNS the receiving number (null ⇒ the
// shared/default number); `waCreds` are that partner's outbound credentials so
// every reply leaves FROM the number the customer messaged.

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
      if (ev.status === 'failed') {
        console.warn(
          `WhatsApp message delivery FAILED — recipient=${ev.recipientId} wamid=${ev.wamid} code=${ev.errorCode ?? 'n/a'} (${ev.errorTitle ?? ''})`,
        );
      } else {
        console.debug(
          `WhatsApp status ${ev.status} — recipient=${ev.recipientId} wamid=${ev.wamid}`,
        );
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

  // STOP / START consent short-circuit (order intentional — see consent.ts).
  if (incoming.kind === 'text') {
    if (isResumeKeyword(incoming.text)) {
      await customerStore.clearOptedOut(incoming.from);
      await sendText(incoming.from, OPT_IN_REPLY, waCreds);
      return { ok: true };
    }
    if (isOptOutKeyword(incoming.text)) {
      await customerStore.setOptedOut(incoming.from);
      await sendText(incoming.from, OPT_OUT_REPLY, waCreds);
      return { ok: true };
    }
    const existing = await customerStore.getCustomer(incoming.from);
    if (existing?.optedOutAt) {
      await sendText(incoming.from, OPT_OUT_REMINDER, waCreds);
      return { ok: true };
    }
  }

  const lastInboundAt = await store.getLastInboundAt(incoming.from);
  const isNewConversation = lastInboundAt === null;
  await store.recordInboundNow(incoming.from);

  // WL2: route the customer to the partner that owns the receiving number —
  // new customers are created under it; existing customers follow the number.
  const { customer, wasCreated } = await customerStore.upsertOnFirstInbound(
    incoming.from,
    routedPartnerId ?? undefined,
  );

  if (!customer.optInAt) {
    await customerStore.setOptedIn(incoming.from);
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
  pokeWorker(); // fast path — the heartbeat is the guarantee

  return { ok: true };
}
