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
    for (const message of messages) {
      await sendText(transfer.phone, message);
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
