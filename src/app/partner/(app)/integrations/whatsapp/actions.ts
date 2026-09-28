'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { scopeOf } from '@/lib/staff-scope';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getRedis } from '@/lib/redis';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import {
  WhatsappConfigError,
  disconnectWhatsapp,
  saveWhatsappConfig,
  testWhatsappConnection,
} from '@/lib/partner-whatsapp-config';
import { WA_FIELD_ERROR_KEY, parseWhatsappForm, waErrorKey } from '@/lib/partner-whatsapp-view';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { PartnerCtx } from '@/lib/partner-access';
import { PARTNER_ROUTES } from '../../../routes';
import type { ActionResult } from '../../../action-result';

// /partner/integrations/whatsapp actions (UI redesign M3-13). Each one: the site-host guard, then
// the admin gate (outside any try). The tenant is ALWAYS ctx.partnerId: no form field names it.
// The core is the SAME lib the legacy admin tab calls (src/lib/partner-whatsapp-config.ts).
// Secrets are write-only: no result, audit row or log line carries a submitted value (the lib's
// refusals map to fixed copy through a code allowlist; anything else is the generic failure with
// the error NAME logged). The audit rows carry meta.actorScope derived from the session.

const PAGE = PARTNER_ROUTES.integrationsWhatsapp.href;
const SAVE_LIMIT = { scope: 'partner-wa-save', limit: 10, windowSec: 600 } as const;
const TEST_LIMIT = { scope: 'partner-wa-test', limit: 5, windowSec: 600 } as const;
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/** The audit marker, derived from the authenticated record (never from input). */
const actorScopeOf = (ctx: PartnerCtx) => scopeOf(ctx.staff).kind;

/**
 * Per-tenant budget for Graph-probing actions. FAILS CLOSED on a limiter error: this is config,
 * not a money path, and an unbounded probe would let a session use SmartRemit as a Graph proxy.
 */
async function withinLimit(partnerId: string, l: { scope: string; limit: number; windowSec: number }): Promise<boolean> {
  try {
    return (await checkIpRateLimit(getRedis(), l.scope, partnerId, { limit: l.limit, windowSec: l.windowSec })).allowed;
  } catch (err) {
    logWarn('partner.whatsapp.limit', errName(err), { partnerId });
    return false;
  }
}

// The default tenant IS the shared SmartRemit number: its channel stays platform-managed.
const sharedManaged = (ctx: PartnerCtx): ActionResult | null =>
  ctx.partnerId === DEFAULT_PARTNER_ID ? { ok: false, error: t('partner.whatsapp.sharedManaged') } : null;

function refusal(err: unknown, partnerId: string, source: string): ActionResult {
  if (err instanceof WhatsappConfigError) return { ok: false, error: t(waErrorKey(err.code)) };
  logWarn(source, errName(err), { partnerId });
  return { ok: false, error: t('partner.whatsapp.failed') };
}

export async function saveWhatsappAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.integrationsWhatsapp.policy);
  const managed = sharedManaged(ctx);
  if (managed) return managed;
  const parsed = parseWhatsappForm(formData);
  if (!parsed.ok) return { ok: false, error: t(WA_FIELD_ERROR_KEY[parsed.field]) };
  if (!(await withinLimit(ctx.partnerId, SAVE_LIMIT))) return { ok: false, error: t('partner.whatsapp.rateLimited') };
  try {
    await saveWhatsappConfig(ctx.partnerId, ctx.username, parsed.form, { actorScope: actorScopeOf(ctx), blankPnidKeeps: true });
  } catch (err) {
    return refusal(err, ctx.partnerId, 'partner.whatsapp.save');
  }
  revalidatePath(PAGE);
  return { ok: true };
}

export async function testWhatsappAction(_formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.integrationsWhatsapp.policy);
  const managed = sharedManaged(ctx);
  if (managed) return managed;
  if (!(await withinLimit(ctx.partnerId, TEST_LIMIT))) return { ok: false, error: t('partner.whatsapp.rateLimited') };
  try {
    // THIS partner's stored number + token only; an unconfigured tenant makes no network call.
    const result = await testWhatsappConnection(ctx.partnerId);
    await createAuditRepo(getDb()).record({
      partnerId: ctx.partnerId,
      actor: ctx.username,
      actorType: 'staff',
      action: 'partner.whatsapp.test',
      subjectId: ctx.partnerId,
      meta: {
        actorScope: actorScopeOf(ctx),
        ok: result.ok,
        ...(result.status !== undefined ? { status: result.status } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      },
    });
  } catch (err) {
    return refusal(err, ctx.partnerId, 'partner.whatsapp.test');
  }
  revalidatePath(PAGE);
  return { ok: true };
}

export async function disconnectWhatsappAction(_formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.integrationsWhatsapp.policy);
  const managed = sharedManaged(ctx);
  if (managed) return managed;
  try {
    await disconnectWhatsapp(ctx.partnerId, ctx.username, { actorScope: actorScopeOf(ctx) });
  } catch (err) {
    return refusal(err, ctx.partnerId, 'partner.whatsapp.disconnect');
  }
  revalidatePath(PAGE);
  return { ok: true };
}
