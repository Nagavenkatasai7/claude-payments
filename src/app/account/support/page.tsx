export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { requireCustomer } from '@/lib/customer-auth';
import { getPartnerStore } from '@/lib/partner-store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AccountShell, PageHeader } from '../shell';

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

type BadgeTone = 'default' | 'secondary' | 'destructive' | 'outline';

const STATUS_TONE: Record<string, BadgeTone> = {
  open: 'secondary',
  waiting_admin: 'secondary',
  pending: 'default', // "Waiting for you" — the customer's turn, draw the eye
  resolved: 'outline',
  closed: 'outline',
};

export default async function SupportListPage() {
  const customer = await requireCustomer();

  // Admin kill switch (enableSupportPortal default-true when absent): when the
  // partner turned the portal off, support stays in WhatsApp.
  const partner =
    (await getPartnerStore().getPartner(customer.partnerId)) ??
    (await getPartnerStore().ensureDefaultPartner());
  if (partner.supportConfig?.enableSupportPortal === false) {
    return (
      <AccountShell active="support" customer={customer}>
        <PageHeader title="Support" sub="Your requests" />
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            Support is handled in WhatsApp — message us there.
          </CardContent>
        </Card>
      </AccountShell>
    );
  }

  const tickets = await createTicketRepo(getDb()).listByCustomer(customer.senderPhone);

  return (
    <AccountShell active="support" customer={customer}>
      <PageHeader
        title="Support"
        sub="Your requests"
        actions={
          <Button asChild>
            <Link href="/account/support/new">New request</Link>
          </Button>
        }
      />

      {tickets.length === 0 ? (
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            No support requests yet. If something doesn&rsquo;t look right with a transfer or your
            account, start a request and we&rsquo;ll get back to you.
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {tickets.map((t) => (
            <Card key={t.id} className="py-0 transition-colors hover:bg-muted/40">
              <Link
                href={`/account/support/${t.id}`}
                className="flex items-center justify-between gap-3 p-4"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-foreground">{t.subject}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Updated{' '}
                    {new Date(t.updatedAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </div>
                </div>
                <Badge variant={STATUS_TONE[t.status] ?? 'secondary'}>
                  {STATUS_LABEL[t.status] ?? 'In progress'}
                </Badge>
              </Link>
            </Card>
          ))}
        </div>
      )}
    </AccountShell>
  );
}
