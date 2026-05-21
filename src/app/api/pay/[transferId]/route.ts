import { NextRequest, NextResponse, after } from 'next/server';
import { getStore } from '@/lib/store';
import { completePaymentStage1, completePaymentStage2 } from '@/lib/payment';
import { sendText } from '@/lib/whatsapp';

export const maxDuration = 300;

const DELIVERY_DELAY_MS = 120000; // 2 minutes

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ transferId: string }> },
) {
  const { transferId } = await params;
  try {
    const store = getStore();
    const { transfer, senderMessages, recipientMessages } =
      await completePaymentStage1(store, transferId);

    // Send stage-1 messages to sender and recipient
    for (const msg of senderMessages) {
      await sendText(transfer.phone, msg);
    }
    for (const msg of recipientMessages) {
      await sendText(transfer.recipientPhone, msg);
    }

    // Schedule stage-2 delivery after a delay
    after(async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, DELIVERY_DELAY_MS));
        const stage2 = await completePaymentStage2(store, transferId);
        for (const msg of stage2.senderMessages) {
          await sendText(stage2.transfer.phone, msg);
        }
        for (const msg of stage2.recipientMessages) {
          await sendText(stage2.transfer.recipientPhone, msg);
        }
      } catch (err) {
        console.error('Stage-2 delivery failed:', err);
      }
    });

    return NextResponse.json({ ok: true, status: 'paid' });
  } catch (err) {
    console.error('Payment processing failed:', err);
    return NextResponse.json(
      { ok: false, error: 'Payment failed' },
      { status: 400 },
    );
  }
}
