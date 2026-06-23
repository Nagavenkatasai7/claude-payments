import Link from 'next/link';
import { hashApplicationToken, isApplicationTokenExpired } from '@/lib/partner-application-token';
import { getStore } from '@/lib/store';
import { PartnerApplicationForm } from './partner-application-form';

// Public, token-gated detailed partner application (Stage 2). The URL token is a
// capability: hash it, resolve the partner_request it points at, and only render
// the form when the link is live (exists, not expired, not already completed).
// Every miss is a FRIENDLY status card — never a 500 or a bare notFound. The
// submit action and the upload route re-validate the same token independently;
// nothing here is trusted by the server beyond this read.

export const dynamic = 'force-dynamic'; // token lookup is per-request; never cache

const PAGE =
  'min-h-svh bg-[#050607] text-[#f5f7f8] antialiased [&_:focus-visible]:rounded-[6px] [&_:focus-visible]:[outline-offset:3px] [&_:focus-visible]:[outline:2px_solid_#25d366]';

function StatusCard({
  title,
  body,
  tone = 'neutral',
}: {
  title: string;
  body: string;
  tone?: 'neutral' | 'success';
}) {
  const ring =
    tone === 'success'
      ? 'border-[rgba(37,211,102,0.3)] bg-[rgba(37,211,102,0.06)]'
      : 'border-white/10 bg-white/[0.02]';
  return (
    <main className={`${PAGE} grid place-items-center px-5 py-16`}>
      <div className={`w-full max-w-[520px] rounded-2xl border ${ring} p-7 sm:p-9`}>
        <p className="mb-3 inline-flex items-center gap-2 text-[13px] font-semibold text-[#25d366]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#25d366]" aria-hidden="true" />
          SmartRemit partner application
        </p>
        <h1 className="text-[22px] font-bold leading-tight">{title}</h1>
        <p className="mt-3 text-[15px] leading-[1.6] text-[#8b94a0]">{body}</p>
        <Link
          href="/"
          className="mt-6 inline-flex min-h-[44px] items-center justify-center rounded-full bg-[#25d366] px-6 text-[14px] font-bold text-[#04231a] transition-[background-color,transform] duration-150 hover:bg-[#1fbd5d] hover:[transform:translateY(-1px)]"
        >
          Back to smartremit.ai
        </Link>
      </div>
    </main>
  );
}

export default async function PartnerApplyPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  const hash = hashApplicationToken(token);
  const request = await getStore().getPartnerRequestByTokenHash(hash);

  // Already submitted ⇒ a warm thank-you (single-use link is now dead).
  if (request && request.applicationStatus === 'completed') {
    return (
      <StatusCard
        tone="success"
        title="Thank you — your application has been received."
        body="Our partnerships team is reviewing your details and will be in touch shortly. This application link has now been used and is no longer active."
      />
    );
  }

  // Missing, expired, or otherwise unusable ⇒ a friendly dead-end (no 500).
  if (!request || isApplicationTokenExpired(request.tokenExpiresAt)) {
    return (
      <StatusCard
        title="This application link is no longer available."
        body="This application link is invalid, has expired, or has already been completed. If you still need to apply, reply to the email we sent you and we'll issue a fresh link."
      />
    );
  }

  return (
    <main className={`${PAGE} px-5 py-12 sm:py-16`}>
      <div className="mx-auto w-full max-w-[760px]">
        <header className="mb-8">
          <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 text-[12.5px] font-medium text-[#8b94a0]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#25d366]" aria-hidden="true" />
            SmartRemit partner application
          </p>
          <h1 className="text-[clamp(26px,4vw,34px)] font-bold leading-tight">
            Detailed partner application
          </h1>
          <p className="mt-3 max-w-[58ch] text-[15px] leading-[1.6] text-[#8b94a0]">
            Thanks for your interest in partnering with SmartRemit. This is the detailed
            onboarding application — company &amp; legal entity, licensing &amp; compliance,
            operations &amp; settlement, and your technical &amp; contact details. It takes
            about 10–15 minutes. Document uploads are optional; you can submit without them and
            send documents later.
          </p>
        </header>

        <PartnerApplicationForm
          token={token}
          error={error}
          prefill={{
            companyName: request.companyName,
            email: request.email,
            phone: request.phone,
          }}
        />
      </div>
    </main>
  );
}
