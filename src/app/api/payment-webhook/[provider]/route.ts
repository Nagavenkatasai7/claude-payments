import { NextRequest, NextResponse, after } from 'next/server';
import { getStore } from '@/lib/store';
import { getPaymentProvider } from '@/lib/providers/payment-provider';
import { verifyWebhookSignature } from '@/lib/providers/payment-webhook-verify';
import { env } from '@/lib/env';
import { recipientTemplateParams } from '@/lib/payment';
import {
  sendText, sendTemplate, RECIPIENT_TEMPLATE_NAME, RECIPIENT_TEMPLATE_LANG,
} from '@/lib/whatsapp';

function inr(amount: number): string {
  return amount.toLocaleString('en-IN');
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const raw = await req.text();                           // raw body first (for HMAC)
  const store = getStore();

  // Mock skips verification (it never posts callbacks); real providers MUST verify.
  if (provider !== 'mock') {
    const secret = env.paymentWebhookSecret(provider);    // '' if unconfigured
    const signature = req.headers.get('x-signature') ?? '';
    if (!verifyWebhookSignature(raw, signature, secret)) {
      return NextResponse.json({ ok: false }, { status: 401 }); // fail-closed
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 }); // malformed
  }

  const result = await getPaymentProvider(store).handleWebhook(body);
  if (!result) {
    return NextResponse.json({ ok: true, ignored: true });  // unparseable/irrelevant → 200, no mutation
  }

  const updated = await store.updateTransferFromWebhook(result.transferId, result.status);
  // Fire stage-2 notifications ONLY on a real terminal transition (non-null + delivered).
  if (updated && updated.status === 'delivered') {
    after(async () => {
      try {
        await sendText(
          updated.phone,
          `🎉 ₹${inr(updated.amountInr)} delivered to ${updated.recipientName}. Thanks for using SmartRemit!`,
        );
        if (updated.recipientPhone) {
          await sendTemplate(
            updated.recipientPhone, RECIPIENT_TEMPLATE_NAME, RECIPIENT_TEMPLATE_LANG,
            recipientTemplateParams(updated),
          );
        }
      } catch (err) {
        console.error('Webhook stage-2 notify failed:', err);
      }
    });
  }
  return NextResponse.json({ ok: true });
}
