import { NextResponse } from 'next/server';
import { isInfraError } from '@/lib/infra-error';
import { logWarn } from '@/lib/log';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { getRedis } from '@/lib/redis';
import type { PartnerId } from '@/lib/types';

const errorName = (err: unknown) => (err instanceof Error ? err.name : 'error');

/** R1: at most one `webhook_error` audit row per (tenant, hour). */
export const WEBHOOK_ERROR_AUDIT_WINDOW_SEC = 60 * 60;

/**
 * R1: the webhook routes' answer when the inbound pipeline threw. ONLY an
 * infrastructure error (isInfraError's allowlist — R7's binding rule) is a
 * 500, so Meta redelivers; the redelivery is exactly-once against the
 * outbox's `wamid:{id}` unique key. Anything else is acknowledged (200): one
 * deterministic failure must never make Meta retry the POST for days — and it
 * is recorded as a best-effort `whatsapp.inbound_dropped` row (reason
 * `webhook_error`) under the routed tenant, at most one per (tenant, hour).
 * Log and audit carry the tenant and the error NAME only — never the message,
 * which could echo payload text.
 */
export async function respondToInboundFailure(err: unknown, partnerId: PartnerId | null): Promise<NextResponse> {
  const tenant = partnerId ?? DEFAULT_PARTNER_ID;
  const infra = isInfraError(err);
  logWarn('whatsapp.inbound_failed', infra ? 'infrastructure error — 500, Meta will redeliver' : 'unexpected error — acknowledged', {
    partnerId: tenant,
    error: errorName(err),
  });
  if (infra) return NextResponse.json({ ok: false }, { status: 500 });
  await recordWebhookError(tenant, errorName(err));
  return NextResponse.json({ ok: true });
}

async function recordWebhookError(tenant: PartnerId, error: string): Promise<void> {
  const hour = Math.floor(Date.now() / (WEBHOOK_ERROR_AUDIT_WINDOW_SEC * 1000));
  const claimKey = `wawebhookerr:${tenant}:${hour}`;
  let claimed = false;
  try {
    const first = await getRedis().set(claimKey, '1', { ex: WEBHOOK_ERROR_AUDIT_WINDOW_SEC, nx: true });
    if (first === null) return;
    claimed = true;
    await createAuditRepo(getDb()).record({
      partnerId: tenant,
      actor: 'whatsapp',
      actorType: 'system',
      action: 'whatsapp.inbound_dropped',
      meta: { reason: 'webhook_error', error },
    });
  } catch (auditErr) {
    logWarn('whatsapp.inbound_dropped', 'audit insert failed', { error: errorName(auditErr) });
    if (claimed) {
      try {
        await getRedis().del(claimKey);
      } catch {
        /* the claim expires on its own within the hour */
      }
    }
  }
}
