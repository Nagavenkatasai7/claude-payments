import { PARTNER_ADMIN, type PartnerRole } from './partner-access';
import type { ChannelHealthSummary } from './channel-health';

// partner-shell-health: the PURE model behind the WhatsApp health strip on every /partner page
// (lost-features p3 B12; the legacy shell showed one too). Only the level and whether the viewer
// gets the "Fix it" link leave this function: the shell renders fixed copy, never the English item
// messages from channel-health (which name config fields, codes and times). Admins fix the channel
// on /partner/integrations/whatsapp; every other role is told to ask their admin.

export interface ShellChannelBanner {
  level: 'warn' | 'error';
  link: boolean;
}

export function shellChannelBanner(summary: ChannelHealthSummary, role: PartnerRole): ShellChannelBanner | null {
  if (summary.level === 'ok') return null;
  return { level: summary.level, link: PARTNER_ADMIN.roles.includes(role) };
}
