// The landing calculator's "to" list (Raj's website brief, Oct 25: widget step 2). Pure and
// server-side: page.tsx resolves the FX legs and passes the result to the client calculator.
// US to India is the launch corridor; every other supported country is "coming next", so its
// button points at the waitlist instead of a send. The send-from country stays the US.
import { DEFAULT_CURRENCY_FOR_COUNTRY, type CountryCode, type CurrencyCode } from '@/lib/types';
import { WAITLIST_DESTINATIONS } from './corridors';

export const LAUNCH_DESTINATION: CountryCode = 'IN';

export interface CalcDestination {
  code: CountryCode;
  name: string;
  currency: CurrencyCode;
  /** 1 USD in this currency (daily reference rate); null ⇒ no figure is shown. */
  rate: number | null;
  launch: boolean;
}

const positive = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * `usdToInr` is the USD leg's toInr (the figure the page already shows). `toUsd(currency)` is that
 * currency's own leg (1 unit → USD), or null when it is unavailable; USD → X is 1 / toUsd(X).
 */
export function calcDestinations(
  usdToInr: number | null,
  toUsd: (currency: CurrencyCode) => number | null,
): CalcDestination[] {
  const out: CalcDestination[] = [];
  for (const d of WAITLIST_DESTINATIONS) {
    const code = d.value as CountryCode;
    if (code === 'US') continue;
    const currency = DEFAULT_CURRENCY_FOR_COUNTRY[code];
    const launch = code === LAUNCH_DESTINATION;
    let rate: number | null = null;
    if (currency === 'INR') {
      rate = positive(usdToInr) ? usdToInr : null;
    } else {
      const leg = toUsd(currency);
      rate = positive(leg) && positive(1 / leg) ? 1 / leg : null;
    }
    out.push({ code, name: d.label, currency, rate, launch });
  }
  return out.sort((a, b) => Number(b.launch) - Number(a.launch));
}
