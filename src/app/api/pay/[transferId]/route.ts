import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { completePayment } from '@/lib/payment';
import { sendText } from '@/lib/whatsapp';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ transferId: string }> },
) {
  const { transferId } = await params;
  try {
    const { transfer, messages } = await completePayment(
      getStore(),
      transferId,
    );
    // Send each confirmation with a short beat between them so the
    // "payment received → converting → delivered" sequence reads as a
    // live progression in the chat rather than a single burst.
    for (let i = 0; i < messages.length; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
      await sendText(transfer.phone, messages[i]);
    }
    return NextResponse.json({ ok: true, status: transfer.status });
  } catch (err) {
    console.error('Payment processing failed:', err);
    return NextResponse.json(
      { ok: false, error: 'Payment failed' },
      { status: 400 },
    );
  }
}
