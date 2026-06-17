import type { CountryCode, CurrencyCode, Partner } from './types';
import { DEFAULT_CURRENCY_FOR_COUNTRY } from './types';
import { QuoteError } from './fx';

// Calling-code prefix → CountryCode (greedy longest-match: 971 before 9, etc.).
const CALLING_CODE_TO_COUNTRY: Record<string, CountryCode> = {
  '1': 'US', '44': 'GB', '971': 'AE', '61': 'AU', '64': 'NZ', '65': 'SG', '91': 'IN',
};

/** Best-effort CountryCode from a normalized (digits-only) sender phone. undefined if unknown. */
export function countryForPhone(normalizedPhone: string): CountryCode | undefined {
  if (!normalizedPhone || !/^\d+$/.test(normalizedPhone)) return undefined;
  for (let len = 3; len >= 1; len--) {
    const country = CALLING_CODE_TO_COUNTRY[normalizedPhone.slice(0, len)];
    if (country) return country;
  }
  return undefined;
}

/** Best-effort DESTINATION CountryCode from a normalized (digits-only) RECIPIENT
 *  phone (any-to-any: e.g. recipient '15551234567'→US, '919876543210'→IN). undefined
 *  when the calling code is unknown/absent (a bare local number) ⇒ the agent asks. */
export function destinationCountryForRecipientPhone(normalizedPhone: string): CountryCode | undefined {
  return countryForPhone(normalizedPhone);
}

/** Best-effort send currency from a normalized (digits-only) sender phone.
 *  e.g. '15551234567'→USD, '971501234567'→AED, '447911123456'→GBP. undefined if unknown.
 *  '+1' is heuristically US (NANP ambiguity accepted). */
export function currencyForPhone(normalizedPhone: string): CurrencyCode | undefined {
  const country = countryForPhone(normalizedPhone);
  return country ? DEFAULT_CURRENCY_FOR_COUNTRY[country] : undefined;
}

const CURRENCY_TO_COUNTRY = Object.fromEntries(
  Object.entries(DEFAULT_CURRENCY_FOR_COUNTRY).map(([country, cur]) => [cur, country]),
) as Record<CurrencyCode, CountryCode>;

export function countryForCurrency(c: CurrencyCode): CountryCode {
  const country = CURRENCY_TO_COUNTRY[c];
  if (!country) throw new QuoteError(`Unsupported currency: ${c}.`);
  return country;
}

// Send currencies = the partner's operating countries mapped to home currency,
// de-duplicated, stable order. ['US'] → ['USD']. Any-to-any: India (INR) is now a
// valid SOURCE too (a sender in India can send out), so it is NO LONGER excluded.
export function allowedSendCurrencies(partner: Partner): CurrencyCode[] {
  const seen = new Set<CurrencyCode>();
  const out: CurrencyCode[] = [];
  for (const country of partner.countries) {
    const cur = DEFAULT_CURRENCY_FOR_COUNTRY[country];
    if (!seen.has(cur)) {
      seen.add(cur);
      out.push(cur);
    }
  }
  if (out.length === 0) out.push('USD'); // safety net for a partner with no countries
  return out;
}

// The single authority for a transfer's currency. The LLM-supplied value is
// untrusted: on the single-currency (dormant) path it is ignored entirely.
export function resolveSendCurrency(partner: Partner, requested?: string, senderPhone?: string): CurrencyCode {
  const allowed = allowedSendCurrencies(partner);
  if (allowed.length === 1) return allowed[0];
  const req = (requested ?? '').trim().toUpperCase();
  const match = allowed.find((c) => c === req);
  if (match) return match;
  if (senderPhone) {
    const phoneCurr = currencyForPhone(senderPhone);
    if (phoneCurr && allowed.includes(phoneCurr)) return phoneCurr;
  }
  throw new QuoteError(`Please tell me which currency you're sending: ${allowed.join(', ')}.`);
}
