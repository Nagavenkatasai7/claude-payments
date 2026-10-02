import Link from 'next/link';
import type { Metadata } from 'next';
import { requirePartnerStaff } from '@/lib/auth';
import { getAuthStore } from '@/lib/auth-store';
import { PARTNER_ROUTES } from '../../routes';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { maskPhoneLast4 } from '@/lib/mask';
import {
  QUEUE_LIMIT,
  contactAvailable,
  errName,
  listVisibleCustomerTickets,
  parseMineFilter,
  parseQueueStatus,
  supportQueueHref,
  tenantStaffUsernames,
} from '@/lib/partner-tickets';
import { EmptyState, PageHeader, buttonVariants } from '@/components/ds';
import { dsCn } from '@/lib/ui/ds-cn';
import type { Ticket, TicketStatus } from '@/lib/types';
import { LoadError, TicketRows, formatWhen, priorityLabel, statusLabel } from './support-bits';

export const metadata: Metadata = { title: t('partner.support.title'), robots: { index: false, follow: false } };

// /partner/support (UI redesign M3-19): the SESSION tenant's customer support queue. Admin and
// support see the tenant queue; an agent sees only the tickets assigned to them. The customer is
// shown as ••••last4 only. Read-only here; the work happens on the ticket page. Merge plan 2e:
// ?mine=1 narrows an admin's or support member's queue to the tickets assigned to them.

const FILTERS: readonly (TicketStatus | undefined)[] = [undefined, 'open', 'pending', 'resolved', 'closed'];
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';

export default async function PartnerSupportPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[]; mine?: string | string[] }>;
}) {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.support.policy);
  const sp = await searchParams;
  const status = parseQueueStatus(typeof sp.status === 'string' ? sp.status : undefined);
  const mine = parseMineFilter(sp.mine, ctx.role);
  const showMine = parseMineFilter('1', ctx.role);

  let rows: Ticket[] | null = null;
  let named = new Set<string>();
  try {
    rows = await listVisibleCustomerTickets(ctx, { status, mine });
    named = await tenantStaffUsernames(
      ctx.partnerId,
      rows.map((r) => r.assignedTo ?? ''),
      (u) => getAuthStore().getStaff(u),
    );
  } catch (err) {
    logWarn('partner.support.list', errName(err), { partnerId: ctx.partnerId });
    rows = null;
  }

  const assignee = (r: Ticket) =>
    !r.assignedTo
      ? t('partner.support.unassigned')
      : t('partner.support.assignedTo', { name: named.has(r.assignedTo) ? r.assignedTo : t('partner.support.from.platform') });

  return (
    <>
      <PageHeader
        title={t('partner.support.title')}
        sub={ctx.role === 'agent' ? t('partner.support.agentSub') : t('partner.support.sub')}
        actions={
          // The platform's own 'default' tenant has no Contact SmartRemit surface.
          contactAvailable(ctx.partnerId) ? (
            <Link href={PARTNER_ROUTES.supportContact.href} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              {t('partner.support.contactLink')}
            </Link>
          ) : undefined
        }
      />
      <nav aria-label={t('partner.support.filterLabel')} className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const current = f === status;
          return (
            <Link
              key={f ?? 'all'}
              href={supportQueueHref({ status: f, mine })}
              aria-current={current ? 'page' : undefined}
              className={dsCn(
                'inline-flex min-h-10 items-center rounded-full border px-4 text-[13.5px] font-semibold',
                current ? 'border-ds-primary bg-ds-tint text-ds-ink' : 'border-ds-border-strong bg-ds-surface text-ds-ink-muted hover:text-ds-ink',
                FOCUS,
              )}
            >
              {f ? statusLabel(f) : t('partner.support.filterAll')}
            </Link>
          );
        })}
      </nav>
      {showMine ? (
        <nav aria-label={t('partner.support.mineLabel')} className="-mt-2 mb-4 flex flex-wrap gap-2">
          {[false, true].map((m) => (
            <Link
              key={String(m)}
              href={supportQueueHref({ status, mine: m })}
              aria-current={m === mine ? 'page' : undefined}
              className={dsCn(
                'inline-flex min-h-10 items-center rounded-full border px-4 text-[13.5px] font-semibold',
                m === mine ? 'border-ds-primary bg-ds-tint text-ds-ink' : 'border-ds-border-strong bg-ds-surface text-ds-ink-muted hover:text-ds-ink',
                FOCUS,
              )}
            >
              {m ? t('partner.support.filterMine') : t('partner.support.filterAll')}
            </Link>
          ))}
        </nav>
      ) : null}
      {rows === null ? (
        <LoadError message={t('partner.support.loadError')} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={t('partner.support.emptyTitle')}
          body={mine && !status ? t('partner.support.emptyMine') : status || mine ? t('partner.support.emptyFiltered') : t('partner.support.emptyBody')}
        />
      ) : (
        <section aria-label={t('partner.support.listCaption')}>
          <TicketRows
            rows={rows}
            meta={(r) => [
              t('partner.support.customer', { masked: maskPhoneLast4(r.customerPhone) }),
              priorityLabel(r.priority),
              assignee(r),
              t('partner.support.updated', { when: formatWhen(r.updatedAt) }),
            ]}
          />
          {rows.length >= QUEUE_LIMIT ? (
            <p className="mt-3 text-[13.5px] text-ds-ink-muted">{t('partner.support.limitNote', { count: QUEUE_LIMIT })}</p>
          ) : null}
        </section>
      )}
    </>
  );
}
