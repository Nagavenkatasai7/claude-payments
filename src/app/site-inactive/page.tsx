import type { Metadata } from 'next';
import { resolvePartnerBranding, type ResolvedBranding } from '@/lib/partner-config';

// /site-inactive — what a partner subdomain shows when its slug is unknown, the partner is not
// active, the lookup is throttled or the lookup failed (src/proxy.ts rewrites to it). It is the SAME
// sheet as the pay page's dead link, with default branding, so it is never an oracle for whether a
// slug exists. tests/site-inactive-page.test.ts pins <main> byte-equal to the pay page's render.
//
// The classes below are copied verbatim from src/app/pay/[transferId]/page.tsx (pageClasses,
// sheetClasses, headingClasses, brandClasses, Brand, InactiveSheet). This file is exempt from the
// no-hex rule (src/lib/ui/new-ui-roots.ts) until H2 moves the pay page to the landing look and
// dedupes the sheet into one shared component.

export const metadata: Metadata = { robots: { index: false, follow: false } };

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

function InactiveSheet({ branding }: { branding: ResolvedBranding }) {
  return (
    <main className={pageClasses}>
      <div className={sheetClasses}>
        <Brand branding={branding} />
        <h1 className={headingClasses}>This link is no longer active</h1>
      </div>
    </main>
  );
}

export default function SiteInactivePage() {
  return <InactiveSheet branding={resolvePartnerBranding(null)} />;
}
