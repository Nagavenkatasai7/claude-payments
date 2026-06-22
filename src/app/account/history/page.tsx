export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requireCustomer } from '@/lib/customer-auth';
import { getStore } from '@/lib/store';
import { formatDestAmount } from '@/lib/payment';
import { AccountShell, PageHeader } from '../shell';
import { transferAmount, transferStatusLabel, transferStatusTone } from '../format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const metadata = { title: 'Transfers · SmartRemit' };

// /account/history — the customer's OWN transfers (Stage 5d). Ownership is
// structural: the query is WHERE phone = <session phone> (indexed), and the
// default ledger read masks payout destinations, so nothing here can leak
// another customer's data or a full account number. Light web-dashboard chrome
// (AccountShell) — a clean Table on sm:+ and stacked Cards on mobile. Status
// labels/tones come from format.ts (refund-aware); never re-implemented here.

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default async function AccountHistoryPage() {
  const customer = await requireCustomer();
  const transfers = await getStore().listTransfersByPhone(customer.senderPhone, 50);

  return (
    <AccountShell active="transfers" customer={customer}>
      <PageHeader title="Transfers" sub="Your transfer history" />

      {transfers.length === 0 ? (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No transfers yet — message us on WhatsApp to send your first one.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Desktop / tablet: a clean table. */}
          <Card className="hidden overflow-hidden py-0 sm:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-4">Date</TableHead>
                  <TableHead className="px-4">Recipient</TableHead>
                  <TableHead className="px-4 text-right">Amount</TableHead>
                  <TableHead className="px-4">Status</TableHead>
                  <TableHead className="px-4 text-right">
                    <span className="sr-only">View receipt</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transfers.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="px-4 text-muted-foreground tabular-nums">
                      {formatDate(t.createdAt)}
                    </TableCell>
                    <TableCell className="px-4 font-medium text-foreground">
                      {t.recipientName}
                    </TableCell>
                    <TableCell className="px-4 text-right tabular-nums">
                      <div className="font-medium text-foreground">{transferAmount(t)}</div>
                      <div className="text-xs text-muted-foreground">
                        → {formatDestAmount(t.amountInr, t.destinationCurrency ?? 'INR')}
                      </div>
                    </TableCell>
                    <TableCell className="px-4">
                      <Badge variant={transferStatusTone(t)}>{transferStatusLabel(t)}</Badge>
                    </TableCell>
                    <TableCell className="px-4 text-right">
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/account/receipt/${t.id}`}>View</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {/* Mobile: stacked, tappable cards (one big target per transfer). */}
          <div className="flex flex-col gap-3 sm:hidden">
            {transfers.map((t) => (
              <Link
                key={t.id}
                href={`/account/receipt/${t.id}`}
                className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Card className="gap-3 py-4 transition-colors hover:bg-muted/50">
                  <CardContent className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-foreground">
                        {t.recipientName}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                        {formatDate(t.createdAt)}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-medium text-foreground tabular-nums">
                        {transferAmount(t)}
                      </div>
                      <div className="text-xs text-muted-foreground tabular-nums">
                        → {formatDestAmount(t.amountInr, t.destinationCurrency ?? 'INR')}
                      </div>
                    </div>
                  </CardContent>
                  <CardContent className="flex items-center justify-between gap-3">
                    <Badge variant={transferStatusTone(t)}>{transferStatusLabel(t)}</Badge>
                    <span className="text-sm font-medium text-primary">View receipt →</span>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </>
      )}
    </AccountShell>
  );
}
