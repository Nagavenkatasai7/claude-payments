import { NextResponse } from 'next/server';
import { isInfraError } from '@/lib/infra-error';
import { logWarn } from '@/lib/log';
import type { PartnerId } from '@/lib/types';

/**
 * R1: the webhook routes' answer when the inbound pipeline threw. Only an
 * INFRASTRUCTURE error (DB / Redis unavailable — isInfraError's allowlist) is
 * a 500, so Meta redelivers; the redelivery is exactly-once against the
 * outbox's `wamid:{id}` unique key. Anything else is acknowledged (200): one
 * deterministic failure must never make Meta retry the POST for days. The
 * log line carries the tenant and the error NAME only — never the message,
 * which could echo payload text.
 */
export function respondToInboundFailure(err: unknown, partnerId: PartnerId | null): NextResponse {
  const infra = isInfraError(err);
  logWarn('whatsapp.inbound_failed', infra ? 'infrastructure error — 500, Meta will redeliver' : 'unexpected error — acknowledged', {
    partnerId: partnerId ?? 'default',
    error: err instanceof Error ? err.name : 'error',
  });
  return infra ? NextResponse.json({ ok: false }, { status: 500 }) : NextResponse.json({ ok: true });
}
