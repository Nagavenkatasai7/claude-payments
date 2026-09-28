import { getDb, type DbOrTx } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { sendAuthTemplate, type WaCreds } from './whatsapp';
import { authenticationTemplateParams } from './whatsapp-templates';
import { WhatsAppSendError } from './whatsapp-errors';
import { resolveWaChannel } from './whatsapp-creds';
import { getPartnerIntegrationsStore } from './partner-integrations-store';
import { parseHealthMarks, recordChannelHealth } from './channel-health';
import { getPortalSettings, type PortalSettings } from './portal-settings-repo';
import { getStore } from './store';
import { pokeWorker } from './outbox';
import { env } from './env';
import { DEFAULT_PARTNER_ID } from './defaults';
import type { PartnerIntegrations } from './partner-integrations';
import type { PartnerId } from './types';

/**
 * portal-otp-sender — the customer portal's sign-in code delivery (UI redesign M2-5, Task 5.3;
 * SPEC §2.1, X5, X16, owner O2).
 *
 * The code goes out ONLY as the partner's approved AUTHENTICATION template, FROM the partner's own
 * WhatsApp number. There is NO free-form fallback and NO retry on another number: a failed send is a
 * failed send (the customer resends; ops gets an alert). A non-default partner on the shared number
 * gets no portal codes; the default tenant counts as `own` on the shared number (it IS its number).
 *
 * Readiness is phone-independent (it depends on the partner only), so the login action can check it
 * on the request path without creating an oracle. Every lookup error → not ready (fail CLOSED, unlike
 * partnerWaContext's fail-soft).
 *
 * The code is never logged, never put in an error, never in an outbox row.
 */

export type PortalOtpNotReady = 'no_template' | 'channel_shared' | 'channel_incomplete' | 'health_auth_error' | 'lookup_failed';

export type PortalOtpReady =
  | { ready: true; creds: WaCreds | undefined; template: { name: string; lang: string } }
  | { ready: false; why: PortalOtpNotReady };

export interface PortalOtpReadyDeps {
  getIntegrations(partnerId: PartnerId): Promise<PartnerIntegrations | null | undefined>;
  getSettings(partnerId: PartnerId): Promise<PortalSettings>;
  readChannelHealth(partnerId: PartnerId): Promise<string | null>;
  now(): number;
}

/** A token-revoked mark this recent blocks sends (the partner must replace the token). */
export const PORTAL_OTP_AUTH_ERROR_WINDOW_MS = 3_600_000;

const defaultReadyDeps = (): PortalOtpReadyDeps => ({
  getIntegrations: (id) => getPartnerIntegrationsStore().getIntegrations(id),
  getSettings: (id) => getPortalSettings(getDb(), id),
  readChannelHealth: (id) => getStore().readChannelHealth(id),
  now: () => Date.now(),
});

export async function portalOtpChannelReady(partnerId: PartnerId, deps?: PortalOtpReadyDeps): Promise<PortalOtpReady> {
  try {
    const d = deps ?? defaultReadyDeps();
    const settings = await d.getSettings(partnerId);
    const channel = resolveWaChannel(partnerId, await d.getIntegrations(partnerId));
    const health = parseHealthMarks(await d.readChannelHealth(partnerId));
    if (!settings.authTemplateName || !settings.authTemplateLang) return { ready: false, why: 'no_template' };
    let creds: WaCreds | undefined;
    if (channel.kind === 'own') creds = channel.creds;
    else if (channel.kind === 'shared') {
      if (partnerId !== DEFAULT_PARTNER_ID) return { ready: false, why: 'channel_shared' };
      creds = undefined; // the env number: the default tenant's own
    } else return { ready: false, why: 'channel_incomplete' };
    const authErrAt = health.auth_error ? Date.parse(health.auth_error.at) : NaN;
    if (Number.isFinite(authErrAt) && d.now() - authErrAt < PORTAL_OTP_AUTH_ERROR_WINDOW_MS) {
      return { ready: false, why: 'health_auth_error' };
    }
    return { ready: true, creds, template: { name: settings.authTemplateName, lang: settings.authTemplateLang } };
  } catch {
    return { ready: false, why: 'lookup_failed' };
  }
}

/**
 * Send the code as the partner's template. ONE attempt: no free-form fallback, no other number.
 * On a Graph 190 (token revoked) the partner's channel health gets an `auth_error` mark, which makes
 * the next readiness check fail until the partner fixes the token.
 */
export async function sendPortalOtp(
  partnerId: PartnerId,
  phone: string,
  code: string,
  ready: Extract<PortalOtpReady, { ready: true }>,
): Promise<{ ok: true } | { ok: false; code?: number }> {
  if (env.otpDevMode) return { ok: true }; // the same dev switch as sendOtpCode; never on in prod
  try {
    await sendAuthTemplate(phone, ready.template.name, ready.template.lang, authenticationTemplateParams(code), ready.creds);
    return { ok: true };
  } catch (err) {
    const graphCode = err instanceof WhatsAppSendError ? err.code : undefined;
    if (graphCode === 190) await recordChannelHealth(partnerId, 'auth_error', { code: 190 });
    return graphCode === undefined ? { ok: false } : { ok: false, code: graphCode };
  }
}

/**
 * One deduped ops alert per (partner, hour) that portal sign-in codes are failing. The message
 * names the partner and the reason only: never a phone, never a code. Best-effort; never throws.
 */
export async function alertPortalOtpFailure(
  partnerId: PartnerId,
  why: PortalOtpNotReady | 'send_failed' | 'partner_ceiling',
  deps: { db?: DbOrTx; now?: () => number } = {},
): Promise<void> {
  try {
    const hourBucket = Math.floor((deps.now ?? Date.now)() / 3_600_000);
    await createOutboxRepo(deps.db ?? getDb()).enqueue(
      'ops.alert',
      {
        message:
          `SmartRemit ops: customer portal sign-in codes are failing for partner ${partnerId} (${why}). ` +
          'Check the partner authentication template and WhatsApp channel.',
      },
      { dedupeKey: `portalotp:${partnerId}:${hourBucket}` },
    );
    pokeWorker();
  } catch {
    /* alerting is best-effort */
  }
}
