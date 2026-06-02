import { requireCustomer } from '@/lib/customer-auth';
import { startVerificationAction } from './actions';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Verify your identity · SmartRemit' };

/**
 * Customer-facing KYC entry (Phase 2). Logged-in only (requireCustomer). The
 * "Start" button posts startVerificationAction, which creates a real Persona
 * inquiry and redirects to the hosted flow. Once submitted, shows the in-review
 * state instead of re-offering the button.
 */
export default async function VerifyPage() {
  const customer = await requireCustomer();
  const done = customer.kycStatus === 'verified' || customer.kycStatus === 'grandfathered';
  const inReview =
    customer.kycReviewState === 'pending_review' || customer.kycReviewState === 'needs_review';

  return (
    <main className="payapp">
      <div className="card">
        <div className="brand">SmartRemit</div>
        <h1>Verify your identity</h1>

        {done ? (
          <p className="acct-sub">✓ You&rsquo;re verified. You can send money in WhatsApp.</p>
        ) : inReview ? (
          <p className="acct-sub">
            Thanks — we received your verification and are reviewing it. We&rsquo;ll message you on
            WhatsApp shortly.
          </p>
        ) : (
          <>
            <p className="acct-sub">
              To send money we need to verify your identity. It takes about 2 minutes on our secure
              partner&rsquo;s page — have a government photo ID ready. Your details are encrypted and
              never stored on our servers.
            </p>
            <form action={startVerificationAction}>
              <button type="submit" className="acct-cta">Start verification</button>
            </form>
          </>
        )}

        <p className="acct-alt">
          <a href="/account">Back to your account</a>
        </p>
      </div>
    </main>
  );
}
