export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import { requireScope } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { isPartnerPulled } from '@/lib/funding-method';
import { Sidebar } from '../sidebar';
import { ExpandableTable, type ExpandableColumn } from '../expandable-table';
import { money } from '../format';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { B2bInvoice } from '@/lib/types';
import {
  seedDemoInvoiceAction,
  cancelB2bTransferAction,
  reverseB2bTransferAction,
  voidB2bInvoiceAction,
  reissueB2bInvoiceAction,
} from './actions';

// /admin-dashboard/b2b — the B2B (business-to-business) review surface. Shows the
// mock invoices (the "ERP" stand-in) the WhatsApp bot presents to buyers, and
// the B2B transfers that pay them. Invoices and B2B transfers cross no tenant
// boundary into another partner here, so this is PLATFORM-ONLY — the nav hides
// it from partner-scoped staff and the requireScope bounce closes the direct URL.

const INVOICE_COLUMNS: ExpandableColumn[] = [
  { label: 'Seller business', primary: true },
  { label: 'Buyer', primary: true },
  { label: 'Line items' },
  { label: 'Total', primary: true, align: 'right' },
  { label: 'Status', primary: true },
  { label: 'Created' },
  { label: 'Paid' },
  { label: 'Actions', primary: true },
];

const TRANSFER_COLUMNS: ExpandableColumn[] = [
  { label: 'Sender business', primary: true },
  { label: 'Recipient business', primary: true },
  { label: 'Amount', primary: true, align: 'right' },
  { label: 'Status', primary: true },
  { label: 'KYB review notes' },
  { label: 'Actions', primary: true },
];

function shortDate(iso?: string): string {
  if (!iso) return '—';
  // Mirror team/page.tsx's guard: a non-parseable timestamp degrades to '—'
  // rather than rendering a garbled truncated string.
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : iso.replace('T', ' ').slice(0, 16);
}

/**
 * Render the invoice status as a DISTINCT badge for all four states. The old
 * cell was a binary paid/Unpaid ternary, so `voided` and `disputed` bills wrongly
 * showed as "Unpaid" — staff would re-chase a killed or disputed bill. Disputed
 * is the loud one (destructive/red): a buyer rejected it and a support ticket
 * carries the reason. Voided is muted (the bill is dead, not actionable).
 */
function invoiceStatusBadge(status: B2bInvoice['status']) {
  switch (status) {
    case 'paid':
      return <Badge variant="outline" className="border-success/50 text-success">Paid</Badge>;
    case 'voided':
      return <Badge variant="outline" className="border-muted-foreground/40 text-muted-foreground">Voided</Badge>;
    case 'disputed':
      return <Badge variant="destructive">Disputed</Badge>;
    case 'unpaid':
    default:
      return <Badge variant="secondary">Unpaid</Badge>;
  }
}

export default async function B2bPage() {
  const { scope } = await requireScope();
  if (scope.kind !== 'platform') redirect('/admin-dashboard');

  const store = getStore();
  const [invoices, allTransfers] = await Promise.all([
    store.listB2bInvoices(DEFAULT_PARTNER_ID),
    store.listTransfers(),
  ]);
  const b2bTransfers = allTransfers.filter((t) => t.transferType === 'b2b');
  const unpaidCount = invoices.filter((i) => i.status === 'unpaid').length;
  const disputedCount = invoices.filter((i) => i.status === 'disputed').length;

  return (
    <>
      <Sidebar active="b2b" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">B2B</div>
            <div className="sh-page-sub">
              {invoices.length} invoice{invoices.length === 1 ? '' : 's'}
              {unpaidCount > 0 ? ` · ${unpaidCount} unpaid` : ''}
              {disputedCount > 0 ? ` · ${disputedCount} disputed` : ''} ·{' '}
              {b2bTransfers.length} B2B transfer{b2bTransfers.length === 1 ? '' : 's'}
            </div>
          </div>
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Seed a demo invoice</CardTitle>
            <CardDescription>
              Creates a sample unpaid invoice on the default partner so the WhatsApp B2B flow has a
              bill to present — the bot resolves the buyer&rsquo;s open invoice by phone.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={seedDemoInvoiceAction} className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Seller business</span>
                <input
                  name="businessName"
                  required
                  defaultValue="Mango Exports Pvt Ltd"
                  className="h-9 w-56 rounded-md border border-input bg-card px-2 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Buyer phone</span>
                <input
                  name="buyerPhone"
                  required
                  placeholder="15551234567"
                  className="h-9 w-44 rounded-md border border-input bg-card px-2 text-sm"
                />
                <span className="text-[10px] text-muted-foreground">
                  Country code + number, digits only (no +)
                </span>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Line item</span>
                <input
                  name="itemDescription"
                  required
                  defaultValue="Alphonso mangoes (case)"
                  className="h-9 w-52 rounded-md border border-input bg-card px-2 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Qty</span>
                <input
                  name="qty"
                  type="number"
                  min={1}
                  step={1}
                  defaultValue={10}
                  required
                  className="h-9 w-20 rounded-md border border-input bg-card px-2 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Unit (USD)</span>
                <input
                  name="unitAmountUsd"
                  type="number"
                  min="0.01"
                  step="0.01"
                  defaultValue={45}
                  required
                  className="h-9 w-24 rounded-md border border-input bg-card px-2 text-sm"
                />
              </label>
              <Button type="submit">Seed invoice</Button>
            </form>
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>B2B invoices</CardTitle>
            <CardDescription>
              Mock invoices the WhatsApp bot presents to buyers, newest by capture time.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={INVOICE_COLUMNS}
              empty={<>No B2B invoices yet — seed a demo invoice above.</>}
              rows={invoices.map((inv) => ({
                key: inv.id,
                label: inv.businessName,
                cells: [
                  <span key="seller" className="font-medium">{inv.businessName}</span>,
                  <span key="buyer" className="tabular-nums text-muted-foreground">{inv.buyerPhone}</span>,
                  <span key="items" className="block max-w-xs break-words text-muted-foreground">
                    {inv.lineItems
                      .map((li) => `${li.qty}× ${li.description}`)
                      .join(', ')}
                  </span>,
                  <span key="total" className="tabular-nums">{money(inv.amountUsd, inv.currency)}</span>,
                  <span key="status">{invoiceStatusBadge(inv.status)}</span>,
                  <span key="created" className="whitespace-nowrap text-muted-foreground">{shortDate(inv.createdAt)}</span>,
                  <span key="paid" className="whitespace-nowrap text-muted-foreground">{shortDate(inv.paidAt)}</span>,
                  inv.status === 'unpaid' ? (
                    <form key="actions" action={voidB2bInvoiceAction}>
                      <input type="hidden" name="id" value={inv.id} />
                      <Button
                        type="submit"
                        size="sm"
                        variant="outline"
                        className="text-destructive"
                        title="Kills this unpaid bill — the bot can no longer present it (reissue revives it as a fresh invoice)"
                      >
                        Void
                      </Button>
                    </form>
                  ) : inv.status === 'voided' || inv.status === 'disputed' ? (
                    <form key="actions" action={reissueB2bInvoiceAction}>
                      <input type="hidden" name="id" value={inv.id} />
                      <Button
                        type="submit"
                        size="sm"
                        variant="outline"
                        title="Clones this bill into a fresh unpaid invoice the bot can present again"
                      >
                        Reissue
                      </Button>
                    </form>
                  ) : (
                    <span key="actions" className="text-xs text-muted-foreground">—</span>
                  ),
                ],
              }))}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>B2B transfers</CardTitle>
            <CardDescription>
              Transfers flagged business-to-business. Business names are shown masked (the ledger
              default) — no decryption happens in a list.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={TRANSFER_COLUMNS}
              empty={<>No B2B transfers yet.</>}
              rows={b2bTransfers.map((t) => ({
                key: t.id,
                label: t.senderBusinessName ?? t.id,
                cells: [
                  <span key="sender" className="font-medium">{t.senderBusinessName ?? '—'}</span>,
                  <span key="recipient" className="font-medium">{t.recipientBusinessName ?? '—'}</span>,
                  <span key="amount" className="tabular-nums">{money(t.amountUsd)}</span>,
                  <Badge key="status" variant="outline">{t.status}</Badge>,
                  t.kybReviewNotes ? (
                    <span key="kyb" className="block max-w-xs break-words whitespace-pre-line text-muted-foreground">
                      {t.kybReviewNotes}
                    </span>
                  ) : (
                    <span key="kyb" className="text-xs text-muted-foreground">—</span>
                  ),
                  t.status === 'awaiting_payment' || t.status === 'in_review' ? (
                    <form key="actions" action={cancelB2bTransferAction}>
                      <input type="hidden" name="id" value={t.id} />
                      <Button
                        type="submit"
                        size="sm"
                        variant="outline"
                        className="text-destructive"
                        title="Cancels this unpaid B2B transfer (non-custodial — nothing was pulled from the buyer)"
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : t.status === 'paid' && isPartnerPulled(t.fundingMethod) ? (
                    <form key="actions" action={reverseB2bTransferAction}>
                      <input type="hidden" name="id" value={t.id} />
                      <Button
                        type="submit"
                        size="sm"
                        variant="outline"
                        className="text-destructive"
                        title="Instructs the partner to return the ACH debit — a SIGNED reverse-instruction (SmartRemit holds no funds)"
                      >
                        Reverse
                      </Button>
                    </form>
                  ) : t.status === 'delivered' ? (
                    <span key="actions" className="text-xs text-muted-foreground">Recall via support</span>
                  ) : (
                    <span key="actions" className="text-xs text-muted-foreground">—</span>
                  ),
                ],
              }))}
            />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
