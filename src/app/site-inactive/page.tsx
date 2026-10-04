import type { Metadata } from 'next';
import { DarkSheetBrand } from '@/components/brand/dark-sheet-brand';

// /site-inactive — what a partner subdomain shows when its slug is unknown, the partner is not
// active, the lookup is throttled or the lookup failed (src/proxy.ts rewrites to it). It is the SAME
// sheet as the pay page's dead link, with default branding, so it is never an oracle for whether a
// slug exists. tests/site-inactive-page.test.ts pins <main> byte-equal to the pay page's render.
//
// The classes below are copied verbatim from src/app/pay/[transferId]/page.tsx (pageClasses,
// sheetClasses, headingClasses, InactiveSheet; the brand line is the shared DarkSheetBrand). This file is exempt from the
// no-hex rule (src/lib/ui/new-ui-roots.ts) until H2 moves the pay page to the landing look and
// dedupes the sheet into one shared component.

export const metadata: Metadata = { robots: { index: false, follow: false } };

const pageClasses =
  "flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 font-[-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif] text-[#e9edef]";
const sheetClasses = 'w-full max-w-[420px] rounded-2xl bg-[#111b21] p-7';
const headingClasses = 'mb-5 text-lg leading-normal font-semibold';

function InactiveSheet() {
  return (
    <main className={pageClasses}>
      <div className={sheetClasses}>
        <DarkSheetBrand />
        <h1 className={headingClasses}>This link is no longer active</h1>
      </div>
    </main>
  );
}

export default function SiteInactivePage() {
  return <InactiveSheet />;
}
