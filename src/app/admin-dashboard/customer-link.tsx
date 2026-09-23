import type { ReactNode } from 'react';
import { openCustomerAction } from './customers/actions';

// customer-link (Program-Fix 37, dash-04): the ONE way a staff page links to a
// customer's detail page. It is a tiny POST form, not an <a href>: the phone
// rides in the request body to openCustomerAction, which checks scope and
// redirects to `/admin-dashboard/customers/<sealed ref>`. So no phone number
// lands in a URL (request logs, history, referrers). A client component cannot
// seal the ref itself (that needs FIELD_ENCRYPTION_KEY), which is why this is a
// server action. Works inside client components too (transactions-tabs), since
// the action is imported from a 'use server' file. This file must never import
// src/lib/customer-ref.ts. Trade-off (owner decision): staff lose "open in new
// tab" on customer links. Never render it inside another <form>.

export function CustomerLink({
  phone,
  partnerId,
  className,
  children,
}: {
  phone: string;
  partnerId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <form action={openCustomerAction} className="inline">
      <input type="hidden" name="phone" value={phone} />
      {partnerId && <input type="hidden" name="partnerId" value={partnerId} />}
      <button
        type="submit"
        className={
          className ??
          'cursor-pointer border-0 bg-transparent p-0 text-left font-medium text-foreground hover:underline'
        }
      >
        {children}
      </button>
    </form>
  );
}
