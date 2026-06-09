import type { WaCreds } from './whatsapp';
import type { PartnerIntegrations } from './partner-integrations';

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
