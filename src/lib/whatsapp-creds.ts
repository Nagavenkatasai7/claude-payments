import type { WaCreds } from './whatsapp';
import type { PartnerIntegrations, PartnerWhatsappConfig } from './partner-integrations';
import type { Partner, PartnerId } from './types';
import { resolvePartnerBranding, DEFAULT_BRAND } from './partner-config';
import { getPartnerStore } from './partner-store';
import { getPartnerIntegrationsStore } from './partner-integrations-store';
import { logWarn } from './log';
import { DEFAULT_PARTNER_ID } from './defaults';

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

/** A WhatsApp config field, by the name the integrations row uses. */
export type WaConfigField = 'phoneNumberId' | 'token' | 'appSecret' | 'verifyToken';

/**
 * R2a: the partner's outbound channel, keyed on what SENDING needs.
 *  - own: pnid AND token are set. `warnings` lists a missing appSecret /
 *    verifyToken (inbound signature / the one-time GET handshake); they are
 *    shown to the partner and never block a send.
 *  - shared: the default partner, or a partner with NO WhatsApp field set
 *    (an API-only partner legitimately sends from the shared number).
 *  - incomplete: some field is set but not pnid+token. The worker's
 *    whatsapp.text/template send fails closed on it (never the shared number:
 *    the partner's customers messaged the partner's number).
 * waCredsFrom is unchanged and agrees with `own.creds`.
 */
export type WaChannel =
  | { kind: 'own'; creds: WaCreds; warnings: WaConfigField[] }
  | { kind: 'shared' }
  | { kind: 'incomplete'; missing: WaConfigField[] };

const present = (v: string | undefined): boolean => typeof v === 'string' && v.trim() !== '';

export function resolveWaChannel(
  partnerId: PartnerId,
  integrations: PartnerIntegrations | null | undefined,
): WaChannel {
  const w: PartnerWhatsappConfig = integrations?.whatsapp ?? {};
  const creds = waCredsFrom(integrations);
  if (creds) {
    const warnings: WaConfigField[] = [];
    if (!present(w.appSecret)) warnings.push('appSecret');
    if (!present(w.verifyToken)) warnings.push('verifyToken');
    return { kind: 'own', creds, warnings };
  }
  const anySet = present(w.phoneNumberId) || present(w.token) || present(w.appSecret) || present(w.verifyToken);
  if (partnerId === DEFAULT_PARTNER_ID || !anySet) return { kind: 'shared' };
  const missing: WaConfigField[] = [];
  if (!present(w.phoneNumberId)) missing.push('phoneNumberId');
  if (!present(w.token)) missing.push('token');
  return { kind: 'incomplete', missing };
}

/**
 * R2a: thrown by the outbox worker's whatsapp.text/template send when the
 * tenant's channel is `incomplete`. The message is the FIXED reason code (it
 * lands in outbox.last_error and the ops alert) — never a field value.
 */
export class WaChannelIncompleteError extends Error {
  constructor() {
    super('wa_channel_incomplete');
    this.name = 'WaChannelIncompleteError';
  }
}

export type WaConfigCheck = { ok: true; warnings: WaConfigField[] } | { ok: false; missing: WaConfigField[] };

/**
 * R2a: the SAVE-time rule, run on the MERGED state (a blank secret field keeps
 * the stored value, so the submitted form alone proves nothing). Accept either
 * nothing set (the shared number) or pnid + token + appSecret — the per-partner
 * webhook refuses every delivery without an appSecret, so an own number without
 * one could send but never receive. verifyToken is a warning only (it serves
 * the one-time GET handshake). Stricter than the send rule on purpose: nothing
 * savable here can ever resolve to `incomplete`.
 */
export function checkWhatsappConfig(w: PartnerWhatsappConfig): WaConfigCheck {
  const anySet = present(w.phoneNumberId) || present(w.token) || present(w.appSecret) || present(w.verifyToken);
  if (!anySet) return { ok: true, warnings: [] };
  const missing: WaConfigField[] = [];
  if (!present(w.phoneNumberId)) missing.push('phoneNumberId');
  if (!present(w.token)) missing.push('token');
  if (!present(w.appSecret)) missing.push('appSecret');
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, warnings: present(w.verifyToken) ? [] : ['verifyToken'] };
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
