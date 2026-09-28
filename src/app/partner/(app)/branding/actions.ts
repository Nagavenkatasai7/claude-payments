'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { savePartnerTheme } from '@/db/repos/partner-site-repo';
import { setPartnerSupportContact } from '@/db/repos/partner-support-contact';
import { savePartnerLogo } from '@/lib/partner-logo-store';
import { getPartnerStore } from '@/lib/partner-store';
import { scopeOf } from '@/lib/staff-scope';
import { MAX_LOGO_FILE_BYTES, MAX_LOGO_FILE_KB, logoErrorKey, themeErrorKey, type ThemeField } from '@/lib/partner-branding';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { PartnerCtx } from '@/lib/partner-access';
import type { ActionResult } from '../../action-result';
import { PARTNER_ROUTES } from '../../routes';

// /partner/branding server actions (UI redesign M3-17). The shared /partner action shape:
//  - refuseOnSiteHost() first, then the gate (outside any try);
//  - the target is ALWAYS the session's own tenant (ctx.partnerId). No form field names a partner:
//    any id / partnerId / partner field is never read (carry-forward from the PR 381 review);
//  - the tenant is confirmed to exist before a write, and a writer's not_found maps to the same copy;
//  - validation is the M1 writers' own (colour format + contrast, logo type allowlist + magic bytes,
//    the support-contact rules), each writing its value + ONE audit row in one transaction, with
//    meta.actorScope derived from the session (never from input);
//  - errors are fixed, translated copy: never an exception message, never the input echoed back.
// Nothing is cached per partner: the portal/site pages are request-time and the site cache maps a
// slug to a partner id only, so revalidating this page is the whole invalidation.

export type ThemeActionResult = { ok: true } | { ok: false; error: string; field?: ThemeField };

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
const notFound = (): { ok: false; error: string } => ({ ok: false, error: t('partner.branding.notFound') });
const failed = (): { ok: false; error: string } => ({ ok: false, error: t('partner.branding.failed') });

async function tenantExists(ctx: PartnerCtx): Promise<boolean> {
  return (await getPartnerStore().getPartner(ctx.partnerId)) !== null;
}

function done(): void {
  revalidatePath(PARTNER_ROUTES.branding.href);
}

export async function saveThemeAction(formData: FormData): Promise<ThemeActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.branding.policy);
  if (!(await tenantExists(ctx))) return notFound();
  const input = { primaryColor: formData.get('primaryColor'), accentColor: formData.get('accentColor') };
  let r: Awaited<ReturnType<typeof savePartnerTheme>>;
  try {
    r = await savePartnerTheme(getDb(), ctx.partnerId, input, ctx.username, { actorScope: scopeOf(ctx.staff).kind });
  } catch (err) {
    logWarn('partner.branding.theme', errName(err), { partnerId: ctx.partnerId });
    return failed();
  }
  if (!r.ok) {
    if (r.reason === 'not_found') return notFound();
    return { ok: false, field: r.field, error: t(themeErrorKey(r.reason)) };
  }
  done();
  return { ok: true };
}

export async function saveLogoAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.branding.policy);
  if (!(await tenantExists(ctx))) return notFound();
  const file = formData.get('logo');
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: t(logoErrorKey('missing')) };
  // The size check comes BEFORE any read: an oversized upload is never buffered.
  if (file.size > MAX_LOGO_FILE_BYTES) return { ok: false, error: t(logoErrorKey('size'), { max: MAX_LOGO_FILE_KB }) };
  let r: Awaited<ReturnType<typeof savePartnerLogo>>;
  try {
    // The declared type goes into the header as-is; the logo store accepts only the exact
    // png/jpeg/webp headers and then checks the decoded bytes' signature against it.
    const dataUri = `data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}`;
    r = await savePartnerLogo(getDb(), ctx.partnerId, dataUri, ctx.username, { actorScope: scopeOf(ctx.staff).kind });
  } catch (err) {
    logWarn('partner.branding.logo', errName(err), { partnerId: ctx.partnerId });
    return failed();
  }
  if (!r.ok) {
    if (r.reason === 'not_found') return notFound();
    return { ok: false, error: t(logoErrorKey(r.reason), { max: MAX_LOGO_FILE_KB }) };
  }
  done();
  return { ok: true };
}

export async function saveSupportContactAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.branding.policy);
  if (!(await tenantExists(ctx))) return notFound();
  let r: Awaited<ReturnType<typeof setPartnerSupportContact>>;
  try {
    r = await setPartnerSupportContact(getDb(), ctx.partnerId, formData.get('supportContact'), ctx.username, {
      actorScope: scopeOf(ctx.staff).kind,
    });
  } catch (err) {
    logWarn('partner.branding.contact', errName(err), { partnerId: ctx.partnerId });
    return failed();
  }
  if (!r.ok) return r.reason === 'not_found' ? notFound() : { ok: false, error: t('partner.branding.contactInvalid') };
  done();
  return { ok: true };
}
