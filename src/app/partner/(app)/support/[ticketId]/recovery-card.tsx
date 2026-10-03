import { t } from '@/lib/i18n';
import { Card } from '@/components/ds';
import { getCustomerMfaStore } from '@/lib/customer-mfa';
import { RECOVERY_COOL_OFF_MS, isRecoveryTicket, recoveryTimeLabel } from '@/lib/customer-mfa-recovery-rules';
import { logWarn } from '@/lib/log';
import type { PartnerRole } from '@/lib/partner-access';
import type { Ticket } from '@/lib/types';
import { RecoveryForms } from './recovery-forms';

// The two-step recovery card on /partner/support/[ticketId] (lost-features p4 B4). The page mounts
// it in place of the ordinary reply / status cards on a recovery request. Shown to every role that
// can open the ticket: the request time, whether two-step verification is on now, and the time
// the 24-hour wait ends. Decision forms only for an admin, on an open request that is not with
// SmartRemit. The phone is never rendered here. That is UX: the actions re-gate everything.

export async function RecoveryCard({ ticket, role }: { ticket: Ticket; role: PartnerRole }) {
  if (!isRecoveryTicket(ticket)) return null;
  let on: boolean | null = null;
  try {
    on = await getCustomerMfaStore().isEnrolled({ partnerId: ticket.partnerId, phone: ticket.customerPhone });
  } catch (err) {
    logWarn('partner.support.mfaRecovery.card', err instanceof Error ? err.name : 'error', { ticketId: ticket.id });
  }
  const requestedAt = Date.parse(ticket.createdAt);
  const open = ticket.status === 'open' || ticket.status === 'pending';
  return (
    <Card as="section" className="flex flex-col gap-3 p-5 sm:p-6">
      <h2 className="text-[17px] font-bold text-ds-ink">{t('partner.support.mfaRecovery.title')}</h2>
      <p className="text-[14px] leading-relaxed text-ds-ink-muted">{t('partner.support.mfaRecovery.intro')}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[14px]">
        <dt className="text-ds-ink-muted">{t('partner.support.mfaRecovery.requestedAt')}</dt>
        <dd className="text-ds-ink">{recoveryTimeLabel(requestedAt)}</dd>
      </dl>
      {on !== null ? (
        <p role="status" className="text-[14px] font-semibold text-ds-ink">
          {t(on ? 'partner.support.mfaRecovery.stateOn' : 'partner.support.mfaRecovery.stateOff')}
        </p>
      ) : null}
      {ticket.status === 'waiting_admin' ? (
        <p className="text-[14px] text-ds-ink-muted">{t('partner.support.mfaRecovery.escalated')}</p>
      ) : !open ? (
        <p className="text-[14px] text-ds-ink-muted">{t('partner.support.mfaRecovery.handled')}</p>
      ) : role === 'admin' ? (
        <RecoveryForms id={ticket.id} waitUntil={recoveryTimeLabel(requestedAt + RECOVERY_COOL_OFF_MS)} />
      ) : (
        <p className="text-[14px] text-ds-ink-muted">{t('partner.support.mfaRecovery.readOnly')}</p>
      )}
    </Card>
  );
}
