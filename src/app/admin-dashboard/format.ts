/**
 * Shared money-formatting helper for dashboard server and client components.
 *
 * `currency` defaults to 'USD'. Uses Intl.NumberFormat with the supplied
 * currency code; falls back to `"<amount> <currency>"` for any code that
 * the runtime's Intl implementation doesn't recognise (should never happen
 * for the ISO-4217 codes we use, but keeps us safe).
 */
export function money(amount: number, currency: string = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amount);
  } catch {
    // Unknown currency code — render a plain numeric fallback.
    return `${amount.toFixed(2)} ${currency}`;
  }
}
