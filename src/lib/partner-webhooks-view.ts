import { PREVIOUS_SECRET_KEYS, railSecrets, type PartnerIntegrations, type RailSecretKind } from '@/lib/partner-integrations';

// partner-webhooks-view (UI redesign M3-15a): the PURE projection of the partner's settlement
// webhook config for /partner/integrations/webhooks. The page renders ONLY this: whether each
// secret is set and when a rotated-out secret stops working, never a secret value.

export interface SecretState {
  set: boolean;
  /** ISO expiry of the previous secret while it is still in its grace window, else null. */
  previousUntil: string | null;
}

export interface WebhookConfigView {
  railType: string;
  /** Only a partner-operated rail ('http') is self-service; simulator / mock are SmartRemit-managed. */
  partnerRail: boolean;
  endpoint: string | null;
  signing: SecretState;
  webhook: SecretState;
}

function secretState(payment: PartnerIntegrations['payment'], kind: RailSecretKind, now: Date): SecretState {
  const active = railSecrets(payment, kind, now);
  return {
    set: active.length > 0,
    previousUntil: active.length > 1 ? (payment.credentials?.[PREVIOUS_SECRET_KEYS[kind].until] ?? null) : null,
  };
}

export function webhookConfigView(cfg: PartnerIntegrations, now: Date): WebhookConfigView {
  const railType = cfg.payment.providerType ?? 'mock';
  return {
    railType,
    partnerRail: railType === 'http',
    endpoint: cfg.payment.credentials?.settlementUrl || null,
    signing: secretState(cfg.payment, 'signing', now),
    webhook: secretState(cfg.payment, 'webhook', now),
  };
}

export function parseSecretKind(v: unknown): RailSecretKind | null {
  return v === 'signing' || v === 'webhook' ? v : null;
}

/** The rotate action's result: the fresh secret travels ONLY here, once. */
export type RotateSecretResult = { ok: true; secret: string; kind: RailSecretKind; graceUntil: string | null } | { ok: false; error: string };
/** The test-event action's result. */
export type TestPingResult = { ok: true; outcome: 'ok' | 'http_error' | 'network' | 'refused'; httpStatus: number | null; latencyMs: number } | { ok: false; error: string };
