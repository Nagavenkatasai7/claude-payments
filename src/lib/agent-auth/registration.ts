import { AGENT_AUTH_METHODS, AGENT_CLIENT_NAME_MAX, AGENT_MAX_REDIRECT_URIS, parseScope, type AgentAuthMethod } from './config';
import { checkRedirectUri } from './redirect-uri';

// RFC 7591 dynamic client registration: the metadata SmartRemit accepts. PURE.
// client_name is the app's own, UNVERIFIED claim: printable, single line, at most 60 characters,
// shown only as "an app that calls itself …" (escaped, never a link).

export interface ClientRegistration {
  name: string;
  redirectUris: string[];
  authMethod: AgentAuthMethod;
}

export type RegistrationCheck =
  | { ok: true; value: ClientRegistration }
  | { ok: false; error: 'invalid_redirect_uri' | 'invalid_client_metadata'; description: string };

const bad = (error: 'invalid_redirect_uri' | 'invalid_client_metadata', description: string): RegistrationCheck => ({ ok: false, error, description });

/** Letters, marks, numbers, punctuation, symbols and plain spaces; no controls, no bidi or format characters. */
const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u;

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function parseClientRegistration(body: unknown): RegistrationCheck {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad('invalid_client_metadata', 'The body must be a JSON object.');
  const b = body as Record<string, unknown>;

  const uris = b.redirect_uris;
  if (!isStringArray(uris) || uris.length === 0) return bad('invalid_redirect_uri', 'redirect_uris must list at least one URI.');
  const unique = [...new Set(uris)];
  if (unique.length > AGENT_MAX_REDIRECT_URIS) return bad('invalid_redirect_uri', `At most ${AGENT_MAX_REDIRECT_URIS} redirect URIs.`);
  if (!unique.every(checkRedirectUri)) return bad('invalid_redirect_uri', 'Each redirect URI must be https (or http on localhost / 127.0.0.1), without a fragment.');

  let name = '';
  if (b.client_name !== undefined) {
    if (typeof b.client_name !== 'string') return bad('invalid_client_metadata', 'client_name must be a string.');
    name = b.client_name.trim();
    if (name.length > AGENT_CLIENT_NAME_MAX) return bad('invalid_client_metadata', `client_name is at most ${AGENT_CLIENT_NAME_MAX} characters.`);
    if (name !== '' && !PRINTABLE.test(name)) return bad('invalid_client_metadata', 'client_name must be printable text on one line.');
  }

  // RFC 7591 §2: the default is client_secret_basic.
  const method = b.token_endpoint_auth_method ?? 'client_secret_basic';
  if (typeof method !== 'string' || !(AGENT_AUTH_METHODS as readonly string[]).includes(method)) {
    return bad('invalid_client_metadata', 'token_endpoint_auth_method must be none, client_secret_post or client_secret_basic.');
  }

  if (b.grant_types !== undefined) {
    const ok = isStringArray(b.grant_types) && b.grant_types.every((g) => g === 'authorization_code' || g === 'refresh_token');
    if (!ok) return bad('invalid_client_metadata', 'grant_types may list only authorization_code and refresh_token.');
  }
  if (b.response_types !== undefined) {
    const ok = isStringArray(b.response_types) && b.response_types.every((r) => r === 'code');
    if (!ok) return bad('invalid_client_metadata', 'response_types may list only code.');
  }
  if (b.scope !== undefined && (typeof b.scope !== 'string' || parseScope(b.scope) === null)) {
    return bad('invalid_client_metadata', 'scope may list only quotes:read, recipients:read, transfers:read, transfers:prepare and offline_access.');
  }

  return { ok: true, value: { name, redirectUris: unique, authMethod: method as AgentAuthMethod } };
}
