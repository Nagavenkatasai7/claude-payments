export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requireCustomer } from '@/lib/customer-auth';
import { getPartnerStore } from '@/lib/partner-store';
import { getStore } from '@/lib/store';
import { createTicketAction } from '../actions';

export const metadata = { title: 'New support request · SmartRemit' };

// /account/support/new — start a support conversation. The optional transfer
// select only ever offers the customer's OWN last 10 transfers, and the server
// action re-validates the chosen id against that same set (the form is never
// trusted). Validation failures bounce back here with ?error=<code>.

const ERROR_MSG: Record<string, string> = {
  subject: 'Please give your request a short subject (3–120 characters).',
  message: 'Please describe what’s going on in a bit more detail (10–2000 characters).',
  transfer: 'That transfer couldn’t be linked — please pick one from the list.',
  cap: 'You already have 5 open requests. Reply on one of those, or wait for one to be resolved first.',
};

const fieldCls = 'mb-4 block';
const fieldLabelCls = 'mb-1.5 block text-[13px] text-[#8696a0]';
// 16px so iOS Safari never auto-zooms on focus (same recipe as account-forms).
const inputCls =
  'w-full rounded-lg border border-[#2a3942] bg-[#2a3942] p-2.5 text-[16px] text-[#e9edef]';

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export default async function NewSupportRequestPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const customer = await requireCustomer();

  // Admin kill switch — same gate as the support landing; the action re-checks.
  const partner =
    (await getPartnerStore().getPartner(customer.partnerId)) ??
    (await getPartnerStore().ensureDefaultPartner());
  if (partner.supportConfig?.enableSupportPortal === false) {
    return (
      <main className="flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 text-[#e9edef] [font-family:-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif]">
        <div className="w-full max-w-[420px] rounded-2xl bg-[#111b21] p-7">
          <div className="mb-1 text-xl font-extrabold leading-normal text-[#25d366]">SmartRemit</div>
          <h1 className="mb-5 text-lg font-semibold leading-normal">Support</h1>
          <p className="-mt-2 mb-5 text-sm leading-normal text-[#8696a0]">
            Support is handled in WhatsApp — message us there.
          </p>
          <p className="mt-4">
            <Link href="/account" className="text-sm text-[#8696a0] underline">
              ← Back to your account
            </Link>
          </p>
        </div>
      </main>
    );
  }

  const { error } = await searchParams;
  const errorMsg = error ? ERROR_MSG[error] : undefined;
  // The customer's OWN last 10 transfers — the only ids the select offers.
  const transfers = await getStore().listTransfersByPhone(customer.senderPhone, 10);

  return (
    <main className="flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 text-[#e9edef] [font-family:-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif]">
      <div className="w-full max-w-[420px] rounded-2xl bg-[#111b21] p-7">
        <div className="mb-1 text-xl font-extrabold leading-normal text-[#25d366]">SmartRemit</div>
        <h1 className="mb-5 text-lg font-semibold leading-normal">New support request</h1>
        <p className="-mt-2 mb-3.5 text-sm leading-normal text-[#8696a0]">
          Tell us what&rsquo;s going on and we&rsquo;ll get back to you here.
        </p>
        {errorMsg ? (
          <p className="mt-1 mb-3.5 text-[13px] leading-[1.4] text-[#f15c6d]" role="alert">
            {errorMsg}
          </p>
        ) : null}
        <form action={createTicketAction}>
          <label className={fieldCls}>
            <span className={fieldLabelCls}>Subject</span>
            <input
              name="subject"
              type="text"
              required
              minLength={3}
              maxLength={120}
              placeholder="e.g. My transfer hasn’t arrived"
              className={inputCls}
            />
          </label>
          <label className={fieldCls}>
            <span className={fieldLabelCls}>What&rsquo;s going on?</span>
            <textarea
              name="message"
              required
              minLength={10}
              maxLength={2000}
              rows={5}
              placeholder="Describe the issue — what you expected and what happened."
              className={inputCls}
            />
          </label>
          {transfers.length > 0 ? (
            <label className={fieldCls}>
              <span className={fieldLabelCls}>About a transfer? (optional)</span>
              <select name="transferId" defaultValue="" className={inputCls}>
                <option value="">Not about a specific transfer</option>
                {transfers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.recipientName} · {money(t.amountSource ?? t.amountUsd, t.sourceCurrency ?? 'USD')} ·{' '}
                    {new Date(t.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <p className="mt-1 mb-[18px] text-xs leading-normal text-[#667781]">
            Never include full account numbers or passwords — we&rsquo;ll never ask for them.
          </p>
          <button
            type="submit"
            className="w-full cursor-pointer rounded-3xl bg-[#25d366] p-3 text-[15px] font-bold text-[#0b141a]"
          >
            Send request
          </button>
        </form>
        <p className="mt-4">
          <Link href="/account/support" className="text-sm text-[#8696a0] underline">
            ← Back to support
          </Link>
        </p>
      </div>
    </main>
  );
}
