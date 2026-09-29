import Link from 'next/link';
import type { Metadata } from 'next';
import { ChevronLeft, CircleAlert, CircleCheck, CircleMinus, TriangleAlert } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { t, type MessageKey } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { env } from '@/lib/env';
import { getDb } from '@/db/client';
import { getStore } from '@/lib/store';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { getPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { getChannelHealth, parseChannelTest, summarizeChannelHealth, type ChannelTestResult } from '@/lib/channel-health';
import { readSignatureHealth, type SignatureHealth } from '@/lib/webhook-signature-health';
import { resolveWaChannel, type WaChannel } from '@/lib/whatsapp-creds';
import { healthItemsView, maskPnid, testResultView, type HealthItemView } from '@/lib/partner-whatsapp-view';
import { Badge, Card, ErrorState, PageHeader, type Tone } from '@/components/ds';
import { PARTNER_ROUTES } from '../../../routes';
import { DisconnectControl, TestConnectionForm, WhatsappConfigForm } from './form';

export const metadata: Metadata = { title: t('partner.whatsapp.title'), robots: { index: false, follow: false } };

// /partner/integrations/whatsapp (UI redesign M3-13). Admin only; the page gates itself (the
// layout's gate is chrome only) and reads the SESSION tenant only. Secrets are WRITE-ONLY: the
// integrations row is decrypted here only to derive booleans and the phone number id's last 4; no
// secret value is passed to a client component or rendered. Health is read-only from the existing
// sources (channel-health marks + audit events, webhook-signature-health, the last test result).
// Viewing writes nothing.

const H2 = 'text-[17px] font-semibold text-ds-ink';

async function safe<T>(source: string, partnerId: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    logWarn('partner.whatsapp.page', err instanceof Error ? err.name : 'error', { source, partnerId });
    return null;
  }
}

const CHANNEL: Record<WaChannel['kind'], { key: MessageKey; tone: Tone }> = {
  own: { key: 'partner.whatsapp.channel.own', tone: 'success' },
  shared: { key: 'partner.whatsapp.channel.shared', tone: 'neutral' },
  incomplete: { key: 'partner.whatsapp.channel.incomplete', tone: 'danger' },
};

function SetBadge({ set }: { set: boolean }) {
  return set ? (
    <Badge tone="success">
      <CircleCheck aria-hidden="true" className="size-3.5" />
      {t('partner.whatsapp.set')}
    </Badge>
  ) : (
    <Badge>
      <CircleMinus aria-hidden="true" className="size-3.5" />
      {t('partner.whatsapp.notSet')}
    </Badge>
  );
}

function HealthList({ state, items }: { state: 'ok' | 'warn' | 'error'; items: HealthItemView[] }) {
  if (state === 'ok') {
    return (
      <p className="mt-3 flex items-center gap-2 text-[15px] text-ds-ink-muted">
        <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-ds-success-ink" />
        {t('partner.whatsapp.health.ok')}
      </p>
    );
  }
  return (
    <ul className="mt-3 flex flex-col gap-2" data-health={state}>
      {items.map((i, n) => {
        const Icon = i.level === 'error' ? CircleAlert : TriangleAlert;
        return (
          <li key={`${i.kind}-${n}`} className="flex items-start gap-2 text-[14px] leading-relaxed text-ds-ink">
            <Badge tone={i.level === 'error' ? 'danger' : 'warning'} className="shrink-0">
              <Icon aria-hidden="true" className="size-3.5" />
              {t(i.level === 'error' ? 'partner.whatsapp.health.error' : 'partner.whatsapp.health.warn')}
            </Badge>
            <span className="min-w-0">
              {t(i.labelKey)}
              {i.count ? <span className="text-ds-ink-muted"> · {t('partner.whatsapp.health.count', { count: i.count })}</span> : null}
              {i.when ? <span className="text-ds-ink-muted"> · {i.when}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default async function PartnerWhatsappPage() {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.integrationsWhatsapp.policy);
  const pid = ctx.partnerId;
  const isDefault = pid === DEFAULT_PARTNER_ID;
  const now = new Date();

  const [integrations, health, signature, lastTest] = await Promise.all([
    safe('integrations', pid, () => getPartnerIntegrationsStore().getIntegrations(pid)),
    // The default tenant IS the shared number: its marks are the platform's, not a partner signal.
    isDefault ? Promise.resolve(null) : safe('health', pid, () => getChannelHealth(pid, { store: getStore(), db: getDb(), includeChannel: false })),
    isDefault ? Promise.resolve<SignatureHealth>({}) : safe('signature', pid, () => readSignatureHealth(pid)),
    safe('test', pid, async (): Promise<ChannelTestResult | null> => parseChannelTest(await getStore().readChannelTest(pid))),
  ]);

  const header = (
    <PageHeader
      title={t('partner.whatsapp.title')}
      sub={t('partner.whatsapp.sub')}
      actions={
        <Link
          href={PARTNER_ROUTES.integrations.href}
          className="inline-flex min-h-11 items-center gap-1 rounded-ds-focus text-[14px] font-semibold text-ds-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring"
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
          {t('partner.whatsapp.back')}
        </Link>
      }
    />
  );
  if (integrations === null) {
    return (
      <>
        {header}
        <ErrorState />
      </>
    );
  }

  // Booleans and the last 4 only: nothing below this line holds a secret.
  const w = integrations.whatsapp;
  const status = {
    pnid: maskPnid(w.phoneNumberId),
    token: Boolean(w.token),
    appSecret: Boolean(w.appSecret),
    verifyToken: Boolean(w.verifyToken),
  };
  const channel = resolveWaChannel(pid, integrations);
  const channelView = CHANNEL[channel.kind];
  const summary = summarizeChannelHealth({ channel, marks: health?.marks ?? {}, now, signature: signature ?? {} });
  const healthView = healthItemsView(summary);
  const test = testResultView(lastTest);
  const callbackUrl = `${env.appBaseUrl}/api/whatsapp/${encodeURIComponent(pid)}`;

  return (
    <>
      {header}
      <div className="grid gap-4 lg:grid-cols-2 lg:gap-6">
        <Card as="section" className="p-5 sm:p-6">
          <h2 className={H2}>{t('partner.whatsapp.statusTitle')}</h2>
          <dl className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 text-[14px]">
            <dt className="text-ds-ink-muted">{t('partner.whatsapp.channel')}</dt>
            <dd className="justify-self-end">
              <Badge tone={channelView.tone}>{t(channelView.key)}</Badge>
            </dd>
            <dt className="text-ds-ink-muted">{t('partner.whatsapp.pnid')}</dt>
            <dd className="justify-self-end font-mono tabular-nums text-ds-ink">{status.pnid ?? <SetBadge set={false} />}</dd>
            <dt className="text-ds-ink-muted">{t('partner.whatsapp.token')}</dt>
            <dd className="justify-self-end"><SetBadge set={status.token} /></dd>
            <dt className="text-ds-ink-muted">{t('partner.whatsapp.appSecret')}</dt>
            <dd className="justify-self-end"><SetBadge set={status.appSecret} /></dd>
            <dt className="text-ds-ink-muted">{t('partner.whatsapp.verifyToken')}</dt>
            <dd className="justify-self-end"><SetBadge set={status.verifyToken} /></dd>
          </dl>
          {isDefault ? <p className="mt-4 text-[14px] leading-relaxed text-ds-ink-muted">{t('partner.whatsapp.sharedManaged')}</p> : null}
        </Card>

        <Card as="section" className="p-5 sm:p-6">
          <h2 className={H2}>{t('partner.whatsapp.healthTitle')}</h2>
          {health === null && !isDefault ? (
            <p role="status" className="mt-3 text-[15px] leading-relaxed text-ds-ink-muted">
              {t('partner.whatsapp.health.unavailable')}
            </p>
          ) : (
            <HealthList state={healthView.state} items={healthView.items} />
          )}
          {!isDefault ? (
            <div className="mt-5 border-t border-ds-border pt-4">
              <h3 className="text-[15px] font-semibold text-ds-ink">{t('partner.whatsapp.test.title')}</h3>
              <p className="mt-1 text-[14px] leading-relaxed text-ds-ink-muted">{t('partner.whatsapp.test.body')}</p>
              <p className="mt-2 text-[14px] text-ds-ink" data-test-result={test.ok === undefined ? 'none' : test.ok ? 'pass' : 'fail'}>
                {t(test.key, test.vars)}
              </p>
              <TestConnectionForm />
            </div>
          ) : null}
        </Card>

        {!isDefault ? (
          <>
            <Card as="section" className="p-5 sm:p-6 lg:col-span-2">
              <h2 className={H2}>{t('partner.whatsapp.formTitle')}</h2>
              <p className="mt-1 text-[14px] leading-relaxed text-ds-ink-muted">{t('partner.whatsapp.formHint')}</p>
              <WhatsappConfigForm />
              {channel.kind !== 'shared' ? <DisconnectControl /> : null}
            </Card>

            <Card as="section" className="p-5 sm:p-6 lg:col-span-2">
              <h2 className={H2}>{t('partner.whatsapp.callbackTitle')}</h2>
              <p className="mt-1 text-[14px] leading-relaxed text-ds-ink-muted">{t('partner.whatsapp.callbackHint')}</p>
              <code className="mt-3 block rounded-ds-inner border border-ds-border bg-ds-ground px-4 py-3 font-mono text-[13.5px] break-all text-ds-ink">
                {callbackUrl}
              </code>
            </Card>
          </>
        ) : null}
      </div>
    </>
  );
}
