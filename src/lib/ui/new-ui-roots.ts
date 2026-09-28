// The contract every later milestone extends. A new top-level route dir MUST be listed here
// (then it is hex-scanned and state-walked) or in LEGACY_APP_DIRS (frozen: today's dirs only).
export const NEW_UI_ROOTS: readonly string[] = [
  'src/components/ds',
  // Review round 1: M4's roots are PRE-REGISTERED here (the scanners tolerate missing dirs), so neither plan
  // goes red on the "every src/app dir is classified" test whichever merges first. M4's src/components/site
  // is scanned by M4's own grep test.
  'src/app/docs-next',
  'src/app/trust',
  // M2/M3 append their roots here, e.g. 'src/app/partner'.
];
/** Frozen @ 96c8933. Never add to this list. */
export const LEGACY_APP_DIRS: readonly string[] = [
  'about', 'account', 'admin-dashboard', 'api', 'docs', 'landing', 'legal', 'login',
  'onboard', 'partners', 'pay', 'privacy', 'terms',
];
/** Files allowed to carry hex (each needs a reason). */
export const HEX_EXEMPT_FILES: readonly string[] = [];
/** New route dirs exempt from the loading/error rule (static, data-free pages only; each needs a reason). */
export const STATE_EXEMPT_DIRS: readonly string[] = [];
