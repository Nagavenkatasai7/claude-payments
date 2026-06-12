export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { requireCustomer } from '@/lib/customer-auth';
import { getPartnerStore } from '@/lib/partner-store';

export const metadata = { title: 'Support · SmartRemit' };

// /account/support — the customer's OWN support conversations. Ownership is
// structural (WHERE customer_phone = <session phone>, kind 'customer'), and
// every label here is CUSTOMER-SAFE: waiting_admin is an internal escalation
// detail so it collapses into "In progress"; assignees, internal notes, and
// partner ids never render.

const STATUS_LABEL: Record<string, string> = {
  open: 'In progress',
  waiting_admin: 'In progress',
  pending: 'Waiting for you',
  resolved: 'Resolved',
  closed: 'Closed',
};

const rowCls = 'flex justify-between py-1.5 text-sm leading-normal';

export default async function SupportListPage() {
  const customer = await requireCustomer();

  // Admin kill switch (enableSupportPortal default-true when absent): when the
  // partner turned the portal off, support stays in WhatsApp.
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

  const tickets = await createTicketRepo(getDb()).listByCustomer(customer.senderPhone);

  return (
    <main className="flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 text-[#e9edef] [font-family:-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif]">
      <div className="w-full max-w-[420px] rounded-2xl bg-[#111b21] p-7">
        <div className="mb-1 text-xl font-extrabold leading-normal text-[#25d366]">SmartRemit</div>
        <h1 className="mb-5 text-lg font-semibold leading-normal">Support</h1>
        {tickets.length === 0 ? (
          <p className="-mt-2 mb-5 text-sm leading-normal text-[#8696a0]">
            No support requests yet. If something doesn&rsquo;t look right with a transfer or your
            account, start a request and we&rsquo;ll get back to you.
          </p>
        ) : (
          <>
            <p className="-mt-2 mb-3.5 text-sm leading-normal text-[#8696a0]">
              Your support requests, most recent first. Tap one to read the conversation or reply.
            </p>
            {tickets.map((t) => (
              <Link
                key={t.id}
                href={`/account/support/${t.id}`}
                className="mb-5 block rounded-xl bg-[#202c33] p-3.5 text-inherit no-underline"
              >
                <div className={rowCls}>
                  <span className="font-semibold">{t.subject}</span>
                </div>
                <div className={`${rowCls} opacity-75`}>
                  <span className="text-[#8696a0]">
                    {new Date(t.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                  <span className={t.status === 'pending' ? 'text-[#25d366]' : ''}>
                    {STATUS_LABEL[t.status] ?? 'In progress'}
                  </span>
                </div>
              </Link>
            ))}
          </>
        )}
        <Link
          href="/account/support/new"
          className="block w-full rounded-3xl bg-[#25d366] p-3 text-center text-[15px] font-bold text-[#0b141a] no-underline"
        >
          New support request
        </Link>
        <p className="mt-4">
          <Link href="/account" className="text-sm text-[#8696a0] underline">
            ← Back to your account
          </Link>
        </p>
      </div>
    </main>
  );
}
