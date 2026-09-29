import Link from 'next/link';
import type { Metadata } from 'next';
import { ChevronLeft } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { t, type MessageKey } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { getDb } from '@/db/client';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { listRecentPings, type PingView } from '@/lib/partner-settlement-endpoint';
import { webhookConfigView, type SecretState } from '@/lib/partner-webhooks-view';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { listDeliveries, parseDeliveryCursor, type DeliveryView } from '@/lib/webhook-delivery-log';
import type { RailSecretKind } from '@/lib/partner-integrations';
import { Badge, Card, EmptyState, ErrorState, PageHeader, buttonVariants } from '@/components/ds';
import { PARTNER_ROUTES } from '../../../routes';
import { EndpointForm, ReplayControl, RotateSecretControl, TestEventForm } from './webhook-controls';

export const metadata: Metadata = { title: t('partner.webhooks.title'), robots: { index: false, follow: false } };

// /partner/integrations/webhooks (UI redesign M3-15a; O2 default: the settlement endpoint). Admin
// only; the page gates itself (the layout's gate is chrome only) and reads the SESSION tenant only.
// It decrypts the integrations row server-side but renders ONLY webhookConfigView (the endpoint URL
// is the partner's own config; secrets are shown as set / not set plus the grace expiry, never a
// value). A rotated secret is shown once from the rotate action's result (webhook-controls.tsx). The
// page reads cookies, so it is dynamically rendered and never cached. Viewing writes nothing.
// M3-15b adds, for a partner-operated rail only: the delivery log (the worker's
// partner_webhook_deliveries rows for this tenant AS THE RAIL OWNER, keyset-paged on a strict id
// cursor: transfer id, outcome, HTTP status, latency, attempt, time; never a URL, body or outbox
// payload) and the failed (dead) instructions with Replay (id, time and attempts only).

const H2 = 'text-[17px] font-semibold text-ds-ink';
const whenUtc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const OUTCOME_KEYS: Record<string, MessageKey> = {
  ok: 'partner.webhooks.outcome.ok',
  http_error: 'partner.webhooks.outcome.http_error',
  network: 'partner.webhooks.outcome.network',
  refused: 'partner.webhooks.outcome.refused',
};

const DEAD_LIMIT = 50;
type SearchParams = Record<string, string | string[] | undefined>;

async function safe<T>(source: string, partnerId: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    logWarn('partner.webhooks.page', err instanceof Error ? err.name : 'error', { source, partnerId });
    return null;
  }
}

function SecretRow({ kind, state }: { kind: RailSecretKind; state: SecretState }) {
  const label: MessageKey = kind === 'signing' ? 'partner.webhooks.secret.signing' : 'partner.webhooks.secret.webhook';
  const hint: MessageKey = kind === 'signing' ? 'partner.webhooks.secret.signingHint' : 'partner.webhooks.secret.webhookHint';
  return (
    <li className="flex flex-col gap-3 border-t border-ds-border pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[15px] font-semibold text-ds-ink">{t(label)}</span>
        <Badge tone={state.set ? 'success' : 'neutral'}>{t(state.set ? 'partner.webhooks.secret.set' : 'partner.webhooks.secret.notSet')}</Badge>
      </div>
      <p className="text-[13.5px] leading-relaxed text-ds-ink-muted">{t(hint)}</p>
      {state.previousUntil ? <p className="text-[13.5px] leading-relaxed text-ds-ink">{t('partner.webhooks.secret.grace', { when: whenUtc(state.previousUntil) })}</p> : null}
      <RotateSecretControl kind={kind} graceUntil={state.previousUntil} />
    </li>
  );
}

function PingList({ pings }: { pings: PingView[] }) {
  if (pings.length === 0) return <EmptyState title={t('partner.webhooks.recentEmpty')} />;
  return (
    <ul className="flex flex-col gap-3">
      {pings.map((p, i) => (
        <Card as="li" key={`${p.createdAt.toISOString()}-${i}`} className="p-4 sm:p-5">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1 text-[14px] sm:grid-cols-4 sm:gap-y-0">
            <div className="contents sm:block">
              <dt className="text-ds-ink-muted">{t('partner.webhooks.col.when')}</dt>
              <dd className="text-ds-ink">{whenUtc(p.createdAt.toISOString())}</dd>
            </div>
            <div className="contents sm:block">
              <dt className="text-ds-ink-muted">{t('partner.webhooks.col.outcome')}</dt>
              <dd>
                <Badge tone={p.outcome === 'ok' ? 'success' : 'danger'}>{t(OUTCOME_KEYS[p.outcome] ?? 'partner.webhooks.outcome.refused')}</Badge>
              </dd>
            </div>
            <div className="contents sm:block">
              <dt className="text-ds-ink-muted">{t('partner.webhooks.col.status')}</dt>
              <dd className="text-ds-ink tabular-nums">{p.httpStatus ?? '—'}</dd>
            </div>
            <div className="contents sm:block">
              <dt className="text-ds-ink-muted">{t('partner.webhooks.col.latency')}</dt>
              <dd className="text-ds-ink tabular-nums">{p.latencyMs === null ? '—' : `${p.latencyMs} ms`}</dd>
            </div>
          </dl>
        </Card>
      ))}
    </ul>
  );
}

function DeliveryLog({ page, before }: { page: { rows: DeliveryView[]; nextBefore: number | null }; before: number | null }) {
  const base = PARTNER_ROUTES.integrationsWebhooks.href;
  return (
    <>
      {page.rows.length === 0 ? (
        <EmptyState title={t('partner.webhooks.log.empty')} />
      ) : (
        <ul className="flex flex-col gap-3">
          {page.rows.map((d) => (
            <Card as="li" key={d.id} className="p-4 sm:p-5">
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1 text-[14px] sm:grid-cols-3 lg:grid-cols-6 sm:gap-y-3">
                <div className="contents sm:block">
                  <dt className="text-ds-ink-muted">{t('partner.webhooks.col.when')}</dt>
                  <dd className="text-ds-ink">{whenUtc(d.createdAt.toISOString())}</dd>
                </div>
                <div className="contents sm:block">
                  <dt className="text-ds-ink-muted">{t('partner.webhooks.col.transfer')}</dt>
                  <dd className="font-mono text-[13.5px] break-all text-ds-ink">{d.subjectId ?? '—'}</dd>
                </div>
                <div className="contents sm:block">
                  <dt className="text-ds-ink-muted">{t('partner.webhooks.col.outcome')}</dt>
                  <dd>
                    <Badge tone={d.outcome === 'ok' ? 'success' : 'danger'}>{t(OUTCOME_KEYS[d.outcome] ?? 'partner.webhooks.outcome.refused')}</Badge>
                  </dd>
                </div>
                <div className="contents sm:block">
                  <dt className="text-ds-ink-muted">{t('partner.webhooks.col.status')}</dt>
                  <dd className="text-ds-ink tabular-nums">{d.httpStatus ?? '—'}</dd>
                </div>
                <div className="contents sm:block">
                  <dt className="text-ds-ink-muted">{t('partner.webhooks.col.latency')}</dt>
                  <dd className="text-ds-ink tabular-nums">{d.latencyMs === null ? '—' : `${d.latencyMs} ms`}</dd>
                </div>
                <div className="contents sm:block">
                  <dt className="text-ds-ink-muted">{t('partner.webhooks.col.attempt')}</dt>
                  <dd className="text-ds-ink tabular-nums">{d.attempt}</dd>
                </div>
              </dl>
            </Card>
          ))}
        </ul>
      )}
      {before !== null || page.nextBefore !== null ? (
        <nav className="flex flex-wrap gap-3">
          {before !== null ? (
            <Link href={`${base}#delivery-log`} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              {t('partner.webhooks.log.newest')}
            </Link>
          ) : null}
          {page.nextBefore !== null ? (
            <Link href={`${base}?before=${page.nextBefore}#delivery-log`} rel="next" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              {t('partner.webhooks.log.older')}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </>
  );
}

function DeadList({ rows }: { rows: Array<{ id: number; createdAt: Date; attempts: number }> }) {
  if (rows.length === 0) return <EmptyState title={t('partner.webhooks.dead.empty')} />;
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((r) => (
        <Card as="li" key={r.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div>
            <p className="text-[15px] font-semibold text-ds-ink">{t('partner.webhooks.dead.item', { id: r.id })}</p>
            <p className="mt-1 text-[13.5px] text-ds-ink-muted">{t('partner.webhooks.dead.meta', { when: whenUtc(r.createdAt.toISOString()), attempts: r.attempts })}</p>
          </div>
          <ReplayControl id={r.id} />
        </Card>
      ))}
    </ul>
  );
}

export default async function PartnerWebhooksPage({ searchParams }: { searchParams?: Promise<SearchParams> } = {}) {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.integrationsWebhooks.policy);
  const pid = ctx.partnerId;
  const before = parseDeliveryCursor((await searchParams)?.before);
  const [cfg, pings, log, dead] = await Promise.all([
    safe('config', pid, () => createPartnerIntegrationsStore(getDb()).getIntegrations(pid)),
    safe('pings', pid, () => listRecentPings(getDb(), pid, 10)),
    safe('deliveries', pid, () => listDeliveries(getDb(), pid, { before })),
    safe('dead', pid, () => createOutboxRepo(getDb()).listDeadInstructionsForPartner(pid, DEAD_LIMIT)),
  ]);

  const header = (
    <PageHeader
      title={t('partner.webhooks.title')}
      sub={t('partner.webhooks.sub')}
      actions={
        <Link
          href={PARTNER_ROUTES.integrations.href}
          className="inline-flex min-h-11 items-center gap-1 rounded-ds-focus text-[14px] font-semibold text-ds-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring"
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
          {t('partner.webhooks.back')}
        </Link>
      }
    />
  );
  if (cfg === null) {
    return (
      <>
        {header}
        <ErrorState />
      </>
    );
  }
  const view = webhookConfigView(cfg, new Date());

  if (!view.partnerRail) {
    return (
      <>
        {header}
        <Card as="section" className="p-5 sm:p-6">
          <h2 className={H2}>{t('partner.webhooks.managedTitle')}</h2>
          <p className="mt-2 text-[14px] leading-relaxed text-ds-ink-muted">{t('partner.webhooks.managed')}</p>
          <p className="mt-3 text-[14px] text-ds-ink">
            <span className="text-ds-ink-muted">{t('partner.webhooks.railType')}: </span>
            <code className="font-mono text-[13.5px]">{view.railType}</code>
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="flex flex-col gap-4 lg:gap-6">
        <Card as="section" className="p-5 sm:p-6">
          <h2 className={H2}>{t('partner.webhooks.endpointTitle')}</h2>
          <dl className="mt-3 grid gap-x-6 gap-y-2 text-[14px] sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="text-ds-ink-muted">{t('partner.webhooks.railType')}</dt>
            <dd className="font-mono text-[13.5px] text-ds-ink">{view.railType}</dd>
            <dt className="text-ds-ink-muted">{t('partner.webhooks.endpointLabel')}</dt>
            <dd className="font-mono text-[13.5px] break-all text-ds-ink">{view.endpoint ?? t('partner.webhooks.endpointNone')}</dd>
          </dl>
          <EndpointForm current={view.endpoint} />
        </Card>
        <Card as="section" className="p-5 sm:p-6">
          <h2 className={H2}>{t('partner.webhooks.secretsTitle')}</h2>
          <ul className="mt-4 flex flex-col gap-4">
            <SecretRow kind="signing" state={view.signing} />
            <SecretRow kind="webhook" state={view.webhook} />
          </ul>
        </Card>
        <Card as="section" className="p-5 sm:p-6">
          <h2 className={H2}>{t('partner.webhooks.testTitle')}</h2>
          <p className="mt-2 text-[14px] leading-relaxed text-ds-ink-muted">{t('partner.webhooks.testHint')}</p>
          <TestEventForm />
        </Card>
        <section className="flex flex-col gap-3">
          <h2 className={H2}>{t('partner.webhooks.recentTitle')}</h2>
          {pings === null ? <ErrorState /> : <PingList pings={pings} />}
        </section>
        <section className="flex flex-col gap-3">
          <h2 className={H2}>{t('partner.webhooks.dead.title')}</h2>
          <p className="text-[14px] leading-relaxed text-ds-ink-muted">{t('partner.webhooks.dead.hint')}</p>
          {dead === null ? <ErrorState /> : <DeadList rows={dead} />}
        </section>
        <section id="delivery-log" className="flex flex-col gap-3">
          <h2 className={H2}>{t('partner.webhooks.log.title')}</h2>
          <p className="text-[14px] leading-relaxed text-ds-ink-muted">{t('partner.webhooks.log.hint')}</p>
          {log === null ? <ErrorState /> : <DeliveryLog page={log} before={before} />}
        </section>
      </div>
    </>
  );
}
