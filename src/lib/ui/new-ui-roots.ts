// The contract every later milestone extends. A new top-level route dir MUST be listed here
// (then it is hex-scanned and state-walked) or in LEGACY_APP_DIRS (frozen: today's dirs only).
export const NEW_UI_ROOTS: readonly string[] = [
  'src/components/ds',
  // Planned roots are PRE-REGISTERED here (the scanners tolerate missing dirs), so the
  // "every src/app dir is classified" test stays green whichever change lands first.
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
