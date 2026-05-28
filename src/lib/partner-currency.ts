import type { CountryCode, CurrencyCode, Partner } from './types';
import { DEFAULT_CURRENCY_FOR_COUNTRY } from './types';
import { QuoteError } from './fx';

const CURRENCY_TO_COUNTRY = Object.fromEntries(
  Object.entries(DEFAULT_CURRENCY_FOR_COUNTRY).map(([country, cur]) => [cur, country]),
) as Record<CurrencyCode, CountryCode>;

export function countryForCurrency(c: CurrencyCode): CountryCode {
  return CURRENCY_TO_COUNTRY[c];
}

// Send currencies = the partner's operating countries minus payout-side IN,
// mapped to home currency, de-duplicated, stable order. ['US'] → ['USD'].
export function allowedSendCurrencies(partner: Partner): CurrencyCode[] {
  const seen = new Set<CurrencyCode>();
  const out: CurrencyCode[] = [];
  for (const country of partner.countries) {
    if (country === 'IN') continue; // payout-side only in v1
    const cur = DEFAULT_CURRENCY_FOR_COUNTRY[country];
    if (!seen.has(cur)) {
      seen.add(cur);
      out.push(cur);
    }
  }
  if (out.length === 0) out.push('USD'); // safety net for a partner with no send countries
  return out;
}

// The single authority for a transfer's currency. The LLM-supplied value is
// untrusted: on the single-currency (dormant) path it is ignored entirely.
export function resolveSendCurrency(partner: Partner, requested?: string): CurrencyCode {
  const allowed = allowedSendCurrencies(partner);
  if (allowed.length === 1) return allowed[0];
  const req = (requested ?? '').trim().toUpperCase();
  const match = allowed.find((c) => c === req);
  if (!match) {
    throw new QuoteError(
      `Please tell me which currency you're sending: ${allowed.join(', ')}.`,
    );
  }
  return match;
}
