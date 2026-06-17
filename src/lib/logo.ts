// logo — validate a partner logo value before it is persisted or rendered.
// Partners "upload" a logo: the admin UI reads the chosen image file and submits
// it as a base64 image DATA URI (the existing `logoUrl` field carries it, and the
// CSP already allows `img-src data:` so it renders with no infra). An https URL is
// still accepted for back-compat. Anything else — junk, a non-image data URI, or
// an oversized blob — collapses to undefined so we never store/serve garbage.
//
// SVG note: a logo is set only by an authenticated admin (platform or that
// partner's own admin), and it is rendered exclusively via <img src> — which does
// NOT execute scripts embedded in an SVG — so image/svg+xml is safe to allow.

const DATA_URI = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i;
const HTTPS_URL = /^https:\/\/[^\s]+$/i;

// A 256 KB image base64-encodes to ~350 KB of string; cap a little above that.
// Keeps partner rows (and the pages that inline the data URI) from bloating, and
// stays well under the Next.js server-action body limit.
export const MAX_LOGO_LEN = 512 * 1024;

/**
 * Returns a safe logo value (image data URI or https URL) or undefined. Pure.
 */
export function sanitizeLogoValue(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  if (!v || v.length > MAX_LOGO_LEN) return undefined;
  if (DATA_URI.test(v)) return v;
  if (HTTPS_URL.test(v)) return v;
  return undefined;
}
