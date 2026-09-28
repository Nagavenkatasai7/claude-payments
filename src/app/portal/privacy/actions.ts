'use server';

import { notFound, redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { env } from '@/lib/env';
import { requirePortalSite } from '@/lib/portal-site';
import { requireFreshPortalAuth } from '@/lib/portal-auth';
import { runOnce, BadRequestKeyError, RequestInFlightError } from '@/lib/portal-request-key';
import { isReasonValid, DEFAULT_REASON_MIN } from '@/lib/ui/confirm-reason';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { auditSubjectId } from '@/lib/customer-ref';
import { PORTAL_AUTH_ACTOR } from '@/lib/portal-auth-audit';
import { dataRequestAlertMessage, dataRequestDedupeKey, isDataRequestKind, PORTAL_PRIVACY_LIMIT } from '@/lib/portal-data-rights';
import { pokeWorker } from '@/lib/outbox';
import { getRedis } from '@/lib/redis';
import { logWarn } from '@/lib/log';

/**
 * File a data request: "Export my data" or "Delete my account" (UI redesign M2-13, Task 13.2).
 * A PUBLIC POST endpoint (Next checks Origin against Host for server actions). In order:
 *  1. requirePortalSite() FIRST (the host gate; the scanner pins it);
 *  2. CUSTOMER_DATA_RIGHTS_ENABLED off → 404, exactly like a page that does not exist;
 *  3. `kind` is bound on the page but travels from the client: a closed set, else 404;
 *  4. requireFreshPortalAuth (the WhatsApp-code step-up, plus TOTP when enrolled);
 *  5. the typed reason is re-validated here (the ConfirmDialog check is UX only). It is NOT stored:
 *     it is free text and may carry PII; the audit meta is `{ kind }` only;
 *  6. runOnce on the bound request key (a double submit files one request);
 *  7. inside it: 3 requests per customer per day, then ONE transaction with the audit row and the
 *     ops alert (deduped per subject, kind and UTC day; no phone in it).
 * No export job, no erasure, no table (SPEC §6b: compliance loop A owns those). redirect() is called
 * outside every try (it throws).
 */
export async function requestDataAction(kind: string, requestKey: string, formData: FormData): Promise<void> {
  await requirePortalSite();
  if (!env.customerDataRightsEnabled) notFound();
  if (!isDataRequestKind(kind)) notFound();
  const ctx = await requireFreshPortalAuth('/portal/privacy');
  if (!isReasonValid(formData.get('reason'), DEFAULT_REASON_MIN)) redirect('/portal/privacy?status=reason');

  const partnerId = ctx.site.partnerId;
  const phone = ctx.session.phone;
  const subjectId = auditSubjectId(partnerId, phone);
  let status: string;
  try {
    ({ status } = (
      await runOnce(getRedis(), 'portal-privacy', partnerId, phone, requestKey, async () => {
        const rl = await checkIpRateLimit(getRedis(), PORTAL_PRIVACY_LIMIT.scope, subjectId, {
          limit: PORTAL_PRIVACY_LIMIT.limit,
          windowSec: PORTAL_PRIVACY_LIMIT.windowSec,
        });
        if (!rl.allowed) return { status: 'rate_limited' };
        const db = getDb();
        await db.transaction(async (tx) => {
          await createAuditRepo(tx).record({
            partnerId,
            actor: PORTAL_AUTH_ACTOR,
            actorType: 'system',
            action: 'customer.data_request',
            subjectId,
            meta: { kind },
          });
          await createOutboxRepo(tx).enqueue(
            'ops.alert',
            { message: dataRequestAlertMessage(kind, partnerId, subjectId) },
            { dedupeKey: dataRequestDedupeKey(subjectId, kind, Date.now()) },
          );
        });
        pokeWorker();
        return { status: 'requested' };
      })
    ).value);
  } catch (err) {
    if (err instanceof BadRequestKeyError) status = 'expired';
    else if (err instanceof RequestInFlightError) status = 'in_flight';
    else {
      logWarn('portal.privacy.request', err);
      status = 'failed';
    }
  }
  redirect(`/portal/privacy?status=${status}`);
}
