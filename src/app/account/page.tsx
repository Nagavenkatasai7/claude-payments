import { requireCustomer } from '@/lib/customer-auth';
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
/** Map the KYC state to a CTA label + sublabel for the account-home card. */
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
  const cta = kycCta(customer);

  return (
    <main className="payapp">
      <div className="card">
        <div className="brand">SmartRemit</div>
        <h1>Your account</h1>
        <p className="acct-signed-in">
          You&rsquo;re signed in as <strong>{maskPhone(customer.senderPhone)}</strong>.
        </p>
        <div className="acct-kyc-card">
          <p className="acct-kyc-status">{cta.done ? '✓ ' : ''}{cta.label}</p>
          <p className="acct-sub">{cta.note}</p>
          {cta.done ? null : <a className="acct-cta" href="/account/verify">{cta.label}</a>}
        </div>
        <div className="acct-kyc-card">
          <p className="acct-kyc-status">Transfer history</p>
          <p className="acct-sub">Every transfer you&rsquo;ve sent, with receipts.</p>
          <a className="acct-cta" href="/account/history">View history</a>
        </div>
        <LogoutButton />
      </div>
    </main>
  );
}
