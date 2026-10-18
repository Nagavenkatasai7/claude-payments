import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildCsp } from '@/lib/csp';
import { isCodeChallenge, isCodeVerifier, verifyPkceS256 } from '@/lib/agent-auth/pkce';
import { checkRedirectUri, redirectOriginOf } from '@/lib/agent-auth/redirect-uri';
import { parseClientRegistration } from '@/lib/agent-auth/registration';
import {
  authorizeQueryString,
  checkAuthorizeRequest,
  readAuthorizeParams,
  safeAuthorizeNext,
  type AuthorizeParams,
} from '@/lib/agent-auth/authorize-request';
import { authorizeCsp } from '@/lib/agent-auth/authorize-csp';
import { renderConsentPage, renderMessagePage } from '@/lib/agent-auth/consent-page';
import { authorizationServerMetadata, protectedResourceMetadata, issuerFor, parseScope } from '@/lib/agent-auth/config';
import { agentSecretHash } from '@/lib/agent-auth/secrets';

// Stage C1 (agent sign-in): the pure helpers of the OAuth 2.1 authorization server. Each is a
// rule the route handlers rely on, so each is pinned here on its own.

const b64url = (b: Buffer) => b.toString('base64url');
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = b64url(createHash('sha256').update(VERIFIER).digest());
const HOST = 'send.smartremit.ai';
const RESOURCE = 'https://send.smartremit.ai/api/mcp';
const CLIENT = { id: 'agc_AAAAAAAAAAAAAAAAAAAAAA', redirectUris: ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:33418/callback'] };

function params(over: Partial<AuthorizeParams> = {}): AuthorizeParams {
  return {
    responseType: 'code',
    clientId: CLIENT.id,
    redirectUri: CLIENT.redirectUris[0],
    codeChallenge: CHALLENGE,
    codeChallengeMethod: 'S256',
    scope: null,
    state: 'xyz',
    resource: RESOURCE,
    ...over,
  };
}

describe('PKCE (S256 only)', () => {
  it('the RFC 7636 appendix B vector verifies', () => {
    expect(CHALLENGE).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(verifyPkceS256(VERIFIER, CHALLENGE)).toBe(true);
  });
  it('a wrong verifier fails', () => expect(verifyPkceS256(`${VERIFIER.slice(0, -1)}Y`, CHALLENGE)).toBe(false));
  it('a missing or malformed verifier fails without throwing', () => {
    expect(verifyPkceS256('', CHALLENGE)).toBe(false);
    expect(verifyPkceS256(undefined as unknown as string, CHALLENGE)).toBe(false);
    expect(verifyPkceS256('short', CHALLENGE)).toBe(false);
    expect(verifyPkceS256(VERIFIER, 'not-a-challenge')).toBe(false);
  });
  it('the plain method is never accepted: verifier === challenge fails', () => {
    const v = 'a'.repeat(43);
    expect(verifyPkceS256(v, v)).toBe(false);
  });
  it('shape checks', () => {
    expect(isCodeChallenge(CHALLENGE)).toBe(true);
    expect(isCodeChallenge(`${CHALLENGE}=`)).toBe(false);
    expect(isCodeVerifier(VERIFIER)).toBe(true);
    expect(isCodeVerifier('a'.repeat(42))).toBe(false);
    expect(isCodeVerifier('a'.repeat(129))).toBe(false);
    expect(isCodeVerifier(`${'a'.repeat(43)} `)).toBe(false);
  });
});

describe('redirect URIs', () => {
  it.each(['https://claude.ai/api/mcp/auth_callback', 'https://chatgpt.com/connector_platform_oauth_redirect', 'http://localhost:6274/oauth/callback',
    'http://127.0.0.1:33418/callback', 'http://localhost/cb', 'https://app.example.com/cb?x=1'])('%s is accepted', (u) => expect(checkRedirectUri(u)).toBe(true));
  it.each(['http://example.com/cb', 'https://example.com/cb#frag', 'https://user:pw@example.com/cb', 'javascript:alert(1)', 'myapp://cb',
    'http://localhost.evil.com/cb', 'http://127.0.0.2/cb', '//example.com/cb', '/cb', '', 'https://exa mple.com/cb', 'https://example.com/\ncb',
    `https://example.com/${'a'.repeat(600)}`, 42, null, 'http://[::1]:3000/cb'])('%s is refused', (u) => expect(checkRedirectUri(u)).toBe(false));
  it('the origin is the scheme, host and port', () => {
    expect(redirectOriginOf('https://claude.ai/api/mcp/auth_callback')).toBe('https://claude.ai');
    expect(redirectOriginOf('http://localhost:33418/callback')).toBe('http://localhost:33418');
  });
});

describe('dynamic client registration (RFC 7591)', () => {
  const ok = { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude', token_endpoint_auth_method: 'none' };
  it('a public client', () => {
    expect(parseClientRegistration(ok)).toEqual({
      ok: true,
      value: { name: 'Claude', redirectUris: ['https://claude.ai/api/mcp/auth_callback'], authMethod: 'none' },
    });
  });
  it('the RFC default auth method is client_secret_basic (a confidential client)', () => {
    const r = parseClientRegistration({ redirect_uris: ok.redirect_uris });
    expect(r).toEqual({ ok: true, value: { name: '', redirectUris: ok.redirect_uris, authMethod: 'client_secret_basic' } });
  });
  it.each([
    [{ ...ok, redirect_uris: [] }, 'invalid_redirect_uri'],
    [{ ...ok, redirect_uris: undefined }, 'invalid_redirect_uri'],
    [{ ...ok, redirect_uris: ['http://evil.example/cb'] }, 'invalid_redirect_uri'],
    [{ ...ok, redirect_uris: Array.from({ length: 6 }, (_, i) => `https://a.example/${i}`) }, 'invalid_redirect_uri'],
    [{ ...ok, redirect_uris: ['https://a.example/cb#x'] }, 'invalid_redirect_uri'],
    [{ ...ok, client_name: 'x'.repeat(61) }, 'invalid_client_metadata'],
    [{ ...ok, client_name: 'Bad‮name' }, 'invalid_client_metadata'],
    [{ ...ok, client_name: 'line\nbreak' }, 'invalid_client_metadata'],
    [{ ...ok, client_name: 7 }, 'invalid_client_metadata'],
    [{ ...ok, token_endpoint_auth_method: 'private_key_jwt' }, 'invalid_client_metadata'],
    [{ ...ok, grant_types: ['client_credentials'] }, 'invalid_client_metadata'],
    [{ ...ok, response_types: ['token'] }, 'invalid_client_metadata'],
    [{ ...ok, scope: 'transfers:prepare' }, 'invalid_client_metadata'],
    [null, 'invalid_client_metadata'],
    [[ok], 'invalid_client_metadata'],
  ] as const)('refuses %j with %s', (body, error) => {
    const r = parseClientRegistration(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(error);
  });
  it('dedupes redirect URIs and trims the name', () => {
    const r = parseClientRegistration({ ...ok, client_name: '  My app  ', redirect_uris: [ok.redirect_uris[0], ok.redirect_uris[0]] });
    expect(r).toMatchObject({ ok: true, value: { name: 'My app', redirectUris: ok.redirect_uris } });
  });
  it('accepts the grant and response types it supports', () => {
    expect(parseClientRegistration({ ...ok, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'quotes:read transfers:read' }).ok).toBe(true);
  });
});

describe('the authorize request', () => {
  const check = (p: AuthorizeParams, client: typeof CLIENT | null = CLIENT) => checkAuthorizeRequest(p, { client, resource: RESOURCE });

  it('a good request, default scope = all three', () => {
    const r = check(params());
    expect(r).toEqual({
      ok: true,
      req: { clientId: CLIENT.id, redirectUri: CLIENT.redirectUris[0], codeChallenge: CHALLENGE, scopes: ['quotes:read', 'recipients:read', 'transfers:read'], state: 'xyz', resource: RESOURCE },
    });
  });
  it('an unknown client or a redirect_uri mismatch is SHOWN, never redirected (no open redirect)', () => {
    expect(check(params(), null)).toEqual({ ok: false, kind: 'show', error: 'invalid_client' });
    expect(check(params({ redirectUri: 'https://evil.example/cb' }))).toEqual({ ok: false, kind: 'show', error: 'invalid_redirect_uri' });
    expect(check(params({ redirectUri: 'https://claude.ai/api/mcp/auth_callback/' }))).toEqual({ ok: false, kind: 'show', error: 'invalid_redirect_uri' });
    expect(check(params({ redirectUri: null }))).toEqual({ ok: false, kind: 'show', error: 'invalid_redirect_uri' });
    expect(check(params({ clientId: 'agc_other' }))).toEqual({ ok: false, kind: 'show', error: 'invalid_client' });
  });
  it.each([
    [{ responseType: 'token' }, 'unsupported_response_type'],
    [{ codeChallenge: null }, 'invalid_request'],
    [{ codeChallenge: 'short' }, 'invalid_request'],
    [{ codeChallengeMethod: 'plain' }, 'invalid_request'],
    [{ codeChallengeMethod: null }, 'invalid_request'],
    [{ scope: 'transfers:prepare' }, 'invalid_scope'],
    [{ scope: '' }, 'invalid_scope'],
    [{ resource: null }, 'invalid_target'],
    [{ resource: 'https://acme.smartremit.ai/api/mcp' }, 'invalid_target'],
    [{ resource: 'https://send.smartremit.ai/api/mcp/' }, 'invalid_target'],
    [{ state: 'x'.repeat(513) }, 'invalid_request'],
  ] as const)('%j redirects back with %s', (over, error) => {
    const r = check(params(over as Partial<AuthorizeParams>));
    expect(r).toMatchObject({ ok: false, kind: 'redirect', error, redirectUri: CLIENT.redirectUris[0] });
  });
  it('a narrower scope is kept, deduped, in canonical order', () => {
    const r = check(params({ scope: 'transfers:read quotes:read transfers:read' }));
    expect(r.ok && r.req.scopes).toEqual(['quotes:read', 'transfers:read']);
  });
  it('a duplicated parameter is refused', () => {
    expect(readAuthorizeParams(new URLSearchParams('client_id=a&client_id=b'))).toBeNull();
    expect(readAuthorizeParams(new URLSearchParams('client_id=a&state=s'))).toMatchObject({ clientId: 'a', state: 's', redirectUri: null });
  });
});

describe('safeAuthorizeNext (the sign-in return path)', () => {
  const good = `/oauth/authorize?${authorizeQueryString(params())}`;
  it('a well-formed authorize path is kept (canonical)', () => {
    expect(safeAuthorizeNext(good)).toBe(good);
    expect(good).toContain('resource=https%3A%2F%2Fsend.smartremit.ai%2Fapi%2Fmcp');
  });
  it.each([
    '/oauth/authorize',
    '/oauth/authorize?',
    `/oauth/authorizex?${authorizeQueryString(params())}`,
    `//evil.example/oauth/authorize?${authorizeQueryString(params())}`,
    `https://evil.example/oauth/authorize?${authorizeQueryString(params())}`,
    `${good}#frag`,
    `${good}&evil=1`,
    `${good}&state=again`,
    `${good}\\x`,
    `${good} `,
    `/oauth/authorize?${authorizeQueryString(params({ responseType: 'token' }))}`,
    `/oauth/authorize?${authorizeQueryString(params({ codeChallengeMethod: 'plain' }))}`,
    `/oauth/authorize?${authorizeQueryString(params({ clientId: 'not an id' }))}`,
    `/oauth/authorize?${authorizeQueryString(params({ state: 'x'.repeat(600) }))}`,
    `/oauth/authorize?${'a'.repeat(5000)}`,
    null,
    42,
  ])('%s → null', (v) => expect(safeAuthorizeNext(v)).toBeNull());
});

describe('the authorize page CSP (form-action trap)', () => {
  const base = buildCsp({ isDev: false });
  it('allows exactly self + the validated redirect origin in form-action, nothing else changes', () => {
    const csp = authorizeCsp('https://claude.ai', false);
    expect(csp).toBe(base.replace("form-action 'self'", "form-action 'self' https://claude.ai"));
    expect(csp.match(/form-action [^;]+/)?.[0]).toBe("form-action 'self' https://claude.ai");
  });
  it('a loopback origin with a port', () => {
    expect(authorizeCsp('http://127.0.0.1:33418', false)).toContain("form-action 'self' http://127.0.0.1:33418");
  });
  it.each([null, '', 'https://claude.ai/cb', "https://claude.ai 'unsafe-inline'", 'https://a.example; script-src *', 'http://evil.example', '*', 'https:'])(
    '%s → no extra source (the base policy)',
    (o) => expect(authorizeCsp(o, false)).toBe(base),
  );
});

describe('the consent page', () => {
  it('escapes the unverified client name and never links it', () => {
    const html = renderConsentPage({ clientName: '<img src=x onerror=alert(1)>"&\'', ticket: 'tkt_123', returnHost: 'claude.ai' });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;&#39;');
    expect(html).toMatch(/An app that calls itself/);
    expect(html).toContain('It cannot send or pay.');
    expect(html).not.toMatch(/<a\s/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('name="ticket" value="tkt_123"');
    expect(html).toContain('method="post" action="/oauth/authorize"');
    expect(html).toContain('value="allow"');
    expect(html).toContain('value="deny"');
  });
  it('an empty name reads as an unnamed app', () => {
    expect(renderConsentPage({ clientName: '', ticket: 't', returnHost: 'claude.ai' })).toContain('an unnamed app');
  });
  it('a message page escapes its text', () => {
    const html = renderMessagePage({ title: 'Not <b>here</b>', body: 'a & b' });
    expect(html).toContain('Not &lt;b&gt;here&lt;/b&gt;');
    expect(html).toContain('a &amp; b');
  });
});

describe('metadata documents', () => {
  it('RFC 8414 authorization server metadata', () => {
    expect(authorizationServerMetadata(HOST)).toEqual({
      issuer: 'https://send.smartremit.ai',
      authorization_endpoint: 'https://send.smartremit.ai/oauth/authorize',
      token_endpoint: 'https://send.smartremit.ai/oauth/token',
      registration_endpoint: 'https://send.smartremit.ai/oauth/register',
      revocation_endpoint: 'https://send.smartremit.ai/oauth/revoke',
      scopes_supported: ['quotes:read', 'recipients:read', 'transfers:read'],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    });
  });
  it('RFC 9728 protected resource metadata', () => {
    expect(protectedResourceMetadata(HOST)).toEqual({
      resource: RESOURCE,
      authorization_servers: ['https://send.smartremit.ai'],
      scopes_supported: ['quotes:read', 'recipients:read', 'transfers:read'],
      bearer_methods_supported: ['header'],
      resource_name: 'SmartRemit',
    });
  });
  it('the issuer is lower-case https', () => expect(issuerFor('Send.SmartRemit.ai')).toBe('https://send.smartremit.ai'));
  it('parseScope', () => {
    expect(parseScope(null)).toEqual(['quotes:read', 'recipients:read', 'transfers:read']);
    expect(parseScope('recipients:read')).toEqual(['recipients:read']);
    expect(parseScope('recipients:read bogus')).toBeNull();
    expect(parseScope('   ')).toBeNull();
  });
});

describe('secret hashing', () => {
  it('is the api-key-repo construction: sha256(plaintext + pepper), hex', () => {
    expect(agentSecretHash('sra_abc', 'pep')).toBe(createHash('sha256').update('sra_abcpep').digest('hex'));
    expect(agentSecretHash('sra_abc', 'pep')).not.toBe(agentSecretHash('sra_abc', 'other'));
  });
});
