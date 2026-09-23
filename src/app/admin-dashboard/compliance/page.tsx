export const dynamic = 'force-dynamic';

import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { WATCHLIST } from '@/lib/compliance';
import { resolveCorridorRules } from '@/lib/compliance-config';
import { resolveSenderNames, senderNameKey } from '@/lib/sender-names';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { reviewAmlAlertAction, setAmlHoldsAction } from './actions';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { Sidebar } from '../sidebar';
import { SenderCell } from '../sender-cell';
import { money } from '../format';
import { MaskedDestination } from '../masked-destination';
import { canReleaseHeld } from '@/lib/dashboard-ops';
import {
  releaseTransferAction,
  rejectTransferAction,
} from '../actions';
import { ExpandableTable, type ExpandableColumn } from '../expandable-table';
import { ReviewCopilot } from './review-copilot';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import Link from 'next/link';
import { Input } from '@/components/ui/input';
import { CustomerLink } from '../customer-link';
import type { Transfer } from '@/lib/types';

const REVIEW_COLUMNS: ExpandableColumn[] = [
  { label: 'Recipient', primary: true },
  { label: 'Amount', primary: true },
  { label: 'Reasons' },
  { label: 'Created' },
  { label: 'Sender' },
  { label: 'Actions' },
];

const TRANSFER_COLUMNS: ExpandableColumn[] = [
  { label: 'Recipient', primary: true },
  { label: 'Amount', primary: true },
  { label: 'Reasons' },
  { label: 'Created' },
  { label: 'Sender' },
];

const CORRIDOR_COLUMNS: ExpandableColumn[] = [
  { label: 'Partner', primary: true },
  { label: 'Corridor', primary: true },
  { label: 'Large-amount (USD)' },
  { label: 'Velocity / day' },
  { label: 'Watchlist' },
  { label: 'AML holds' },
];

const AML_COLUMNS: ExpandableColumn[] = [
  { label: 'Rule', primary: true },
  { label: 'Transfer', primary: true },
  { label: 'Sender' },
  { label: 'Raised' },
  { label: 'Review' },
];

// Program-Fix 43: staff-facing names for the behavioural rules (aml-rules.ts).
// Staff only — rule names never reach the customer, the bot or the partner API.
const AML_RULE_LABEL: Record<string, string> = {
  structuring: 'Possible structuring',
  first_transfer: 'Large first transfer',
  new_beneficiary: 'Large send to a new beneficiary',
  cluster: 'Many senders → one beneficiary',
};

const VELOCITY_COLUMNS: ExpandableColumn[] = [
  { label: 'Phone', primary: true },
  { label: 'Transfers today', primary: true },
  { label: '' },
];

// "Recipient gets" is denominated in the transfer's DESTINATION currency
// (amountInr holds the destination amount post-multi-currency). Fall back to
// INR for legacy rows written before destinationCurrency existed.
function recipientGets(t: Transfer): string {
  return money(t.amountInr, t.destinationCurrency ?? 'INR');
}

function transferCells(t: Transfer, senderNames: Map<string, string>) {
  return [
    <div key="recipient">
      <div className="font-semibold">{t.recipientName}</div>
      <MaskedDestination
        transferId={t.id}
        payoutMethod={t.payoutMethod}
        payoutDestination={t.payoutDestination}
      />
    </div>,
    <div key="amount">
      <div className="font-semibold tabular-nums">{money(t.amountSource, t.sourceCurrency)}</div>
      {t.sourceCurrency !== 'USD' && (
        <div className="mt-0.5 text-xs text-muted-foreground">≈ {money(t.amountUsd, 'USD')}</div>
      )}
      <div className="mt-0.5 text-xs text-muted-foreground">{recipientGets(t)}</div>
    </div>,
    <span key="reasons" className="inline-flex flex-wrap items-center gap-1.5">
      {t.complianceReasons.length === 0 ? '—' : t.complianceReasons.map((r) =>
        r === 'edd_required'
          ? <Badge key={r} variant="outline" className="border-warning/50 text-warning">EDD required</Badge>
          : <span key={r}>{r}</span>,
      )}
    </span>,
    new Date(t.createdAt).toLocaleString(),
    <SenderCell key="sender" name={senderNames.get(senderNameKey(t.partnerId, t.phone))} phone={t.phone} partnerId={t.partnerId} />,
  ];
}

export default async function CompliancePage() {
  const { staff } = await requireScope();
  const scoped = createScopedStore(staff);
  // Stage 5e scan fix: four indexed queries (status / compliance_status /
  // GROUP BY velocity), partner-scoped at the WHERE — no more loading the
  // whole ledger and filtering in JS per render.
  const { inReview, flagged, blocked, topVelocity: topVel } = await scoped.complianceViews();

  // Program-Fix 43: open behavioural AML alerts (an aml.alert with no
  // aml.reviewed), pinned to the staff member's tenant at the WHERE; the
  // transfers they name are loaded masked and tenant-pinned too.
  const tenant = scoped.scope.kind === 'partner' ? scoped.scope.partnerId : undefined;
  const amlAlerts = await createAuditRepo(getDb()).listOpenAmlAlerts(tenant ?? null, 100);
  const amlTransfers = new Map(
    (await createTransferRepo(getDb()).listByIdsScoped(
      [...new Set(amlAlerts.map((a) => a.subjectId).filter((id): id is string => Boolean(id)))],
      tenant,
    )).map((t) => [t.id, t]),
  );

  // Resolve decrypted sender names for every transfer shown on the page in ONE
  // batched query, so each Sender cell can show the KYC name (linked to the
  // profile) instead of a bare phone — phones with no captured name fall back to
  // the phone inside SenderCell.
  const senderNames = await resolveSenderNames(
    getDb(),
    [...inReview, ...flagged, ...blocked, ...amlTransfers.values()],
  );

  const partners = await scoped.listPartners();
  // Mirrors releaseTransferAction's gate (the server action is the authority):
  // a hold SmartRemit's own screening flagged (kycMode 'ours') is released by
  // PLATFORM staff only, so partner-scoped admins don't see a Release that
  // would refuse. Owner decision 2026-09-16.
  const partnersById = new Map(partners.map((p) => [p.id, p]));
  // Program-Fix 43 follow-up: a sanctions / name-screening hold is PLATFORM-only
  // in every KYC mode — canReleaseHeld reads the transfer's hold reasons.
  const canRelease = (t: Transfer) => canReleaseHeld(scoped.scope, partnersById.get(t.partnerId), t);
  const corridorRows = partners.flatMap((p) =>
    (p.countries ?? [])
      .filter((c) => c !== 'IN')
      .map((country) => {
        const rules = resolveCorridorRules(p, country);
        return {
          partnerId: p.id,
          country,
          partnerName: p.name ?? '',
          corridor: `${country} → IN`,
          amlHolds: rules.amlHolds,
          largeAmountUsd: rules.largeAmountUsd,
          velocityLimit: rules.velocityLimit,
          watchlistSize: rules.baseWatchlist.length + rules.watchlistExtra.length,
          watchlistExtra: rules.watchlistExtra,
        };
      }),
  );
  // Program-Fix 43 PR B: only platform admins may switch a partner's AML
  // holds (setAmlHoldsAction re-checks — the action is the authority).
  const canSetAmlHolds = staff.role === 'admin' && scoped.scope.kind !== 'partner';
  corridorRows.sort((a, b) => (a.partnerName + a.corridor).localeCompare(b.partnerName + b.corridor));

  return (
    <>
      <Sidebar active="compliance" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Compliance</div>
            <div className="sh-page-sub">
              Flagged + blocked transfers · watchlist · velocity
            </div>
          </div>
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Needs review</CardTitle>
            <CardDescription>
              {inReview.length} {inReview.length === 1 ? 'transfer' : 'transfers'} — payment captured, pending staff decision.
              Rejecting cancels the transfer and automatically refunds the captured charge to the sender&apos;s original payment method.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={REVIEW_COLUMNS}
              empty={<>No transfers awaiting review.</>}
              rows={inReview.map((t) => ({
                key: t.id,
                label: t.recipientName,
                cells: [
                  ...transferCells(t, senderNames),
                  <div key="actions">
                    <div className="flex flex-wrap gap-2">
                      {canRelease(t) ? (
                        <form action={releaseTransferAction} className="flex flex-col gap-1">
                          <input type="hidden" name="id" value={t.id} />
                          <div className="flex items-center gap-1">
                            {/* Program-Fix 43 follow-up: a release reason is
                                REQUIRED (the action refuses a blank one) and
                                is written to the audit log with the actor. */}
                            <Input
                              name="note"
                              required
                              maxLength={500}
                              placeholder="Reason (required)"
                              aria-label="Release reason (required)"
                              aria-describedby={`release-help-${t.id}`}
                              className="h-8 w-36"
                            />
                            <Button type="submit" size="sm">Release</Button>
                          </div>
                          <span id={`release-help-${t.id}`} className="text-xs text-muted-foreground">
                            Why is this hold being released? Recorded in the audit log.
                          </span>
                        </form>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          disabled
                          title="Flagged by SmartRemit screening — release requires SmartRemit platform staff"
                        >
                          Release
                        </Button>
                      )}
                      <form action={rejectTransferAction} className="flex items-center gap-1">
                        <input type="hidden" name="id" value={t.id} />
                        <Input name="note" maxLength={500} placeholder="Note (optional)" aria-label="Note (optional)" className="h-8 w-36" />
                        <Button
                          type="submit"
                          size="sm"
                          variant="outline"
                          className="text-destructive"
                          title="Cancels the transfer and auto-refunds the captured charge to the sender"
                        >
                          Reject &amp; refund
                        </Button>
                      </form>
                    </div>
                    {/* Rung-1 copilot: suggests a disposition narrative; the
                        Release / Reject actions above stay the deterministic,
                        audited decision — the AI never executes. */}
                    <ReviewCopilot transferId={t.id} />
                  </div>,
                ],
              }))}
            />
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Flagged transfers</CardTitle>
            <CardDescription>
              {flagged.length} {flagged.length === 1 ? 'transfer' : 'transfers'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={TRANSFER_COLUMNS}
              empty={<>No flagged transfers.</>}
              rows={flagged.map((t) => ({
                key: t.id,
                label: t.recipientName,
                cells: transferCells(t, senderNames),
              }))}
            />
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Blocked transfers</CardTitle>
            <CardDescription>
              {blocked.length} {blocked.length === 1 ? 'transfer' : 'transfers'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={TRANSFER_COLUMNS}
              empty={<>No blocked transfers.</>}
              rows={blocked.map((t) => ({
                key: t.id,
                label: t.recipientName,
                cells: transferCells(t, senderNames),
              }))}
            />
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Behavioural alerts</CardTitle>
            <CardDescription>
              {amlAlerts.length} open {amlAlerts.length === 1 ? 'alert' : 'alerts'} — review items only.
              These never hold a transfer and are never shown to the customer.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={AML_COLUMNS}
              empty={<>No open behavioural alerts.</>}
              rows={amlAlerts.map((a) => {
                const t = a.subjectId ? amlTransfers.get(a.subjectId) : undefined;
                const label = AML_RULE_LABEL[String(a.meta.rule)] ?? 'Behavioural alert';
                return {
                  key: String(a.id),
                  label,
                  cells: [
                    <span key="rule" className="font-semibold">{label}</span>,
                    a.subjectId ? (
                      <Link key="transfer" href={`/admin-dashboard/transactions/${a.subjectId}`} className="font-mono text-xs hover:underline">
                        {a.subjectId}
                      </Link>
                    ) : '—',
                    t ? (
                      <SenderCell key="sender" name={senderNames.get(senderNameKey(t.partnerId, t.phone))} phone={t.phone} partnerId={t.partnerId} />
                    ) : '—',
                    new Date(a.at).toLocaleString(),
                    <form key="review" action={reviewAmlAlertAction} className="flex flex-wrap items-center gap-1">
                      <input type="hidden" name="alertId" value={a.id} />
                      <Input name="note" maxLength={500} placeholder="Note (optional)" aria-label="Note (optional)" className="h-8 w-36" />
                      <Button type="submit" size="sm" variant="outline" name="disposition" value="no_action">No action</Button>
                      <Button type="submit" size="sm" name="disposition" value="escalated">Escalate</Button>
                    </form>,
                  ],
                };
              })}
            />
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Watchlist</CardTitle>
            <CardDescription>
              Recipient names that hard-block a transfer (read-only)
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {WATCHLIST.map((name) => (
              <Badge key={name} variant="destructive">{name}</Badge>
            ))}
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Corridor rules</CardTitle>
            <CardDescription>
              Resolved compliance rules per corridor. AML holds are OFF by default: when ON, a transfer on
              that partner&apos;s live (http) rail that trips a behavioural rule is held for review. Demo
              transfers are never held.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={CORRIDOR_COLUMNS}
              empty={<>No corridors configured.</>}
              rows={corridorRows.map((r) => ({
                key: r.partnerName + r.corridor,
                label: `${r.partnerName} ${r.corridor}`,
                cells: [
                  r.partnerName,
                  r.corridor,
                  // largeAmountUsd is a USD-equivalent threshold, not a source amount — always USD
                  <span key="large" className="font-semibold tabular-nums">{money(r.largeAmountUsd, 'USD')}</span>,
                  <span key="velocity" className="font-semibold tabular-nums">{r.velocityLimit}</span>,
                  <span key="watchlist">
                    {r.watchlistSize}
                    {r.watchlistExtra.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {r.watchlistExtra.map((name) => (
                          <Badge key={name} variant="destructive">{name}</Badge>
                        ))}
                      </div>
                    )}
                  </span>,
                  r.partnerId === DEFAULT_PARTNER_ID ? (
                    <span key="aml-holds" className="text-muted-foreground">Never (demo)</span>
                  ) : (
                    <span key="aml-holds" className="inline-flex flex-wrap items-center gap-2">
                      <Badge variant={r.amlHolds ? 'destructive' : 'outline'}>{r.amlHolds ? 'On' : 'Off'}</Badge>
                      {canSetAmlHolds && (
                        <form action={setAmlHoldsAction}>
                          <input type="hidden" name="partnerId" value={r.partnerId} />
                          <input type="hidden" name="country" value={r.country} />
                          <input type="hidden" name="on" value={r.amlHolds ? 'off' : 'on'} />
                          <Button type="submit" size="sm" variant="outline">
                            {r.amlHolds ? 'Turn off' : 'Turn on'}
                          </Button>
                        </form>
                      )}
                    </span>
                  ),
                ],
              }))}
            />
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Top velocity today</CardTitle>
            <CardDescription>
              Phones with the most transfers today
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={VELOCITY_COLUMNS}
              empty={<>No activity today yet.</>}
              rows={topVel.map(({ phone, count }) => ({
                key: phone,
                label: phone,
                cells: [
                  phone,
                  <span key="count" className="font-semibold tabular-nums">{count}</span>,
                  // Program-Fix 37: a POST link to the customer page (sealed-ref URL,
                  // it lists the transfers), never a phone query in a URL.
                  <CustomerLink key="link" phone={phone} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
                    View customer
                  </CustomerLink>,
                ],
              }))}
            />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
