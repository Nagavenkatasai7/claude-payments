import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createPaymentLinkRepo } from '@/db/repos/payment-link-repo';
import { linksExportCsv } from '@/lib/payment-link-bulk';
import { paymentLinkUrl } from '@/lib/pay-url';
import { PARTNER_ROUTES } from '../../../routes';

// GET /partner/payment-links/download (Batch B2): every payment link of the SESSION tenant as CSV
// (reference, customer, phone, rupees, purpose, company, status, expiry, the link while open, the
// transfer id once paid), so the partner can send the links themselves; SmartRemit sends nothing.
//
//  - refuseOnSiteHost() then requirePartnerStaff(PARTNER_ADMIN) FIRST, outside any try (both throw:
//    notFound / redirect, which Route Handlers support, as in reports/[id]/download/route.ts);
//  - the list is read INSIDE the tenant; the file holds customer names and phones, so the export is
//    audited (paylink.export, the row count only) BEFORE the response is built, and a failed audit
//    write sends nothing;
//  - every cell is formula-neutralised (csvCell); no-store, nosniff, attachment.

const MAX_LINKS = 5000;

export async function GET(): Promise<Response> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.paymentLinks.policy);
  const db = getDb();
  const links = await createPaymentLinkRepo(db).listForPartner(ctx.partnerId, { limit: MAX_LINKS });
  await createAuditRepo(db).record({
    partnerId: ctx.partnerId,
    actor: ctx.username,
    actorType: 'staff',
    action: 'paylink.export',
    meta: { rows: links.length },
  });
  const now = new Date();
  return new Response(linksExportCsv(links, paymentLinkUrl, now), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="payment-links-${now.toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
