import type { RedisLike } from '@/lib/store';
import type { PartnerId } from '@/lib/types';
import { AGENT_SCOPES, type AgentScope } from './contract';
import { ACCESS_TOKEN_PREFIX, AGENT_ACCESS_TTL_SEC, AGENT_CODE_TTL_SEC, AGENT_CODE_USED_TTL_SEC, AGENT_CONSENT_TTL_SEC, AGENT_GRANT_TTL_MS } from './config';
import { agentSecretHash, newAgentSecret } from './secrets';

// agent token store — the short-lived secrets of the AI-agent sign-in in Redis (Stage C1).
//
// Hashes only: every key is `agent:<kind>:<agentSecretHash(secret)>`, and no value holds the
// secret itself. Each record carries its own `exp` (ms) and is checked against the injected clock
// as well as the Redis TTL. Codes and consent tickets are single-use (GETDEL). A used code leaves
// a marker (grant id only) so a replay can revoke the grant it minted.
//
// Records are parsed defensively: a malformed value reads as "not found".

export interface AgentConsentRecord {
  partnerId: PartnerId;
  phone: string;
  sid: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: AgentScope[];
  state: string | null;
  exp: number;
}

export interface AgentCodeRecord {
  partnerId: PartnerId;
  phone: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: AgentScope[];
  grantId: string;
  exp: number;
}

export interface AgentAccessRecord {
  grantId: string;
  partnerId: PartnerId;
  phone: string;
  clientId: string;
  scopes: AgentScope[];
  resource: string;
  exp: number;
}

const str = (v: unknown): v is string => typeof v === 'string' && v !== '';
const scopesOk = (v: unknown): v is AgentScope[] => Array.isArray(v) && v.length > 0 && v.every((s) => (AGENT_SCOPES as readonly unknown[]).includes(s));

function parse(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const has = (r: Record<string, unknown>, keys: readonly string[]) => keys.every((k) => str(r[k]));

export function createAgentTokenStore(redis: RedisLike, opts: { now?: () => number; pepper?: string } = {}) {
  const now = opts.now ?? Date.now;
  const h = (secret: string) => agentSecretHash(secret, opts.pepper);
  const key = (kind: 'consent' | 'code' | 'codeused' | 'at' | 'rtretired', secret: string) => `agent:${kind}:${h(secret)}`;
  const alive = (r: Record<string, unknown>) => typeof r.exp === 'number' && Number.isFinite(r.exp) && r.exp > now();

  return {
    async issueConsent(rec: Omit<AgentConsentRecord, 'exp'>): Promise<string> {
      const ticket = newAgentSecret();
      await redis.set(key('consent', ticket), JSON.stringify({ ...rec, exp: now() + AGENT_CONSENT_TTL_SEC * 1000 }), { ex: AGENT_CONSENT_TTL_SEC });
      return ticket;
    },
    async takeConsent(ticket: string): Promise<AgentConsentRecord | null> {
      if (!str(ticket) || ticket.length > 128) return null;
      const r = parse(await redis.getdel(key('consent', ticket)));
      if (!r || !alive(r) || !has(r, ['partnerId', 'phone', 'sid', 'clientId', 'redirectUri', 'codeChallenge', 'resource']) || !scopesOk(r.scopes)) return null;
      if (r.state !== null && typeof r.state !== 'string') return null;
      return r as unknown as AgentConsentRecord;
    },

    async issueCode(rec: Omit<AgentCodeRecord, 'exp'>): Promise<string> {
      const code = newAgentSecret();
      await redis.set(key('code', code), JSON.stringify({ ...rec, exp: now() + AGENT_CODE_TTL_SEC * 1000 }), { ex: AGENT_CODE_TTL_SEC });
      return code;
    },
    async takeCode(code: string): Promise<AgentCodeRecord | null> {
      if (!str(code) || code.length > 128) return null;
      const r = parse(await redis.getdel(key('code', code)));
      if (!r || !alive(r) || !has(r, ['partnerId', 'phone', 'clientId', 'redirectUri', 'codeChallenge', 'resource', 'grantId']) || !scopesOk(r.scopes)) return null;
      return r as unknown as AgentCodeRecord;
    },
    async markCodeUsed(code: string, rec: { partnerId: PartnerId; grantId: string }): Promise<void> {
      await redis.set(key('codeused', code), JSON.stringify({ partnerId: rec.partnerId, grantId: rec.grantId, exp: now() + AGENT_CODE_USED_TTL_SEC * 1000 }), {
        ex: AGENT_CODE_USED_TTL_SEC,
      });
    },
    async usedCodeGrant(code: string): Promise<{ partnerId: PartnerId; grantId: string } | null> {
      if (!str(code) || code.length > 128) return null;
      const r = parse(await redis.get(key('codeused', code)));
      if (!r || !alive(r) || !has(r, ['partnerId', 'grantId'])) return null;
      return { partnerId: r.partnerId as PartnerId, grantId: r.grantId as string };
    },

    /**
     * A refresh token just rotated out. Kept (hash only) for the grant's whole life so a token from ANY
     * earlier rotation is caught as theft, not only the one the grant row still holds. Best effort:
     * a lost key only loses detection; the token itself is already dead.
     */
    async markRefreshRetired(refreshToken: string, rec: { partnerId: PartnerId; grantId: string }): Promise<void> {
      const ttlSec = Math.floor(AGENT_GRANT_TTL_MS / 1000);
      await redis.set(key('rtretired', refreshToken), JSON.stringify({ partnerId: rec.partnerId, grantId: rec.grantId, exp: now() + ttlSec * 1000 }), {
        ex: ttlSec,
      });
    },
    async retiredRefreshGrant(refreshToken: string): Promise<{ partnerId: PartnerId; grantId: string } | null> {
      if (!str(refreshToken) || refreshToken.length > 128) return null;
      const r = parse(await redis.get(key('rtretired', refreshToken)));
      if (!r || !alive(r) || !has(r, ['partnerId', 'grantId'])) return null;
      return { partnerId: r.partnerId as PartnerId, grantId: r.grantId as string };
    },

    async issueAccess(rec: Omit<AgentAccessRecord, 'exp'>): Promise<{ token: string; expiresIn: number }> {
      const token = newAgentSecret(ACCESS_TOKEN_PREFIX);
      const value: AgentAccessRecord = {
        grantId: rec.grantId,
        partnerId: rec.partnerId,
        phone: rec.phone,
        clientId: rec.clientId,
        scopes: rec.scopes,
        resource: rec.resource,
        exp: now() + AGENT_ACCESS_TTL_SEC * 1000,
      };
      await redis.set(key('at', token), JSON.stringify(value), { ex: AGENT_ACCESS_TTL_SEC });
      return { token, expiresIn: AGENT_ACCESS_TTL_SEC };
    },
    async readAccess(token: string): Promise<AgentAccessRecord | null> {
      if (!str(token) || !token.startsWith(ACCESS_TOKEN_PREFIX) || token.length > 128) return null;
      const r = parse(await redis.get(key('at', token)));
      if (!r || !alive(r) || !has(r, ['grantId', 'partnerId', 'phone', 'clientId', 'resource']) || !scopesOk(r.scopes)) return null;
      return r as unknown as AgentAccessRecord;
    },
    async dropAccess(token: string): Promise<void> {
      if (!str(token) || token.length > 128) return;
      await redis.del(key('at', token));
    },
  };
}

export type AgentTokenStore = ReturnType<typeof createAgentTokenStore>;
