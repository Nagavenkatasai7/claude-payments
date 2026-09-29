import type { WaCreds } from './whatsapp';
import type { PartnerIntegrations } from './partner-integrations';
import type { PartnerId } from './types';
import { resolveWaChannel } from './whatsapp-creds';
import { getPartnerIntegrationsStore } from './partner-integrations-store';
import { recordChannelHealth } from './channel-health';
import { pokeWorker } from './outbox';
import { logWarn } from './log';
import { DEFAULT_PARTNER_ID } from './defaults';

/**
 * direct-otp-channel: which WhatsApp number a DIRECTLY sent confirmation code (B2B bill pay,
 * seller onboarding) goes out on. Resolve it BEFORE a code is minted, so a refusal spends no
 * issue budget.
 *
 * The rule is FAIL CLOSED for a partner's own channel. A non-default partner's customer is dealing
 * with that partner's brand, so a code never silently falls back to SmartRemit's shared number:
 *  - own (pnid + token)                      → the partner's creds;
 *  - shared (default tenant, or nothing set) → undefined, the shared env number, as before (an
 *    API-only partner is deliberately on the shared number);
 *  - incomplete (half-configured)            → refused, with an `incomplete_config` health mark;
 *  - creds read throws                       → refused for a non-default partner; the default
 *    tenant keeps the shared number (it IS that tenant's number);
 *  - no tenant                               → refused, without a lookup.
 * The portal pay page applies the same rule (its twin landed separately; see PR #438).
 *
 * Logs carry the tenant id, a fixed reason and at most an error NAME: never a field value, a
 * token, or an error message (a driver or decrypt message can echo input).
 */

export type DirectOtpChannel =
  | { ok: true; creds: WaCreds | undefined }
  | { ok: false; why: 'tenant_unresolved' | 'lookup_failed' | 'incomplete' };

export interface DirectOtpChannelDeps {
  getIntegrations(partnerId: PartnerId): Promise<PartnerIntegrations | null | undefined>;
  recordIncomplete(partnerId: PartnerId): Promise<unknown>;
}

const defaultDeps = (): DirectOtpChannelDeps => ({
  getIntegrations: (id) => getPartnerIntegrationsStore().getIntegrations(id),
  // recordChannelHealth may enqueue the partner's alert email (an outbox row): poke the worker
  // when it did, so the email does not wait for the cron (outbox-poke-coverage).
  recordIncomplete: async (id) => {
    if (await recordChannelHealth(id, 'incomplete_config')) pokeWorker();
  },
});

export async function resolveDirectOtpChannel(
  partnerId: PartnerId | null | undefined,
  scope: string,
  deps?: DirectOtpChannelDeps,
): Promise<DirectOtpChannel> {
  if (!partnerId) {
    logWarn(scope, 'tenant unresolved; confirmation code not sent (fail closed)', {});
    return { ok: false, why: 'tenant_unresolved' };
  }
  const d = deps ?? defaultDeps();
  let integrations: PartnerIntegrations | null | undefined;
  try {
    integrations = await d.getIntegrations(partnerId);
  } catch (err) {
    if (partnerId === DEFAULT_PARTNER_ID) {
      // The default tenant's number IS the shared one; logged so ops still sees the failed read.
      logWarn(scope, 'default channel read failed; shared number', { error: err instanceof Error ? err.name : 'error' });
      return { ok: true, creds: undefined };
    }
    logWarn(scope, 'partner channel read failed; confirmation code not sent (fail closed)', {
      partnerId,
      error: err instanceof Error ? err.name : 'error',
    });
    return { ok: false, why: 'lookup_failed' };
  }
  const channel = resolveWaChannel(partnerId, integrations);
  if (channel.kind === 'own') return { ok: true, creds: channel.creds };
  if (channel.kind === 'shared') return { ok: true, creds: undefined };
  try {
    await d.recordIncomplete(partnerId);
  } catch {
    /* best-effort signal; the refusal stands */
  }
  logWarn(scope, 'partner channel incomplete; confirmation code not sent (fail closed)', { partnerId });
  return { ok: false, why: 'incomplete' };
}
