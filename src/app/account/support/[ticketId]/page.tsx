export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { requireCustomer } from '@/lib/customer-auth';
import { getPartnerStore } from '@/lib/partner-store';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { AccountShell, PageHeader } from '../../shell';
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

type BadgeTone = 'default' | 'secondary' | 'destructive' | 'outline';

const STATUS_TONE: Record<string, BadgeTone> = {
  open: 'secondary',
  waiting_admin: 'secondary',
  pending: 'default',
  resolved: 'outline',
  closed: 'outline',
};

const ERROR_MSG: Record<string, string> = {
  message: 'Replies can’t be empty (max 2000 characters).',
  closed: 'This conversation is closed — start a new request if you need more help.',
};

const controlCls =
  'flex min-h-9 w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm';

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
    <AccountShell active="support" customer={customer}>
      <PageHeader
        title={ticket.subject}
        sub={
          <>
            Started{' '}
            {new Date(ticket.createdAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </>
        }
        actions={<Badge variant={STATUS_TONE[ticket.status] ?? 'secondary'}>{STATUS_LABEL[ticket.status] ?? 'In progress'}</Badge>}
      />

      {ticket.transferId ? (
        <p className="mb-5 text-sm">
          <Link
            href={`/account/receipt/${ticket.transferId}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            View the linked transfer receipt →
          </Link>
        </p>
      ) : null}

      <Card className="mb-5">
        <CardContent className="flex flex-col gap-3">
          {messages.map((m) => {
            const mine = m.actorType === 'customer';
            return (
              <div
                key={m.id}
                className={`max-w-[85%] rounded-lg px-3.5 py-2.5 ${
                  mine ? 'ml-auto bg-primary/10' : 'mr-auto bg-muted'
                }`}
              >
                <div className="mb-1 text-xs font-semibold text-muted-foreground">
                  {mine ? 'You' : 'Support'}
                </div>
                <div className="whitespace-pre-wrap text-sm leading-normal text-foreground">
                  {m.body}
                </div>
                <div className="mt-1 text-right text-[11px] text-muted-foreground">
                  {new Date(m.createdAt).toLocaleString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {errorMsg ? (
        <Alert variant="destructive" className="mb-5">
          <AlertDescription>{errorMsg}</AlertDescription>
        </Alert>
      ) : null}

      {closed ? (
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            This conversation is closed.{' '}
            <Link
              href="/account/support/new"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Start a new request
            </Link>{' '}
            if you need more help.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent>
            <form action={replyToTicketAction.bind(null, ticket.id)} className="flex flex-col gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="message">Reply</Label>
                <textarea
                  id="message"
                  name="message"
                  required
                  maxLength={2000}
                  rows={3}
                  placeholder="Write a reply…"
                  className={controlCls}
                />
              </div>
              <Button type="submit" className="w-full sm:w-auto">
                Send reply
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </AccountShell>
  );
}
