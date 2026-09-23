import type { WaCreds } from './whatsapp';
import type { PartnerIntegrations } from './partner-integrations';
import type { Partner, PartnerId } from './types';
import { resolvePartnerBranding, DEFAULT_BRAND } from './partner-config';
import { getPartnerStore } from './partner-store';
import { getPartnerIntegrationsStore } from './partner-integrations-store';
import { logWarn } from './log';

// whatsapp-creds — derive the outbound WhatsApp credentials for a partner from
// their integrations row. A partner counts as BYO-WhatsApp ONLY when both the
// phoneNumberId and the token are configured — a half-configured channel falls
// back to the shared env number (undefined) rather than failing sends.
export function waCredsFrom(
  integrations: PartnerIntegrations | null | undefined,
): WaCreds | undefined {
  const w = integrations?.whatsapp;
  if (w?.phoneNumberId && w.token) {
    return { phoneNumberId: w.phoneNumberId, token: w.token };
  }
  return undefined;
}

export interface PartnerWaContext {
  brand: string;
  waCreds?: WaCreds;
}

export interface PartnerWaContextDeps {
  getPartner(partnerId: PartnerId): Promise<Partner | null | undefined>;
  getIntegrations(partnerId: PartnerId): Promise<PartnerIntegrations | null | undefined>;
}

/**
 * Program-Fix 49A (whatsapp-11): the owning partner's customer-facing identity
 * for a DIRECT send (portal OTP, Persona nudge, KYC decision) — the same
 * resolution api/cron/route.ts's partnerSendContext does. FAIL-SOFT: any read
 * error ⇒ the SmartRemit brand on the shared number (logged), because an OTP
 * that arrives from the shared number beats one that never arrives. The outbox
 * worker does NOT use this: its resolveSendCreds is deliberately fail-closed
 * and memoized per drain.
 */
export async function partnerWaContext(
  partnerId: PartnerId,
  deps?: PartnerWaContextDeps,
): Promise<PartnerWaContext> {
  try {
    const d: PartnerWaContextDeps = deps ?? {
      getPartner: (id) => getPartnerStore().getPartner(id),
      getIntegrations: (id) => getPartnerIntegrationsStore().getIntegrations(id),
    };
    const partner = await d.getPartner(partnerId);
    const integrations = await d.getIntegrations(partnerId);
    return { brand: resolvePartnerBranding(partner).brand, waCreds: waCredsFrom(integrations) };
  } catch (err) {
    logWarn('whatsapp.partner-context', err, { partnerId });
    return { brand: DEFAULT_BRAND, waCreds: undefined };
  }
}
