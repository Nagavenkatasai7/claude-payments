import type { CountryCode, CurrencyCode, PartnerId } from './types';

export const DEFAULT_SENDER_COUNTRY: CountryCode = 'US';
export const DEFAULT_SOURCE_COUNTRY: CountryCode = 'US';
export const DEFAULT_SOURCE_CURRENCY: CurrencyCode = 'USD';
export const DEFAULT_DESTINATION_COUNTRY: CountryCode = 'IN';
export const DEFAULT_DESTINATION_CURRENCY: CurrencyCode = 'INR';
export const DEFAULT_PARTNER_ID: PartnerId = 'default';   // NEW (P2)

// Any-to-any: the platform's own default tenant serves senders from every
// supported source country whose calling code is UNAMBIGUOUS (so a sender's
// currency is auto-detected from their number instead of collapsing to USD).
// 'CA' is deliberately EXCLUDED: Canada shares the +1 NANP code with the US, so
// a Canadian number can't be distinguished from a US one — CAD would be
// unreachable by phone detection. A partner that genuinely serves Canada can
// still configure 'CA' explicitly. White-label partners scope to their own
// `countries`.
export const DEFAULT_PARTNER_COUNTRIES: CountryCode[] = ['US', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN', 'HK'];
