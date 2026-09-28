import type { Locale } from '@/lib/i18n';

// Money formatting in one place for new UI. Output equals the customer portal's money() for the
// same inputs (tests/ui-money.test.ts), plus a guard so NaN/Infinity never reach a page.
const LOCALE_TAG: Record<Locale, string> = { en: 'en-US' };

export function formatMoney(amount: number, currency = 'USD', locale: Locale = 'en'): string {
  if (!Number.isFinite(amount)) return '—';
  try {
    return new Intl.NumberFormat(LOCALE_TAG[locale], { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
