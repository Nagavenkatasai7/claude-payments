import type { KycMode, Partner } from './types';
import { DEFAULT_PARTNER_ID } from './defaults';
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

// ── Reg E provider of record (Program-Fix 15 PR B) ──────────────────────────
//
// The licensed partner is the remittance transfer provider (recommendation C3).
// Its identity comes ONLY from partner.supportConfig.disclosure, which staff
// enter on the partner page (saveDisclosureConfigAction). Nothing is invented:
//  • no partner / the 'default' tenant ⇒ demo — no licensed entity, the page
//    shows DEMO_NO_PARTNER_NOTE (SmartRemit is never presented as the transmitter,
//    even if fields were saved on the default row);
//  • a real partner without a licensed entity ⇒ its brand + "details pending",
//    never the SmartRemit fallback brand.
// The jsonb is untyped at read, so every field is shape-checked here; URLs must
// be https (they become customer-facing links).

export const DEFAULT_DELIVERY_BUSINESS_DAYS = 1;
export const MAX_DELIVERY_BUSINESS_DAYS = 10;

export interface ResolvedDisclosure {
  demo: boolean;
  configured: boolean; // staff supplied the licensed entity (never true for demo)
  licensedEntity: string | null;
  licenseIds: string[];
  phone: string | null;
  website: string | null; // https only
  stateRegulator: { name: string; phone: string | null; website: string | null } | null;
  deliveryBusinessDays: number;
}

/** An absolute https URL (the only scheme a disclosure link may carry). */
export function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 200) return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

/** A customer-service phone: digits with common separators, 7-15 digits. */
export function isDisclosurePhone(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\+?[0-9 ().-]{7,24}$/.test(v)) return false;
  const digits = v.replace(/\D/g, '').length;
  return digits >= 7 && digits <= 15;
}

function text(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null;
}

function isBusinessDays(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_DELIVERY_BUSINESS_DAYS;
}

export function resolvePartnerDisclosure(partner: Partner | null | undefined): ResolvedDisclosure {
  if (!partner || partner.id === DEFAULT_PARTNER_ID) {
    return {
      demo: true,
      configured: false,
      licensedEntity: null,
      licenseIds: [],
      phone: null,
      website: null,
      stateRegulator: null,
      deliveryBusinessDays: DEFAULT_DELIVERY_BUSINESS_DAYS,
    };
  }
  const raw: unknown = partner.supportConfig?.disclosure;
  const c = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const entity = text(c.licensedEntity);
  const brand = resolvePartnerBranding(partner).brand;
  const reg = c.stateRegulator && typeof c.stateRegulator === 'object' ? (c.stateRegulator as Record<string, unknown>) : null;
  const regName = reg ? text(reg.name) : null;
  const est = c.deliveryEstimate && typeof c.deliveryEstimate === 'object'
    ? (c.deliveryEstimate as Record<string, unknown>).businessDays
    : undefined;
  return {
    demo: false,
    configured: entity !== null,
    licensedEntity: entity ?? (brand !== DEFAULT_BRAND ? brand : null),
    licenseIds: Array.isArray(c.licenseIds)
      ? c.licenseIds.map((x) => text(x)).filter((x): x is string => x !== null)
      : [],
    phone: isDisclosurePhone(c.phone) ? c.phone : null,
    website: isHttpsUrl(c.website) ? c.website : null,
    stateRegulator: regName
      ? {
          name: regName,
          phone: isDisclosurePhone(reg!.phone) ? reg!.phone : null,
          website: isHttpsUrl(reg!.website) ? reg!.website : null,
        }
      : null,
    deliveryBusinessDays: isBusinessDays(est) ? est : DEFAULT_DELIVERY_BUSINESS_DAYS,
  };
}

export interface ResolvedKyc {
  mode: KycMode;
  requireKyc: boolean;
}

/**
 * Resolve a partner's KYC posture. The verify-before-send gate is OPT-IN:
 * active ONLY when the partner explicitly configured
 * `requireKycBeforeSend: true` — in EITHER mode. `kycMode` decides WHO runs
 * verification when it happens ('ours' = SmartRemit's flow, 'delegated' = the
 * partner attests); `requireKycBeforeSend` decides WHETHER sends are blocked
 * until verified. The default/unconfigured partner has NO gate — customers
 * can quote and send immediately.
 *
 * INVARIANT UNCHANGED: sanctions screening is untouched by any of this — it
 * has no toggle anywhere and runs on every transfer (see screenTransfer).
 */
export function resolveKycMode(
  partner: Partner | null | undefined,
): ResolvedKyc {
  const mode: KycMode = partner?.kycMode ?? 'ours';
  return { mode, requireKyc: partner?.requireKycBeforeSend === true };
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
