import { getDb } from '@/db/client';
import { readEsignConsent } from '@/db/repos/customer-repo';
import { esignConsentView, type EsignConsentView } from '@/lib/esign-staff-withdraw';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { Card } from '@/components/ds';
import type { PartnerId } from '@/lib/types';
import { EsignWithdrawalForm } from './esign-form';

// Fix pack 6 truth check TC-T1: the "Electronic records" block of /partner/customers/[ref] (a
// SERVER component). The page reads the three consent columns of THIS tenant's customer (owner
// key, tenant in the WHERE, loadEsignConsentView); the block shows none / on file (text version,
// date) / withdrawn (date) and, only when on file, the "Record withdrawal" form (the action re-gates PARTNER_OPS: every role that can open
// this page). A failed read never breaks the page: the error NAME is logged and the block says
// "Not available right now.". Staff-facing only: the customer sees nothing new.

const WHEN = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

/**
 * The consent state of THIS tenant's customer for the block; null when the read failed (the error
 * NAME is logged, never the error object or the phone). Called by the page, so the block itself
 * stays a plain (synchronous) component.
 */
export async function loadEsignConsentView(partnerId: PartnerId, phone: string): Promise<EsignConsentView | null> {
  try {
    return esignConsentView(await readEsignConsent(getDb(), partnerId, phone));
  } catch (err) {
    logWarn('partner.customers.esign-read', err instanceof Error ? err.name : 'error', { partnerId });
    return null;
  }
}

export function EsignConsentBlock({ view, customerRef }: { view: EsignConsentView | null; customerRef: string }) {
  return (
    <div className="mt-5" data-testid="partner-customer-esign">
      <Card as="section" className="p-5 sm:p-6">
        <h2 className="text-[17px] font-bold text-ds-ink">{t('partner.customers.esign.title')}</h2>
        <p className="mt-1 text-[13px] text-ds-ink-muted">{t('partner.customers.esign.sub')}</p>
        <div className="mt-3 text-[14.5px] text-ds-ink">
          {view === null ? (
            <p>{t('partner.customers.esign.unavailable')}</p>
          ) : view.state === 'none' ? (
            <p>{t('partner.customers.esign.none')}</p>
          ) : view.state === 'on' ? (
            <>
              <p>{t('partner.customers.esign.on', { version: view.version ?? '', date: view.consentedAt ? WHEN.format(view.consentedAt) : '—' })}</p>
              <EsignWithdrawalForm customerRef={customerRef} />
            </>
          ) : (
            <p>{t('partner.customers.esign.withdrawn', { date: view.withdrawnAt ? WHEN.format(view.withdrawnAt) : '—' })}</p>
          )}
        </div>
      </Card>
    </div>
  );
}
