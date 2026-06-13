import { Suspense } from 'react';
import Link from 'next/link';
import { requireCustomer } from '@/lib/customer-auth';
import { sendGateActive } from '@/lib/kyc-gate';
import { getPartnerStore } from '@/lib/partner-store';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getDailyVolumeStore } from '@/lib/daily-volume-store';
import {
  getCustomerSummary,
  buildSummaryContext,
  buildDeterministicSummary,
} from '@/lib/customer-summary';
import { waLink, WA_MESSAGES } from '@/app/landing/wa';
import { LogoutButton } from './logout-button';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Your account · SmartRemit' };

/** Mask a phone for display (•••2030) — never render the full number. */
function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.length <= 4 ? d : `••• ••• ${d.slice(-4)}`;
}

/** Map the KYC state to a CTA label + sublabel for the account-home screen. */
function kycCta(customer: { kycStatus: string; kycReviewState?: string }): { label: string; note: string; done: boolean } {
  if (customer.kycStatus === 'verified') {
    return { label: 'Identity verified', note: 'You can send money in WhatsApp.', done: true };
  }
  switch (customer.kycReviewState) {
    case 'pending_review':
    case 'needs_review':
      return { label: 'Verification in review', note: 'We received it and are reviewing — we’ll message you on WhatsApp.', done: false };
    case 'inquiry_started':
      return { label: 'Continue verification', note: 'Pick up where you left off.', done: false };
    default:
      return { label: 'Verify your identity', note: 'Takes about 2 minutes on our secure partner’s page.', done: false };
  }
}

// Status labels — mirror /account/history (incl. the refund-aware overlay) so
// the dashboard strip and the history page never disagree about a transfer.
const STATUS_LABEL: Record<string, string> = {
  awaiting_payment: 'Awaiting payment',
  paid: 'Processing',
  delivered: 'Delivered ✓',
  cancelled: 'Cancelled',
  in_review: 'Under review',
  blocked: 'Could not be completed',
};

const REFUND_LABEL: Record<string, string> = {
  requested: 'Refund requested',
  pending: 'Refund on the way',
  completed: 'Refunded',
};

function statusLabel(t: { status: string; refundStatus?: string }): string {
  return REFUND_LABEL[t.refundStatus ?? ''] ?? STATUS_LABEL[t.status] ?? t.status;
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

const cardCls = 'mb-4 rounded-2xl bg-[#111b21] p-6';
const cardHeadCls = 'text-[13px] font-semibold uppercase tracking-[0.06em] text-[#8696a0]';

/**
 * Smart-summary card — streamed in behind <Suspense> so a cold cache never
 * blocks the page shell. The AI path (getCustomerSummary) returns null on ANY
 * model/cache failure; rather than leave the slot silently empty we then fall
 * back to a DETERMINISTIC digest built purely from the customer's own data
 * (buildDeterministicSummary). The "AI-generated" disclaimer is shown ONLY on
 * the real-AI path — the deterministic card never claims to be AI.
 */
async function SmartSummaryCard({ phone }: { phone: string }) {
  const summary = await getCustomerSummary(phone);
  if (summary) {
    return (
      <section className={cardCls}>
        <h2 className={`${cardHeadCls} mb-2`}>Your summary</h2>
        <p className="mb-3 text-[15px] leading-[1.6]">{summary}</p>
        <p className="text-xs leading-normal text-[#667781]">
          AI-generated — check your history for official status.
        </p>
      </section>
    );
  }

  // AI path unavailable — build the same SummaryContext the model would have
  // seen (the customer's OWN masked facts only) and render it deterministically.
  // Any failure here too just drops the card, exactly as before.
  let fallback: string | null = null;
  try {
    const store = getStore();
    const [customer, transfers, todayUsedCents] = await Promise.all([
      getCustomerStore(store).getCustomer(phone),
      store.listTransfersByPhone(phone, 5),
      getDailyVolumeStore().getTodayCents(phone),
    ]);
    if (customer) {
      const partnerRow = await getPartnerStore().getPartner(customer.partnerId);
      const partner = partnerRow ?? (await getPartnerStore().ensureDefaultPartner());
      const context = buildSummaryContext(
        customer,
        transfers,
        todayUsedCents,
        sendGateActive(partner),
      );
      fallback = buildDeterministicSummary(context);
    }
  } catch {
    fallback = null;
  }
  if (!fallback) return null;

  return (
    <section className={cardCls}>
      <h2 className={`${cardHeadCls} mb-2`}>Your summary</h2>
      <p className="mb-3 text-[15px] leading-[1.6]">{fallback}</p>
      <p className="text-xs leading-normal text-[#667781]">
        Based on your account activity — check your history for official status.
      </p>
    </section>
  );
}

function SummarySkeleton() {
  return (
    <section className={`${cardCls} animate-pulse`} aria-hidden="true">
      <h2 className={`${cardHeadCls} mb-2`}>Your summary</h2>
      <div className="mb-2 h-3.5 w-full rounded bg-[#202c33]" />
      <div className="h-3.5 w-2/3 rounded bg-[#202c33]" />
    </section>
  );
}

export default async function AccountHomePage() {
  const customer = await requireCustomer();
  // KYC is partner OPT-IN (sendGateActive) — the customer's partner ROW decides
  // whether the verification card exists at all. Gate off ⇒ no card; the verify
  // page + its server action enforce the same gate.
  const [partnerRow, transfers] = await Promise.all([
    getPartnerStore().getPartner(customer.partnerId),
    getStore().listTransfersByPhone(customer.senderPhone, 3),
  ]);
  const partner = partnerRow ?? (await getPartnerStore().ensureDefaultPartner());
  const cta = sendGateActive(partner) ? kycCta(customer) : null;

  const actions: { href: string; title: string; note: string; external?: boolean; accent?: boolean }[] = [
    { href: waLink(WA_MESSAGES.generic), title: 'Send money', note: 'Chat with us on WhatsApp', external: true, accent: true },
    { href: '/account/history', title: 'Transfer history', note: 'Every transfer, with receipts' },
    { href: '/account/support', title: 'Get help', note: 'Open a support ticket' },
    { href: '/account/chat', title: 'AI assistant', note: 'Ask about your account' },
    { href: '/account/settings', title: 'Settings', note: 'Email, password & more' },
  ];

  return (
    <main className="flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 text-[#e9edef] [font-family:-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif]">
      <div className="w-full max-w-[420px]">
        {/* Greeting header */}
        <div className={cardCls}>
          <div className="mb-1 text-xl font-extrabold leading-normal text-[#25d366]">SmartRemit</div>
          <h1 className="mb-5 text-lg font-semibold leading-normal">Your account</h1>
          <p className="mb-5 text-[15px] leading-[1.6] text-[#e9edef]">
            You&rsquo;re signed in as <strong className="text-[#25d366]">{maskPhone(customer.senderPhone)}</strong>.
          </p>
          {cta ? (
            <div className="mb-5">
              <p>{cta.done ? '✓ ' : ''}{cta.label}</p>
              <p className="-mt-2 mb-3 text-sm leading-normal text-[#8696a0]">{cta.note}</p>
              {cta.done ? null : (
                <a
                  href="/account/verify"
                  className="block rounded-2xl bg-[#25d366] p-4 text-[#0b141a] no-underline"
                >
                  <div className="text-[15px] font-bold leading-normal">{cta.label}</div>
                  <div className="mt-0.5 text-xs leading-normal text-[#04231a]/80">{cta.note}</div>
                </a>
              )}
            </div>
          ) : null}
          <LogoutButton />
        </div>

        {/* AI smart summary */}
        <Suspense fallback={<SummarySkeleton />}>
          <SmartSummaryCard phone={customer.senderPhone} />
        </Suspense>

        {/* Recent activity strip — last 3 transfers */}
        <section className={cardCls}>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className={cardHeadCls}>Recent activity</h2>
            <Link href="/account/history" className="text-sm font-semibold text-[#25d366] no-underline hover:underline">
              View all →
            </Link>
          </div>
          {transfers.length === 0 ? (
            <p className="text-sm leading-normal text-[#8696a0]">
              No transfers yet — message us on WhatsApp to send your first one.
            </p>
          ) : (
            transfers.map((t) => (
              <Link
                key={t.id}
                href={`/account/receipt/${t.id}`}
                className="mb-2 block rounded-xl bg-[#202c33] p-3.5 text-inherit no-underline last:mb-0"
              >
                <div className="flex justify-between py-0.5 text-sm leading-normal">
                  <span className="font-semibold text-[#8696a0]">{t.recipientName}</span>
                  <span>{money(t.amountSource ?? t.amountUsd, t.sourceCurrency ?? 'USD')}</span>
                </div>
                <div className="flex justify-between py-0.5 text-[12px] leading-normal text-[#8696a0]">
                  <span>{new Date(t.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                  <span>{statusLabel(t)}</span>
                </div>
              </Link>
            ))
          )}
        </section>

        {/* Action grid */}
        <div className="grid grid-cols-2 gap-3">
          {actions.map((a) =>
            a.external ? (
              <a
                key={a.title}
                href={a.href}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-2xl bg-[#25d366] p-4 text-[#0b141a] no-underline"
              >
                <div className="text-[15px] font-bold leading-normal">{a.title}</div>
                <div className="mt-0.5 text-xs leading-normal text-[#04231a]/80">{a.note}</div>
              </a>
            ) : (
              <Link
                key={a.title}
                href={a.href}
                className="block rounded-2xl bg-[#111b21] p-4 text-inherit no-underline"
              >
                <div className="text-[15px] font-semibold leading-normal">{a.title}</div>
                <div className="mt-0.5 text-xs leading-normal text-[#8696a0]">{a.note}</div>
              </Link>
            ),
          )}
        </div>
      </div>
    </main>
  );
}
