import { getStore } from '@/lib/store';
import { getPartnerStore } from '@/lib/partner-store';
import { resolvePartnerBranding, type ResolvedBranding } from '@/lib/partner-config';
import { SellerOnboardForm } from './seller-onboard-form';

// Hosted seller-onboarding page — the web-finish of the WhatsApp-start
// register_seller flow. The URL `id` is an unguessable capability (mirrors the
// pay page loading a transfer by id): load the PENDING seller, show their
// business name + country, and render the per-country payout fields + OTP step-up.
// A missing/ineligible seller is a FRIENDLY status card, never a 500 or a 403 —
// 404-never-403, so a stranger's id is indistinguishable from a missing one.

export const dynamic = 'force-dynamic'; // per-request seller lookup; never cache

const pageClasses =
  "flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 font-[-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif] text-[#e9edef]";
const sheetClasses = 'w-full max-w-[420px] rounded-2xl bg-[#111b21] p-7';
const headingClasses = 'mb-5 text-lg leading-normal font-semibold';
const brandClasses = 'mb-1 text-xl leading-normal font-extrabold text-[#25d366]';

function Brand({ branding }: { branding: ResolvedBranding }) {
  if (branding.logoUrl) {
    return (
      <div className={brandClasses}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={branding.logoUrl} alt={branding.brand} style={{ maxHeight: 28, verticalAlign: 'middle' }} />
      </div>
    );
  }
  return (
    <div className={brandClasses} style={branding.primaryColor ? { color: branding.primaryColor } : undefined}>
      {branding.brand}
    </div>
  );
}

async function resolveBrandFor(partnerId: string | null): Promise<ResolvedBranding> {
  if (!partnerId) return resolvePartnerBranding(null);
  return resolvePartnerBranding(await getPartnerStore().getPartner(partnerId));
}

function StatusSheet({ branding, title, body }: { branding: ResolvedBranding; title: string; body?: string }) {
  return (
    <main className={pageClasses}>
      <div className={sheetClasses}>
        <Brand branding={branding} />
        <h1 className={headingClasses}>{title}</h1>
        {body && <p className="text-sm leading-normal text-[#8696a0]">{body}</p>}
      </div>
    </main>
  );
}

export default async function SellerOnboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const seller = await getStore().getSellerById(id);
  const branding = await resolveBrandFor(seller?.partnerId ?? null);

  // 404-never-403: a missing id and a stranger's id look identical.
  if (!seller) {
    return <StatusSheet branding={branding} title="This onboarding link is no longer active" />;
  }

  if (seller.status === 'active') {
    return (
      <StatusSheet
        branding={branding}
        title="You're all set"
        body="Your seller account is active — you can send bills to your customers on WhatsApp."
      />
    );
  }

  // Pending + flagged for review, or suspended → with our team; no form.
  if (seller.kycReviewState === 'needs_review' || seller.status === 'suspended') {
    return (
      <StatusSheet
        branding={branding}
        title="Your registration is under review"
        body="Our team is reviewing a few details on your seller registration and will be in touch before you can start sending bills."
      />
    );
  }

  // Pending + clear → render the payout + OTP onboarding form.
  return (
    <main className={pageClasses}>
      <div className={sheetClasses}>
        <Brand branding={branding} />
        <h1 className={headingClasses}>Finish your seller setup</h1>
        <div className="mb-5 rounded-xl bg-[#202c33] p-3.5">
          <div className="flex justify-between py-1.5 text-sm leading-normal">
            <span className="text-[#8696a0]">Business</span>
            <span>{seller.businessName}</span>
          </div>
          <div className="flex justify-between py-1.5 text-sm leading-normal">
            <span className="text-[#8696a0]">Country</span>
            <span>{seller.country}</span>
          </div>
          <div className="flex justify-between py-1.5 text-sm leading-normal">
            <span className="text-[#8696a0]">Payout currency</span>
            <span>{seller.currency}</span>
          </div>
        </div>
        <SellerOnboardForm sellerId={seller.id} country={seller.country} />
      </div>
    </main>
  );
}
