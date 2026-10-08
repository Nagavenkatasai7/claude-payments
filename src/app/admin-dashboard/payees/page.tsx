export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requirePlatformAdmin } from '@/lib/auth';
import { getDb } from '@/db/client';
import { createPayeeRepo } from '@/db/repos/payee-repo';
import { nextPayeeStatus, PAYEE_STATUS_LABELS, type PayeeDecision, type PayeeStatus } from '@/lib/payees';
import { Sidebar } from '../sidebar';
import { decidePayeeAction } from './actions';
import { RevealBank } from './reveal-bank';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

// /admin-dashboard/payees (Batch B2). Platform ADMIN only. Partners add the companies in India
// their customers pay through payment links; each one waits here until a SmartRemit admin
// approves it. Approve re-screens both names (a possible match cannot be approved; a match
// rejects it). Bank details are masked; opening one is an audited reveal. A payee is never
// edited: new bank details mean a new payee. Payment links also need the "Payment links"
// switch (paylinks.enabled) and demo-mode phones.

const ERROR_TEXT: Record<string, string> = {
  invalid: 'That decision is not valid.',
  not_found: 'That payee was not found.',
  not_allowed: 'That decision does not apply to this payee now (it may have changed). Reload and try again.',
  review: 'Sanctions screening found a possible match, so this payee cannot be approved. Reject it, or ask the partner to check the names.',
  refused: 'Sanctions screening matched this payee, so it was rejected.',
  forbidden: 'Only a SmartRemit platform admin can decide payees.',
};
const OK_TEXT: Record<string, string> = {
  approve: 'Payee approved. The partner can now make payment links to it.',
  reject: 'Payee rejected.',
  suspend: 'Payee suspended. Its open links stop working until it is approved again.',
};
const FILTERS: Array<{ key: string; label: string; statuses?: PayeeStatus[] }> = [
  { key: 'pending', label: 'Waiting', statuses: ['pending'] },
  { key: 'approved', label: 'Approved', statuses: ['approved'] },
  { key: 'suspended', label: 'Suspended', statuses: ['suspended'] },
  { key: 'rejected', label: 'Rejected', statuses: ['rejected'] },
  { key: 'all', label: 'All' },
];
const DECISION_LABELS: Record<PayeeDecision, string> = { approve: 'Approve', reject: 'Reject', suspend: 'Suspend' };

export default async function PayeesPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; status?: string }>;
}) {
  await requirePlatformAdmin();
  const params = await searchParams;
  const filter = FILTERS.find((f) => f.key === params.status) ?? FILTERS[0];
  const payees = await createPayeeRepo(getDb()).listAll({ statuses: filter.statuses, limit: 200 });
  const error = params.error ? (ERROR_TEXT[params.error] ?? 'Nothing changed.') : null;
  const ok = !error && params.ok ? OK_TEXT[params.ok] : undefined;

  return (
    <>
      <Sidebar active="payees" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <h1 className="sh-page-title">Payees</h1>
            <p className="sh-page-sub">
              Companies in India that partners add so their customers can pay them through payment links. Approve one only
              after checking it is a real business the partner works with. Every decision and every bank-detail view is audited.
            </p>
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

        <nav aria-label="Filter payees" className="mb-4 flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={`/admin-dashboard/payees?status=${f.key}`}
              aria-current={f.key === filter.key ? 'page' : undefined}
              className={`rounded-full border px-3 py-1 text-sm ${f.key === filter.key ? 'border-primary font-semibold text-primary' : 'text-muted-foreground'}`}
            >
              {f.label}
            </Link>
          ))}
        </nav>

        {payees.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payees here.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Partner</TableHead>
                  <TableHead>Bank account</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead>Decide</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payees.map((p) => {
                  const decisions = (['approve', 'reject', 'suspend'] as const).filter((d) => nextPayeeStatus(p.status, d) !== null);
                  return (
                    <TableRow key={p.id} data-testid={`payee-${p.id}`}>
                      <TableCell className="max-w-[260px] break-words font-medium">{p.legalName}</TableCell>
                      <TableCell className="font-mono text-xs">{p.partnerId}</TableCell>
                      <TableCell>
                        <RevealBank payeeId={p.id} last4={p.payoutLast4} />
                      </TableCell>
                      <TableCell className="space-y-1">
                        <Badge variant={p.status === 'approved' ? 'default' : 'secondary'}>{PAYEE_STATUS_LABELS[p.status]}</Badge>
                        {p.screening === 'review' && (
                          <div className="text-xs font-semibold text-destructive">Screening: possible match</div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {p.createdAt.toISOString().slice(0, 10)} by {p.createdBy}
                        {p.decidedBy && (
                          <div>
                            Decided {p.decidedAt?.toISOString().slice(0, 10)} by {p.decidedBy}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          {decisions.map((d) => (
                            <form key={d} action={decidePayeeAction}>
                              <input type="hidden" name="id" value={p.id} />
                              <input type="hidden" name="decision" value={d} />
                              <Button type="submit" size="sm" variant={d === 'approve' ? 'default' : 'outline'}>
                                {DECISION_LABELS[d]}
                              </Button>
                            </form>
                          ))}
                          {decisions.length === 0 && <span className="text-xs text-muted-foreground">Final</span>}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </main>
    </>
  );
}
