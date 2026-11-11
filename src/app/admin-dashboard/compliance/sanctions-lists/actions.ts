'use server';

// Fix pack 5 (R08, P28, P29): the platform-only India MHA (UAPA) list actions. MHA publishes no
// machine feed, so a SmartRemit platform admin uploads the curated CSV here, and confirms it is
// still current (the 8-day freshness rule, LIST_MAX_AGE_MS['in-mha-uapa']) without a re-upload.
// Nothing screens against this list unless SANCTIONS_LIST=lists.
//
// A server action is a public POST endpoint (CLAUDE.md): each action refuses on a site host FIRST,
// then requirePlatformAdmin (partner-scoped staff and non-admins are redirected before any read),
// then the actor's own staff MFA. From there on a bounds or parser refusal is audited ('refused',
// counts and codes only, never a name), the step-up is ALWAYS asked (gateStaffStepUp, target
// 'sanctions_list.upload'), and the store goes through storeList's integrity rules (all rows or
// none, the 0.8 shrink floor, forward-only versions). The store commits in its own transaction
// under the per-source advisory lock and the audit row follows it, as the list loader does
// (list-loader.ts recordAudit). Errors are logged by NAME only. No partner id is read or written:
// the list is platform data.
import { revalidatePath } from 'next/cache';
import { requirePlatformAdmin } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import {
  createSanctionsListRepo,
  SanctionsListShrinkError,
  SanctionsListStaleError,
} from '@/db/repos/sanctions-list-repo';
import {
  MHA_MAX_BYTES,
  MHA_MIN_ENTRIES,
  MHA_SOURCE,
  parseInMhaCsv,
  type MhaRowError,
} from '@/lib/sanctions/in-mha-list';
import { isCalendarDate } from '@/lib/live-controls-write';
import { staffMfaEnrolled } from '@/lib/staff-mfa-store';
import { gateStaffStepUp } from '@/lib/partner-step-up-gate';
import { logWarn } from '@/lib/log';
import { t } from '@/lib/i18n';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import type { Staff } from '@/lib/types';
import { mhaCodeCopy } from './copy';

export type MhaUploadOutcome = 'activated' | 'unchanged';
export type MhaListActionResult =
  | { ok: true; outcome: MhaUploadOutcome | 'confirmed' }
  | { ok: false; error: string; rows?: Array<{ row: number; code: string }> }
  | StepUpRequired;

const PAGE = '/admin-dashboard/compliance/sanctions-lists';
/** Rows returned to the page (the audit row keeps the full count). */
const ROWS_SHOWN = 200;

const refused = (error: string, rows?: MhaRowError[]): MhaListActionResult =>
  rows ? { ok: false, error, rows: rows.slice(0, ROWS_SHOWN).map((r) => ({ row: r.row, code: r.code })) } : { ok: false, error };
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/** After the site-host guard (each action's FIRST statement): the platform-admin gate and the actor's own MFA. */
async function gate(): Promise<Staff | MhaListActionResult> {
  const staff = await requirePlatformAdmin();
  if (!(await staffMfaEnrolled(staff.username))) return refused(t('admin.compliance.sanctionsLists.refused.needMfa'));
  return staff;
}

async function audit(staff: Staff, action: 'sanctions.list.upload' | 'sanctions.list.confirm', meta: Record<string, unknown>): Promise<void> {
  await createAuditRepo(getDb()).record({ actor: staff.username, actorType: 'staff', action, subjectId: MHA_SOURCE, meta });
}

/** A bounds or parser refusal after the admin and MFA gates: one audit row, counts and codes only. */
async function refuseAudited(staff: Staff, error: string, codes: string[], rows?: MhaRowError[]): Promise<MhaListActionResult> {
  try {
    await audit(staff, 'sanctions.list.upload', {
      source: MHA_SOURCE,
      errorCount: rows ? rows.length : codes.length,
      codes: [...new Set(codes)].sort(),
      outcome: 'refused',
    });
  } catch (err) {
    logWarn('admin.sanctions-list.audit', errName(err), { source: MHA_SOURCE });
  }
  return refused(error, rows);
}

export async function uploadMhaListAction(formData: FormData): Promise<MhaListActionResult> {
  await refuseOnSiteHost();
  const g = await gate();
  if ('ok' in g) return g;
  const staff = g;

  // Bounds, before reading the body: the size is checked BEFORE text().
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return refuseAudited(staff, t('admin.compliance.sanctionsLists.refused.noFile'), ['no_file']);
  }
  if (file.size > MHA_MAX_BYTES) {
    return refuseAudited(staff, t('admin.compliance.sanctionsLists.refused.tooLarge'), ['too_large']);
  }
  // The notification date. "Not after today" is measured in UTC (P28), as the contract date of
  // recordContractAction is.
  const version = formData.get('version');
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (!isCalendarDate(version) || version > todayUtc) {
    return refuseAudited(staff, t('admin.compliance.sanctionsLists.refused.badVersion'), ['bad_version']);
  }
  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    logWarn('admin.sanctions-list.read', errName(err), { source: MHA_SOURCE });
    return refuseAudited(staff, t('admin.compliance.sanctionsLists.refused.noFile'), ['no_file']);
  }
  const parsed = parseInMhaCsv(text);
  if (!parsed.ok) {
    const error =
      parsed.errors.length === 1 && ['bad_header', 'too_many_rows', 'no_rows'].includes(parsed.errors[0].code)
        ? mhaCodeCopy(parsed.errors[0].code)
        : t('admin.compliance.sanctionsLists.refused.rows');
    return refuseAudited(staff, error, parsed.errors.map((e) => e.code), parsed.errors);
  }
  if (parsed.list.entries.length < MHA_MIN_ENTRIES) {
    return refuseAudited(staff, t('admin.compliance.sanctionsLists.refused.tooFew'), ['too_few_entries']);
  }
  const list = { ...parsed.list, version };

  const stepUp = await gateStaffStepUp(staff, formData, 'sanctions_list.upload', { always: true });
  if (stepUp) return stepUp;

  const nameCount = list.entries.reduce((n, e) => n + e.names.length + (e.weakNames?.length ?? 0), 0);
  const metaOf = (outcome: string) => ({ source: MHA_SOURCE, version, hash: list.hash, entryCount: list.entries.length, nameCount, outcome });
  let outcome: MhaUploadOutcome | 'shrink' | 'stale';
  try {
    outcome = (await createSanctionsListRepo(getDb()).storeList(list, { minEntries: MHA_MIN_ENTRIES })).status;
  } catch (err) {
    if (err instanceof SanctionsListShrinkError) outcome = 'shrink';
    else if (err instanceof SanctionsListStaleError) outcome = 'stale';
    else {
      logWarn('admin.sanctions-list.store', errName(err), { source: MHA_SOURCE });
      return refused(t('admin.compliance.sanctionsLists.refused.failed'));
    }
  }
  try {
    await audit(staff, 'sanctions.list.upload', metaOf(outcome));
  } catch (err) {
    logWarn('admin.sanctions-list.audit', errName(err), { source: MHA_SOURCE });
  }
  revalidatePath(PAGE);
  if (outcome === 'shrink') return refused(t('admin.compliance.sanctionsLists.refused.shrink'));
  if (outcome === 'stale') return refused(t('admin.compliance.sanctionsLists.refused.stale'));
  return { ok: true, outcome };
}

export async function confirmMhaListCurrentAction(formData: FormData): Promise<MhaListActionResult> {
  await refuseOnSiteHost();
  const g = await gate();
  if ('ok' in g) return g;
  const staff = g;
  const repo = createSanctionsListRepo(getDb());
  const noList = () => refused(t('admin.compliance.sanctionsLists.refused.noList'));
  try {
    // A read before the step-up: no code is asked for a list that is not there.
    if (!(await repo.activeVersion(MHA_SOURCE))) return noList();
  } catch (err) {
    logWarn('admin.sanctions-list.read', errName(err), { source: MHA_SOURCE });
    return refused(t('admin.compliance.sanctionsLists.refused.failed'));
  }

  const stepUp = await gateStaffStepUp(staff, formData, 'sanctions_list.upload', { always: true });
  if (stepUp) return stepUp;

  let confirmed: { version: string; hash: string } | null;
  try {
    confirmed = await repo.touchActiveCheckedAt(MHA_SOURCE, new Date());
  } catch (err) {
    logWarn('admin.sanctions-list.confirm', errName(err), { source: MHA_SOURCE });
    return refused(t('admin.compliance.sanctionsLists.refused.failed'));
  }
  if (!confirmed) return noList();
  try {
    await audit(staff, 'sanctions.list.confirm', { source: MHA_SOURCE, version: confirmed.version, hash: confirmed.hash });
  } catch (err) {
    logWarn('admin.sanctions-list.audit', errName(err), { source: MHA_SOURCE });
  }
  revalidatePath(PAGE);
  return { ok: true, outcome: 'confirmed' };
}
