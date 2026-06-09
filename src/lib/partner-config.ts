import type { KycMode, Partner } from './types';
import type { PartnerIntegrations } from './partner-integrations';
import { EMPTY_PARTNER_INTEGRATIONS } from './partner-integrations';
import type { PartnerIntegrationsStore } from './partner-integrations-store';

// partner-config — the LINCHPIN resolvers for white-label orchestration.
//
// Every caller resolves through here and NEVER branches on `undefined`. The
// `default` / unconfigured partner resolves to literally today's behavior:
//   brand 'SmartRemit', KYC 'ours' (gate ON), mock payment, env-driven KYC,
//   shared WhatsApp number, no color/logo override, no persona.
//
// resolvePartnerBranding + resolveKycMode are PURE and SYNC (no I/O) — they read
// only the Partner record, which the agent already has in scope (agent.ts:104),
// so the per-turn hot path costs zero extra fetches. Only the provider seams
// reach for the integrations row via resolvePartnerIntegrations().

export const DEFAULT_BRAND = 'SmartRemit';

export interface ResolvedBranding {
  brand: string; // always a non-empty string
  supportContact: string; // '' when none
  botPersona: string; // '' when none — appended to the system prompt only if set
  primaryColor: string | null; // null = no override (keep default CSS)
  logoUrl: string | null; // null = no logo override
}

/** Resolve the end-customer-facing brand from a Partner record. null ⇒ 'SmartRemit'. */
export function resolvePartnerBranding(
  partner: Partner | null | undefined,
): ResolvedBranding {
  return {
    brand: partner?.displayName?.trim() || partner?.brandName?.trim() || DEFAULT_BRAND,
    supportContact: partner?.supportContact?.trim() ?? '',
    botPersona: partner?.botPersona?.trim() ?? '',
    primaryColor: partner?.primaryColor?.trim() || null,
    logoUrl: partner?.logoUrl?.trim() || null,
  };
}

export interface ResolvedKyc {
  mode: KycMode;
  requireKyc: boolean;
}

/**
 * Resolve a partner's KYC posture. INVARIANT: 'ours' ALWAYS requires KYC — a
 * partner can never be 'ours' and skip the gate. Only an explicitly 'delegated'
 * partner short-circuits, and even then sanctions screening is untouched
 * (it has no toggle here — see screenTransfer).
 */
export function resolveKycMode(
  partner: Partner | null | undefined,
): ResolvedKyc {
  const mode: KycMode = partner?.kycMode ?? 'ours';
  if (mode === 'ours') return { mode: 'ours', requireKyc: true };
  return { mode: 'delegated', requireKyc: partner?.requireKycBeforeSend ?? false };
}

/**
 * Async: load the partner's technical integration config (provider selection +
 * decrypted creds). A partner with no row resolves to EMPTY ⇒ mock payment,
 * env-driven KYC, shared WhatsApp — i.e. today's behavior. Used ONLY by the
 * provider seams, never the per-turn hot path.
 */
export async function resolvePartnerIntegrations(
  partner: Partner | null | undefined,
  store: PartnerIntegrationsStore,
): Promise<PartnerIntegrations> {
  if (!partner) return EMPTY_PARTNER_INTEGRATIONS;
  return store.getIntegrations(partner.id);
}
