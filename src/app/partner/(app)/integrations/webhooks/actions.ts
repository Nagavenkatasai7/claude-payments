'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { scopeOf } from '@/lib/staff-scope';
import { getDb } from '@/db/client';
import { rotateRailSecret, saveSettlementEndpoint, sendTestPing, type EndpointActor } from '@/lib/partner-settlement-endpoint';
import { parseSecretKind, type RotateSecretResult, type TestPingResult } from '@/lib/partner-webhooks-view';
import { MAX_SETTLEMENT_URL_LENGTH } from '@/lib/settlement-url';
import { t, type MessageKey } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { PartnerCtx } from '@/lib/partner-access';
import { PARTNER_ROUTES } from '../../../routes';
import type { ActionResult } from '../../../action-result';

// /partner/integrations/webhooks actions (UI redesign M3-15a; O2 default: the settlement endpoint).
// Each one: the site-host guard, then the admin gate (+ MFA enrolment), both outside any try. The
// tenant is ALWAYS ctx.partnerId: no form field names it, and any partnerId / partner field is
// never read. The rules live in src/lib/partner-settlement-endpoint.ts (URL rule + SmartRemit-host
// refusal, the locked read-spread-write, the 7-day rotation overlap, the rate-limited safeFetch ping,
// the audit rows). A rotated secret travels ONLY in the rotate action's result: never in an audit
// row, a log line or a revalidated page.

const PAGE = PARTNER_ROUTES.integrationsWebhooks.href;
const POLICY = PARTNER_ROUTES.integrationsWebhooks.policy;

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
/** The audit actor, derived from the authenticated record (never from input). */
const actorOf = (ctx: PartnerCtx): EndpointActor => ({ username: ctx.username, actorScope: scopeOf(ctx.staff).kind });
const refused = (key: MessageKey) => ({ ok: false as const, error: t(key) });
const whenUtc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

export async function saveEndpointAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(POLICY);
  const raw = formData.get('url');
  // Bounded before anything else: the URL rule refuses > MAX_SETTLEMENT_URL_LENGTH too.
  if (typeof raw !== 'string' || raw.length > MAX_SETTLEMENT_URL_LENGTH + 64) return refused('partner.webhooks.invalidUrl');
  let r;
  try {
    r = await saveSettlementEndpoint(getDb(), ctx.partnerId, actorOf(ctx), raw);
  } catch (err) {
    logWarn('partner.webhooks.save', errName(err), { partnerId: ctx.partnerId });
    return refused('partner.webhooks.failed');
  }
  if (!r.ok) return refused(r.reason === 'not_partner_rail' ? 'partner.webhooks.managed' : 'partner.webhooks.invalidUrl');
  revalidatePath(PAGE);
  return { ok: true };
}

export async function rotateSecretAction(_prev: RotateSecretResult | null, formData: FormData): Promise<RotateSecretResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(POLICY);
  const kind = parseSecretKind(formData.get('kind'));
  if (!kind) return refused('partner.webhooks.invalid');
  let r;
  try {
    // The override is an explicit ConfirmDialog flag: exactly '1', anything else means no.
    r = await rotateRailSecret(getDb(), ctx.partnerId, actorOf(ctx), kind, { endGrace: formData.get('endGrace') === '1' });
  } catch (err) {
    logWarn('partner.webhooks.rotate', errName(err), { partnerId: ctx.partnerId, kind });
    return refused('partner.webhooks.failed');
  }
  if (!r.ok) {
    if (r.reason === 'rotation_in_grace') return { ok: false, error: t('partner.webhooks.rotationInGrace', { when: whenUtc(r.graceUntil) }) };
    return refused('partner.webhooks.managed');
  }
  revalidatePath(PAGE);
  return { ok: true, secret: r.secret, kind, graceUntil: r.graceUntil };
}

export async function sendTestAction(_prev: TestPingResult | null, _formData: FormData): Promise<TestPingResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(POLICY);
  let r;
  try {
    r = await sendTestPing(getDb(), ctx.partnerId, actorOf(ctx));
  } catch (err) {
    logWarn('partner.webhooks.test', errName(err), { partnerId: ctx.partnerId });
    return refused('partner.webhooks.failed');
  }
  if (!r.ok) {
    const key: Record<typeof r.reason, MessageKey> = {
      rate_limited: 'partner.webhooks.rateLimited',
      not_partner_rail: 'partner.webhooks.managed',
      no_endpoint: 'partner.webhooks.noEndpoint',
      no_signing_secret: 'partner.webhooks.noSigningSecret',
    };
    return refused(key[r.reason]);
  }
  revalidatePath(PAGE);
  return { ok: true, outcome: r.outcome, httpStatus: r.httpStatus, latencyMs: r.latencyMs };
}
