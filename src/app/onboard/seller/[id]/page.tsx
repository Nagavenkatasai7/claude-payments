import { getStore } from '@/lib/store';
import { SellerOnboardForm } from './seller-onboard-form';
import { DarkSheetBrand } from '@/components/brand/dark-sheet-brand';

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

function StatusSheet({ title, body }: { title: string; body?: string }) {
  return (
    <main className={pageClasses}>
      <div className={sheetClasses}>
        <DarkSheetBrand />
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

  // 404-never-403: a missing id and a stranger's id look identical.
  if (!seller) {
    return <StatusSheet title="This onboarding link is no longer active" />;
  }

  if (seller.status === 'active') {
    return (
      <StatusSheet
        title="You're all set"
        body="Your seller account is active — you can send bills to your customers on WhatsApp."
      />
    );
  }

  // Pending + flagged for review, or suspended → with our team; no form.
  if (seller.kycReviewState === 'needs_review' || seller.status === 'suspended') {
    return (
      <StatusSheet
        title="Your registration is under review"
        body="Our team is reviewing a few details on your seller registration and will be in touch before you can start sending bills."
      />
    );
  }

  // Pending + clear → render the payout + OTP onboarding form.
  return (
    <main className={pageClasses}>
      <div className={sheetClasses}>
        <DarkSheetBrand />
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
