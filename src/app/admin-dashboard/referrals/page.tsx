export const dynamic = 'force-dynamic';

import { requirePlatformAdmin } from '@/lib/auth';
import { getDb } from '@/db/client';
import { env } from '@/lib/env';
import { createReferralRepo } from '@/db/repos/referral-repo';
import { buildReferralStatement, isReferralAdminError, REFERRAL_ADMIN_ERRORS } from '@/lib/referral-admin';
import {
  COMMISSION_MAX_CENTS,
  formatUsdCents,
  PLUM_URL_MAX,
  REFERRAL_CONTACT_MAX,
  referralPortalLink,
  referralWhatsAppLink,
} from '@/lib/referrals';
import { NAME_MAX } from '@/lib/untrusted-text';
import { WA_PHONE } from '@/app/landing/wa';
import { CUSTOMER_PORTAL_LOGIN } from '@/components/site/site-links';
import { Sidebar } from '../sidebar';
import {
  addReferralCodeAction,
  createReferralPartnerAction,
  setReferralCodeActiveAction,
  setReferralPlumUrlAction,
  updateReferralPartnerAction,
} from './actions';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

// /admin-dashboard/referrals (Batch B4). Platform ADMIN only. Referral partners are OUTSIDE
// affiliates with no dashboard: an admin adds one (name, contact, a fixed USD commission per
// delivered, not refunded transfer for 12 months after a referred customer's first transfer),
// hands out its WhatsApp and portal links, reads the monthly statement and downloads it as CSV
// for Plum. The "Referral rewards" address is the rewards portal referral partners redeem in; the
// public /referral-rewards page exists only while it is set. This page is a view and forms only:
// src/lib/referral-admin.ts validates and audits every change.

const SELECT_CLASS = 'h-9 w-full rounded-md border border-input bg-card px-3 text-sm';
const OK_TEXT: Record<string, string> = {
  created: 'Referral partner added, with its first code.',
  updated: 'Referral partner saved.',
  code: 'Code saved.',
  settings: 'Referral rewards address saved.',
};

function usd(cents: number): string {
  return `$${formatUsdCents(cents)}`;
}

export default async function ReferralsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; month?: string }>;
}) {
  await requirePlatformAdmin();
  const params = await searchParams;
  const db = getDb();
  const repo = createReferralRepo(db);
  const [partners, plumUrl, statement] = await Promise.all([
    repo.listPartnersWithCodes(),
    repo.getPlumPortalUrl(),
    buildReferralStatement(db, params.month, new Date()),
  ]);
  const error = isReferralAdminError(params.error) ? REFERRAL_ADMIN_ERRORS[params.error] : null;
  const ok = !error && params.ok ? OK_TEXT[params.ok] : undefined;
  const publicRewardsLink = `${env.appBaseUrl}/referral-rewards`;

  return (
    <>
      <Sidebar active="referrals" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Referrals</div>
            <div className="sh-page-sub">
              Referral partners are outside affiliates. A code links a new customer to them; they earn a fixed amount per delivered,
              not refunded transfer for 12 months after that customer&apos;s first transfer. A code never changes the customer&apos;s
              licensed partner. Every change is audited.
            </div>
          </div>
        </div>

        {error && (
          <Alert variant="destructive" className="mb-4" role="alert">
            <AlertTitle>Nothing changed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {ok && (
          <Alert className="mb-4" role="status">
            <AlertTitle>Saved</AlertTitle>
            <AlertDescription>{ok}</AlertDescription>
          </Alert>
        )}

        <Card className="mb-5">
          <CardHeader>
            <CardTitle>Add a referral partner</CardTitle>
            <CardDescription>The partner gets one code right away. You can add more codes later.</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={createReferralPartnerAction} className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="rp-name">Name</Label>
                <Input id="rp-name" name="name" required maxLength={NAME_MAX} placeholder="e.g. TANA DC chapter" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rp-contact">Contact (optional)</Label>
                <Input id="rp-contact" name="contact" maxLength={REFERRAL_CONTACT_MAX} placeholder="Email or phone" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rp-commission">Commission per transfer (USD)</Label>
                <Input id="rp-commission" name="commission" inputMode="decimal" placeholder="0.00" maxLength={10} />
              </div>
              <div className="sm:col-span-3">
                <Button type="submit">Add referral partner</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {partners.length === 0 ? (
          <p className="mb-5 text-sm text-muted-foreground">No referral partners yet.</p>
        ) : (
          partners.map((p) => (
            <Card key={p.id} className="mb-5" data-testid={`referral-partner-${p.id}`}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  {p.name}
                  <Badge variant={p.status === 'active' ? 'default' : 'secondary'}>{p.status}</Badge>
                </CardTitle>
                <CardDescription>
                  {p.contact || 'No contact'} · {usd(p.commissionCents)} per delivered transfer
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Code</TableHead>
                        <TableHead>Links to hand out</TableHead>
                        <TableHead>State</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {p.codes.map((c) => (
                        <TableRow key={c.code}>
                          <TableCell className="font-mono">{c.code}</TableCell>
                          <TableCell className="max-w-[420px] space-y-1 break-all text-xs">
                            <div>
                              <span className="text-muted-foreground">WhatsApp: </span>
                              {referralWhatsAppLink(c.code, WA_PHONE)}
                            </div>
                            <div>
                              <span className="text-muted-foreground">Portal: </span>
                              {referralPortalLink(c.code, CUSTOMER_PORTAL_LOGIN)}
                            </div>
                          </TableCell>
                          <TableCell>
                            <form action={setReferralCodeActiveAction} className="flex items-center gap-2">
                              <input type="hidden" name="code" value={c.code} />
                              <input type="hidden" name="enabled" value={c.active ? 'off' : 'on'} />
                              <Badge variant={c.active ? 'default' : 'secondary'}>{c.active ? 'on' : 'off'}</Badge>
                              <Button type="submit" size="sm" variant="outline">
                                {c.active ? 'Turn off' : 'Turn on'}
                              </Button>
                            </form>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <form action={addReferralCodeAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="id" value={p.id} />
                  <div className="space-y-1.5">
                    <Label htmlFor={`${p.id}-code`}>New code (leave empty to generate one)</Label>
                    <Input id={`${p.id}-code`} name="code" maxLength={10} placeholder="REF-XXXXXX" className="w-44 font-mono" />
                  </div>
                  <Button type="submit" size="sm" variant="outline">Add code</Button>
                </form>

                <form action={updateReferralPartnerAction} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-4">
                  <input type="hidden" name="id" value={p.id} />
                  <div className="space-y-1.5">
                    <Label htmlFor={`${p.id}-name`}>Name</Label>
                    <Input id={`${p.id}-name`} name="name" required maxLength={NAME_MAX} defaultValue={p.name} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${p.id}-contact`}>Contact</Label>
                    <Input id={`${p.id}-contact`} name="contact" maxLength={REFERRAL_CONTACT_MAX} defaultValue={p.contact} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${p.id}-commission`}>Commission (USD, max {usd(COMMISSION_MAX_CENTS)})</Label>
                    <Input id={`${p.id}-commission`} name="commission" inputMode="decimal" maxLength={10} defaultValue={formatUsdCents(p.commissionCents)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${p.id}-status`}>Status</Label>
                    <select id={`${p.id}-status`} name="status" className={SELECT_CLASS} defaultValue={p.status}>
                      <option value="active">active</option>
                      <option value="inactive">inactive (its codes stop linking customers)</option>
                    </select>
                  </div>
                  <div className="sm:col-span-4">
                    <p className="mb-2 text-xs text-muted-foreground">
                      A new commission applies to every statement, including past months.
                    </p>
                    <Button type="submit" size="sm">Save</Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          ))
        )}

        <Card className="mb-5" data-testid="referral-statement">
          <CardHeader>
            <CardTitle>Monthly statement</CardTitle>
            <CardDescription>
              Delivered, not refunded live transfers of referred customers in the month (UTC), within 12 months of each customer&apos;s
              first delivered transfer.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form method="get" className="flex flex-wrap items-end gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="statement-month">Month</Label>
                <Input id="statement-month" name="month" type="month" defaultValue={statement.month} className="w-44" />
              </div>
              <Button type="submit" size="sm" variant="outline">Show</Button>
            </form>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Referral partner</TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead className="text-right">Delivered transfers</TableHead>
                    <TableHead className="text-right">Per transfer</TableHead>
                    <TableHead className="text-right">Commission</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {statement.lines.map((l) => (
                    <TableRow key={l.referralPartnerId}>
                      <TableCell>{l.name}</TableCell>
                      <TableCell>{l.contact}</TableCell>
                      <TableCell className="text-right">{l.deliveredCount}</TableCell>
                      <TableCell className="text-right">{usd(l.commissionCents)}</TableCell>
                      <TableCell className="text-right">{usd(l.commissionCents * l.deliveredCount)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell colSpan={4} className="font-medium">Total for {statement.month}</TableCell>
                    <TableCell className="text-right font-medium">{usd(statement.totalCents)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
            <form method="post" action="/admin-dashboard/referrals/statement">
              <input type="hidden" name="month" value={statement.month} />
              <Button type="submit" size="sm">Download CSV for {statement.month}</Button>
            </form>
          </CardContent>
        </Card>

        <Card className="mb-5" data-testid="referral-rewards-settings">
          <CardHeader>
            <CardTitle>Referral rewards portal</CardTitle>
            <CardDescription>
              The rewards portal (Xoxoday Plum) where referral partners redeem their commission. https only. Leave it empty to hide the
              public Referral rewards page.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <form action={setReferralPlumUrlAction} className="flex flex-wrap items-end gap-2">
              <div className="min-w-[260px] flex-1 space-y-1.5">
                <Label htmlFor="plum-url">Rewards portal address</Label>
                <Input id="plum-url" name="url" type="url" maxLength={PLUM_URL_MAX} defaultValue={plumUrl ?? ''} placeholder="https://" />
              </div>
              <Button type="submit" size="sm">Save</Button>
            </form>
            {plumUrl ? (
              <p className="break-all text-sm">
                Public link for referral partners:{' '}
                <a href="/referral-rewards" className="underline" target="_blank" rel="noopener noreferrer">
                  {publicRewardsLink}
                </a>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">No address set: the public Referral rewards page is hidden.</p>
            )}
          </CardContent>
        </Card>
      </main>
    </>
  );
}
