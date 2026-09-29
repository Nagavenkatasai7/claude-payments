'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createPartnerReportRepo } from '@/db/repos/partner-report-repo';
import { pokeWorker } from '@/lib/outbox';
import {
  ACTIVE_JOB_WINDOW_MS,
  DAILY_JOB_CAP,
  MAX_ACTIVE_JOBS,
  isReportKind,
  parseReportRequest,
  reportPolicy,
  type ReportRequestError,
} from '@/lib/partner-reports';
import { scopeOf } from '@/lib/staff-scope';
import { t, type MessageKey } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { ActionResult } from '../../action-result';
import { PARTNER_ROUTES } from '../../routes';

// /partner/reports server action (UI redesign M3-16). The shared /partner action shape:
//  - refuseOnSiteHost() first, then the gate (outside any try): the page policy (money read),
//    then reportPolicy(kind) for the chosen kind, so an agent may export transfers but is bounced
//    to /partner for settlements / fees. Nav hiding is never the guard;
//  - the tenant is ALWAYS ctx.partnerId: no partnerId / partner / id field is read;
//  - ONE transaction: lock the tenant row (so the caps are counted one request at a time), the
//    concurrency cap (recent queued/running jobs) and the daily cap, the job row, its outbox
//    'partner.report' effect { jobId } (dedupe report:<jobId>) and the report.request audit row.
//    Nothing is written unless all of it is. Then pokeWorker() (after the commit);
//  - errors are fixed, translated copy: never an exception message, never input echoed back.

const DAY_MS = 86_400_000;

const ERR_KEYS: Record<ReportRequestError, MessageKey> = {
  kind: 'partner.reports.err.kind',
  date: 'partner.reports.err.date',
  window: 'partner.reports.err.window',
  future: 'partner.reports.err.future',
};

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

export async function requestReportAction(formData: FormData): Promise<ActionResult> {
  await refuseOnSiteHost();
  await requirePartnerStaff(PARTNER_ROUTES.reports.policy);
  const kind = formData.get('kind');
  if (!isReportKind(kind)) return { ok: false, error: t(ERR_KEYS.kind) };
  // The per-kind gate: a role outside reportPolicy(kind) is redirected to /partner (no write).
  const ctx = await requirePartnerStaff(reportPolicy(kind));

  const parsed = parseReportRequest(formData, new Date());
  if (!parsed.ok) return { ok: false, error: t(ERR_KEYS[parsed.error]) };
  const params = parsed.params as unknown as Record<string, unknown>;
  const window = 'month' in parsed.params ? { month: parsed.params.month } : { from: parsed.params.from, to: parsed.params.to };

  const id = randomUUID();
  let outcome: 'ok' | 'missing' | 'busy' | 'daily';
  try {
    outcome = await getDb().transaction(async (tx) => {
      const repo = createPartnerReportRepo(tx);
      if (!(await repo.lockTenant(ctx.partnerId))) return 'missing';
      const now = Date.now();
      if ((await repo.countActive(ctx.partnerId, new Date(now - ACTIVE_JOB_WINDOW_MS))) >= MAX_ACTIVE_JOBS) return 'busy';
      if ((await repo.countSince(ctx.partnerId, new Date(now - DAY_MS))) >= DAILY_JOB_CAP) return 'daily';
      await repo.createJob(ctx.partnerId, { id, kind: parsed.kind, params, requestedBy: ctx.username });
      await createOutboxRepo(tx).enqueue('partner.report', { jobId: id }, { dedupeKey: `report:${id}` });
      await createAuditRepo(tx).record({
        partnerId: ctx.partnerId,
        actor: ctx.username,
        actorType: 'staff',
        action: 'report.request',
        subjectId: id,
        // Server-derived scope; the window is dates only (never PII).
        meta: { kind: parsed.kind, window, actorScope: scopeOf(ctx.staff).kind },
      });
      return 'ok';
    });
  } catch (err) {
    logWarn('partner.reports.request', errName(err), { partnerId: ctx.partnerId });
    return { ok: false, error: t('partner.reports.err.failed') };
  }
  if (outcome === 'missing') return { ok: false, error: t('partner.reports.err.notFound') };
  if (outcome === 'busy') return { ok: false, error: t('partner.reports.err.busy', { max: MAX_ACTIVE_JOBS }) };
  if (outcome === 'daily') return { ok: false, error: t('partner.reports.err.daily') };
  pokeWorker();
  revalidatePath(PARTNER_ROUTES.reports.href);
  return { ok: true };
}
