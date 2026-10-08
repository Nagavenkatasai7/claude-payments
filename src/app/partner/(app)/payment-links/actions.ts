'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { getFxRates } from '@/lib/rate';
import { CSV_MAX_BYTES } from '@/lib/csv-parse';
import { cancelLink, checkBulk, createBulk, createLink, PaymentLinkOpsError, type PartnerActor } from '@/lib/payment-link-ops';
import { paymentLinkUrl } from '@/lib/pay-url';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { PARTNER_ROUTES } from '../../routes';
import type { ActionResult } from '../../action-result';
import type { BulkRow } from '@/lib/payment-link-bulk';

// Batch B2: the payment-link actions. Each is a PUBLIC POST endpoint: the partner-site host guard,
// then the PARTNER_ADMIN gate (outside any try), then payment-link-ops with the SESSION's tenant
// and username (a tenant or actor field in the form is never read). The service validates every
// field, reads the payee and the link under that tenant, and writes the change and its audit row
// in one transaction. Errors come back as fixed text; the validator's own messages are fixed text.

const POLICY = PARTNER_ROUTES.paymentLinks.policy;

/** The PARTNER_ADMIN gate (call AFTER refuseOnSiteHost); the actor is the session's. */
async function actor(): Promise<PartnerActor> {
  const ctx = await requirePartnerStaff(POLICY);
  return { partnerId: ctx.partnerId, username: ctx.username, role: ctx.role };
}

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v : '';
};

/** USD per rupee for the $10–$2,999 range check and the $500 warning; undefined when no rate is available. */
async function usdPerInr(): Promise<number | undefined> {
  try {
    const r = await getFxRates('USD');
    return r.toInr > 0 ? 1 / r.toInr : undefined;
  } catch {
    return undefined;
  }
}

function opsError(e: unknown, partnerId: string, scope: string): string {
  if (e instanceof PaymentLinkOpsError) {
    switch (e.code) {
      case 'invalid':
        return t('partner.paymentLinks.err.invalid');
      case 'not_found':
      case 'payee_not_approved':
        return t('partner.paymentLinks.err.payee');
      case 'duplicate_reference':
        return t('partner.paymentLinks.err.duplicate');
      case 'nothing_to_create':
        return t('partner.paymentLinks.err.nothing');
      case 'bad_file':
        return e.fieldErrors.file ?? t('partner.common.failed');
      case 'not_allowed':
        return t('partner.paymentLinks.err.notAllowed');
      default:
        return t('partner.common.failed');
    }
  }
  logWarn(scope, e instanceof Error ? e.name : 'error', { partnerId });
  return t('partner.common.failed');
}

export type CreateLinkState =
  | { ok: true; reference: string; url: string; warnings: string[] }
  | { ok: false; error: string; fieldErrors?: Partial<Record<string, string>> };

export async function createLinkAction(formData: FormData): Promise<CreateLinkState> {
  await refuseOnSiteHost();
  const a = await actor();
  try {
    const link = await createLink(getDb(), a, {
      payeeId: str(formData, 'payeeId'),
      raw: {
        name: formData.get('name'),
        phone: formData.get('phone'),
        amount: formData.get('amount'),
        reference: formData.get('reference'),
        purpose: formData.get('purpose'),
      },
      usdPerInr: await usdPerInr(),
    });
    revalidatePath(PARTNER_ROUTES.paymentLinks.href);
    return { ok: true, reference: link.reference, url: paymentLinkUrl(link.token), warnings: link.warnings };
  } catch (e) {
    const fieldErrors = e instanceof PaymentLinkOpsError ? e.fieldErrors : undefined;
    return { ok: false, error: opsError(e, a.partnerId, 'partner.paymentLinks.create'), fieldErrors };
  }
}

export type BulkCheckState =
  | { ok: true; rows: Array<Pick<BulkRow, 'line' | 'cells' | 'ok' | 'errors' | 'warnings'>>; valid: number; invalid: number; warned: number }
  | { ok: false; error: string };

function csvText(formData: FormData): string | null {
  const text = str(formData, 'csv');
  return text.length > CSV_MAX_BYTES ? null : text;
}

/** The row-by-row check. Saves nothing. */
export async function checkBulkAction(formData: FormData): Promise<BulkCheckState> {
  await refuseOnSiteHost();
  const a = await actor();
  const text = csvText(formData);
  if (text === null) return { ok: false, error: t('partner.paymentLinks.bulk.tooBig') };
  try {
    const report = await checkBulk(getDb(), a, { text, usdPerInr: await usdPerInr() });
    if (!report.ok) return { ok: false, error: report.error };
    return {
      ok: true,
      rows: report.rows.map(({ line, cells, ok, errors, warnings }) => ({ line, cells, ok, errors, warnings })),
      valid: report.valid,
      invalid: report.invalid,
      warned: report.warned,
    };
  } catch (e) {
    return { ok: false, error: opsError(e, a.partnerId, 'partner.paymentLinks.check') };
  }
}

export type BulkCreateState =
  | { ok: true; links: Array<{ reference: string; url: string }>; skipped: number }
  | { ok: false; error: string };

/** Make the links of a checked file (the SAME check runs again on the same text). */
export async function createBulkAction(formData: FormData): Promise<BulkCreateState> {
  await refuseOnSiteHost();
  const a = await actor();
  const text = csvText(formData);
  if (text === null) return { ok: false, error: t('partner.paymentLinks.bulk.tooBig') };
  try {
    const out = await createBulk(getDb(), a, { payeeId: str(formData, 'payeeId'), text, usdPerInr: await usdPerInr() });
    revalidatePath(PARTNER_ROUTES.paymentLinks.href);
    return { ok: true, links: out.created.map((l) => ({ reference: l.reference, url: paymentLinkUrl(l.token) })), skipped: out.skipped };
  } catch (e) {
    return { ok: false, error: opsError(e, a.partnerId, 'partner.paymentLinks.bulk') };
  }
}

/** Cancel one OPEN link of this tenant. */
export async function cancelLinkAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  const a = await actor();
  try {
    await cancelLink(getDb(), a, str(formData, 'id'));
  } catch (e) {
    return { ok: false, error: opsError(e, a.partnerId, 'partner.paymentLinks.cancel') };
  }
  revalidatePath(PARTNER_ROUTES.paymentLinks.href);
  return { ok: true };
}
