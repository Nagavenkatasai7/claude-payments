import Link from 'next/link';
import { Send, ShieldAlert, Wallet } from 'lucide-react';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { listPortalTransfers, portalOwner } from '@/lib/portal-transfers';
import { getPartnerStore } from '@/lib/partner-store';
import { isSendVerified, sendGateActive } from '@/lib/kyc-gate';
import { t } from '@/lib/i18n';
import { Button, Card, EmptyState, PageHeader } from '@/components/ds';
import { TransferRows } from './transfers/transfer-rows';
import { portalMetadata } from '@/lib/portal-metadata';

export const generateMetadata = () => portalMetadata('portal.home.title');

/**
 * Home (UI redesign M2-7, Task 7.2): quick send, the KYC banner when the partner gates sends and the
 * customer is not verified, and the last 5 transfers (masked). The gates run on every render (the
 * layout is never the guard).
 */
export default async function PortalHomePage() {
  const site = await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const [recent, partner] = await Promise.all([
    listPortalTransfers(portalOwner(ctx), { limit: 5 }),
    getPartnerStore().getPartner(site.partnerId),
  ]);
  const kycNeeded = sendGateActive(partner) && !isSendVerified(ctx.customer);

  return (
    <>
      <PageHeader title={t('portal.home.title')} sub={t('portal.home.sub', { brand: site.brand })} />
      <div className="flex flex-col gap-6">
        {kycNeeded ? (
          <div
            data-kyc-banner
            role="status"
            className="flex flex-wrap items-start gap-3 rounded-ds-card border border-ds-warning-border bg-ds-warning-bg p-4 text-ds-warning-ink"
          >
            <ShieldAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{t('portal.home.kycTitle')}</p>
              <p className="mt-1 text-[14px]">{t('portal.home.kycBody')}</p>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link href="/portal/profile">{t('portal.home.kycCta')}</Link>
            </Button>
          </div>
        ) : null}

        <Card className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-[18px] font-bold text-ds-ink">{t('portal.home.sendTitle')}</h2>
            <p className="mt-1 text-[14px] text-ds-ink-muted">{t('portal.home.sendBody')}</p>
          </div>
          <Button asChild size="md">
            <Link href="/portal/send">
              <Send aria-hidden="true" className="size-4" />
              {t('portal.home.sendCta')}
            </Link>
          </Button>
        </Card>

        <section aria-labelledby="recent-heading" className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 id="recent-heading" className="text-[18px] font-bold text-ds-ink">
              {t('portal.home.recentTitle')}
            </h2>
            {recent.items.length > 0 ? (
              <Link href="/portal/transfers" className="text-[14px] font-semibold text-ds-primary hover:underline">
                {t('portal.home.viewAll')}
              </Link>
            ) : null}
          </div>
          {recent.items.length > 0 ? (
            <TransferRows rows={recent.items} caption={t('portal.home.recentTitle')} />
          ) : (
            <div data-empty>
              <EmptyState icon={<Wallet className="size-5" />} title={t('portal.home.emptyTitle')} body={t('portal.home.emptyBody')} />
            </div>
          )}
        </section>
      </div>
    </>
  );
}
