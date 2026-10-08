import type { Metadata } from 'next';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { createRewardRepo } from '@/db/repos/reward-repo';
import { computeStatement, statementMonth, type Statement } from '@/lib/rewards/statement';
import { festivalFormState } from '@/lib/rewards/settings';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { formatMoney } from '@/lib/ui/money';
import { Badge, Card, PageHeader } from '@/components/ds';
import { PARTNER_ROUTES } from '../../routes';
import { FestivalRewardForm, NthRewardForm } from './reward-forms';

export const metadata: Metadata = { title: t('partner.rewards.title'), robots: { index: false, follow: false } };

// /partner/rewards (B3 rewards v1): the tenant's own customer rewards (every Nth transfer free, a
// festival offer), inside the limits the SmartRemit admin catalog sets; the money terms SmartRemit
// set (read only); and this month's statement. Partner ADMIN only; the page gates itself and reads
// the SESSION tenant only (every read takes ctx.partnerId). Customers see a reward only while the
// rewards.enabled switch is on for this partner (and, during the beta, on demo-mode phones).

const H2 = 'text-[18px] font-extrabold text-ds-ink';
const INTRO = 'mt-1 mb-4 text-[14px] text-ds-ink-muted';
const usd = (n: number) => formatMoney(n, 'USD');

function StatementCard({ s }: { s: Statement | null }) {
  const row = 'flex flex-wrap items-center justify-between gap-2 py-2.5';
  const month = s?.month ?? '';
  return (
    <Card as="section" className="p-5 sm:p-6">
      <h2 className={H2}>{t('partner.rewards.statement.title', { month })}</h2>
      {s === null ? (
        <p role="alert" className="mt-3 text-[14px] text-ds-danger-ink">{t('partner.rewards.statement.error')}</p>
      ) : (
        <dl data-testid="rewards-statement" className="mt-3 divide-y divide-ds-border text-[14px] tabular-nums">
          <div className={row}><dt className="text-ds-ink-muted">{t('partner.rewards.statement.delivered')}</dt><dd>{s.deliveredCount}</dd></div>
          <div className={row}><dt className="text-ds-ink-muted">{t('partner.rewards.statement.feeOwed')}</dt><dd>{usd(s.feeOwedUsd)}</dd></div>
          <div className={row}><dt className="text-ds-ink-muted">{t('partner.rewards.statement.rewards')}</dt><dd>{s.rewardsGiven.count} · {usd(s.rewardsGiven.usd)}</dd></div>
          <div className={row}><dt className="text-ds-ink-muted">{t('partner.rewards.statement.firstFree')}</dt><dd>{s.firstTransferFree.count} · {usd(s.firstTransferFree.usd)}</dd></div>
          <div className={row}><dt className="text-ds-ink-muted">{t('partner.rewards.statement.credit')}</dt><dd>{usd(s.giveBackCreditUsd)}</dd></div>
          <div className={row}><dt className="font-semibold text-ds-ink">{t('partner.rewards.statement.net')}</dt><dd className="font-bold">{usd(s.netUsd)}</dd></div>
        </dl>
      )}
    </Card>
  );
}

export default async function PartnerRewardsPage() {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.rewards.policy);
  const repo = createRewardRepo(getDb());
  const month = statementMonth(undefined);
  const [catalog, settings, terms] = await Promise.all([
    repo.getCatalog(),
    repo.getPartnerSettings(ctx.partnerId),
    repo.getTerms(ctx.partnerId),
  ]);
  let statement: Statement | null = null;
  try {
    const [facts] = await repo.statementFacts(month, ctx.partnerId);
    statement = computeStatement(month, facts ?? { partnerId: ctx.partnerId, deliveredCount: 0, feeOwedUsd: 0, rewards: [] }, terms);
  } catch (err) {
    logWarn('partner.rewards.page', err instanceof Error ? err.name : 'error', { partnerId: ctx.partnerId });
  }
  const nth = settings.nth_transfer;
  const fest = settings.festival;
  const festState = festivalFormState(catalog.festival, fest);

  return (
    <>
      <PageHeader title={t('partner.rewards.title')} sub={t('partner.rewards.sub')} />
      <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
        <p className="text-[14px] text-ds-ink-muted">{t('partner.rewards.firstFree')}</p>

        <Card as="section" className="p-5 sm:p-6">
          <h2 className={H2}>{t('partner.rewards.terms.title')}</h2>
          <p className={INTRO}>{t('partner.rewards.terms.intro')}</p>
          <dl data-testid="rewards-terms" className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-2 text-[14px] tabular-nums">
            <dt className="text-ds-ink-muted">{t('partner.rewards.terms.fee')}</dt>
            <dd className="justify-self-end text-ds-ink">{usd(terms.platformFeeUsd)}</dd>
            <dt className="text-ds-ink-muted">{t('partner.rewards.terms.giveBack')}</dt>
            <dd className="justify-self-end text-ds-ink">{terms.giveBackPct}%</dd>
            <dt className="text-ds-ink-muted">{t('partner.rewards.terms.budget')}</dt>
            <dd className="justify-self-end text-ds-ink">{usd(terms.monthlyBudgetUsd)}</dd>
          </dl>
          {terms.monthlyBudgetUsd <= 0 ? (
            <p className="mt-3 text-[13.5px] font-semibold text-ds-warning-ink">{t('partner.rewards.terms.noBudget')}</p>
          ) : null}
        </Card>

        <Card as="section" className="p-5 sm:p-6">
          <h2 className={`${H2} flex flex-wrap items-center gap-2`}>
            {t('partner.rewards.nth.title')}
            {nth?.enabled ? <Badge tone="success">on</Badge> : <Badge tone="neutral">off</Badge>}
          </h2>
          <p className={INTRO}>{t('partner.rewards.nth.intro', { max: usd(catalog.nth_transfer.maxDiscountUsd) })}</p>
          {catalog.nth_transfer.available || nth?.enabled ? (
            <NthRewardForm enabled={nth?.enabled ?? false} nth={nth?.nth ?? null} min={catalog.nth_transfer.nthMin} max={catalog.nth_transfer.nthMax} />
          ) : (
            <p className="text-[14px] text-ds-ink-muted">{t('partner.rewards.unavailable')}</p>
          )}
        </Card>

        <Card as="section" className="p-5 sm:p-6">
          <h2 className={`${H2} flex flex-wrap items-center gap-2`}>
            {t('partner.rewards.festival.title')}
            {fest?.enabled ? <Badge tone="success">on</Badge> : <Badge tone="neutral">off</Badge>}
          </h2>
          <p className={INTRO}>
            {t('partner.rewards.festival.intro', { days: catalog.festival.maxDays, max: usd(catalog.festival.maxDiscountUsd) })}
          </p>
          {festState === 'form' ? (
            <FestivalRewardForm
              names={catalog.festival.festivalNames}
              current={{
                enabled: fest?.enabled ?? false,
                festivalName: fest?.festivalName ?? '',
                startsOn: fest?.startsOn ?? '',
                endsOn: fest?.endsOn ?? '',
                minAmountUsd: fest?.minAmountUsd !== null && fest?.minAmountUsd !== undefined ? fest.minAmountUsd.toFixed(2) : '0',
              }}
            />
          ) : festState === 'no_festivals' ? (
            <p className="text-[14px] text-ds-ink-muted" data-testid="rewards-festival-none">{t('partner.rewards.festival.none')}</p>
          ) : (
            <p className="text-[14px] text-ds-ink-muted">{t('partner.rewards.unavailable')}</p>
          )}
        </Card>

        <StatementCard s={statement} />
      </div>
    </>
  );
}
