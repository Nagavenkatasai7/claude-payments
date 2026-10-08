import Link from 'next/link';
import type { ReactNode } from 'react';
import { Gift, Send, ShieldAlert, Wallet } from 'lucide-react';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { listPortalTransfers, portalOwner } from '@/lib/portal-transfers';
import { getPartnerStore } from '@/lib/partner-store';
import { isSendVerified, sendGateActive } from '@/lib/kyc-gate';
import { getStore } from '@/lib/store';
import { getDailyVolumeStore } from '@/lib/daily-volume-store';
import { resolveEffectiveSendLimits } from '@/lib/send-limits';
import { buildSummaryContext } from '@/lib/customer-summary';
import { sentThisMonthUsd } from '@/lib/customer-stats';
import { recipientRid } from '@/lib/portal-recipients';
import { maskAccount } from '@/lib/tools';
import { getDb } from '@/db/client';
import { createRecipientRepo } from '@/db/repos/aux-repos';
import { t } from '@/lib/i18n';
import { formatMoney } from '@/lib/ui/money';
import { Button, Card, EmptyState, Money, PageHeader } from '@/components/ds';
import { TransferRows } from './transfers/transfer-rows';
import { portalMetadata } from '@/lib/portal-metadata';
import { loadMyRewards, type MyRewards } from '@/lib/rewards/read';

export const generateMetadata = () => portalMetadata('portal.home.title');

/** How many transfers the tiles read (the legacy /account home's window). */
const STATS_SCAN = 200;
/** Saved recipients shown on the home (the legacy /account home's count). */
const SAVED_MAX = 6;

/** One number tile: a label, the value, and a small line under it. */
function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub: string }) {
  return (
    <Card className="flex flex-col gap-1 p-4 sm:p-5">
      <p className="text-[12px] font-semibold uppercase tracking-wide text-ds-ink-muted">{label}</p>
      <p className="text-[22px] font-bold text-ds-ink tabular-nums">{value}</p>
      <p className="text-[12px] text-ds-ink-muted">{sub}</p>
    </Card>
  );
}

/**
 * B3 rewards v1: the "My rewards" card. Only while rewards are active for this customer (demo mode
 * AND the rewards.enabled switch, loadMyRewards returns null otherwise): the offers that are on and
 * the rewards the customer kept. Escaped text only.
 */
function MyRewardsCard({ rewards }: { rewards: MyRewards }) {
  return (
    <div data-my-rewards>
      <Card as="section" className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 text-[18px] font-bold text-ds-ink">
          <Gift aria-hidden="true" className="size-5" />
          {t('portal.home.rewards.title')}
        </h2>
        {rewards.offers.length > 0 ? (
          <div>
            <p className="text-[13px] font-semibold uppercase tracking-wide text-ds-ink-muted">{t('portal.home.rewards.offers')}</p>
            <ul className="mt-1 list-disc pl-5 text-[14px] text-ds-ink">
              {rewards.offers.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div>
          <p className="text-[13px] font-semibold uppercase tracking-wide text-ds-ink-muted">{t('portal.home.rewards.kept')}</p>
          {rewards.kept.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-1 text-[14px] text-ds-ink">
              {rewards.kept.map((k) => (
                <li key={k.transferId}>
                  <Link href={`/portal/transfers/${encodeURIComponent(k.transferId)}`} className="hover:underline">
                    {k.text}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[14px] text-ds-ink-muted">{t('portal.home.rewards.none')}</p>
          )}
        </div>
      </Card>
    </div>
  );
}

/**
 * Home (UI redesign M2-7, Task 7.2): quick send, the KYC banner when the partner gates sends and the
 * customer is not verified, and the last 5 transfers (masked). The gates run on every render (the
 * layout is never the guard).
 *
 * One customer portal (Oct 2): also the legacy /account home's four tiles (sent this month, daily
 * limit left, transfers, pending refunds; the same numbers, from the same helpers the bot's
 * check_send_limit uses) and the saved recipients with "Send again" (the send page pre-selects the
 * rid, src/app/portal/send/page.tsx). Every read is keyed by the HOST's partner and the SESSION
 * phone, never by request input; the recipient list shows masked accounts only.
 */
export default async function PortalHomePage() {
  const site = await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const owner = portalOwner(ctx);
  const [recent, partner, scanned, todayUsedCents, book, rewards] = await Promise.all([
    listPortalTransfers(owner, { limit: 5 }),
    getPartnerStore().getPartner(site.partnerId),
    getStore().listTransfersByPhone(owner.partnerId, owner.phone, STATS_SCAN),
    getDailyVolumeStore().getTodayCents(owner.partnerId, owner.phone),
    createRecipientRepo(getDb()).listAllForSender(owner.partnerId, owner.phone),
    loadMyRewards(getDb(), getStore(), owner.partnerId, owner.phone, new Date(), (usd) => formatMoney(usd, 'USD')),
  ]);
  const gateActive = sendGateActive(partner);
  const kycNeeded = gateActive && !isSendVerified(ctx.customer);
  const cap = buildSummaryContext(ctx.customer, scanned, todayUsedCents, gateActive, resolveEffectiveSendLimits(partner, ctx.customer));
  const saved = book.slice(0, SAVED_MAX).map((r) => ({
    rid: recipientRid(owner.partnerId, owner.phone, r.recipientPhone),
    name: r.name,
    masked: maskAccount(r.payoutMethod, r.payoutDestination),
  }));

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

        <div data-stat-tiles className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label={t('portal.home.stat.sentMonth')} value={<Money amount={sentThisMonthUsd(scanned, new Date())} currency="USD" />} sub={t('portal.home.stat.sentMonthSub')} />
          <StatTile
            label={t('portal.home.stat.dailyLeft')}
            value={<Money amount={cap.dailyRemainingUsd} currency="USD" />}
            sub={t('portal.home.stat.dailyLeftSub', { limit: formatMoney(cap.dailyLimitUsd, 'USD') })}
          />
          <StatTile label={t('portal.home.stat.transfers')} value={scanned.length} sub={t('portal.home.stat.transfersSub')} />
          <StatTile label={t('portal.home.stat.refunds')} value={cap.pendingRefunds} sub={t('portal.home.stat.refundsSub')} />
        </div>

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

        {rewards ? <MyRewardsCard rewards={rewards} /> : null}

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

        {saved.length > 0 && !kycNeeded ? (
          <section aria-labelledby="saved-heading" data-saved-recipients className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 id="saved-heading" className="text-[18px] font-bold text-ds-ink">
                {t('portal.home.savedTitle')}
              </h2>
              <Link href="/portal/recipients" className="text-[14px] font-semibold text-ds-primary hover:underline">
                {t('portal.home.viewAll')}
              </Link>
            </div>
            <ul className="grid gap-3 sm:grid-cols-2">
              {saved.map((r) => (
                <li key={r.rid}>
                  <Card className="flex items-center justify-between gap-3 p-4 sm:p-4">
                    <div className="min-w-0">
                      <p className="truncate text-[15px] font-semibold text-ds-ink">{r.name}</p>
                      <p className="truncate text-[13px] text-ds-ink-muted tabular-nums">{r.masked}</p>
                    </div>
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/portal/send?r=${encodeURIComponent(r.rid)}`} aria-label={t('portal.home.sendAgainTo', { name: r.name })}>
                        {t('portal.home.sendAgain')}
                      </Link>
                    </Button>
                  </Card>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </>
  );
}
