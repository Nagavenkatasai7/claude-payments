export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { requireScope } from '@/lib/auth';
import { scopeOf } from '@/lib/staff-scope';
import { logWarn } from '@/lib/log';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createScopedStore } from '@/lib/scoped-store';
import { getDailyVolumeStore } from '@/lib/daily-volume-store';
import { evaluateCap } from '@/lib/tier-rules';
import { resolveEffectiveSendLimits } from '@/lib/send-limits';
import { sendGateActive } from '@/lib/kyc-gate';
import { maskLast4 } from '@/lib/mask';
import { getStore } from '@/lib/store';
import { getKycCaseStore } from '@/lib/kyc-case-store';
import { Sidebar } from '../../sidebar';
import { ExpandableTable, type ExpandableColumn } from '../../expandable-table';
import { money } from '../../format';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { markCustomerVerifiedAction, markCustomerRejectedAction, reviewKycAction, setCustomerSendLimitAction } from '../actions';
import { KycCopilotPanel } from './kyc-copilot-panel';
import { CustomerLink } from '../../customer-link';
import { openCustomerRef, auditIdentityView } from '@/lib/customer-ref';
import { SendLimitsCard } from '../../send-limits-card';

const TRANSFER_COLUMNS: ExpandableColumn[] = [
  { label: 'ID' },
  { label: 'Amount', primary: true },
  { label: 'Status', primary: true },
  { label: 'Created' },
];

const DL_CLASS =
  'grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm [&_dt]:text-muted-foreground [&_dd]:min-w-0 [&_dd]:break-words';

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ ref: string }>;
}) {
  const { staff } = await requireScope();
  const isAdmin = staff.role === 'admin';
  // Program fix 16b: the raise form is PLATFORM-admin only (the action self-gates too).
  const isPlatformAdmin = isAdmin && scopeOf(staff).kind === 'platform';
  // Program-Fix 37 (dash-04): the URL carries a sealed ref of (tenant, phone),
  // never the phone. Anything else (a raw phone from an old bookmark, a
  // tampered or foreign blob) is a 404. The scope check below is unchanged:
  // the ref only names the row; createScopedStore decides who may see it.
  const opened = openCustomerRef((await params).ref);
  if (!opened) notFound();
  const { phone, partnerId: partnerHint } = opened;

  const scoped = createScopedStore(staff);
  const dailyVolumeStore = getDailyVolumeStore();
  const customer = await scoped.getCustomer(phone, { partnerId: partnerHint || undefined });
  if (!customer) notFound();
  // Program-Fix 37 (dash-05): this page renders decrypted identity, so every
  // view writes one pii.view audit row (field names only, keyed subject).
  // Awaited and not caught: no audit row, no identity on screen.
  await auditIdentityView(getDb(), staff, customer);
  const siblingTenants = (await scoped.customerTenants(phone)).filter((id) => id !== customer.partnerId);

  const [mine, todayUsedCents, partner, kycAudit, lastLimitChange] = await Promise.all([
    // Indexed WHERE partner_id = $1 AND phone = $2 (newest-first) — the F44 read sink is tenant-keyed.
    getStore().listTransfersByPhone(customer.partnerId, phone, 50),
    dailyVolumeStore.getTodayCents(customer.partnerId, phone),
    scoped.getPartner(customer.partnerId),
    getKycCaseStore(getStore())
      .getAudit(customer.partnerId, phone)
      .catch(() => [] as Awaited<ReturnType<ReturnType<typeof getKycCaseStore>['getAudit']>>),
    // Program fix 16b: the last audited raise/clear for THIS (tenant, phone).
    createAuditRepo(getDb()).lastSendLimitChange(customer.partnerId, 'customer', phone).catch((err: unknown) => {
      // Never blank the card silently: log (tenant id only — no phone), then render "—".
      logWarn('admin.send_limits.last_change', err, { scope: 'customer', partnerId: customer.partnerId });
      return null;
    }),
  ]);
  const inReview =
    customer.kycReviewState === 'pending_review' || customer.kycReviewState === 'needs_review';
  const now = new Date();
  const limits = resolveEffectiveSendLimits(partner, customer, now);
  const capEval = evaluateCap(customer, now, todayUsedCents, 0, sendGateActive(partner), limits);

  return (
    <>
      <Sidebar active="customers" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">+{customer.senderPhone}</div>
            <div className="sh-page-sub">
              Customer · joined {new Date(customer.firstSeenAt).toLocaleDateString()}
            </div>
            {siblingTenants.length > 0 && (
              <p className="sh-page-sub">
                This number also exists under:{' '}
                {siblingTenants.map((id) => (
                  <CustomerLink
                    key={id}
                    phone={phone}
                    partnerId={id}
                    className="mr-2 cursor-pointer border-0 bg-transparent p-0 underline-offset-2 hover:underline"
                  >
                    {id}
                  </CustomerLink>
                ))}
              </p>
            )}
          </div>
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Identity &amp; KYC</CardTitle>
            <CardDescription>Verification status and customer-supplied details</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className={DL_CLASS}>
              <dt>Status</dt><dd>{customer.kycStatus}</dd>
              <dt>Verified at</dt><dd>{customer.kycVerifiedAt ?? '—'}</dd>
              <dt>Country</dt><dd>{customer.senderCountry}</dd>
              <dt>Partner</dt><dd>{partner ? partner.name : customer.partnerId}</dd>
              <dt>Provider ref</dt><dd>{customer.kycProviderRef ?? '—'}</dd>
              <dt>Review state</dt><dd>{customer.kycReviewState ?? 'none'}</dd>
              <dt>Inquiry</dt><dd>{customer.kycInquiryId ?? '—'}</dd>
              <dt>ID last 4</dt><dd>{customer.idLast4 ? `••••${customer.idLast4}` : '—'}</dd>
              <dt>Screening</dt><dd>{customer.watchlistHit ? '⚠ Watchlist hit' : customer.pepHit ? '⚠ PEP hit' : 'Clear'}</dd>
              <dt>Full name</dt><dd>{customer.fullName ?? '—'}</dd>
              <dt>DOB</dt><dd>{customer.dateOfBirth ?? '—'}</dd>
              <dt>Nationality</dt><dd>{customer.nationality ?? '—'}</dd>
              <dt>Address</dt><dd>{customer.residentialAddress ?? '—'}</dd>
              <dt>Gov ID</dt><dd>{customer.govIdType ? `${customer.govIdType} ••••${maskLast4(customer.govIdNumber)}` : '—'}</dd>
              <dt>PEP</dt><dd>{customer.pepDeclared ? 'Self-declared' : 'No'}</dd>
              <dt>Source of funds</dt><dd>{customer.sourceOfFunds ?? '—'}</dd>
              <dt>Occupation</dt><dd>{customer.occupation ?? '—'}</dd>
              {customer.kycRejectedReason && (
                <>
                  <dt>Rejected reason</dt>
                  <dd>{customer.kycRejectedReason}</dd>
                </>
              )}
            </dl>
            {isAdmin && customer.kycStatus !== 'verified' && customer.kycStatus !== 'grandfathered' && (
              <form action={markCustomerVerifiedAction} className="mt-4 flex flex-wrap items-center gap-2">
                <input type="hidden" name="phone" value={customer.senderPhone} />
                <input type="hidden" name="partnerId" value={customer.partnerId} />
                <Button type="submit">Mark KYC verified</Button>
              </form>
            )}
            {isAdmin && customer.kycStatus !== 'rejected' && (
              <form action={markCustomerRejectedAction} className="mt-3 flex flex-wrap items-center gap-2">
                <input type="hidden" name="phone" value={customer.senderPhone} />
                <input type="hidden" name="partnerId" value={customer.partnerId} />
                <Input type="text" name="reason" placeholder="Rejection reason (optional)" className="max-w-xs" />
                <Button type="submit" variant="outline">Mark KYC rejected</Button>
              </form>
            )}

            {isAdmin && inReview && (
              <div className="mt-4 space-y-3 rounded-lg border p-4">
                <p className="text-sm text-muted-foreground">
                  Persona {customer.kycReviewState === 'pending_review' ? 'passed — confirm to approve' : 'flagged — review required'}.
                  A reason is required and recorded in the audit log.
                </p>
                <form action={reviewKycAction} className="space-y-3">
                  <input type="hidden" name="phone" value={customer.senderPhone} />
                  <input type="hidden" name="partnerId" value={customer.partnerId} />
                  <textarea
                    name="reason"
                    required
                    placeholder="Reviewer reason (required)"
                    rows={2}
                    className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" name="decision" value="approve">Approve KYC</Button>
                    <Button type="submit" name="decision" value="reject" variant="outline">Reject KYC</Button>
                  </div>
                </form>
                <KycCopilotPanel phone={customer.senderPhone} partnerId={customer.partnerId} />
              </div>
            )}

            {kycAudit.length > 0 && (
              <div className="mt-4 space-y-2">
                <div className="text-sm text-muted-foreground">KYC audit trail</div>
                <ul className="space-y-1 text-sm">
                  {kycAudit.map((e, i) => (
                    <li key={i}>
                      <span className="tabular-nums text-muted-foreground">{e.at}</span> · <strong>{e.actor}</strong> · {e.action}
                      {e.reason ? ` — ${e.reason}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Sending today</CardTitle>
            <CardDescription>Tier and daily cap usage</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className={DL_CLASS}>
              <dt>Tier</dt><dd>{capEval.tier}</dd>
              <dt>Daily cap</dt><dd>${(capEval.dailyCapCents / 100).toFixed(2)}</dd>
              <dt>Today used</dt><dd>${(capEval.todayUsedCents / 100).toFixed(2)}</dd>
              <dt>Today remaining</dt><dd>${(capEval.todayRemainingCents / 100).toFixed(2)}</dd>
              {capEval.dayOfWindow && (
                <>
                  <dt>Day of window</dt>
                  <dd>{capEval.dayOfWindow}/3</dd>
                </>
              )}
            </dl>
          </CardContent>
        </Card>

        {/* Program fix 16b: the effective ladder with its sources; the audited raise form for platform admins. */}
        <SendLimitsCard
          scope="customer"
          effective={limits}
          stored={customer.sendLimitOverride}
          lastChange={lastLimitChange}
          canEdit={isPlatformAdmin}
          action={setCustomerSendLimitAction}
          hidden={{ phone: customer.senderPhone, partnerId: customer.partnerId }}
        />

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Recent transfers</CardTitle>
            <CardDescription>
              {mine.length} {mine.length === 1 ? 'transfer' : 'transfers'} on file
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={TRANSFER_COLUMNS}
              empty={<>No transfers yet.</>}
              rows={mine.slice(0, 50).map((t) => ({
                key: t.id,
                label: t.id,
                cells: [
                  t.id,
                  <div key="amt">
                    <div className="font-medium tabular-nums">{money(t.amountSource, t.sourceCurrency)}</div>
                    {t.sourceCurrency !== 'USD' && (
                      <div className="text-xs text-muted-foreground">≈ {money(t.amountUsd, 'USD')}</div>
                    )}
                  </div>,
                  t.status,
                  new Date(t.createdAt).toLocaleString(),
                ],
              }))}
            />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
