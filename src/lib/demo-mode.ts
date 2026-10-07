import { env } from './env';
import { normalizePhone } from './phone';

// demo-mode — ONE shared phone list decides which customers see new beta
// features (owner decision). DEMO_PHONES: '*' alone ⇒ everyone (development),
// a comma list ⇒ those phones, empty ⇒ falls back to the legacy
// VOICE_NOTES_BETA_PHONES (and empty there too ⇒ nobody). Each feature still has
// its own feature_flags switch; demo mode only narrows WHO sees it.
//
// Phone numbers never leave this module except as the boolean answer:
// demoModeSummary() reports a kind and a count, never the numbers.

/** Is `from` on `list`? Digits are compared; [] ⇒ nobody; only an exact ['*'] ⇒ everyone. Pure. */
export function phoneInList(from: string, list: readonly string[]): boolean {
  const phone = normalizePhone(from);
  if (phone === '') return false;
  if (list.length === 1 && list[0] === '*') return true;
  return list.some((entry) => {
    const digits = normalizePhone(entry);
    return digits !== '' && digits === phone;
  });
}

/** The demo-mode list, read at call time: DEMO_PHONES when non-empty, else the legacy VOICE_NOTES_BETA_PHONES. */
export function demoPhoneList(): readonly string[] {
  const demo = env.demoPhones;
  return demo.length > 0 ? demo : env.voiceNotesBetaPhones;
}

/** Is this phone in demo mode? */
export function inDemo(phone: string, list: readonly string[] = demoPhoneList()): boolean {
  return phoneInList(phone, list);
}

export interface DemoModeSummary {
  kind: 'everyone' | 'list' | 'nobody';
  /** How many phones are listed (0 for everyone / nobody). Never the numbers. */
  count: number;
}

/** A display-safe summary of the demo-mode list (for the switches page). */
export function demoModeSummary(list: readonly string[] = demoPhoneList()): DemoModeSummary {
  if (list.length === 0) return { kind: 'nobody', count: 0 };
  if (list.length === 1 && list[0] === '*') return { kind: 'everyone', count: 0 };
  return { kind: 'list', count: list.length };
}

/** The one read-only line on /admin-dashboard/switches. */
export function demoModeLabel(s: DemoModeSummary): string {
  if (s.kind === 'everyone') return 'Demo mode: everyone';
  if (s.kind === 'nobody') return 'Demo mode: nobody';
  return `Demo mode: ${s.count} ${s.count === 1 ? 'phone' : 'phones'}`;
}
