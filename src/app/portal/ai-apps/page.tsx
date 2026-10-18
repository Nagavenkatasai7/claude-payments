import { notFound } from 'next/navigation';
import { Bot } from 'lucide-react';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { agentPortal } from '@/lib/agent-auth/portal-wiring';
import { t } from '@/lib/i18n';
import { Card, EmptyState, PageHeader } from '@/components/ds';
import { portalMetadata } from '@/lib/portal-metadata';
import { disconnectAgentAppAction } from './actions';
import { DisconnectApp } from './disconnect-form';

export const generateMetadata = () => portalMetadata('portal.agentApps.title');

const WHEN = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
const when = (d: Date) => `${WHEN.format(d)} UTC`;

/**
 * Connected AI apps (Stage C1 spec item 10): the signed-in customer's live AI-app grants, scoped to
 * (host partner, session phone). Each row is the app's own (unverified, React-escaped, never a
 * link) name and two times, with a Disconnect button. Shown while the AI-agent gate is open OR the
 * customer still has a live grant, so an app can always be disconnected; otherwise a 404.
 */
export default async function AgentAppsPage() {
  await requirePortalSite();
  const ctx = await requirePortalCustomer('/portal/ai-apps');
  const partnerId = ctx.site.partnerId;
  const phone = ctx.session.phone;
  const apps = agentPortal();
  if (!(await apps.visible(partnerId, phone))) notFound();
  const grants = await apps.list(partnerId, phone);

  return (
    <>
      <PageHeader title={t('portal.agentApps.title')} sub={t('portal.agentApps.sub')} />
      <div className="flex flex-col gap-6">
        {grants.length === 0 ? (
          <EmptyState icon={<Bot aria-hidden="true" className="size-6" />} title={t('portal.agentApps.emptyTitle')} body={t('portal.agentApps.emptyBody')} />
        ) : (
          <>
            <ul className="flex flex-col gap-3" aria-label={t('portal.agentApps.title')}>
              {grants.map((g) => {
                const label = g.clientName === '' ? t('portal.agentApps.unnamed') : g.clientName;
                return (
                  <li key={g.id}>
                    <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-start gap-3">
                        <Bot aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-ds-ink-muted" />
                        <div className="min-w-0">
                          <p className="font-semibold text-ds-ink [overflow-wrap:anywhere]">{label}</p>
                          <p className="mt-1 text-[13.5px] text-ds-ink-muted">{t('portal.agentApps.connected', { date: when(g.createdAt) })}</p>
                          <p className="text-[13.5px] text-ds-ink-muted">
                            {g.lastUsedAt ? t('portal.agentApps.lastUsed', { date: when(g.lastUsedAt) }) : t('portal.agentApps.neverUsed')}
                          </p>
                        </div>
                      </div>
                      <DisconnectApp action={disconnectAgentAppAction} grantId={g.id} appLabel={label} />
                    </Card>
                  </li>
                );
              })}
            </ul>
            <p className="text-[13px] text-ds-ink-muted">{t('portal.agentApps.unverified')}</p>
          </>
        )}
      </div>
    </>
  );
}
