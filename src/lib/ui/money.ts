import type { Locale } from '@/lib/i18n';

// Money formatting in one place for new UI. Output equals the customer portal's money() for the
// same inputs (tests/ui-money.test.ts), plus a guard so NaN/Infinity never reach a page.
const LOCALE_TAG: Record<Locale, string> = { en: 'en-US' };

export function formatMoney(amount: number, currency = 'USD', locale: Locale = 'en'): string {
  if (!Number.isFinite(amount)) return '—';
  // An amount that rounds to zero (including -0) renders as plain zero, never "-$0.00".
  const zeroIfRoundsAway = (digits: number) => (Math.abs(amount) < 0.5 * 10 ** -digits ? 0 : amount);
  try {
    const fmt = new Intl.NumberFormat(LOCALE_TAG[locale], { style: 'currency', currency });
    return fmt.format(zeroIfRoundsAway(fmt.resolvedOptions().maximumFractionDigits ?? 2));
  } catch {
    return `${zeroIfRoundsAway(2).toFixed(2)} ${currency}`;
  }
}
