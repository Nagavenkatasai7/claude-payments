import { after, NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { parseIncoming, sendText } from '@/lib/whatsapp';
import { chat } from '@/lib/ollama';
import { createAgent } from '@/lib/agent';
import { getStore } from '@/lib/store';
import { getScheduleStore } from '@/lib/schedule-store';

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

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const incoming = parseIncoming(body);
  if (!incoming) return NextResponse.json({ ok: true });
  if (incoming.kind !== 'text') return NextResponse.json({ ok: true });

  const store = getStore();
  const isNew = await store.markMessageSeen(incoming.messageId);
  if (!isNew) return NextResponse.json({ ok: true });

  after(async () => {
    try {
      const agent = createAgent({ chat, store, scheduleStore: getScheduleStore() });
      const reply = await agent.runAgentTurn(incoming.from, incoming.text);
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
