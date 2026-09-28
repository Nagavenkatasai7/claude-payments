import { t, CATALOGUES } from '@/lib/i18n';
import type { SidebarItem } from '@/components/ds';

// The customer portal's navigation (UI redesign M2-5). Pure: the layout renders it, tests pin it.

/** The portal nav. Hiding an item is never the guard: every page gates itself. */
export function portalNavItems(dataRightsEnabled: boolean): SidebarItem[] {
  const items: SidebarItem[] = [
    { href: '/portal', label: t('portal.nav.home') },
    { href: '/portal/send', label: t('portal.nav.send') },
    { href: '/portal/transfers', label: t('portal.nav.transfers') },
    { href: '/portal/recipients', label: t('portal.nav.recipients') },
    { href: '/portal/schedules', label: t('portal.nav.schedules') },
    { href: '/portal/chat', label: t('portal.nav.chat') },
    { href: '/portal/help', label: t('portal.nav.help') },
    { href: '/portal/profile', label: t('portal.nav.profile') },
    { href: '/portal/notifications', label: t('portal.nav.notifications') },
    { href: '/portal/devices', label: t('portal.nav.devices') },
  ];
  if (dataRightsEnabled) items.push({ href: '/portal/privacy', label: t('portal.nav.privacy') });
  return items;
}

/** D5: the language switch shows only once a second catalogue exists (only `en` today). */
export const showLanguageSwitch = () => Object.keys(CATALOGUES).length > 1;

