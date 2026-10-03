import { resolveKycMode } from './partner-config';
import { gateOffOnLiveRail, sendGateActive } from './kyc-gate';
import type { PartnerIntegrations } from './partner-integrations';
import type { CountryCode, KycMode, Partner } from './types';

// partner-setup-view: the PURE, read-only compliance setup summary on /partner/settings (lost-features
// p3 B13). SmartRemit sets these (D8); the partner sees who runs KYC, whether sends wait for
// verification, the live-rail warning and its countries. Sanctions screening has no switch anywhere,
// so the page states it as a fixed line and this view carries nothing about it. No credential or
// URL from the integrations row leaves this function: only the provider type is read, as a boolean.

export interface SetupView {
  kycMode: KycMode;
  verifyBeforeSend: boolean;
  /** null when the integrations row could not be read: the page then shows no warning, never a guess. */
  liveRailWarning: boolean | null;
  countries: CountryCode[];
}

export function setupView(partner: Partner, integrations: Pick<PartnerIntegrations, 'payment'> | null): SetupView {
  return {
    kycMode: resolveKycMode(partner).mode,
    verifyBeforeSend: sendGateActive(partner),
    liveRailWarning: integrations === null ? null : gateOffOnLiveRail(partner, integrations),
    countries: [...partner.countries],
  };
}
