/**
 * portal-device-label — the label the customer portal's Devices page shows for
 * a session (UI redesign M2-2, Task 2.2).
 *
 * The output is ALWAYS a member of a closed set built from fixed browser and OS
 * words. The raw User-Agent (and the IP) is never stored or echoed, so a session
 * record carries no fingerprint and a hostile UA cannot inject text into a page.
 *
 * Pure and dependency-free: safe to import anywhere.
 */

const BROWSERS = ['Samsung Internet', 'Edge', 'Firefox', 'Chrome', 'Safari'] as const;
const SYSTEMS = ['iPad', 'iPhone', 'Android', 'Windows', 'macOS', 'Linux'] as const;
type Browser = (typeof BROWSERS)[number];
type System = (typeof SYSTEMS)[number];

export const UNKNOWN_DEVICE = 'Unknown device';

/**
 * Every label deviceLabel can return:
 * - `<Browser> on <OS>` for a recognised pair,
 * - `<Browser>` when only the browser is recognised,
 * - `Browser on <OS>` when only the OS is recognised,
 * - `Unknown device` otherwise.
 */
export const DEVICE_LABELS: readonly string[] = Object.freeze([
  ...BROWSERS.flatMap((b) => SYSTEMS.map((o) => `${b} on ${o}`)),
  ...BROWSERS,
  ...SYSTEMS.map((o) => `Browser on ${o}`),
  UNKNOWN_DEVICE,
]);
const LABEL_SET: ReadonlySet<string> = new Set(DEVICE_LABELS);

/** True only for a member of the closed label set. */
export function isDeviceLabel(value: unknown): value is string {
  return typeof value === 'string' && LABEL_SET.has(value);
}

// Order matters: Samsung Internet and Edge also carry "Chrome"; Chrome also carries "Safari".
const BROWSER_TESTS: ReadonlyArray<[RegExp, Browser]> = [
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bFirefox\b|\bFxiOS\//, 'Firefox'],
  [/\bChrome\b|\bCriOS\/|\bChromium\//, 'Chrome'],
  [/\bSafari\b/, 'Safari'],
];

// Order matters: iPhone/iPad agents say "like Mac OS X"; Android agents say "Linux".
const SYSTEM_TESTS: ReadonlyArray<[RegExp, System]> = [
  [/\biPad\b/, 'iPad'],
  [/\biPhone\b|\biPod\b/, 'iPhone'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b|\bX11\b/, 'Linux'],
];

/** The User-Agent header can be arbitrarily long; only its start is ever inspected. */
const MAX_UA_INSPECT = 512;

/** Map a User-Agent to a closed-set label. Never returns any part of the input. */
export function deviceLabel(userAgent: string | null | undefined): string {
  if (typeof userAgent !== 'string' || userAgent === '') return UNKNOWN_DEVICE;
  const ua = userAgent.slice(0, MAX_UA_INSPECT);
  const browser = BROWSER_TESTS.find(([re]) => re.test(ua))?.[1];
  const system = SYSTEM_TESTS.find(([re]) => re.test(ua))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  if (browser) return browser;
  if (system) return `Browser on ${system}`;
  return UNKNOWN_DEVICE;
}
