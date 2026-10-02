'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { getPartnerStore } from '@/lib/partner-store';
import { scopeOf } from '@/lib/staff-scope';
import {
  parseAlertEmail,
  parseDisclosureForm,
  parseSupportPortal,
  setAlertEmail,
  setDisclosure,
  setSupportPortal,
  type DisclosureParseReason,
  type SupportSettingsActor,
  type SupportWriteResult,
} from '@/lib/partner-support-settings';
import { MAX_DELIVERY_BUSINESS_DAYS } from '@/lib/partner-config';
import { gatePartnerStepUp } from '@/lib/partner-step-up-gate';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import { t, type MessageKey } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { PartnerCtx } from '@/lib/partner-access';
import type { ActionResult } from '../../action-result';
import { PARTNER_ROUTES } from '../../routes';

// /partner/settings server actions (partner-dashboard merge, 2f). The shared /partner action shape:
//  - refuseOnSiteHost() first, then the admin gate, both outside any try;
//  - the target is ALWAYS the session's tenant (ctx.partnerId): no form field names a partner, and
//    any id / partnerId / partner field is never read;
//  - the rules and writers are src/lib/partner-support-settings.ts (shared with the legacy page):
//    each merges only its own support_config keys under the row lock, with ONE audit row in the same
//    transaction whose meta.actorScope comes from the session. The alert address is never audited;
//  - the Reg E disclosure is what customers see as the provider of record, so its save needs the
//    15-minute step-up (partner-step-up-gate.ts), checked after the parse and before any write;
//  - errors are fixed, translated copy: never an exception message, never the input echoed back.

const POLICY = PARTNER_ROUTES.settings.policy;
const PAGE = PARTNER_ROUTES.settings.href;

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
const refused = (key: MessageKey, vars?: Record<string, string | number>) => ({ ok: false as const, error: t(key, vars) });
/** The audit actor, derived from the authenticated record (never from input). */
const actorOf = (ctx: PartnerCtx): SupportSettingsActor => ({ username: ctx.username, actorScope: scopeOf(ctx.staff).kind });

const DISCLOSURE_ERROR: Record<DisclosureParseReason, MessageKey> = {
  provider_phone: 'partner.settings.disclosure.error.providerPhone',
  regulator_phone: 'partner.settings.disclosure.error.regulatorPhone',
  provider_website: 'partner.settings.disclosure.error.providerWebsite',
  regulator_website: 'partner.settings.disclosure.error.regulatorWebsite',
  delivery_days: 'partner.settings.disclosure.error.deliveryDays',
  regulator_name_required: 'partner.settings.disclosure.error.regulatorNameRequired',
  entity_required: 'partner.settings.disclosure.error.entityRequired',
};

async function tenantExists(ctx: PartnerCtx): Promise<boolean> {
  return (await getPartnerStore().getPartner(ctx.partnerId)) !== null;
}

/** Run a writer; a thrown error is logged by name only and becomes the fixed "failed" copy. */
async function write(scope: string, ctx: PartnerCtx, run: () => Promise<SupportWriteResult>): Promise<ActionResult> {
  let r: SupportWriteResult;
  try {
    r = await run();
  } catch (err) {
    logWarn(scope, errName(err), { partnerId: ctx.partnerId });
    return refused('partner.settings.failed');
  }
  if (!r.ok) return refused('partner.settings.notFound');
  revalidatePath(PAGE);
  return { ok: true };
}

export async function saveSupportPortalAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(POLICY);
  const enabled = parseSupportPortal(formData.get('enableSupportPortal'));
  if (!(await tenantExists(ctx))) return refused('partner.settings.notFound');
  return write('partner.settings.portal', ctx, () => setSupportPortal(getDb(), ctx.partnerId, actorOf(ctx), enabled));
}

export async function saveAlertEmailAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(POLICY);
  const raw = formData.get('alertEmail');
  // A missing field never clears the address: only an explicit blank does.
  if (typeof raw !== 'string') return refused('partner.settings.alert.invalid');
  const parsed = parseAlertEmail(raw);
  if (!parsed.ok) return refused('partner.settings.alert.invalid');
  if (!(await tenantExists(ctx))) return refused('partner.settings.notFound');
  return write('partner.settings.alert_email', ctx, () => setAlertEmail(getDb(), ctx.partnerId, actorOf(ctx), parsed.value));
}

export async function saveDisclosureAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(POLICY);
  const parsed = parseDisclosureForm(formData); // validated BEFORE the step-up and any write
  if (!parsed.ok) return refused(DISCLOSURE_ERROR[parsed.reason], { max: MAX_DELIVERY_BUSINESS_DAYS });
  const stepUp = await gatePartnerStepUp(ctx, formData, 'disclosure.save');
  if (stepUp) return stepUp;
  if (!(await tenantExists(ctx))) return refused('partner.settings.notFound');
  return write('partner.settings.disclosure', ctx, () => setDisclosure(getDb(), ctx.partnerId, actorOf(ctx), parsed.value));
}
