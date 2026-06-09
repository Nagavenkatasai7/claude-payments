import { Redis } from '@upstash/redis';
import { NextResponse, type NextRequest } from 'next/server';
import { env } from './env';
import { getDb } from '@/db/client';
import type { RedisLike } from './store';
import { getStore } from './store';
import { getPartnerStore } from './partner-store';
import { getPartnerIntegrationsStore } from './partner-integrations-store';
import { getMonthlyVolumeStore } from './monthly-volume-store';
import { authenticatePartner } from './partner-api-auth';
import { checkPartnerRateLimit } from './partner-rate-limit';
import type { PartnerApiDeps, SvcResult } from './partner-api-service';
import type { Partner } from './types';

// partner-api — the shared guard every /api/partner/v1/* route runs first:
// authenticate the key → rate-limit the partner → load the (active) partner →
// build the service deps. Returns a ready-made error Response on any failure so
// the route stays a thin adapter.

let redisSingleton: RedisLike | null = null;
function apiRedis(): RedisLike {
  if (!redisSingleton) {
    redisSingleton = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    }) as unknown as RedisLike;
  }
  return redisSingleton;
}

export interface PartnerContext {
  partner: Partner;
  keyId: string;
  deps: PartnerApiDeps;
}

export async function guardPartner(
  req: NextRequest,
): Promise<{ ok: true; ctx: PartnerContext } | { ok: false; response: NextResponse }> {
  const auth = await authenticatePartner(req);
  if (!auth.ok) {
    return { ok: false, response: NextResponse.json({ error: auth.error }, { status: auth.status }) };
  }
  const redis = apiRedis();
  const rl = await checkPartnerRateLimit(redis, auth.partnerId);
  if (!rl.allowed) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Rate limit exceeded.' }, { status: 429, headers: { 'Retry-After': '60' } }),
    };
  }
  const partnerStore = getPartnerStore();
  const partner = await partnerStore.getPartner(auth.partnerId);
  if (!partner || partner.status !== 'active') {
    return { ok: false, response: NextResponse.json({ error: 'Partner not active.' }, { status: 403 }) };
  }
  const deps: PartnerApiDeps = {
    store: getStore(),
    partnerStore,
    monthlyVolumeStore: getMonthlyVolumeStore(),
    integrationsStore: getPartnerIntegrationsStore(), // WL3 — per-partner rail/creds
    db: getDb(), // beneficiaries / idempotency / api audit (Stage 2a-3)
  };
  return { ok: true, ctx: { partner, keyId: auth.keyId, deps } };
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
