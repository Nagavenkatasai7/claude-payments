import Link from 'next/link';
import type { Metadata } from 'next';
import { ChevronLeft } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { getDb } from '@/db/client';
import { env } from '@/lib/env';
import { partnerApiBaseUrl } from '@/lib/partner-integration-urls';
import { isLiveApproved } from '@/db/repos/partner-go-live-repo';
import { getPartnerApiKeyStore } from '@/lib/partner-api-key';
import { keyRowsView, type KeyRowView } from '@/lib/partner-api-keys-view';
import { Badge, Card, EmptyState, ErrorState, PageHeader } from '@/components/ds';
import { PARTNER_ROUTES } from '../../../routes';
import { CreateKeyForm, RevokeKeyControl, RotateKeyForm } from './key-reveal';

export const metadata: Metadata = { title: t('partner.keys.title'), robots: { index: false, follow: false } };

// /partner/integrations/api-keys (UI redesign M3-14). Admin only; the page gates itself (the
// layout's gate is chrome only) and reads the SESSION tenant only. It lists keys by id, mode,
// last 4, the mode's fixed scopes and timestamps (ApiKeyPublic never carries a hash or a
// plaintext). A new key's plaintext is never rendered here: it lives only in the create/rotate
// action result on the client (key-reveal.tsx). The page reads cookies, so it is dynamically
// rendered and never cached (Next sends Cache-Control: private, no-cache, no-store for dynamic
// pages: node_modules/next/dist/docs/01-app/02-guides/self-hosting.md:99; next.config.ts has no
// cacheComponents). The plaintext itself only ever travels in the server-action POST response. The go-live read FAILS CLOSED: an error locks the live option. Viewing writes nothing.

const H2 = 'text-[17px] font-semibold text-ds-ink';
const whenUtc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

async function safe<T>(source: string, partnerId: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    logWarn('partner.apikeys.page', err instanceof Error ? err.name : 'error', { source, partnerId });
    return null;
  }
}

function KeyRow({ k }: { k: KeyRowView }) {
  return (
    <Card as="li" className="flex flex-col gap-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <code className="font-mono text-[14px] text-ds-ink tabular-nums">••••{k.last4}</code>
        <Badge tone={k.mode === 'live' ? 'warning' : 'neutral'}>{t(k.mode === 'live' ? 'partner.keys.mode.live' : 'partner.keys.mode.test')}</Badge>
        {k.active ? (
          <Badge tone="success">{t('partner.keys.status.active')}</Badge>
        ) : (
          <Badge>{t('partner.keys.status.revoked', { when: whenUtc(k.revokedAt ?? '') })}</Badge>
        )}
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-[14px] sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-ds-ink-muted">{t('partner.keys.col.key')}</dt>
        <dd className="font-mono text-[13px] break-all text-ds-ink">{k.keyId}</dd>
        <dt className="text-ds-ink-muted">{t('partner.keys.col.scopes')}</dt>
        <dd className="font-mono text-[13px] break-words text-ds-ink">{k.scopes.join(', ')}</dd>
        <dt className="text-ds-ink-muted">{t('partner.keys.col.created')}</dt>
        <dd className="text-ds-ink">{whenUtc(k.createdAt)}</dd>
        <dt className="text-ds-ink-muted">{t('partner.keys.col.lastUsed')}</dt>
        <dd className="text-ds-ink">{k.lastUsedAt ? whenUtc(k.lastUsedAt) : t('partner.keys.never')}</dd>
      </dl>
      {k.active ? (
        <div className="flex flex-col gap-3 border-t border-ds-border pt-4">
          <p className="text-[13.5px] leading-relaxed text-ds-ink-muted">{t('partner.keys.rotateHint')}</p>
          <div className="flex flex-wrap items-start gap-3">
            <RotateKeyForm keyId={k.keyId} />
            <RevokeKeyControl keyId={k.keyId} last4={k.last4} />
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export default async function PartnerApiKeysPage() {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.integrationsApiKeys.policy);
  const pid = ctx.partnerId;
  const [keys, liveApproved] = await Promise.all([
    safe('keys', pid, () => getPartnerApiKeyStore().list(pid)),
    safe('golive', pid, () => isLiveApproved(getDb(), pid)),
  ]);

  const header = (
    <PageHeader
      title={t('partner.keys.title')}
      sub={t('partner.keys.sub')}
      actions={
        <Link
          href={PARTNER_ROUTES.integrations.href}
          className="inline-flex min-h-11 items-center gap-1 rounded-ds-focus text-[14px] font-semibold text-ds-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring"
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
          {t('partner.keys.back')}
        </Link>
      }
    />
  );
  if (keys === null) {
    return (
      <>
        {header}
        <ErrorState />
      </>
    );
  }
  const rows = keyRowsView(keys);

  return (
    <>
      {header}
      <div className="flex flex-col gap-4 lg:gap-6">
        <Card as="section" className="p-5 sm:p-6">
          <h2 className={H2}>{t('partner.keys.baseUrlTitle')}</h2>
          <p className="mt-1 text-[14px] leading-relaxed text-ds-ink-muted">{t('partner.keys.baseUrlHint')}</p>
          <code data-testid="api-base-url" className="mt-3 block select-all rounded-ds-inner border border-ds-border bg-ds-ground px-4 py-3 font-mono text-[13.5px] break-all text-ds-ink">
            {partnerApiBaseUrl(env.appBaseUrl)}
          </code>
        </Card>
        <Card as="section" className="p-5 sm:p-6">
          <h2 className={H2}>{t('partner.keys.createTitle')}</h2>
          <CreateKeyForm liveAllowed={liveApproved === true} />
        </Card>
        <section className="flex flex-col gap-3">
          <h2 className={H2}>{t('partner.keys.listTitle')}</h2>
          {rows.length === 0 ? (
            <EmptyState title={t('partner.keys.empty')} />
          ) : (
            <ul className="flex flex-col gap-3">
              {rows.map((k) => (
                <KeyRow key={k.keyId} k={k} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
