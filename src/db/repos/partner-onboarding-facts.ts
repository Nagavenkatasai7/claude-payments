import { and, eq, gte, isNull, like, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { apiKeys, auditEvents, conversationMessages, partnerGoLive, partnerSites, partnerWebhookDeliveries, partners, transfers } from '@/db/schema';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { checkPartnerEndpointUrl } from '@/lib/partner-settlement-endpoint';
import { parseChannelTest } from '@/lib/channel-health';
import { getStore } from '@/lib/store';
import { renderableLogoSrc } from '@/lib/partner-logo-store';
import { validateThemeColor } from '@/lib/ui/theme';
import { PING_FRESH_DAYS, type OnboardingFacts } from '@/lib/partner-onboarding';
import type { PartnerId } from '@/lib/types';

// partner-onboarding-facts (UI redesign M3-20): the ONE function that gathers the stored facts the
// seven-step checklist (src/lib/partner-onboarding.ts) is computed from. Every SQL query is keyed
// by `partner_id = partnerId` (the caller passes the SESSION tenant on /partner, or the route's
// partner on the platform approval card, M3-21). The integrations row is decrypted here only to
// derive booleans: no token, phone number id, URL or secret leaves this function. Existence checks
// are LIMIT 1 (counts are never needed).
//
// Sources:
//  1. integrations (own number: pnid + token + app secret; the save rule is checkWhatsappConfig,
//     whatsapp-creds.ts:92, which also accepts "nothing set" = the shared number, so it is not
//     reused here), the last "Test connection" result (Redis watest:<pid>, 7-day TTL,
//     store.ts readChannelTest), and an inbound WhatsApp message (conversation_messages channel 1,
//     direction 1; schema.ts comment "channel: 1 = WhatsApp … direction: 1 = inbound").
//  2. the attestation audit row (partner.templates.attest, subject = the partner id).
//  3. an unrevoked pk_test_ key (keyModeFromId, partner-api-scopes.ts:59).
//  4. a transfer with environment 'test' and status 'delivered'.
//  5. rail providerType 'http', the stored URL passes checkPartnerEndpointUrl (checkSettlementUrl
//     plus the SmartRemit-host refusal, partner-settlement-endpoint.ts:83), and a ping 'ok' row in
//     the last PING_FRESH_DAYS days that is newer than the latest partner.settlement_endpoint.update
//     audit row for this tenant (the partner-surface URL writer; the legacy platform admin save
//     does not write that action, so a platform-side URL change does not reopen the step).
//  6. partner_sites.slug, a renderable logo, or a validated primary colour.
//  7. partner_go_live requested_at / approved_at, and partners.status.

export interface OnboardingFactsOptions {
  now?: Date;
  /** Endpoint URL rule options (tests); defaults to env.appBaseUrl / env.isProduction. */
  urlOpts?: { appOrigin?: string; production?: boolean };
  /** The last WhatsApp test result as stored; defaults to the Redis store. */
  readChannelTest?: (partnerId: PartnerId) => Promise<string | null>;
}

const ENDPOINT_UPDATE_ACTION = 'partner.settlement_endpoint.update';

const present = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

async function exists(q: Promise<unknown[]>): Promise<boolean> {
  return (await q).length > 0;
}

export async function loadOnboardingFacts(db: DbOrTx, partnerId: PartnerId, opts: OnboardingFactsOptions = {}): Promise<OnboardingFacts> {
  const now = opts.now ?? new Date();
  const pingSince = new Date(now.getTime() - PING_FRESH_DAYS * 86_400_000);
  const readTest = opts.readChannelTest ?? ((pid: PartnerId) => getStore().readChannelTest(pid));

  const [partnerRow, integrations, testRaw, inbound, attested, sandboxKey, sandboxTransfer, ping, site, goLive] = await Promise.all([
    db.select({ status: partners.status, primaryColor: partners.primaryColor, logoUrl: partners.logoUrl }).from(partners).where(eq(partners.id, partnerId)).limit(1),
    createPartnerIntegrationsStore(db).getIntegrations(partnerId),
    readTest(partnerId),
    exists(
      db
        .select({ one: sql`1` })
        .from(conversationMessages)
        .where(and(eq(conversationMessages.partnerId, partnerId), eq(conversationMessages.channel, 1), eq(conversationMessages.direction, 1)))
        .limit(1),
    ),
    exists(
      db
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(and(eq(auditEvents.partnerId, partnerId), eq(auditEvents.subjectId, partnerId), eq(auditEvents.action, 'partner.templates.attest')))
        .limit(1),
    ),
    exists(
      db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(and(eq(apiKeys.partnerId, partnerId), isNull(apiKeys.revokedAt), like(apiKeys.id, 'pk\\_test\\_%')))
        .limit(1),
    ),
    exists(
      db
        .select({ id: transfers.id })
        .from(transfers)
        .where(and(eq(transfers.partnerId, partnerId), eq(transfers.environment, 'test'), eq(transfers.status, 'delivered')))
        .limit(1),
    ),
    exists(
      db
        .select({ id: partnerWebhookDeliveries.id })
        .from(partnerWebhookDeliveries)
        .where(
          and(
            eq(partnerWebhookDeliveries.partnerId, partnerId),
            eq(partnerWebhookDeliveries.kind, 'ping'),
            eq(partnerWebhookDeliveries.outcome, 'ok'),
            gte(partnerWebhookDeliveries.createdAt, pingSince),
            // Newer than the tenant's latest endpoint change (written by saveSettlementEndpoint,
            // partner-settlement-endpoint.ts:131): a ping to a previous URL proves nothing now.
            sql`${partnerWebhookDeliveries.createdAt} > coalesce((select max(${auditEvents.at}) from ${auditEvents} where ${auditEvents.partnerId} = ${partnerId} and ${auditEvents.action} = ${ENDPOINT_UPDATE_ACTION}), '-infinity'::timestamptz)`,
          ),
        )
        .limit(1),
    ),
    db.select({ slug: partnerSites.slug }).from(partnerSites).where(eq(partnerSites.partnerId, partnerId)).limit(1),
    db.select({ requestedAt: partnerGoLive.requestedAt, approvedAt: partnerGoLive.approvedAt }).from(partnerGoLive).where(eq(partnerGoLive.partnerId, partnerId)).limit(1),
  ]);

  const p = partnerRow[0];
  const w = integrations.whatsapp;
  const partnerRail = integrations.payment.providerType === 'http';
  const url = integrations.payment.credentials?.settlementUrl;
  const g = goLive[0];

  return {
    whatsappOwnConfigured: present(w.phoneNumberId) && present(w.token) && present(w.appSecret),
    whatsappTestOk: parseChannelTest(testRaw)?.ok === true,
    whatsappInboundSeen: inbound,
    templatesAttested: attested,
    sandboxKeyActive: sandboxKey,
    sandboxTransferDelivered: sandboxTransfer,
    partnerRail,
    endpointUrlValid: partnerRail && typeof url === 'string' && url !== '' && checkPartnerEndpointUrl(url, opts.urlOpts ?? {}).ok,
    recentPingOk: ping,
    slugClaimed: present(site[0]?.slug),
    logoSet: renderableLogoSrc(p?.logoUrl) !== null,
    primaryColorSet: validateThemeColor(p?.primaryColor).ok,
    goLiveRequested: g?.requestedAt != null,
    goLiveApproved: g?.approvedAt != null,
    partnerActive: p?.status === 'active',
  };
}
