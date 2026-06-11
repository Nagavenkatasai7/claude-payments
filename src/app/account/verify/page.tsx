import { requireCustomer } from '@/lib/customer-auth';
import { sendGateActive } from '@/lib/kyc-gate';
import { getPartnerStore } from '@/lib/partner-store';
import { startVerificationAction } from './actions';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Verify your identity · SmartRemit' };

/**
 * Customer-facing KYC entry (Phase 2). Logged-in only (requireCustomer). KYC is
 * partner OPT-IN: when the customer's partner doesn't gate sends on KYC
 * (sendGateActive false) this page shows a "no verification needed" note instead
 * of the flow. Otherwise the "Start" button posts startVerificationAction, which
 * creates a real Persona inquiry and redirects to the hosted flow. Once
 * submitted, shows the in-review state instead of re-offering the button.
 */
export default async function VerifyPage() {
  const customer = await requireCustomer();
  // KYC is partner OPT-IN (sendGateActive) — when the customer's partner doesn't
  // gate sends on KYC there is nothing to verify, so show a friendly note instead
  // of the start-verification UI (the server action enforces the same gate).
  const partner =
    (await getPartnerStore().getPartner(customer.partnerId)) ??
    (await getPartnerStore().ensureDefaultPartner());
  const gateOn = sendGateActive(partner);
  const done = customer.kycStatus === 'verified';
  const inReview =
    customer.kycReviewState === 'pending_review' || customer.kycReviewState === 'needs_review';

  return (
    <main className="flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 text-[#e9edef] [font-family:-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif]">
      <div className="w-full max-w-[420px] rounded-2xl bg-[#111b21] p-7">
        <div className="mb-1 text-xl font-extrabold leading-normal text-[#25d366]">SmartRemit</div>
        <h1 className="mb-5 text-lg font-semibold leading-normal">Verify your identity</h1>

        {!gateOn ? (
          <p className="-mt-2 mb-5 text-sm leading-normal text-[#8696a0]">
            No verification needed — your account can send money without identity verification.
          </p>
        ) : done ? (
          <p className="-mt-2 mb-5 text-sm leading-normal text-[#8696a0]">✓ You&rsquo;re verified. You can send money in WhatsApp.</p>
        ) : inReview ? (
          <p className="-mt-2 mb-5 text-sm leading-normal text-[#8696a0]">
            Thanks — we received your verification and are reviewing it. We&rsquo;ll message you on
            WhatsApp shortly.
          </p>
        ) : (
          <>
            <p className="-mt-2 mb-5 text-sm leading-normal text-[#8696a0]">
              To send money we need to verify your identity. It takes about 2 minutes on our secure
              partner&rsquo;s page — have a government photo ID ready. Your details are encrypted and
              never stored on our servers.
            </p>
            <form action={startVerificationAction}>
              <button type="submit" className="w-full cursor-pointer rounded-3xl bg-[#25d366] p-3 text-[15px] font-bold text-[#0b141a] disabled:cursor-default disabled:opacity-60">Start verification</button>
            </form>
          </>
        )}

        <p className="mt-[18px] text-center text-sm leading-normal text-[#8696a0]">
          <a href="/account" className="font-semibold text-[#25d366] no-underline hover:underline">Back to your account</a>
        </p>
      </div>
    </main>
  );
}
