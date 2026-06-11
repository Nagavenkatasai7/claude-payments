import { requireCustomer } from '@/lib/customer-auth';
import { sendGateActive } from '@/lib/kyc-gate';
import { getPartnerStore } from '@/lib/partner-store';
import { LogoutButton } from './logout-button';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Your account · SmartRemit' };

/** Mask a phone for display (•••2030) — never render the full number. */
function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.length <= 4 ? d : `••• ••• ${d.slice(-4)}`;
}

/**
 * Signed-in landing (placeholder). requireCustomer() redirects to /account/login
 * when there's no live session. The real portal (verification, sending) lands in
 * later phases — Phase 1 only establishes the account + verified phone.
 */
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

export default async function AccountHomePage() {
  const customer = await requireCustomer();
  // KYC is partner OPT-IN (sendGateActive) — the customer's partner ROW decides
  // whether the verification card exists at all. Gate off ⇒ no card; the verify
  // page + its server action enforce the same gate.
  const partner =
    (await getPartnerStore().getPartner(customer.partnerId)) ??
    (await getPartnerStore().ensureDefaultPartner());
  const cta = sendGateActive(partner) ? kycCta(customer) : null;

  return (
    <main className="flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 text-[#e9edef] [font-family:-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif]">
      <div className="w-full max-w-[420px] rounded-2xl bg-[#111b21] p-7">
        <div className="mb-1 text-xl font-extrabold leading-normal text-[#25d366]">SmartRemit</div>
        <h1 className="mb-5 text-lg font-semibold leading-normal">Your account</h1>
        <p className="mb-5 text-[15px] leading-[1.6] text-[#e9edef]">
          You&rsquo;re signed in as <strong className="text-[#25d366]">{maskPhone(customer.senderPhone)}</strong>.
        </p>
        {cta ? (
          <div>
            <p>{cta.done ? '✓ ' : ''}{cta.label}</p>
            <p className="-mt-2 mb-5 text-sm leading-normal text-[#8696a0]">{cta.note}</p>
            {cta.done ? null : <a href="/account/verify">{cta.label}</a>}
          </div>
        ) : null}
        <div>
          <p>Transfer history</p>
          <p className="-mt-2 mb-5 text-sm leading-normal text-[#8696a0]">Every transfer you&rsquo;ve sent, with receipts.</p>
          <a href="/account/history">View history</a>
        </div>
        <LogoutButton />
      </div>
    </main>
  );
}
