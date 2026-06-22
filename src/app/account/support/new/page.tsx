export const dynamic = 'force-dynamic';

import { requireCustomer } from '@/lib/customer-auth';
import { getPartnerStore } from '@/lib/partner-store';
import { getStore } from '@/lib/store';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AccountShell, PageHeader } from '../../shell';
import { money } from '../../format';
import { createTicketAction } from '../actions';

export const metadata = { title: 'New support request · SmartRemit' };

// /account/support/new — start a support conversation. The optional transfer
// select only ever offers the customer's OWN last 10 transfers, and the server
// action re-validates the chosen id against that same set (the form is never
// trusted). Validation failures bounce back here with ?error=<code>.

const ERROR_MSG: Record<string, string> = {
  subject: 'Please give your request a short subject (3–120 characters).',
  message: 'Please describe what’s going on in a bit more detail (10–2000 characters).',
  transfer: 'That transfer couldn’t be linked — please pick one from the list.',
  cap: 'You already have 5 open requests. Reply on one of those, or wait for one to be resolved first.',
};

// Styled native <select>/<textarea> (mirrors the Input recipe) so the form
// posts plain field values to the server action — no client island needed.
const controlCls =
  'flex min-h-9 w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm';

export default async function NewSupportRequestPage({
  searchParams,
}: {
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

  const { error } = await searchParams;
  const errorMsg = error ? ERROR_MSG[error] : undefined;
  // The customer's OWN last 10 transfers — the only ids the select offers.
  const transfers = await getStore().listTransfersByPhone(customer.senderPhone, 10);

  return (
    <AccountShell active="support" customer={customer}>
      <PageHeader title="New request" sub="Tell us what’s going on and we’ll get back to you here." />

      <Card className="max-w-2xl">
        <CardContent>
          {errorMsg ? (
            <Alert variant="destructive" className="mb-5">
              <AlertDescription>{errorMsg}</AlertDescription>
            </Alert>
          ) : null}

          <form action={createTicketAction} className="flex flex-col gap-5">
            <div className="grid gap-1.5">
              <Label htmlFor="subject">Subject</Label>
              <Input
                id="subject"
                name="subject"
                type="text"
                required
                minLength={3}
                maxLength={120}
                placeholder="e.g. My transfer hasn’t arrived"
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="message">What&rsquo;s going on?</Label>
              <textarea
                id="message"
                name="message"
                required
                minLength={10}
                maxLength={2000}
                rows={5}
                placeholder="Describe the issue — what you expected and what happened."
                className={controlCls}
              />
            </div>

            {transfers.length > 0 ? (
              <div className="grid gap-1.5">
                <Label htmlFor="transferId">About a transfer? (optional)</Label>
                <select id="transferId" name="transferId" defaultValue="" className={controlCls}>
                  <option value="">Not about a specific transfer</option>
                  {transfers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.recipientName} ·{' '}
                      {money(t.amountSource ?? t.amountUsd, t.sourceCurrency ?? 'USD')} ·{' '}
                      {new Date(t.createdAt).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <p className="text-xs text-muted-foreground">
              Never include full account numbers or passwords — we&rsquo;ll never ask for them.
            </p>

            <Button type="submit" className="w-full sm:w-auto">
              Send request
            </Button>
          </form>
        </CardContent>
      </Card>
    </AccountShell>
  );
}
