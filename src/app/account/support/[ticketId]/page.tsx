export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { requireCustomer } from '@/lib/customer-auth';
import { getPartnerStore } from '@/lib/partner-store';
import { replyToTicketAction } from '../actions';

export const metadata = { title: 'Support request · SmartRemit' };

// /account/support/[ticketId] — one conversation. Ownership is 404-never-403:
// a ticket that isn't the signed-in customer's own (or is internal) is
// indistinguishable from one that doesn't exist. The thread read is
// includeInternal:false — staff-only notes are excluded in the repo's WHERE,
// never filtered here — and staff replies render as "Support", never as a
// username.

const STATUS_LABEL: Record<string, string> = {
  open: 'In progress',
  waiting_admin: 'In progress',
  pending: 'Waiting for you',
  resolved: 'Resolved',
  closed: 'Closed',
};

const ERROR_MSG: Record<string, string> = {
  message: 'Replies can’t be empty (max 2000 characters).',
  closed: 'This conversation is closed — start a new request if you need more help.',
};

export default async function SupportThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ ticketId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const customer = await requireCustomer();

  // Admin kill switch — same gate as the support landing; the action re-checks.
  const partner =
    (await getPartnerStore().getPartner(customer.partnerId)) ??
    (await getPartnerStore().ensureDefaultPartner());
  if (partner.supportConfig?.enableSupportPortal === false) {
    return (
      <main className="flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 text-[#e9edef] [font-family:-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif]">
        <div className="w-full max-w-[420px] rounded-2xl bg-[#111b21] p-7">
          <div className="mb-1 text-xl font-extrabold leading-normal text-[#25d366]">SmartRemit</div>
          <h1 className="mb-5 text-lg font-semibold leading-normal">Support</h1>
          <p className="-mt-2 mb-5 text-sm leading-normal text-[#8696a0]">
            Support is handled in WhatsApp — message us there.
          </p>
          <p className="mt-4">
            <Link href="/account" className="text-sm text-[#8696a0] underline">
              ← Back to your account
            </Link>
          </p>
        </div>
      </main>
    );
  }

  const { ticketId } = await params;
  const repo = createTicketRepo(getDb());
  const ticket = await repo.getTicket(ticketId);
  if (!ticket || ticket.kind !== 'customer' || ticket.customerPhone !== customer.senderPhone) {
    notFound();
  }

  const messages = await repo.listMessages(ticket.id, { includeInternal: false });
  const { error } = await searchParams;
  const errorMsg = error ? ERROR_MSG[error] : undefined;
  const closed = ticket.status === 'closed';

  return (
    <main className="flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 text-[#e9edef] [font-family:-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif]">
      <div className="w-full max-w-[420px] rounded-2xl bg-[#111b21] p-7">
        <div className="mb-1 text-xl font-extrabold leading-normal text-[#25d366]">SmartRemit</div>
        <h1 className="mb-1 text-lg font-semibold leading-normal">{ticket.subject}</h1>
        <p className="mb-3.5 text-sm leading-normal text-[#8696a0]">
          {STATUS_LABEL[ticket.status] ?? 'In progress'}
          {' · '}started{' '}
          {new Date(ticket.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </p>
        {ticket.transferId ? (
          <p className="-mt-1.5 mb-3.5 text-sm leading-normal">
            <Link href={`/account/receipt/${ticket.transferId}`} className="text-[#25d366] underline">
              View the linked transfer receipt →
            </Link>
          </p>
        ) : null}

        {messages.map((m) => (
          <div
            key={m.id}
            className={`mb-3 max-w-[85%] rounded-xl p-3 ${
              m.actorType === 'customer' ? 'ml-auto bg-[#005c4b]' : 'mr-auto bg-[#202c33]'
            }`}
          >
            <div className="mb-1 text-[12px] font-semibold leading-normal text-[#8696a0]">
              {m.actorType === 'customer' ? 'You' : 'Support'}
            </div>
            <div className="whitespace-pre-wrap text-sm leading-normal">{m.body}</div>
            <div className="mt-1 text-right text-[11px] leading-normal text-[#8696a0]">
              {new Date(m.createdAt).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </div>
          </div>
        ))}

        {errorMsg ? (
          <p className="mt-1 mb-3.5 text-[13px] leading-[1.4] text-[#f15c6d]" role="alert">
            {errorMsg}
          </p>
        ) : null}

        {closed ? (
          <p className="mt-4 mb-2 text-sm leading-normal text-[#8696a0]">
            This conversation is closed.{' '}
            <Link href="/account/support/new" className="text-[#25d366] underline">
              Start a new request
            </Link>{' '}
            if you need more help.
          </p>
        ) : (
          <form action={replyToTicketAction.bind(null, ticket.id)} className="mt-4">
            <label className="mb-4 block">
              <span className="mb-1.5 block text-[13px] text-[#8696a0]">Reply</span>
              <textarea
                name="message"
                required
                maxLength={2000}
                rows={3}
                placeholder="Write a reply…"
                className="w-full rounded-lg border border-[#2a3942] bg-[#2a3942] p-2.5 text-[16px] text-[#e9edef]"
              />
            </label>
            <button
              type="submit"
              className="w-full cursor-pointer rounded-3xl bg-[#25d366] p-3 text-[15px] font-bold text-[#0b141a]"
            >
              Send reply
            </button>
          </form>
        )}

        <p className="mt-4">
          <Link href="/account/support" className="text-sm text-[#8696a0] underline">
            ← Back to support
          </Link>
        </p>
      </div>
    </main>
  );
}
