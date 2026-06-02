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
export default async function AccountHomePage() {
  const customer = await requireCustomer();
  const verified = Boolean(customer.phoneVerifiedAt);

  return (
    <main className="payapp">
      <div className="card">
        <div className="brand">SmartRemit</div>
        <h1>Your account</h1>
        <p className="acct-signed-in">
          You&rsquo;re signed in as <strong>{maskPhone(customer.senderPhone)}</strong>.
        </p>
        <p className="acct-sub">
          {verified
            ? 'Your number is verified. Verification of your identity and sending money come next.'
            : 'Verification & sending come next.'}
        </p>
        <LogoutButton />
      </div>
    </main>
  );
}
