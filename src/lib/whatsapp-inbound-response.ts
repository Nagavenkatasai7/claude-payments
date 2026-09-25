import { NextResponse } from 'next/server';
import { isInfraError } from '@/lib/infra-error';
import { logWarn } from '@/lib/log';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import type { PartnerId } from '@/lib/types';

/**
 * R1: a failure that must be retried by Meta REGARDLESS of isInfraError — a
 * STOP / START whose consent write or confirmation did not land. A consent
 * change is never silently acknowledged: the webhook answers 500 and the
 * redelivery re-applies it (idempotently). `cause` keeps the original error.
 */
export class RetryableInboundError extends Error {
  constructor(cause: unknown) {
    super('inbound consent change not applied', { cause });
    this.name = 'RetryableInboundError';
  }
}

/** Should the webhook answer 500 (Meta redelivers) for this error? */
export function isRetryableInboundFailure(err: unknown): boolean {
  return err instanceof RetryableInboundError || isInfraError(err);
}

const errorName = (err: unknown) => (err instanceof Error ? err.name : 'error');

/**
 * R1: the webhook routes' answer when the inbound pipeline threw. A retryable
 * failure (infrastructure — isInfraError's allowlist — or a consent change) is
 * a 500, so Meta redelivers; the redelivery is exactly-once against the
 * outbox's `wamid:{id}` unique key. Anything else is acknowledged (200): one
 * deterministic failure must never make Meta retry the POST for days — and it
 * is recorded as ONE best-effort `whatsapp.inbound_dropped` row (reason
 * `webhook_error`) under the routed tenant. Log and audit carry the tenant and
 * the error NAME only — never the message, which could echo payload text.
 */
export async function respondToInboundFailure(err: unknown, partnerId: PartnerId | null): Promise<NextResponse> {
  const tenant = partnerId ?? DEFAULT_PARTNER_ID;
  const retry = isRetryableInboundFailure(err);
  const cause = err instanceof RetryableInboundError ? err.cause : err;
  logWarn('whatsapp.inbound_failed', retry ? 'retryable error — 500, Meta will redeliver' : 'unexpected error — acknowledged', {
    partnerId: tenant,
    error: errorName(err),
    ...(cause !== err ? { cause: errorName(cause) } : {}),
  });
  if (retry) return NextResponse.json({ ok: false }, { status: 500 });
  try {
    await createAuditRepo(getDb()).record({
      partnerId: tenant,
      actor: 'whatsapp',
      actorType: 'system',
      action: 'whatsapp.inbound_dropped',
      meta: { reason: 'webhook_error', error: errorName(err) },
    });
  } catch (auditErr) {
    logWarn('whatsapp.inbound_dropped', 'audit insert failed', { error: errorName(auditErr) });
  }
  return NextResponse.json({ ok: true });
}
