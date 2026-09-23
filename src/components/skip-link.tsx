// "Skip to content" (Program-Fix 41, ui-10): the first focusable element on the
// SmartRemit-owned public pages and the customer portal. Visually hidden until
// it takes keyboard focus, then pinned top-left. It targets #main, so every
// page that renders it must give its main content id="main".
//
// Deliberately NOT in the root layout: the root layout also wraps the
// white-label /pay/**, /onboard and /partners/apply pages, which have no #main,
// and this fix does not touch them. Neutral colours, no client JS.
export function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[#1c2024] focus:shadow-lg focus:outline-2 focus:outline-offset-2 focus:outline-[#1c2024]"
    >
      Skip to content
    </a>
  );
}
