// Isolated so middleware / server actions can import the cookie name without
// pulling in next/headers or the Redis client. Customer accounts are SEPARATE
// from staff: different cookie, different Redis namespace.
//
// `__Host-` prefix (RFC 6265bis): the browser only sends it over HTTPS, with
// Path=/, and NO Domain attribute — the strongest cookie-scoping the platform
// offers. Set with `Secure; HttpOnly; SameSite=Lax; Path=/` (Lax because the
// WhatsApp link → page navigation is a top-level cross-site GET).
export const CUSTOMER_SESSION_COOKIE = '__Host-sr_session';
