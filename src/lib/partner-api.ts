import { getRedis } from './redis';
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db/client';
import type { RedisLike } from './store';
import { getStore } from './store';
import { getPartnerStore } from './partner-store';
import { getPartnerIntegrationsStore } from './partner-integrations-store';
import { getMonthlyVolumeStore } from './monthly-volume-store';
import { getCustomerStore } from './customer-store';
import { authenticatePartner } from './partner-api-auth';
import { checkPartnerRateLimit } from './partner-rate-limit';
import type { PartnerApiDeps, SvcResult } from './partner-api-service';
import type { Partner } from './types';
import { hasScope, type ApiKeyMode, type ApiScope } from './partner-api-scopes';

// partner-api — the shared guard every /api/partner/v1/* route runs first:
// authenticate the key → rate-limit the partner AND the key → check the
// handler's scope (fix 44) → load the (active) partner → build the service deps. Returns a ready-made error Response on any failure so
// the route stays a thin adapter.

let redisSingleton: RedisLike | null = null;
function apiRedis(): RedisLike {
  return getRedis();
}

export interface PartnerContext {
  partner: Partner;
  keyId: string;
  mode: ApiKeyMode;
  scopes: ApiScope[];
  deps: PartnerApiDeps;
}

export async function guardPartner(
  req: NextRequest,
  scope: ApiScope,
): Promise<{ ok: true; ctx: PartnerContext } | { ok: false; response: NextResponse }> {
  const auth = await authenticatePartner(req);
  if (!auth.ok) {
    return { ok: false, response: NextResponse.json({ error: auth.error }, { status: auth.status }) };
  }
  const redis = apiRedis();
  const rl = await checkPartnerRateLimit(redis, auth.partnerId, { keyId: auth.keyId });
  if (!rl.allowed) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Rate limit exceeded.' }, { status: 429, headers: { 'Retry-After': '60' } }),
    };
  }
  // Scope AFTER the limiter, so hammering a denied route still spends budget.
  if (!hasScope(auth.scopes, scope)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'This key cannot perform this action.' }, { status: 403 }),
    };
  }
  const partnerStore = getPartnerStore();
  const partner = await partnerStore.getPartner(auth.partnerId);
  if (!partner || partner.status !== 'active') {
    return { ok: false, response: NextResponse.json({ error: 'Partner not active.' }, { status: 403 }) };
  }
  const store = getStore();
  const deps: PartnerApiDeps = {
    store,
    customerStore: getCustomerStore(store), // fix 1 — sender rows are per tenant
    partnerStore,
    monthlyVolumeStore: getMonthlyVolumeStore(),
    integrationsStore: getPartnerIntegrationsStore(), // WL3 — per-partner rail/creds
    db: getDb(), // beneficiaries / idempotency / api audit (Stage 2a-3)
    keyMode: auth.mode, // Program-Fix 44 P2: the key's environment (hash-covered prefix)
  };
  return { ok: true, ctx: { partner, keyId: auth.keyId, mode: auth.mode, scopes: auth.scopes, deps } };
}

/** Map a service result to a JSON Response. */
export function svcResponse(result: SvcResult<unknown>): NextResponse {
  return result.ok
    ? NextResponse.json(result.data as Record<string, unknown>, { status: result.status })
    : NextResponse.json({ error: result.error }, { status: result.status });
}

/** Parse a JSON body, tolerating an empty/invalid body as {}. */
export async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
