import { t, type MessageKey } from '@/lib/i18n';
import { mcpResourceUrl } from './contract';
import { CLIENT_ID_RE, issuerFor } from './config';
import { authorizeQueryString, checkAuthorizeRequest, readAuthorizeParams, type AuthorizeParams } from './authorize-request';
import { authorizeCsp } from './authorize-csp';
import { renderConsentPage, renderMessagePage } from './consent-page';
import { redirectOriginOf } from './redirect-uri';
import { newAgentId } from './secrets';
import type { AgentServerDeps, HostCtx } from './server';

// /oauth/authorize (Stage C1 spec item 3): the customer-facing half of the AI-agent sign-in.
//
// GET  validates the request, then reuses the PORTAL sign-in: no session → /portal/login?next=,
//      a session whose last WhatsApp-code proof (and TOTP, when enrolled) is older than the
//      15-minute step-up window → /portal/verify?next= (the same OTP, MFA, lockouts and
//      enumeration safety as the portal); then the gate (switch AND demo-mode phone); then the
//      consent screen. The validated request goes into a single-use server-side ticket, so the
//      form carries nothing but the ticket and the decision.
// POST is the Allow / Deny form: same-origin only (Origin must be this host), the ticket must
//      belong to THIS session, the session must still be fresh and the gate still open. Allow
//      mints a single-use authorization code; both answers 303 back to the app's validated
//      redirect_uri with `state` and `iss` (RFC 9207).
//
// Every response carries its own CSP (next.config.ts leaves this path out of the site header):
// the site policy, plus the validated redirect origin in form-action on the consent page only.

export interface AgentSession {
  /** The session's phone (digits). */
  phone: string;
  /** The portal session id (the consent ticket is bound to it). */
  sid: string;
  /** isPortalSessionFresh: the 15-minute step-up rule. */
  fresh: boolean;
}

export interface AuthorizeDeps extends AgentServerDeps {
  /** The signed-in portal customer on THIS host, or null. */
  session(): Promise<AgentSession | null>;
  isDev: boolean;
}

const HTML = 'text/html; charset=utf-8';

function html(body: string, status: number, csp: string): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': HTML, 'Cache-Control': 'no-store', 'Content-Security-Policy': csp, 'Referrer-Policy': 'no-referrer' },
  });
}

function messagePage(kind: 'unavailable' | 'badRequest' | 'expired' | 'busy', status: number, deps: AuthorizeDeps): Response {
  const keys: Record<typeof kind, [MessageKey, MessageKey]> = {
    unavailable: ['agent.page.unavailableTitle', 'agent.page.unavailableBody'],
    badRequest: ['agent.page.badRequestTitle', 'agent.page.badRequestBody'],
    expired: ['agent.page.expiredTitle', 'agent.page.expiredBody'],
    busy: ['agent.page.busyTitle', 'agent.page.busyBody'],
  };
  const [title, body] = keys[kind];
  return html(renderMessagePage({ title: t(title), body: t(body) }), status, authorizeCsp(null, deps.isDev));
}

function see(location: string, deps: AuthorizeDeps): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: location, 'Cache-Control': 'no-store', 'Content-Security-Policy': authorizeCsp(null, deps.isDev), 'Referrer-Policy': 'no-referrer' },
  });
}

/** The app's redirect_uri with the response parameters (RFC 6749 §4.1.2 + RFC 9207 iss). */
function backToApp(redirectUri: string, params: Record<string, string | null>, ctx: HostCtx): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  u.searchParams.set('iss', issuerFor(ctx.host));
  return u.toString();
}

const nextPathOf = (p: AuthorizeParams) => `/oauth/authorize?${authorizeQueryString(p)}`;

export async function handleAuthorizeGet(req: Request, ctx: HostCtx, deps: AuthorizeDeps): Promise<Response> {
  if (await deps.limited('authorize', req)) return messagePage('busy', 429, deps);
  // The switch first: with it off nothing else is looked at (no oracle about the client or phone).
  if (!(await deps.toolsOn(ctx.partnerId))) return messagePage('unavailable', 403, deps);

  const p = readAuthorizeParams(new URL(req.url).searchParams);
  if (!p) return messagePage('badRequest', 400, deps);
  const client = p.clientId !== null && CLIENT_ID_RE.test(p.clientId) ? await deps.repo.getClient(ctx.partnerId, p.clientId) : null;
  const check = checkAuthorizeRequest(p, { client, resource: mcpResourceUrl(ctx.host) });
  if (!check.ok && check.kind === 'show') return messagePage('badRequest', 400, deps);
  if (!check.ok) return see(backToApp(check.redirectUri, { error: check.error, state: check.state }, ctx), deps);

  const next = encodeURIComponent(nextPathOf(p));
  const session = await deps.session();
  if (!session) return see(`/portal/login?next=${next}`, deps);
  if (!session.fresh) return see(`/portal/verify?next=${next}`, deps);
  if (!(await deps.gateOpen(ctx.partnerId, session.phone))) return messagePage('unavailable', 403, deps);

  const { req: ok } = check;
  const ticket = await deps.store.issueConsent({
    partnerId: ctx.partnerId,
    phone: session.phone,
    sid: session.sid,
    clientId: ok.clientId,
    redirectUri: ok.redirectUri,
    codeChallenge: ok.codeChallenge,
    resource: ok.resource,
    scopes: ok.scopes,
    state: ok.state,
  });
  const origin = redirectOriginOf(ok.redirectUri);
  const page = renderConsentPage({ clientName: client!.name, ticket, returnHost: new URL(ok.redirectUri).host });
  return html(page, 200, authorizeCsp(origin, deps.isDev));
}

export async function handleAuthorizePost(req: Request, ctx: HostCtx, deps: AuthorizeDeps): Promise<Response> {
  if (await deps.limited('authorize', req)) return messagePage('busy', 429, deps);
  // CSRF: the consent form is same-origin; browsers send Origin on every form POST.
  if (req.headers.get('origin') !== issuerFor(ctx.host)) return messagePage('badRequest', 403, deps);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return messagePage('badRequest', 400, deps);
  }
  const ticket = form.get('ticket');
  const decision = form.get('decision');
  if (typeof ticket !== 'string' || (decision !== 'allow' && decision !== 'deny')) return messagePage('badRequest', 400, deps);

  const session = await deps.session();
  if (!session) return messagePage('expired', 400, deps);
  const rec = await deps.store.takeConsent(ticket);
  if (!rec || rec.partnerId !== ctx.partnerId || rec.sid !== session.sid || rec.phone !== session.phone) return messagePage('expired', 400, deps);

  if (decision === 'deny') return see(backToApp(rec.redirectUri, { error: 'access_denied', state: rec.state }, ctx), deps);

  // Allow: the same checks as the GET, again (the ticket may be up to 10 minutes old).
  const params: AuthorizeParams = {
    responseType: 'code',
    clientId: rec.clientId,
    redirectUri: rec.redirectUri,
    codeChallenge: rec.codeChallenge,
    codeChallengeMethod: 'S256',
    scope: rec.scopes.join(' '),
    state: rec.state,
    resource: rec.resource,
  };
  if (!session.fresh) return see(`/portal/verify?next=${encodeURIComponent(nextPathOf(params))}`, deps);
  if (!(await deps.gateOpen(ctx.partnerId, session.phone))) return messagePage('unavailable', 403, deps);
  const client = await deps.repo.getClient(ctx.partnerId, rec.clientId);
  if (!client || !client.redirectUris.includes(rec.redirectUri) || rec.resource !== mcpResourceUrl(ctx.host)) return messagePage('badRequest', 400, deps);

  const code = await deps.store.issueCode({
    partnerId: ctx.partnerId,
    phone: session.phone,
    clientId: rec.clientId,
    redirectUri: rec.redirectUri,
    codeChallenge: rec.codeChallenge,
    resource: rec.resource,
    scopes: rec.scopes,
    grantId: newAgentId('agg_'),
  });
  return see(backToApp(rec.redirectUri, { code, state: rec.state }, ctx), deps);
}
