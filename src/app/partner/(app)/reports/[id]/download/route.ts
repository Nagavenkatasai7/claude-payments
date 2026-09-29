import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createPartnerReportRepo } from '@/db/repos/partner-report-repo';
import { isJobId, isReportKind, reportAllows, reportFilename } from '@/lib/partner-reports';
import { openReportCsv } from '@/lib/partner-report-worker';
import { scopeOf } from '@/lib/staff-scope';
import { logWarn } from '@/lib/log';
import { PARTNER_ROUTES } from '../../../../routes';

// GET /partner/reports/<id>/download (UI redesign M3-16): one ready report of the SESSION tenant.
//
//  - refuseOnSiteHost() then requirePartnerStaff(money read) FIRST, outside any try: both throw
//    (notFound / redirect), which Route Handlers support (node_modules/next/dist/docs/01-app/
//    03-api-reference/04-functions/redirect.md:10,51 and not-found.md:15);
//  - params is a Promise in this Next (…/03-file-conventions/route.md:80-95);
//  - the id must be a uuid (else 404 before any query); the job is read INSIDE the tenant; a
//    missing, foreign, not-ready, expired (by status OR by expires_at, the daily sweep may lag)
//    job, or a kind the role may not open (reportPolicy), is the SAME 404 (404-never-403);
//  - the CSV is opened under the fetched row's own (tenant, id) context; report.download is
//    audited BEFORE the response is built, and a failed audit write sends nothing;
//  - one non-streamed Response (<= MAX_REPORT_BYTES, inside Vercel's 4.5 MB response cap),
//    no-store, nosniff, attachment with a fixed filename.

function notFoundResponse(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.reports.policy);
  const { id } = await params;
  if (!isJobId(id)) return notFoundResponse();

  const job = await createPartnerReportRepo(getDb()).getJobForPartner(ctx.partnerId, id);
  const now = Date.now();
  if (
    !job ||
    job.status !== 'ready' ||
    !job.contentEnc ||
    !job.expiresAt ||
    job.expiresAt.getTime() <= now ||
    !isReportKind(job.kind) ||
    !reportAllows(job.kind, ctx.role)
  ) {
    return notFoundResponse();
  }

  let csv: string;
  try {
    csv = openReportCsv(job);
  } catch (err) {
    logWarn('partner.reports.download', err instanceof Error ? err.name : 'error', { jobId: job.id });
    return notFoundResponse();
  }

  await createAuditRepo(getDb()).record({
    partnerId: ctx.partnerId,
    actor: ctx.username,
    actorType: 'staff',
    action: 'report.download',
    subjectId: job.id,
    meta: { kind: job.kind, actorScope: scopeOf(ctx.staff).kind },
  });

  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${reportFilename(job.kind, job.completedAt ?? new Date(now))}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
