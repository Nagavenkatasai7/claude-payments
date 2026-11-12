import { getDb } from '@/db/client';
import { readEsignConsent } from '@/db/repos/customer-repo';
import { esignConsentView, type EsignConsentView } from '@/lib/esign-staff-withdraw';
import { logWarn } from '@/lib/log';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { PartnerId } from '@/lib/types';
import { recordEsignWithdrawalAdminAction } from '../esign-actions';

// Fix pack 6 truth check TC-T1: the "Electronic records" card of /admin-dashboard/customers/[ref]
// (a SERVER component, like the page's other forms). The page reads the three consent columns of
// the RESOLVED customer (owner key, tenant in the WHERE, loadEsignConsentView); the card shows
// none / on file (text version, date) / withdrawn (date); only when on file and the viewer is an
// admin, the "Record withdrawal" form
// (the action re-gates requireAdmin and pins the tenant). A failed read never breaks the page: the
// error NAME is logged and the card says "Not available right now.". Staff-facing only.

function when(d: Date | undefined): string {
  return d ? d.toLocaleString() : '—';
}

/**
 * The consent state of the RESOLVED customer for the card; null when the read failed (the error
 * NAME is logged, never the error object or the phone). Called by the page, so the card itself
 * stays a plain (synchronous) component.
 */
export async function loadEsignConsentView(partnerId: PartnerId, phone: string): Promise<EsignConsentView | null> {
  try {
    return esignConsentView(await readEsignConsent(getDb(), partnerId, phone));
  } catch (err) {
    logWarn('admin.customers.esign-read', err instanceof Error ? err.name : 'error', { partnerId });
    return null;
  }
}

export function EsignConsentCard({
  view,
  partnerId,
  phone,
  canWithdraw,
}: {
  view: EsignConsentView | null;
  partnerId: PartnerId;
  phone: string;
  canWithdraw: boolean;
}) {
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Electronic records</CardTitle>
        <CardDescription>The next pay-page payment asks the customer again.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {view === null ? (
          <p>Not available right now.</p>
        ) : view.state === 'none' ? (
          <p>No consent on file.</p>
        ) : view.state === 'withdrawn' ? (
          <p>Consent withdrawn {when(view.withdrawnAt)}.</p>
        ) : (
          <>
            <p>
              Consent on file (text {view.version}), given {when(view.consentedAt)}.
            </p>
            {canWithdraw && (
              <form action={recordEsignWithdrawalAdminAction} className="space-y-3">
                <input type="hidden" name="phone" value={phone} />
                <input type="hidden" name="partnerId" value={partnerId} />
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="confirm" required />
                  The customer asked to withdraw this consent.
                </label>
                <Button type="submit" variant="outline">Record withdrawal</Button>
              </form>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
