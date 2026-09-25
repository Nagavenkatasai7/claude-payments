// webhook-signature-health — R2b: is a partner's inbound WhatsApp webhook
// passing its signature check?
//
// A signature FAILURE is unauthenticated traffic, so it may only touch a
// bounded, deduped Redis mark per (partner, hour): never a DB row, never an
// email, never an alert. The webhook routes call noteSignatureFailure only for
// a partner they already resolved from their own data (a known partner that has
// an app secret) — never for a raw, unknown id, so the key space stays bounded.
// A valid signature records `lastSignedOkAt`. The banner shows a signature
// hint (a WARN, never an error) only when failures are recent AND the partner
// HAS had a valid delivery, but none in the last 24h (signatureAlarm): a
// failure can be produced by anyone, a success cannot, so ongoing valid
// deliveries always win, and a partner with no valid delivery on record sees
// the partner page's "No signed webhook recorded" row instead.
// Best-effort everywhere: a Redis error never changes a route's response.

import { getRedis } from './redis';
import { logWarn } from './log';
import { DEFAULT_PARTNER_ID } from './defaults';
import type { PartnerId } from './types';

type SigRedis = {
  get(key: string): Promise<string | null | unknown>;
  set(key: string, value: string, opts?: { ex?: number; nx?: boolean }): Promise<unknown>;
};
interface SigDeps {
  redis?: SigRedis;
  now?: () => Date;
}

/** The per-(partner, hour) claim lives at most two hours. */
export const SIG_FAIL_CLAIM_TTL_SEC = 2 * 60 * 60;
const LAST_FAIL_TTL_SEC = 7 * 24 * 60 * 60;
const LAST_OK_TTL_SEC = 30 * 24 * 60 * 60;
export const SIGNATURE_ALARM_WINDOW_MS = 24 * 60 * 60 * 1000;

const claimKey = (p: PartnerId, hour: number) => `wasigfail:${p}:${hour}`;
const lastFailKey = (p: PartnerId) => `wasigfaillast:${p}`;
const lastOkKey = (p: PartnerId) => `wasigok:${p}`;

const skip = (p: PartnerId | null | undefined): p is null | undefined => !p || p === DEFAULT_PARTNER_ID;
const redisOf = (deps?: SigDeps): SigRedis => deps?.redis ?? (getRedis() as unknown as SigRedis);
const nowOf = (deps?: SigDeps): Date => (deps?.now ?? (() => new Date()))();

/**
 * One inbound signature failure for a KNOWN partner. One SET NX per call; only
 * the first failure of an hour also writes the last-seen time and a log line.
 */
export async function noteSignatureFailure(partnerId: PartnerId | null | undefined, deps?: SigDeps): Promise<void> {
  if (skip(partnerId)) return;
  try {
    const redis = redisOf(deps);
    const now = nowOf(deps);
    const hour = Math.floor(now.getTime() / 3_600_000);
    const claimed = await redis.set(claimKey(partnerId, hour), '1', { ex: SIG_FAIL_CLAIM_TTL_SEC, nx: true });
    if (claimed === null) return;
    await redis.set(lastFailKey(partnerId), now.toISOString(), { ex: LAST_FAIL_TTL_SEC });
    logWarn('whatsapp.sig_fail', 'inbound webhook failed its signature check', { partnerId });
  } catch {
    /* best-effort: the route still answers 401 */
  }
}

/** A valid signature for a partner's webhook: record when. */
export async function noteSignedOk(partnerId: PartnerId | null | undefined, deps?: SigDeps): Promise<void> {
  if (skip(partnerId)) return;
  try {
    await redisOf(deps).set(lastOkKey(partnerId), nowOf(deps).toISOString(), { ex: LAST_OK_TTL_SEC });
  } catch (err) {
    logWarn('whatsapp.sig_ok', 'last signed webhook not recorded', { partnerId, error: err instanceof Error ? err.name : 'error' });
  }
}

export interface SignatureHealth {
  lastFailAt?: string;
  lastOkAt?: string;
}

/** The partner's signature marks. A Redis error reads as "no marks". */
export async function readSignatureHealth(partnerId: PartnerId, deps?: { redis?: SigRedis }): Promise<SignatureHealth> {
  try {
    const redis = redisOf(deps);
    const [fail, ok] = await Promise.all([redis.get(lastFailKey(partnerId)), redis.get(lastOkKey(partnerId))]);
    return {
      ...(typeof fail === 'string' && fail ? { lastFailAt: fail } : {}),
      ...(typeof ok === 'string' && ok ? { lastOkAt: ok } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Pure: failures within 24h AND a valid delivery on record (the mark lives 30
 * days) but none within 24h. No valid delivery on record ⇒ false: the partner
 * page's signed-webhook row already says so.
 */
export function signatureAlarm(sig: SignatureHealth, now: Date): boolean {
  const fail = sig.lastFailAt ? Date.parse(sig.lastFailAt) : NaN;
  if (!Number.isFinite(fail) || now.getTime() - fail > SIGNATURE_ALARM_WINDOW_MS) return false;
  const ok = sig.lastOkAt ? Date.parse(sig.lastOkAt) : NaN;
  if (!Number.isFinite(ok)) return false;
  return now.getTime() - ok > SIGNATURE_ALARM_WINDOW_MS;
}

/** Pure: the partner page's "Signed webhooks" row. The ok mark lives 30 days. */
export function signedWebhookLabel(sig: SignatureHealth): string {
  return sig.lastOkAt
    ? `Last signed webhook · ${sig.lastOkAt.slice(0, 16).replace('T', ' ')} UTC`
    : 'No signed webhook recorded in the last 30 days';
}
