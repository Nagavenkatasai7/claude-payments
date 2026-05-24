import { after, NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { parseIncoming, sendText } from '@/lib/whatsapp';
import { parseButtonId } from '@/lib/whatsapp-buttons';
import { chat } from '@/lib/ollama';
import { createAgent } from '@/lib/agent';
import { getStore } from '@/lib/store';
import { getScheduleStore } from '@/lib/schedule-store';
import { getDraftStore } from '@/lib/draft-store';
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
    case 'recipient':
      return `[Tapped: Send to recipient ${tap.recipientPhone}]`;
    case 'recipient_new':
      return '[Tapped: Someone new]';
    case 'approve':
      return '[Tapped: Approve & pay]';
    case 'cancel':
      return '[Tapped: Cancel]';
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const incoming = parseIncoming(body);
  if (!incoming) return NextResponse.json({ ok: true });

  const store = getStore();
  const isNew = await store.markMessageSeen(incoming.messageId);
  if (!isNew) return NextResponse.json({ ok: true });

  // Build TurnContext deterministically server-side. The LLM cannot influence
  // these fields.
  const lastInboundAt = await store.getLastInboundAt(incoming.from);
  const isNewConversation = lastInboundAt === null;
  await store.recordInboundNow(incoming.from);

  let messageText: string;
  let buttonTap: ButtonTap | undefined;
  if (incoming.kind === 'text') {
    messageText = incoming.text;
  } else {
    const parsed = parseButtonId(incoming.buttonId);
    if (!parsed) {
      // Unknown button id — treat as text and let the agent ask for clarification.
      messageText = '(unrecognized button)';
    } else {
      buttonTap = parsed;
      messageText = synthesizeButtonText(parsed);
    }
  }

  const turn: TurnContext = { isNewConversation, buttonTap };

  after(async () => {
    try {
      const agent = createAgent({
        chat,
        store,
        scheduleStore: getScheduleStore(),
        draftStore: getDraftStore(),
      });
      const reply = await agent.runAgentTurn(incoming.from, messageText, turn);
      await sendText(incoming.from, reply);
    } catch (err) {
      console.error('Failed to process WhatsApp message:', err);
      try {
        await sendText(
          incoming.from,
          'Sorry, something went wrong on our side. Please try again.',
        );
      } catch {
        // best effort — nothing more we can do
      }
    }
  });

  return NextResponse.json({ ok: true });
}
