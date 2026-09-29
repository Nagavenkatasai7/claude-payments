import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { conversationMessages, partnerSites, partnerWebhookDeliveries, partners } from '@/db/schema';
import { createApiKeyRepo } from '@/db/repos/api-key-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import type { RedisLike } from '@/lib/store';
import { seedPartnerTransfer } from './helpers-partner-app';

// helpers-partner-onboarding (UI redesign M3-20): seed EVERY stored fact the seven-step checklist
// reads, for one tenant, so a test can then remove one fact at a time. M3-21 reuses it.
// Distinctive secret-shaped values let a page test assert none of them reaches the HTML.

export const ONBOARDING_SECRETS = Object.freeze({
  pnid: '998877665544',
  token: 'wa-token-SECRET-onboarding',
  appSecret: 'wa-appsecret-SECRET-onboarding',
  verifyToken: 'wa-verify-SECRET-onboarding',
  settlementUrl: 'https://rail.example.com/instruct?tok=SECRET-onboarding',
  signingSecret: 'c'.repeat(64),
});

export function completeIntegrations(pnid: string = ONBOARDING_SECRETS.pnid): PartnerIntegrations {
  return {
    kyc: { providerType: 'persona', apiKey: 'kyc-key', webhookSecret: 'kyc-hook' },
    payment: {
      providerType: 'http',
      credentials: { settlementUrl: ONBOARDING_SECRETS.settlementUrl, signingSecret: ONBOARDING_SECRETS.signingSecret },
      webhookSecret: 'd'.repeat(64),
    },
    whatsapp: { phoneNumberId: pnid, token: ONBOARDING_SECRETS.token, verifyToken: ONBOARDING_SECRETS.verifyToken, appSecret: ONBOARDING_SECRETS.appSecret },
  };
}

export async function seedInboundMessage(db: Db, partnerId: string, o: { channel?: number; direction?: number } = {}): Promise<void> {
  await db.insert(conversationMessages).values({
    id: randomUUID(),
    partnerId,
    threadKey: new Uint8Array(32).fill(7),
    channel: o.channel ?? 1,
    direction: o.direction ?? 1,
    bodyEnc: 'v2:sealed-placeholder',
  });
}

export async function seedPing(db: Db, partnerId: string, o: { outcome?: string; createdAt?: Date } = {}): Promise<void> {
  await db.insert(partnerWebhookDeliveries).values({
    partnerId,
    kind: 'ping',
    attempt: 1,
    outcome: o.outcome ?? 'ok',
    httpStatus: 200,
    latencyMs: 40,
    createdAt: o.createdAt ?? new Date(),
  });
}

/**
 * Seed steps 1–6 as DONE for `partnerId` (step 7 is the request: not seeded). The pnid must be
 * unique per tenant (the integrations row indexes it), so pass a different one for a second tenant.
 */
export async function seedOnboardingComplete(db: Db, redis: RedisLike, partnerId: string, pnid: string = ONBOARDING_SECRETS.pnid): Promise<void> {
  // 1. own WhatsApp number + a passing test + an inbound message
  await createPartnerIntegrationsStore(db).saveIntegrations(partnerId, completeIntegrations(pnid));
  await redis.set(`watest:${partnerId}`, JSON.stringify({ ok: true, at: new Date().toISOString(), status: 200 }));
  await seedInboundMessage(db, partnerId);
  // 2. the template attestation (the action's audit row)
  await createAuditRepo(db).record({
    partnerId,
    actor: `${partnerId}-admin`,
    actorType: 'staff',
    action: 'partner.templates.attest',
    subjectId: partnerId,
    meta: { templates: ['authentication', 'transfer_delivered'], actorScope: 'partner' },
  });
  // 3. an unrevoked sandbox key
  await createApiKeyRepo(db).issue(partnerId, 'test');
  // 4. a delivered sandbox transfer
  await seedPartnerTransfer(db, { id: `tr_sbx_${partnerId}`, partnerId, environment: 'test', status: 'delivered' });
  // 5. http rail + valid URL (above) + a recent ok ping
  await seedPing(db, partnerId);
  // 6. slug + a validated primary colour
  await db.insert(partnerSites).values({ partnerId, slug: `${partnerId}-site` });
  await db.update(partners).set({ primaryColor: '#0b5d4b' }).where(eq(partners.id, partnerId));
}
