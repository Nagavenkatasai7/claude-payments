import { CheckCircle2, Clock, ShieldCheck } from 'lucide-react';
import { requireCustomer } from '@/lib/customer-auth';
import { sendGateActive } from '@/lib/kyc-gate';
import { getPartnerStore } from '@/lib/partner-store';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AccountShell, PageHeader } from '../shell';
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
    <AccountShell active="overview" customer={customer}>
      <PageHeader title="Identity verification" />

      <div className="mx-auto max-w-lg">
        {!gateOn ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-4 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <CheckCircle2 className="size-6" />
              </div>
              <CardTitle className="text-lg">No verification needed</CardTitle>
              <CardDescription>
                Your account can send money without identity verification.
              </CardDescription>
            </CardContent>
          </Card>
        ) : done ? (
          <Alert className="border-primary/30 bg-primary/5 [&>svg]:text-primary">
            <CheckCircle2 />
            <AlertTitle className="text-primary">You&rsquo;re verified</AlertTitle>
            <AlertDescription>
              Your identity is confirmed. You can send money in WhatsApp.
            </AlertDescription>
          </Alert>
        ) : inReview ? (
          <Alert>
            <Clock />
            <AlertTitle>Thanks — we&rsquo;re reviewing</AlertTitle>
            <AlertDescription>
              We received your verification and are reviewing it. We&rsquo;ll message you on
              WhatsApp shortly.
            </AlertDescription>
          </Alert>
        ) : (
          <Card>
            <CardHeader>
              <div className="mb-1 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <ShieldCheck className="size-6" />
              </div>
              <CardTitle>Verify your identity</CardTitle>
              <CardDescription>
                To send money we need to confirm who you are. It takes about 2 minutes on our
                secure partner&rsquo;s page — have a government photo ID ready. Your details are
                encrypted and never stored on our servers.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form action={startVerificationAction}>
                <Button type="submit" size="lg" className="w-full">
                  Start verification
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </AccountShell>
  );
}
