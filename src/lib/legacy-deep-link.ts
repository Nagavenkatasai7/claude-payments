// legacy-deep-link — old /account receipt and ticket links for signed-out visitors (lost-features C2).
//
// Ticket nudges sent before the one customer portal point at /account/support/<tk_id>; bookmarks and
// older bot messages point at /account/receipt/<id>. The proxy cannot know which partner such a link
// belongs to, so a signed-out request for one is sent to /account/continue/<kind>/<id>, a public route
// that reads only the row's partner and forwards to that partner's portal sign-in.
//
// PURE and import-free: the proxy runs it. Exact shapes only (the same id sets as the portal's
// PORTAL_TRANSFER_ID_RE and PORTAL_TICKET_ID_RE); anything else is null.

export type LegacyLinkKind = 'receipt' | 'support';
export interface LegacyLinkTarget {
  kind: LegacyLinkKind;
  id: string;
}

const ID_RE: Record<LegacyLinkKind, RegExp> = {
  receipt: /^[A-Za-z0-9_-]{6,64}$/,
  support: /^tk_[A-Za-z0-9_-]{1,64}$/,
};

const LEGACY_RE = /^\/account\/(receipt|support)\/([^/]+)$/;

/** The receipt or ticket a legacy /account path names, or null. */
export function legacyDeepLink(pathname: string): LegacyLinkTarget | null {
  const m = LEGACY_RE.exec(pathname);
  return m ? parseContinueTarget(m[1], m[2]) : null;
}

/** Route params of /account/continue/<kind>/<id>, validated with the same rules, or null. */
export function parseContinueTarget(kind: unknown, id: unknown): LegacyLinkTarget | null {
  if (kind !== 'receipt' && kind !== 'support') return null;
  return typeof id === 'string' && ID_RE[kind].test(id) ? { kind, id } : null;
}

/** The public continue route for a target. */
export function continuePath(t: LegacyLinkTarget): string {
  return `/account/continue/${t.kind}/${t.id}`;
}

/** The portal page that replaced the legacy one. */
export function portalPathFor(t: LegacyLinkTarget): `/portal${string}` {
  return t.kind === 'receipt' ? `/portal/transfers/${t.id}` : `/portal/help/tickets/${t.id}`;
}
