import { CircleAlert, CircleCheck, CircleMinus, TriangleAlert } from 'lucide-react';
import { t } from '@/lib/i18n';
import { Badge, Card, Money, type Tone } from '@/components/ds';
import type { HealthView, PartnerHomeModel, PartnerKpis } from '@/lib/partner-home';

// Server components for /partner (home, UI redesign M3-3). They render the pure model only: counts,
// rounded USD aggregates and health states. No PII, no URL, no key id reaches them. The data-*
// attributes are test hooks and carry only fixed keys and states.

const STATE_VIEW: Record<HealthView, { tone: Tone; Icon: typeof CircleCheck }> = {
  ok: { tone: 'success', Icon: CircleCheck },
  attention: { tone: 'warning', Icon: TriangleAlert },
  off: { tone: 'neutral', Icon: CircleMinus },
  error: { tone: 'danger', Icon: CircleAlert },
};

const H2 = 'text-[17px] font-semibold text-ds-ink';

function CardError({ card }: { card: string }) {
  return (
    <p role="status" data-card-error={card} className="mt-3 text-[15px] leading-relaxed text-ds-ink-muted">
      {t('partner.home.cardError')}
    </p>
  );
}

export function KpiRow({ kpis }: { kpis: PartnerKpis | 'error' }) {
  return (
    <Card as="section" className="p-5 sm:p-6">
      <h2 className={H2}>{t('partner.home.kpisTitle')}</h2>
      {kpis === 'error' ? (
        <CardError card="kpis" />
      ) : (
        <>
          <dl className="mt-4 grid gap-4 sm:grid-cols-3">
            <div className="rounded-ds-inner border border-ds-border bg-ds-ground p-4">
              <dt className="text-[13px] font-semibold text-ds-ink-muted">{t('partner.home.kpi.countToday')}</dt>
              <dd className="mt-1 text-[24px] font-extrabold tracking-[-0.02em] text-ds-ink tabular-nums">
                <span data-kpi="countToday">{kpis.countToday}</span>
              </dd>
            </div>
            <div className="rounded-ds-inner border border-ds-border bg-ds-ground p-4">
              <dt className="text-[13px] font-semibold text-ds-ink-muted">{t('partner.home.kpi.volumeToday')}</dt>
              <dd className="mt-1 text-[24px] font-extrabold tracking-[-0.02em] text-ds-ink">
                <span data-kpi="volumeToday">
                  <Money amount={kpis.volumeTodayUsd} currency="USD" />
                </span>
              </dd>
            </div>
            <div className="rounded-ds-inner border border-ds-border bg-ds-ground p-4">
              <dt className="text-[13px] font-semibold text-ds-ink-muted">{t('partner.home.kpi.feesToday')}</dt>
              <dd className="mt-1 text-[24px] font-extrabold tracking-[-0.02em] text-ds-ink">
                <span data-kpi="feesToday">
                  <Money amount={kpis.feesTodayUsd} currency="USD" />
                </span>
              </dd>
              <dd className="mt-1 text-[12.5px] text-ds-ink-subtle">{t('partner.home.kpi.feesHint')}</dd>
            </div>
          </dl>
          <p className="mt-3 text-[13px] text-ds-ink-subtle">{t('partner.home.kpisNote')}</p>
        </>
      )}
    </Card>
  );
}

export function HealthCard({ health }: { health: PartnerHomeModel['health'] }) {
  return (
    <Card as="section" className="p-5 sm:p-6">
      <h2 className={H2}>{t('partner.home.healthTitle')}</h2>
      <ul className="mt-4 divide-y divide-ds-border">
        {health.map(({ key, state }) => {
          const { tone, Icon } = STATE_VIEW[state];
          return (
            <li
              key={key}
              data-health={key}
              data-state={state}
              className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"
            >
              <span className="text-[15px] font-medium text-ds-ink">{t(`partner.home.health.${key}`)}</span>
              <Badge tone={tone}>
                <Icon aria-hidden="true" className="size-3.5" />
                {t(`partner.home.state.${state}`)}
              </Badge>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function ActionList({ actions, incomplete }: { actions: PartnerHomeModel['actions']; incomplete: boolean }) {
  return (
    <Card as="section" className="p-5 sm:p-6">
      <h2 className={H2}>{t('partner.home.actionsTitle')}</h2>
      {actions.length > 0 ? (
        // Links arrive with the pages they point at (M3-5 transfers, M3-13..15 integrations): until
        // then each item is text, so the page never links to a route PARTNER_ROUTES does not list.
        <ul className="mt-4 space-y-2">
          {actions.map(({ key, count }) => (
            <li
              key={key}
              data-action={key}
              className="flex items-start gap-2 rounded-ds-inner border border-ds-warning-border bg-ds-warning-bg px-3 py-2 text-[15px] text-ds-warning-ink"
            >
              <TriangleAlert aria-hidden="true" className="mt-1 size-4 shrink-0" />
              <span>{t(`partner.home.action.${key}`, { count })}</span>
            </li>
          ))}
        </ul>
      ) : incomplete ? null : (
        <p className="mt-3 flex items-center gap-2 text-[15px] text-ds-ink-muted">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
          {t('partner.home.actionsEmpty')}
        </p>
      )}
      {incomplete ? (
        <p role="status" data-actions-incomplete="" className="mt-3 text-[13px] text-ds-ink-subtle">
          {t('partner.home.actionsIncomplete')}
        </p>
      ) : null}
    </Card>
  );
}
