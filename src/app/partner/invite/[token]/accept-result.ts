// The result shape of acceptInviteAction and the invite limits (UI redesign M3-9). A 'use server'
// module may export only async functions, so the constants live here.

/** A password problem (shown on the form) or the ONE dead-link result (the client swaps to the dead sheet). */
export type AcceptInviteResult = { ok: false; dead: true } | { ok: false; error: string };

/**
 * The single result for EVERY token-side failure: unknown, malformed, expired, used, revoked, a
 * suspended tenant, an inviter who lost admin rights, a username taken at accept, and the rate
 * limit. Identical by construction, so the response is no oracle.
 */
export const DEAD_INVITE: AcceptInviteResult = Object.freeze({ ok: false as const, dead: true as const });

/** Page renders (GET, peek only) per IP per 60 s: generous (reloads, link previews). */
export const INVITE_PAGE_SCOPE = 'partner-invite';
export const INVITE_PAGE_IP_LIMIT = 30;
/** Accept attempts (POST) per IP per window. Each one may cost an Argon2id hash and an HIBP call. */
export const INVITE_ACCEPT_SCOPE = 'partner-invite-accept';
export const INVITE_ACCEPT_IP_LIMIT = 10;
export const INVITE_ACCEPT_WINDOW_SEC = 10 * 60;
