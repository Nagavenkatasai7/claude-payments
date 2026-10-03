import { t } from '@/lib/i18n';

// ticket-nudge (lost-features p4 C4): the WhatsApp nudge a staff reply or a resolve sends to the
// customer, ONE source for both dashboards (/admin-dashboard/tickets and /partner/support). Neutral
// wording: the message comes from the partner's own number and the link opens the partner's portal,
// so the brand is already clear, and no partner-written text reaches an outbound message. The dedupe
// keys stay with the callers (ticketmsg:<id>:<msgId>, ticketresolved:<id>), unchanged.

export function ticketReplyNudge(url: string): string {
  return t('support.nudge.reply', { url });
}

export function ticketResolvedNudge(url: string): string {
  return t('support.nudge.resolved', { url });
}
