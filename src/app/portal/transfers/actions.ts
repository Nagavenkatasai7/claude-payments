'use server';

import { redirect } from 'next/navigation';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { portalOwner } from '@/lib/portal-transfers';
import { saveTransferFilter } from '@/lib/portal-transfer-filter';
import { getRedis } from '@/lib/redis';
import { logWarn } from '@/lib/log';

/**
 * The transfer list's search + status filter (UI redesign M2-7, Task 7.2). A recipient name is
 * PII-ish, so the form POSTs here and the filter is stored under a key bound to (host partner,
 * session phone); the redirect carries only an opaque `f`. Read-only otherwise (nothing to replay).
 */
export async function filterTransfersAction(formData: FormData): Promise<void> {
  await requirePortalSite();
  const ctx = await requirePortalCustomer();
  let f: string | null = null;
  try {
    f = await saveTransferFilter(getRedis(), portalOwner(ctx), { status: formData.get('status'), q: formData.get('q') });
  } catch (err) {
    logWarn('portal.transfer.filter', err);
  }
  redirect(f ? `/portal/transfers?f=${f}` : '/portal/transfers');
}
