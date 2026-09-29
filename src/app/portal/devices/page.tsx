import { LogOut, MonitorSmartphone } from 'lucide-react';
import { requirePortalSite } from '@/lib/portal-site';
import { requirePortalCustomer } from '@/lib/portal-auth';
import { listPortalDevices } from '@/lib/portal-devices';
import { t } from '@/lib/i18n';
import { Badge, Button, Card, EmptyState, PageHeader } from '@/components/ds';
import { signOutDeviceAction, signOutEverywhereAction } from './actions';
import { DeviceSignOut } from './device-signout';
import { portalMetadata } from '@/lib/portal-metadata';

export const generateMetadata = () => portalMetadata('portal.devices.title');

const WHEN = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
const when = (ms: number) => (Number.isFinite(ms) ? `${WHEN.format(new Date(ms))} UTC` : '—');

/**
 * Devices (UI redesign M2-13, Task 13.1): the signed-in customer's live portal sessions from the
 * session store's device index, scoped to (host partner, session phone). Each row is the closed-set
 * device label and two times; the current one is marked. No IP, no raw user agent.
 */
export default async function DevicesPage() {
  await requirePortalSite();
  const ctx = await requirePortalCustomer();
  const devices = await listPortalDevices(ctx);
  const others = devices.filter((d) => !d.current);

  return (
    <>
      <PageHeader title={t('portal.devices.title')} sub={t('portal.devices.sub')} />
      <div className="flex flex-col gap-6">
        <ul className="flex flex-col gap-3" aria-label={t('portal.devices.title')}>
          {devices.map((d) => (
            <li key={d.sid}>
              <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <MonitorSmartphone aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-ds-ink-muted" />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-semibold text-ds-ink">
                      <span className="truncate">{d.device}</span>
                      {d.current ? <Badge tone="info">{t('portal.devices.current')}</Badge> : null}
                    </p>
                    <p className="mt-1 text-[13.5px] text-ds-ink-muted">{t('portal.devices.lastActive', { date: when(d.lastSeenMs) })}</p>
                    <p className="text-[13.5px] text-ds-ink-muted">{t('portal.devices.signedIn', { date: when(d.createdAtMs) })}</p>
                  </div>
                </div>
                {d.current ? null : <DeviceSignOut action={signOutDeviceAction} sid={d.sid} deviceLabel={d.device} />}
              </Card>
            </li>
          ))}
        </ul>

        {others.length === 0 ? (
          <EmptyState
            icon={<MonitorSmartphone aria-hidden="true" className="size-6" />}
            title={t('portal.devices.emptyTitle')}
            body={t('portal.devices.emptyBody')}
          />
        ) : null}

        <Card className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-[18px] font-bold text-ds-ink">{t('portal.devices.everywhereTitle')}</h2>
            <p className="mt-1 text-[14px] text-ds-ink-muted">{t('portal.devices.everywhereBody')}</p>
          </div>
          <form action={signOutEverywhereAction}>
            <Button type="submit" variant="danger" size="md">
              <LogOut aria-hidden="true" className="size-4" />
              {t('portal.devices.everywhereCta')}
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}
