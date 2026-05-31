import { after, NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { verifyMetaSignature } from '@/lib/providers/meta-signature-verify';
import { parseIncoming, parseStatusEvent, sendText } from '@/lib/whatsapp';
import {
  isOptOutKeyword,
  isResumeKeyword,
  OPT_OUT_REPLY,
  OPT_IN_REPLY,
} from '@/lib/consent';
import { parseButtonId } from '@/lib/whatsapp-buttons';
import { chat } from '@/lib/ollama';
import { createAgent } from '@/lib/agent';
import { getStore } from '@/lib/store';
import { getScheduleStore } from '@/lib/schedule-store';
import { getDraftStore } from '@/lib/draft-store';
import { getCustomerStore } from '@/lib/customer-store';
import { getDailyVolumeStore } from '@/lib/daily-volume-store';
import { getMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { getPartnerStore } from '@/lib/partner-store';
import { deriveTier } from '@/lib/tier-rules';
import type { ButtonTap, TurnContext } from '@/lib/types';

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');

  if (mode === 'subscribe' && token === env.whatsappVerifyToken && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse('Forbidden', { status: 403 });
}

function synthesizeButtonText(tap: ButtonTap): string {
  switch (tap.kind) {
    case 'recipient':      return `[Tapped: Send to recipient ${tap.recipientPhone}]`;
    case 'recipient_new':  return '[Tapped: Someone new]';
    case 'approve':        return '[Tapped: Approve & pay]';
    case 'cancel':         return '[Tapped: Cancel]';
  }
}

export async function POST(req: NextRequest) {
  const raw = await req.text(); // raw bytes first — Meta signs the exact body

  // Signature gate, ABOVE markMessageSeen, so a forged body can't touch the
  // dedup set or any downstream processing.
  const appSecret = env.metaAppSecret; // '' if unset
  if (appSecret === '') {
    // Dev/test + current prod (secret not yet configured): proceed, but warn.
    console.warn('META_APP_SECRET unset — skipping X-Hub-Signature-256 verification');
  } else {
    const signature = req.headers.get('x-hub-signature-256') ?? '';
    if (!verifyMetaSignature(raw, signature, appSecret)) {
      return NextResponse.json({ ok: false }, { status: 401 }); // fail-closed
    }
  }

  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }

  // Message-STATUS callbacks (sent/delivered/read/failed). Meta delivers these as
  // a `statuses` event with no `messages`, so parseIncoming would return null and
  // we'd silently drop them. Handle BEFORE the message path. We don't map
  // wamid → transfer yet, so the deliverable is structured logging (a future
  // mapping plugs into the `failed` branch). This sits AFTER the signature gate
  // (never log forged events) and BEFORE parseIncoming's null early return.
  const statusEvents = parseStatusEvent(body);
  if (statusEvents) {
    for (const ev of statusEvents) {
      if (ev.status === 'failed') {
        console.warn(
          `WhatsApp message delivery FAILED — recipient=${ev.recipientId} wamid=${ev.wamid} code=${ev.errorCode ?? 'n/a'} (${ev.errorTitle ?? ''})`,
        );
        // FUTURE: map ev.wamid -> transfer and surface a delivery-failure signal.
      } else {
        console.debug(
          `WhatsApp status ${ev.status} — recipient=${ev.recipientId} wamid=${ev.wamid}`,
        );
      }
    }
    return NextResponse.json({ ok: true });
  }

  const incoming = parseIncoming(body);
  if (!incoming) return NextResponse.json({ ok: true });

  const store = getStore();
  const isNew = await store.markMessageSeen(incoming.messageId);
  if (!isNew) return NextResponse.json({ ok: true });

  // Build TurnContext deterministically server-side
  const customerStore = getCustomerStore(store);

  // STOP / START consent short-circuit. AFTER the dedup guard (so a re-delivered
  // STOP isn't double-handled) and BEFORE the agent turn. WhatsApp compliance:
  // honor opt-out and offer resume; exact-keyword only (never "cancel"). Both
  // skip the agent entirely for this turn.
  if (incoming.kind === 'text') {
    if (isOptOutKeyword(incoming.text)) {
      await customerStore.setOptedOut(incoming.from);
      await sendText(incoming.from, OPT_OUT_REPLY);
      return NextResponse.json({ ok: true });
    }
    if (isResumeKeyword(incoming.text)) {
      await customerStore.clearOptedOut(incoming.from);
      await sendText(incoming.from, OPT_IN_REPLY);
      return NextResponse.json({ ok: true });
    }
  }

  const dailyVolumeStore = getDailyVolumeStore();
  const monthlyVolumeStore = getMonthlyVolumeStore();
  const lastInboundAt = await store.getLastInboundAt(incoming.from);
  const isNewConversation = lastInboundAt === null;
  await store.recordInboundNow(incoming.from);

  const { customer, wasCreated } = await customerStore.upsertOnFirstInbound(incoming.from);

  // Transactional opt-in (Item 4): a brand-new customer is opted-in at creation
  // (upsertOnFirstInbound sets optInAt). Existing/grandfathered records that
  // predate the field get a cheap idempotent backfill here (first contact wins).
  if (!customer.optInAt) {
    await customerStore.setOptedIn(incoming.from);
  }

  const now = new Date();
  const tier = deriveTier(customer, now);

  // Tier reminder: only on T0, only when starting a new conversation, never on the
  // very first message (that's covered by [NEW CUSTOMER]).
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

  after(async () => {
    try {
      const kycProvider = new MockKycProvider(customerStore, env.appBaseUrl);
      const agent = createAgent({
        chat,
        store,
        scheduleStore: getScheduleStore(),
        draftStore: getDraftStore(),
        customerStore,
        dailyVolumeStore,
        monthlyVolumeStore,   // NEW (KYC)
        kycProvider,
        partnerStore: getPartnerStore(), // NEW (P4)
      });
      const reply = await agent.runAgentTurn(incoming.from, messageText, turn);
      // An empty reply means a tool already sent an interactive card this turn —
      // sending an empty text would be a stray/blank message, so skip it.
      if (reply.trim()) await sendText(incoming.from, reply);
    } catch (err) {
      console.error('Failed to process WhatsApp message:', err);
      try {
        await sendText(
          incoming.from,
          'Sorry, something went wrong on our side. Please try again.',
        );
      } catch {
        // best effort
      }
    }
  });

  return NextResponse.json({ ok: true });
}
