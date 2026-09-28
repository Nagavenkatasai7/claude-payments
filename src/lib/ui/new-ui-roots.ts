// The contract every later milestone extends. A new top-level route dir MUST be listed here
// (then it is hex-scanned and state-walked) or in LEGACY_APP_DIRS (frozen: today's dirs only).
// Only TOP-LEVEL src/app dirs are auto-checked for classification. A new route nested under a
// legacy dir (e.g. a new segment inside src/app/account/) is NOT scanned unless its path is
// registered here explicitly (e.g. 'src/app/account/<new-segment>').
export const NEW_UI_ROOTS: readonly string[] = [
  'src/components/ds',
  // The shared public-site shell (SiteHeader / SiteFooter / SiteShell).
  'src/components/site',
  // The code-backed MDX blocks the /docs-next guides render (M4 PR-3).
  'src/components/docs',
  // Planned roots are PRE-REGISTERED here (the scanners tolerate missing dirs), so the
  // "every src/app dir is classified" test stays green whichever change lands first.
  'src/app/docs-next',
  'src/app/trust',
  'src/app/partner', // the partner app (hex-scanned and state-walked)
  // PR5: the generic inactive-site sheet a partner subdomain shows for an unknown/disabled slug.
  'src/app/site-inactive',
  // M2-5: the customer portal on partner subdomains (hex-scanned and state-walked).
  'src/app/portal',
  // M2/M3 append their roots here, e.g. 'src/app/partner'.
];
/** Frozen @ 96c8933. Never add to this list. */
export const LEGACY_APP_DIRS: readonly string[] = [
  'about', 'account', 'admin-dashboard', 'api', 'docs', 'landing', 'legal', 'login',
  'onboard', 'partners', 'pay', 'privacy', 'terms',
];
/** Files allowed to carry hex (each needs a reason). */
export const HEX_EXEMPT_FILES: readonly string[] = [
  // Mirrors the legacy dark pay dead-link sheet byte for byte (no oracle between the two) until H2
  // moves the pay page to the landing look and dedupes the sheet.
  'src/app/site-inactive/page.tsx',
];
/** New route dirs exempt from the loading/error rule (static, data-free pages only; each needs a reason). */
export const STATE_EXEMPT_DIRS: readonly string[] = [
  // Static, prerendered, data-free (a loading boundary hides content without JS and flashes a
  // skeleton): the prerendered HTML would put the page in <div hidden id="S:0"> behind the
  // skeleton until React's inline reveal script runs. error.tsx is still required and present.
  'src/app/docs-next',
  'src/app/docs-next/[slug]',
  // A static, data-free page: nothing to load and nothing that can fail.
  'src/app/site-inactive',
];
