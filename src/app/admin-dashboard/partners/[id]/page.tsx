export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { getStore } from '@/lib/store';
import { getDb } from '@/db/client';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { getAuthStore } from '@/lib/auth-store';
import { getPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { getPartnerApiKeyStore } from '@/lib/partner-api-key';
import { env } from '@/lib/env';
import { Sidebar } from '../../sidebar';
import { ExpandableTable, type ExpandableColumn } from '../../expandable-table';
import { IssueKeyButton } from '../issue-key-button';
import { CopyField } from '../copy-field';
import { LogoUpload } from '../logo-upload';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  setPartnerStatusAction,
  updatePartnerAction,
  createPartnerStaffAction,
  removePartnerStaffAction,
  saveWhatsappConfigAction,
  savePaymentConfigAction,
  savePricingAction,
  saveSupportConfigAction,
  revokeApiKeyAction,
} from '../actions';
import type { CountryCode, CurrencyCode, PartnerRate } from '@/lib/types';
import { DEFAULT_CURRENCY_FOR_COUNTRY } from '@/lib/types';
import { scorePartnerHealth, type HealthBand } from '@/lib/partner-health';
import { narratePartnerHealth } from '@/lib/partner-health-ai';

// Stage 5c: the partner detail is TABS (Overview · Settings · WhatsApp ·
// Settlement · API keys · Staff · Integration) instead of a card pile — every
// form and action is byte-identical to before; only the layout moved. The
// Activity numbers come from the one-query SQL summary instead of scanning
// the ledger, and recents are one indexed keyset page.

function configuredBadge(set: boolean) {
  return set ? (
    <Badge variant="outline" className="border-success/50 text-success">configured</Badge>
  ) : (
    <Badge variant="outline" className="text-muted-foreground">not set</Badge>
  );
}

const ALL_COUNTRIES: CountryCode[] = ['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN'];

// The supported corridor currencies — derived from the single source of truth.
const ALL_CURRENCIES: CurrencyCode[] = [...new Set(Object.values(DEFAULT_CURRENCY_FOR_COUNTRY))];

const RATE_COLUMNS: ExpandableColumn[] = [
  { label: 'Corridor', primary: true },
  { label: 'Pushed rate', primary: true },
  { label: 'Freshness', primary: true },
  { label: 'Expires' },
  { label: 'Margin (bps)' },
];

// FRESH = a pushed rate the selector would actually use (mirrors
// effectiveRateFor: rate > 0 AND expiresAt in the future); EXPIRED = pushed
// but no longer competing; — = never pushed.
function freshnessBadge(r: PartnerRate, nowMs: number) {
  if (r.effectiveRate === undefined) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const fresh =
    r.effectiveRate > 0 && r.expiresAt !== undefined && Date.parse(r.expiresAt) > nowMs;
  return fresh ? (
    <Badge variant="outline" className="border-success/50 text-success">FRESH</Badge>
  ) : (
    <Badge variant="outline" className="text-destructive">EXPIRED</Badge>
  );
}

// Partner-health band → a labelled, colour-coded badge. Deterministic (the
// scorer decides the band); this is presentation only.
const HEALTH_BADGE: Record<HealthBand, { label: string; className: string }> = {
  healthy: { label: 'Healthy', className: 'border-success/50 text-success' },
  watch: { label: 'Watch', className: 'border-amber-500/50 text-amber-500' },
  at_risk: { label: 'At risk', className: 'border-destructive/60 text-destructive' },
  stalled: { label: 'Stalled', className: 'border-destructive text-destructive' },
};

function healthBadge(band: HealthBand) {
  const b = HEALTH_BADGE[band];
  return (
    <Badge variant="outline" className={b.className}>{b.label}</Badge>
  );
}

const TRANSFER_COLUMNS: ExpandableColumn[] = [
  { label: 'ID' },
  { label: 'Phone', primary: true },
  { label: 'Amount', primary: true },
  { label: 'Status', primary: true },
  { label: 'Created' },
];

const STAFF_COLUMNS: ExpandableColumn[] = [
  { label: 'Name', primary: true },
  { label: 'Username' },
  { label: 'Role', primary: true },
  { label: 'Created' },
  { label: 'Actions' },
];

const DL_CLASS =
  'grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm [&_dt]:text-muted-foreground [&_dd]:min-w-0 [&_dd]:break-words';

const SELECT_CLASS = 'h-9 w-full rounded-md border border-input bg-card px-3 text-sm';

const PRE_CLASS =
  'rounded-lg border border-border bg-[#1c2024] p-3 text-xs text-[#e6e8ec] overflow-x-auto';

export default async function PartnerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { staff } = await requireScope();
  const isAdmin = staff.role === 'admin';
  const isPlatformAdmin = isAdmin && !staff.partnerId;
  const { id } = await params;

  const scoped = createScopedStore(staff);
  const partner = await scoped.getPartner(id);
  if (!partner) notFound();

  // Activity = one SQL aggregate; recents = one indexed page (Stage 5c —
  // previously this page serialized the whole ledger per render).
  const [summary, recentPage, allStaff, integrations, apiKeys, rates] = await Promise.all([
    getStore().transfersSummary(partner.id), // partner.id is scope-checked above
    scoped.transfersPage({ limit: 50, partnerFilter: partner.id }),
    getAuthStore().listStaff(),
    getPartnerIntegrationsStore().getIntegrations(partner.id),
    getPartnerApiKeyStore().list(partner.id),
    createPartnerRateRepo(getDb()).listRatesForPartner(partner.id), // scope-checked above
  ]);
  const nowMs = Date.now();
  const recents = recentPage.items;
  const partnerStaff = allStaff.filter((s) => s.partnerId === partner.id);
  // Support tab: the absent-config default (portal ON) interpreted ONCE for
  // both the badge and the checkbox.
  const portalEnabled = partner.supportConfig?.enableSupportPortal !== false;

  // Partner health (U4): a deterministic struggling/stalled scorer over the data
  // already loaded above — surfaces a partner before they churn. The AI
  // narration ("why + outreach") is best-effort: a model outage just omits it,
  // the band + signals always render. The 'default' platform partner is not a
  // reseller, so its health is meaningless — skip it.
  const showHealth = partner.id !== 'default';
  const health = showHealth
    ? scorePartnerHealth({ summary, apiKeys, rates, now: nowMs })
    : null;
  let healthNarration: string | null = null;
  if (health && health.band !== 'healthy') {
    try {
      healthNarration = await narratePartnerHealth(health.band, health.signals);
    } catch {
      healthNarration = null; // model unavailable — deterministic signals stand alone
    }
  }

  return (
    <>
      <Sidebar active="partners" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">{partner.name}</div>
            <div className="sh-page-sub">
              Partner · {partner.id} · created {new Date(partner.createdAt).toLocaleDateString()} ·{' '}
              <Badge variant={partner.status === 'active' ? 'secondary' : 'destructive'}>
                {partner.status}
              </Badge>
            </div>
          </div>
          {isPlatformAdmin && partner.id !== 'default' && (
            <form action={setPartnerStatusAction}>
              <input type="hidden" name="id" value={partner.id} />
              <input
                type="hidden"
                name="status"
                value={partner.status === 'active' ? 'suspended' : 'active'}
              />
              <Button
                type="submit"
                variant={partner.status === 'active' ? 'outline' : 'default'}
              >
                {partner.status === 'active' ? 'Suspend' : 'Reactivate'}
              </Button>
            </form>
          )}
        </div>

        <Tabs defaultValue="overview">
          <TabsList className="mb-4 flex-wrap">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            {isAdmin && <TabsTrigger value="settings">Settings</TabsTrigger>}
            {isAdmin && <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>}
            {isAdmin && <TabsTrigger value="settlement">Settlement</TabsTrigger>}
            {isAdmin && <TabsTrigger value="pricing">Pricing</TabsTrigger>}
            {isAdmin && <TabsTrigger value="support">Support</TabsTrigger>}
            {isAdmin && <TabsTrigger value="api-keys">API keys</TabsTrigger>}
            <TabsTrigger value="staff">Staff</TabsTrigger>
            {isAdmin && <TabsTrigger value="integration">Integration</TabsTrigger>}
          </TabsList>

          {/* ── Overview ─────────────────────────────────────────────────── */}
          <TabsContent value="overview">
            {health && (
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2.5">
                    Integration health {healthBadge(health.band)}
                  </CardTitle>
                  <CardDescription>
                    Deterministic churn-risk read from this partner&apos;s activity, rate feed, and queue.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {health.signals.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No risk signals — recent activity and nothing needing attention.
                    </p>
                  ) : (
                    <ul className="list-disc space-y-1 pl-5 text-sm">
                      {health.signals.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ul>
                  )}
                  {healthNarration && (
                    <div className="mt-4 rounded-lg border border-border bg-muted/40 p-3">
                      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Suggested outreach (AI)
                      </div>
                      <p className="whitespace-pre-line text-sm">{healthNarration}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <Card className="mb-6">
              <CardHeader>
                <CardTitle>Activity</CardTitle>
                <CardDescription>Lifetime totals for this partner</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className={DL_CLASS}>
                  <dt>Transfers</dt><dd>{summary.total}</dd>
                  <dt>Lifetime volume</dt><dd>${summary.volumeAllTime.toFixed(2)}</dd>
                  <dt>Commission (paid/delivered)</dt><dd>${summary.commissionAllTime.toFixed(2)}</dd>
                  <dt>Needs attention</dt><dd>{summary.needsAttention}</dd>
                </dl>
              </CardContent>
            </Card>

            <Card className="mb-6">
              <CardHeader>
                <CardTitle>Identity</CardTitle>
                <CardDescription>Partner record &amp; white-label branding</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className={DL_CLASS}>
                  <dt>ID</dt><dd>{partner.id}</dd>
                  <dt>Name</dt><dd>{partner.name}</dd>
                  <dt>Logo</dt>
                  <dd>
                    {partner.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={partner.logoUrl}
                        alt={`${partner.name} logo`}
                        className="h-9 max-w-[180px] rounded border border-border bg-white object-contain p-1"
                      />
                    ) : ('—')}
                  </dd>
                  <dt>Display name</dt><dd>{partner.displayName ?? '—'}</dd>
                  <dt>Countries</dt><dd>{partner.countries.join(', ')}</dd>
                  <dt>KYC mode</dt>
                  <dd>{partner.kycMode === 'delegated' ? 'partner-run (delegated)' : 'SmartRemit-run'}</dd>
                  <dt>Primary color</dt>
                  <dd>
                    {partner.primaryColor ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="inline-block h-3 w-3 rounded-sm border border-border"
                          style={{ background: partner.primaryColor }}
                        />
                        {partner.primaryColor}
                      </span>
                    ) : ('—')}
                  </dd>
                  <dt>Support contact</dt><dd>{partner.supportContact ?? '—'}</dd>
                  <dt>Updated</dt><dd>{new Date(partner.updatedAt).toLocaleString()}</dd>
                </dl>
              </CardContent>
            </Card>

            <Card className="mb-6">
              <CardHeader>
                <CardTitle>Recent transfers</CardTitle>
                <CardDescription>Latest {recents.length} (of {summary.total})</CardDescription>
              </CardHeader>
              <CardContent>
                <ExpandableTable
                  columns={TRANSFER_COLUMNS}
                  empty={<>No transfers yet.</>}
                  rows={recents.map((t) => ({
                    key: t.id,
                    label: t.id,
                    cells: [
                      t.id,
                      `+${t.phone}`,
                      <div key="amount" className="font-medium tabular-nums">${t.amountUsd.toFixed(2)}</div>,
                      t.status,
                      new Date(t.createdAt).toLocaleString(),
                    ],
                  }))}
                />
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Settings (identity + branding + KYC — one form, one action) ── */}
          {isAdmin && (
            <TabsContent value="settings">
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle>Settings</CardTitle>
                  <CardDescription>Identity, branding, and KYC posture</CardDescription>
                </CardHeader>
                <CardContent>
                  <form action={updatePartnerAction} className="space-y-4">
                    <input type="hidden" name="id" value={partner.id} />
                    <Input name="name" defaultValue={partner.name} placeholder="Partner name" required />
                    <fieldset className="rounded-lg border border-border p-4">
                      <legend className="px-1 text-sm font-medium">Operating countries</legend>
                      <div className="flex flex-wrap gap-x-5 gap-y-2">
                        {ALL_COUNTRIES.map((c) => (
                          <label className="flex items-center gap-1.5 text-sm" key={c}>
                            <input type="checkbox" name="countries" value={c} defaultChecked={partner.countries.includes(c)} /> {c}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <Input name="brandName" defaultValue={partner.brandName ?? ''} placeholder="Brand name (internal, optional)" />
                    <Input name="displayName" defaultValue={partner.displayName ?? ''} placeholder="Display name — the brand customers see (e.g. Acme Pay)" />
                    <Input name="supportContact" defaultValue={partner.supportContact ?? ''} placeholder="Support contact (e.g. support@acme.com)" />
                    <Input name="botPersona" defaultValue={partner.botPersona ?? ''} placeholder="Bot persona / tone (optional, e.g. warm and concise)" />
                    <Input name="primaryColor" type="color" className="h-10 w-20 p-1" defaultValue={partner.primaryColor ?? '#1a73e8'} />
                    <div className="space-y-1.5">
                      <Label>Logo</Label>
                      <LogoUpload name="logoUrl" defaultValue={partner.logoUrl ?? ''} />
                    </div>
                    <fieldset className="rounded-lg border border-border p-4">
                      <legend className="px-1 text-sm font-medium">KYC handling</legend>
                      <div className="space-y-1.5">
                        <Label htmlFor="p-kycmode">Who runs identity verification?</Label>
                        <select id="p-kycmode" className={SELECT_CLASS} name="kycMode" defaultValue={partner.kycMode ?? 'ours'}>
                          <option value="ours">SmartRemit runs KYC (default)</option>
                          <option value="delegated">Partner runs KYC (delegated)</option>
                        </select>
                      </div>
                      <label className="mt-3 flex items-center gap-1.5 text-sm">
                        <input type="checkbox" name="requireKycBeforeSend" defaultChecked={partner.requireKycBeforeSend === true} />{' '}
                        Require identity verification before sending (off ⇒ customers send immediately)
                      </label>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Off by default. Sanctions screening always runs, in both modes, regardless of this setting.
                      </p>
                    </fieldset>
                    <Input name="adminNote" defaultValue={partner.adminNote ?? ''} placeholder="Admin note (internal, optional)" />
                    <Button type="submit">Save changes</Button>
                  </form>
                </CardContent>
              </Card>
            </TabsContent>
          )}

          {/* ── WhatsApp channel ─────────────────────────────────────────── */}
          {isAdmin && (
            <TabsContent value="whatsapp">
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle>WhatsApp channel</CardTitle>
                  <CardDescription>
                    Bring your own Meta WhatsApp Business number. Secrets are write-only —
                    leave a field blank to keep the stored value.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className={DL_CLASS}>
                    <dt>Access token</dt><dd>{configuredBadge(Boolean(integrations.whatsapp.token))}</dd>
                    <dt>Verify token</dt><dd>{configuredBadge(Boolean(integrations.whatsapp.verifyToken))}</dd>
                    <dt>App secret</dt><dd>{configuredBadge(Boolean(integrations.whatsapp.appSecret))}</dd>
                  </dl>
                  <form action={saveWhatsappConfigAction} className="mt-4 space-y-4">
                    <input type="hidden" name="id" value={partner.id} />
                    <Input name="phoneNumberId" defaultValue={integrations.whatsapp.phoneNumberId ?? ''} placeholder="Phone number ID (from Meta — routes inbound messages)" />
                    <Input name="token" type="password" autoComplete="off" placeholder="Access token (leave blank to keep)" />
                    <Input name="verifyToken" type="password" autoComplete="off" placeholder="Webhook verify token (leave blank to keep)" />
                    <Input name="appSecret" type="password" autoComplete="off" placeholder="App secret (leave blank to keep)" />
                    <Button type="submit">Save WhatsApp config</Button>
                  </form>
                  <div className="mt-4">
                    <CopyField label="Webhook callback URL (paste into Meta → WhatsApp → Configuration)" value={`${env.appBaseUrl}/api/whatsapp/${partner.id}`} />
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          )}

          {/* ── Settlement rail ──────────────────────────────────────────── */}
          {isAdmin && (
            <TabsContent value="settlement">
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle>Settlement rail</CardTitle>
                  <CardDescription>
                    You settle funds; we relay the signed instruction and mirror your status callback.
                    SmartRemit never holds funds.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className={DL_CLASS}>
                    <dt>Provider</dt><dd>{integrations.payment.providerType ?? 'mock (default)'}</dd>
                    <dt>Settlement endpoint</dt><dd>{configuredBadge(Boolean(integrations.payment.credentials?.settlementUrl))}</dd>
                    <dt>Signing secret</dt><dd>{configuredBadge(Boolean(integrations.payment.credentials?.signingSecret))}</dd>
                    <dt>Webhook secret</dt><dd>{configuredBadge(Boolean(integrations.payment.webhookSecret))}</dd>
                  </dl>
                  <form action={savePaymentConfigAction} className="mt-4 space-y-4">
                    <input type="hidden" name="id" value={partner.id} />
                    <div className="space-y-1.5">
                      <Label htmlFor="p-provider">Settlement provider</Label>
                      <select id="p-provider" className={SELECT_CLASS} name="providerType" defaultValue={integrations.payment.providerType ?? 'mock'}>
                        <option value="mock">Mock (auto-deliver, for testing)</option>
                        <option value="simulator">Simulator (real webhook loop, demo)</option>
                        <option value="http">HTTP rail (your live settlement endpoint)</option>
                      </select>
                    </div>
                    <Input name="settlementUrl" type="url" autoComplete="off" defaultValue={integrations.payment.credentials?.settlementUrl ?? ''} placeholder="Settlement endpoint URL — we POST signed instructions here (auto-filled for Simulator)" />
                    <Input name="signingSecret" type="password" autoComplete="off" placeholder="Outbound signing secret (leave blank to keep)" />
                    <Input name="webhookSecret" type="password" autoComplete="off" placeholder="Inbound webhook secret (leave blank to keep)" />
                    <Button type="submit">Save settlement config</Button>
                  </form>
                </CardContent>
              </Card>
            </TabsContent>
          )}

          {/* ── Pricing (per-corridor rates + admin margin) ──────────────── */}
          {isAdmin && (
            <TabsContent value="pricing">
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle>Pricing</CardTitle>
                  <CardDescription>
                    Per-corridor pricing for best-rate selection. Pushed rates come from your
                    rate API and expire; the margin is a standing adjustment off mid-market
                    (positive ⇒ better for the customer) used when no fresh push exists.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ExpandableTable
                    columns={RATE_COLUMNS}
                    empty={<>No corridor pricing yet — set a margin below or push a rate via the API.</>}
                    rows={rates.map((r) => ({
                      key: `${r.sourceCurrency}-${r.destinationCurrency}`,
                      label: `${r.sourceCurrency} → ${r.destinationCurrency}`,
                      cells: [
                        `${r.sourceCurrency} → ${r.destinationCurrency}`,
                        r.effectiveRate !== undefined ? (
                          <span key="pushed" className="tabular-nums">{r.effectiveRate}</span>
                        ) : (
                          <span key="pushed" className="text-xs text-muted-foreground">—</span>
                        ),
                        freshnessBadge(r, nowMs),
                        r.expiresAt ? new Date(r.expiresAt).toLocaleString() : '—',
                        r.marginBps !== undefined ? (
                          <span key="margin" className="tabular-nums">{r.marginBps}</span>
                        ) : (
                          <span key="margin" className="text-xs text-muted-foreground">—</span>
                        ),
                      ],
                    }))}
                  />
                  <form action={savePricingAction} className="mt-4 space-y-4">
                    <input type="hidden" name="id" value={partner.id} />
                    <div className="grid gap-4 sm:grid-cols-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="p-rate-source">Source currency</Label>
                        <select id="p-rate-source" className={SELECT_CLASS} name="sourceCurrency" defaultValue="USD">
                          {ALL_CURRENCIES.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="p-rate-dest">Destination currency</Label>
                        <select id="p-rate-dest" className={SELECT_CLASS} name="destinationCurrency" defaultValue="INR">
                          {ALL_CURRENCIES.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="p-rate-margin">Margin (bps)</Label>
                        <Input
                          id="p-rate-margin"
                          name="marginBps"
                          type="number"
                          step="1"
                          min="-10000"
                          max="10000"
                          placeholder="e.g. 25 — empty clears"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Saving updates only the margin — a rate your systems pushed is never overwritten here.
                    </p>
                    <Button type="submit">Save margin</Button>
                  </form>
                </CardContent>
              </Card>
            </TabsContent>
          )}

          {/* ── Support (admin-controlled support behavior) ──────────────── */}
          {isAdmin && (
            <TabsContent value="support">
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle>Support</CardTitle>
                  <CardDescription>
                    How this partner&apos;s customer support behaves. Internal-only — nothing
                    here is shown to customers.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className={DL_CLASS}>
                    <dt>Customer support portal</dt>
                    <dd>
                      {portalEnabled ? (
                        <Badge variant="outline" className="border-success/50 text-success">enabled</Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">disabled</Badge>
                      )}
                    </dd>
                    <dt>Ticket auto-assignment</dt>
                    <dd>{partner.supportConfig?.autoAssign === 'round_robin' ? 'round-robin' : 'none (manual)'}</dd>
                  </dl>
                  <form action={saveSupportConfigAction} className="mt-4 space-y-4">
                    <input type="hidden" name="id" value={partner.id} />
                    <label className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        name="enableSupportPortal"
                        defaultChecked={portalEnabled}
                      />{' '}
                      Enable the customer support portal (on by default)
                    </label>
                    <div className="space-y-1.5">
                      <Label htmlFor="p-autoassign">Auto-assign new tickets</Label>
                      <select
                        id="p-autoassign"
                        className={SELECT_CLASS}
                        name="autoAssign"
                        defaultValue={partner.supportConfig?.autoAssign ?? 'none'}
                      >
                        <option value="none">None — staff pick from the queue</option>
                        <option value="round_robin">Round-robin across support staff</option>
                      </select>
                    </div>
                    <Button type="submit">Save support config</Button>
                  </form>
                </CardContent>
              </Card>
            </TabsContent>
          )}

          {/* ── API keys ─────────────────────────────────────────────────── */}
          {isAdmin && (
            <TabsContent value="api-keys">
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle>API keys</CardTitle>
                  <CardDescription>
                    Connect your systems to the Partner API. Keys are shown once at issue and stored hashed.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {apiKeys.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No keys yet — issue one below to connect your systems.</p>
                  ) : (
                    <dl className={DL_CLASS}>
                      {apiKeys.map((k) => (
                        <div key={k.keyId} className="contents">
                          <dt><code>sr_live_…{k.last4}</code></dt>
                          <dd className="flex flex-wrap items-center gap-2.5">
                            {k.revokedAt ? (
                              <Badge variant="outline" className="text-muted-foreground">revoked</Badge>
                            ) : (
                              <Badge variant="secondary">active</Badge>
                            )}
                            <span className="text-xs text-muted-foreground">issued {new Date(k.createdAt).toLocaleDateString()}</span>
                            {!k.revokedAt && (
                              <form action={revokeApiKeyAction.bind(null, partner.id)}>
                                <input type="hidden" name="keyId" value={k.keyId} />
                                <Button type="submit" size="sm" variant="outline" className="text-destructive">Revoke</Button>
                              </form>
                            )}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  <IssueKeyButton partnerId={partner.id} />
                </CardContent>
              </Card>
            </TabsContent>
          )}

          {/* ── Staff ────────────────────────────────────────────────────── */}
          <TabsContent value="staff">
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>Staff for this partner</CardTitle>
                <CardDescription>
                  {partnerStaff.length} {partnerStaff.length === 1 ? 'member' : 'members'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ExpandableTable
                  columns={STAFF_COLUMNS}
                  empty={<>No staff yet.</>}
                  rows={partnerStaff.map((s) => ({
                    key: s.username,
                    label: s.name,
                    cells: [
                      s.name,
                      s.username,
                      <Badge key="role" variant={s.role === 'admin' ? 'default' : 'secondary'}>
                        {s.role}
                      </Badge>,
                      new Date(s.createdAt).toLocaleDateString(),
                      isAdmin ? (
                        <form key="actions" action={removePartnerStaffAction}>
                          <input type="hidden" name="username" value={s.username} />
                          <Button type="submit" size="sm" variant="outline" className="text-destructive">Remove</Button>
                        </form>
                      ) : null,
                    ],
                  }))}
                />
                {isAdmin && (
                  <form action={createPartnerStaffAction.bind(null, partner.id)} className="mt-4 space-y-4">
                    <Input name="username" placeholder="Username" required />
                    <Input name="name" placeholder="Full name" required />
                    <Input name="password" type="password" placeholder="Password" required />
                    <select className={SELECT_CLASS} name="role" defaultValue="agent">
                      <option value="agent">Agent</option>
                      <option value="support">Support</option>
                      <option value="admin">Admin</option>
                    </select>
                    <Button type="submit">Invite staff</Button>
                  </form>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Integration guide ────────────────────────────────────────── */}
          {isAdmin && (
            <TabsContent value="integration">
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle>Integration guide</CardTitle>
                  <CardDescription>
                    Everything your engineers need to connect — webhook URLs, signatures, and API examples.
                    All signatures are HMAC-SHA256 (hex) over the exact raw request body, sent in a header.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="mb-2 text-sm font-semibold">1 · WhatsApp (your Meta app → us)</div>
                  <CopyField label="Webhook callback URL (paste into Meta → WhatsApp → Configuration)" value={`${env.appBaseUrl}/api/whatsapp/${partner.id}`} />
                  <p className="mb-4 text-xs text-muted-foreground">
                    Use the <strong>verify token</strong> you saved on the WhatsApp tab. Inbound
                    events are verified against your <strong>app secret</strong> (x-hub-signature-256) — this
                    endpoint rejects anything unsigned.
                  </p>

                  <div className="mb-2 text-sm font-semibold">2 · Settlement instructions (us → your rail)</div>
                  <pre className={`${PRE_CLASS} mb-4`}>
{`POST <your settlement endpoint>   x-signature: HMAC-SHA256(body)
{ "reference": "<transfer id>", "partner_id": "${partner.id}",
  "corridor": {"source": "US", "destination": "IN"},
  "payout": {"rail": "bank", "destination": "<account>"},
  "recipient": {"name": "...", "phone": "..."},
  "amount": {"source": 200, "currency": "USD",
             "destination": 16600, "destination_currency": "INR", "fx_rate": 83} }
→ 200 { "providerRef": "<your settlement id>" }`}
                  </pre>

                  <div className="mb-2 text-sm font-semibold">3 · Status callbacks (your rail → us)</div>
                  <CopyField label="Status callback URL (POST lifecycle events here)" value={`${env.appBaseUrl}/api/payment-webhook/${integrations.payment.providerType === 'simulator' ? 'simulator' : 'http'}`} />
                  <pre className={`${PRE_CLASS} mb-4`}>
{`POST ...   x-signature: HMAC-SHA256(body) with your INBOUND webhook secret
{ "reference": "<transfer id>", "status": "created | funded | paid_out" }
Delivery fires on "paid_out". Duplicates and out-of-order events are ignored.`}
                  </pre>

                  <div className="mb-2 text-sm font-semibold">4 · Partner API (your systems → us)</div>
                  <CopyField label="API base URL" value={`${env.appBaseUrl}/api/partner/v1`} />
                  <pre className={PRE_CLASS}>
{`# Quote
curl -X POST ${env.appBaseUrl}/api/partner/v1/quote \\
  -H "Authorization: Bearer sr_live_..." -H "Content-Type: application/json" \\
  -d '{"amount_source": 200}'

# Create a transaction (Idempotency-Key is REQUIRED)
curl -X POST ${env.appBaseUrl}/api/partner/v1/transactions \\
  -H "Authorization: Bearer sr_live_..." -H "Idempotency-Key: <unique-key>" \\
  -H "Content-Type: application/json" \\
  -d '{"amount_source": 200,
       "sender": {"phone": "15551230000", "kyc_status": "verified"},
       "beneficiary": {"name": "Anita Kumar", "phone": "919876543210",
                       "payout_method": "bank", "payout_destination": "123456789012"}}'

# Confirm (drives settlement on YOUR rail) · then poll or list
curl -X POST ${env.appBaseUrl}/api/partner/v1/transactions/<id>/confirm \\
  -H "Authorization: Bearer sr_live_..."
curl "${env.appBaseUrl}/api/partner/v1/transactions?limit=25" \\
  -H "Authorization: Bearer sr_live_..."

# Also: GET /corridors · POST /beneficiaries · POST /beneficiaries/validate
# Rate limit: 120 req/min per partner. Errors: 401 bad key · 404 not yours · 429 slow down.`}
                  </pre>
                </CardContent>
              </Card>
            </TabsContent>
          )}
        </Tabs>
      </main>
    </>
  );
}
