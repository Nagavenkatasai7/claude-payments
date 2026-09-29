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
import type { RailSecretKind } from '@/lib/partner-integrations';
import { Badge, Card, EmptyState, ErrorState, PageHeader } from '@/components/ds';
import { PARTNER_ROUTES } from '../../../routes';
import { EndpointForm, RotateSecretControl, TestEventForm } from './webhook-controls';

export const metadata: Metadata = { title: t('partner.webhooks.title'), robots: { index: false, follow: false } };

// /partner/integrations/webhooks (UI redesign M3-15a; O2 default: the settlement endpoint). Admin
// only; the page gates itself (the layout's gate is chrome only) and reads the SESSION tenant only.
// It decrypts the integrations row server-side but renders ONLY webhookConfigView (the endpoint URL
// is the partner's own config; secrets are shown as set / not set plus the grace expiry, never a
// value). A rotated secret is shown once from the rotate action's result (webhook-controls.tsx). The
// page reads cookies, so it is dynamically rendered and never cached. Viewing writes nothing.

const H2 = 'text-[17px] font-semibold text-ds-ink';
const whenUtc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const OUTCOME_KEYS: Record<string, MessageKey> = {
  ok: 'partner.webhooks.outcome.ok',
  http_error: 'partner.webhooks.outcome.http_error',
  network: 'partner.webhooks.outcome.network',
  refused: 'partner.webhooks.outcome.refused',
};

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

export default async function PartnerWebhooksPage() {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.integrationsWebhooks.policy);
  const pid = ctx.partnerId;
  const [cfg, pings] = await Promise.all([
    safe('config', pid, () => createPartnerIntegrationsStore(getDb()).getIntegrations(pid)),
    safe('pings', pid, () => listRecentPings(getDb(), pid, 10)),
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
      </div>
    </>
  );
}
