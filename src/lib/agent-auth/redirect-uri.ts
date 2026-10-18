import { AGENT_REDIRECT_URI_MAX } from './config';

// Redirect URIs an AI app may register (Stage C1 spec item 6): https, or http on the loopback
// names localhost / 127.0.0.1 (local tools such as the MCP Inspector). No fragment, no userinfo,
// no whitespace or control characters, at most AGENT_REDIRECT_URI_MAX characters. The string is
// kept exactly as registered: the authorize and token endpoints compare it EXACTLY.

const LOOPBACK = new Set(['localhost', '127.0.0.1']);

export function checkRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > AGENT_REDIRECT_URI_MAX) return false;
  // Printable ASCII only (no space, no control, no non-ASCII), and never a fragment.
  if (!/^[\x21-\x7E]+$/.test(raw) || raw.includes('#') || raw.includes('\\')) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username !== '' || u.password !== '' || u.hostname === '') return false;
  if (!raw.toLowerCase().startsWith(`${u.protocol}//`)) return false; // e.g. "https:example.com"
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname);
  return false;
}

/** The origin (scheme://host[:port]) a validated redirect URI sends the browser to. */
export function redirectOriginOf(uri: string): string {
  return new URL(uri).origin;
}
