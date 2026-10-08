'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requirePlatformAdmin } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { decidePayee, PaymentLinkOpsError, revealPayeeBank } from '@/lib/payment-link-ops';
import type { PayeeDecision } from '@/lib/payees';

// /admin-dashboard/payees (Batch B2). Each export is a PUBLIC POST endpoint: it refuses a partner
// subdomain, then requirePlatformAdmin(), then hands the raw id and decision to payment-link-ops,
// which re-checks the actor, re-reads the payee, re-screens on approve and writes the change and
// its audit row in one transaction. Errors come back as a fixed code (the page shows fixed text).

const PAGE = '/admin-dashboard/payees';
const DECISIONS: readonly string[] = ['approve', 'reject', 'suspend'];

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v : '';
};

export async function decidePayeeAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  const decision = str(formData, 'decision');
  let error: string | null = null;
  if (!DECISIONS.includes(decision)) {
    error = 'invalid';
  } else {
    try {
      await decidePayee(getDb(), staff, str(formData, 'id'), decision as PayeeDecision);
    } catch (e) {
      if (!(e instanceof PaymentLinkOpsError)) throw e;
      error = e.code;
    }
  }
  revalidatePath(PAGE);
  // redirect() throws, so it stays outside the try.
  redirect(error === null ? `${PAGE}?ok=${decision}` : `${PAGE}?error=${error}`);
}

/** The audited reveal (one pii.reveal row per call). Returns fixed shapes only. */
export async function revealPayeeBankAction(
  payeeId: string,
): Promise<{ accountHolder: string; payoutDestination: string } | { error: string }> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  try {
    return await revealPayeeBank(getDb(), staff, typeof payeeId === 'string' ? payeeId : '');
  } catch (e) {
    if (e instanceof PaymentLinkOpsError) return { error: 'Payee not found' };
    throw e;
  }
}
