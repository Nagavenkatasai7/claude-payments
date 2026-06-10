'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import {
  wizardCreatePartnerAction,
  type PartnerWizardInput,
  type PartnerWizardResult,
} from '../actions';
import { CopyField } from '../copy-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';

// Partner setup wizard (Stage 5c). All steps accumulate CLIENT state; nothing
// is persisted until Review → "Create partner", which commits partner +
// integrations + first API key in one server action. Going back never loses
// input; abandoning the wizard leaves no half-configured tenant behind.

const COUNTRIES = ['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ'] as const;
const STEPS = ['Identity', 'Brand', 'KYC', 'WhatsApp', 'Settlement', 'Review'] as const;

type Draft = PartnerWizardInput;

const EMPTY: Draft = {
  name: '',
  countries: ['US'],
  kycMode: 'ours',
  whatsapp: {},
  payment: { providerType: 'simulator' },
};

function StepDots({ current }: { current: number }) {
  return (
    <div className="mb-6 flex items-center gap-1.5 text-xs">
      {STEPS.map((s, i) => (
        <div key={s} className="flex items-center gap-1.5">
          <span
            className={
              i === current
                ? 'rounded-full bg-primary px-2.5 py-0.5 font-medium text-primary-foreground'
                : i < current
                  ? 'rounded-full bg-accent px-2.5 py-0.5 text-accent-foreground'
                  : 'rounded-full bg-secondary px-2.5 py-0.5 text-muted-foreground'
            }
          >
            {s}
          </span>
          {i < STEPS.length - 1 && <span className="text-muted-foreground">·</span>}
        </div>
      ))}
    </div>
  );
}

function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function PartnerSetupWizard() {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [result, setResult] = useState<PartnerWizardResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setWa = (patch: Partial<NonNullable<Draft['whatsapp']>>) =>
    setDraft((d) => ({ ...d, whatsapp: { ...d.whatsapp, ...patch } }));
  const setPay = (patch: Partial<NonNullable<Draft['payment']>>) =>
    setDraft((d) => ({ ...d, payment: { ...d.payment, ...patch } }));

  function commit() {
    setError(null);
    startTransition(async () => {
      try {
        setResult(await wizardCreatePartnerAction(draft));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not create the partner.');
      }
    });
  }

  // ── Done screen: show-once key + go-live checklist ──────────────────────
  if (result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>🎉 {draft.name} is live</CardTitle>
          <CardDescription>
            Partner id <code>{result.id}</code>. Copy the API key NOW — it is shown exactly once
            and stored only as a hash.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-warning/40 bg-accent/40 p-3">
            <CopyField label="API key (shown once — store it in your secret manager)" value={result.apiKey} />
          </div>
          <CopyField label="API base URL" value={result.apiBaseUrl} />
          <CopyField label="WhatsApp callback URL (Meta → WhatsApp → Configuration)" value={result.whatsappCallbackUrl} />
          <CopyField label="Settlement status-callback URL (your rail POSTs lifecycle events here)" value={result.statusCallbackUrl} />

          <Separator />
          <div className="space-y-2 text-sm">
            <div className="font-medium">Go-live checklist</div>
            <ul className="space-y-1.5">
              <li>✅ Partner record + branding created</li>
              <li>✅ KYC mode: {draft.kycMode === 'delegated' ? 'partner-run (delegated)' : 'SmartRemit-run'} — sanctions screening always stays on</li>
              <li>
                {result.whatsappConfigured ? '✅' : '◻️'} WhatsApp channel{' '}
                {result.whatsappConfigured
                  ? '— paste the callback URL into Meta and verify'
                  : '— add the number later on the partner page'}
              </li>
              <li>
                {result.settlementConfigured ? '✅' : '◻️'} Settlement rail{' '}
                {draft.payment?.providerType === 'simulator'
                  ? '— hosted reference rail auto-provisioned (signed round-trip ready)'
                  : result.settlementConfigured
                    ? '— signed instructions will POST to your endpoint'
                    : '— configure later on the partner page'}
              </li>
              <li>✅ API key issued (…{result.apiKeyLast4})</li>
              <li>
                ◻️ Test the loop: create + confirm a transaction via the API (or WhatsApp), and
                watch it deliver on the partner page.
              </li>
            </ul>
          </div>

          <div className="flex gap-2 pt-2">
            <Button asChild>
              <Link href={`/admin-dashboard/partners/${result.id}`}>Open partner page →</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/docs">Integration docs</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const canNext =
    step === 0 ? draft.name.trim() !== '' && (draft.countries?.length ?? 0) > 0 : true;

  return (
    <Card>
      <CardHeader>
        <StepDots current={step} />
        <CardTitle>{STEPS[step]}</CardTitle>
        <CardDescription>
          {step === 0 && 'Who is this partner? Name and the corridors they may send from.'}
          {step === 1 && 'The identity customers see — every WhatsApp message and pay page carries it.'}
          {step === 2 && 'Who verifies sender identity. Sanctions screening is never delegable.'}
          {step === 3 && 'Bring-your-own Meta WhatsApp number (optional now, configurable later).'}
          {step === 4 && 'Where signed settlement instructions go. You settle; we orchestrate.'}
          {step === 5 && 'Nothing has been saved yet — review, then create everything in one step.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {step === 0 && (
          <>
            <Field label="Partner name *">
              <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Acme Remit Inc." />
            </Field>
            <Field label="Operating countries *" hint="Where their customers send FROM. Destination is India (INR).">
              <div className="flex flex-wrap gap-3 pt-1">
                {COUNTRIES.map((c) => (
                  <label key={c} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.countries.includes(c)}
                      onChange={(e) =>
                        set({
                          countries: e.target.checked
                            ? [...draft.countries, c]
                            : draft.countries.filter((x) => x !== c),
                        })
                      }
                    />
                    {c}
                  </label>
                ))}
              </div>
            </Field>
          </>
        )}

        {step === 1 && (
          <>
            <Field label="Display name" hint="The brand customers see (falls back to the partner name).">
              <Input value={draft.displayName ?? ''} onChange={(e) => set({ displayName: e.target.value })} placeholder="Acme Pay" />
            </Field>
            <Field label="Support contact">
              <Input value={draft.supportContact ?? ''} onChange={(e) => set({ supportContact: e.target.value })} placeholder="support@acme.com" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Primary color">
                <Input type="color" className="h-10 w-20 p-1" value={draft.primaryColor ?? '#533afd'} onChange={(e) => set({ primaryColor: e.target.value })} />
              </Field>
              <Field label="Logo URL">
                <Input value={draft.logoUrl ?? ''} onChange={(e) => set({ logoUrl: e.target.value })} placeholder="https://…/logo.png" />
              </Field>
            </div>
            <Field label="Bot persona" hint="Optional tone hint for the WhatsApp agent.">
              <Input value={draft.botPersona ?? ''} onChange={(e) => set({ botPersona: e.target.value })} placeholder="warm and concise" />
            </Field>
          </>
        )}

        {step === 2 && (
          <>
            <Field label="Who runs identity verification?">
              <select
                className="h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
                value={draft.kycMode}
                onChange={(e) => set({ kycMode: e.target.value })}
              >
                <option value="ours">SmartRemit runs KYC (default)</option>
                <option value="delegated">Partner runs KYC (delegated)</option>
              </select>
            </Field>
            {draft.kycMode === 'delegated' && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.requireKycBeforeSend === true}
                  onChange={(e) => set({ requireKycBeforeSend: e.target.checked })}
                />
                Still block sends until the partner attests verification
              </label>
            )}
            <p className="text-xs text-muted-foreground">
              Sanctions screening runs on every transfer in BOTH modes — structurally untoggleable.
            </p>
          </>
        )}

        {step === 3 && (
          <>
            <Field label="Phone number ID" hint="From Meta — routes inbound messages to this tenant.">
              <Input value={draft.whatsapp?.phoneNumberId ?? ''} onChange={(e) => setWa({ phoneNumberId: e.target.value })} placeholder="1234567890" />
            </Field>
            <Field label="Access token">
              <Input type="password" autoComplete="off" value={draft.whatsapp?.token ?? ''} onChange={(e) => setWa({ token: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Webhook verify token">
                <Input type="password" autoComplete="off" value={draft.whatsapp?.verifyToken ?? ''} onChange={(e) => setWa({ verifyToken: e.target.value })} />
              </Field>
              <Field label="App secret">
                <Input type="password" autoComplete="off" value={draft.whatsapp?.appSecret ?? ''} onChange={(e) => setWa({ appSecret: e.target.value })} />
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">
              Skip freely — the callback URL appears on the done screen and the partner page.
            </p>
          </>
        )}

        {step === 4 && (
          <>
            <Field label="Settlement provider">
              <select
                className="h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
                value={draft.payment?.providerType ?? 'simulator'}
                onChange={(e) => setPay({ providerType: e.target.value })}
              >
                <option value="simulator">Hosted reference rail (signed round-trip, zero setup)</option>
                <option value="http">HTTP rail — your live settlement endpoint</option>
                <option value="mock">Mock (auto-deliver after 2 min, sandbox)</option>
              </select>
            </Field>
            {draft.payment?.providerType === 'http' && (
              <>
                <Field label="Settlement endpoint URL">
                  <Input type="url" value={draft.payment?.settlementUrl ?? ''} onChange={(e) => setPay({ settlementUrl: e.target.value })} placeholder="https://rail.acme.com/settle" />
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Outbound signing secret">
                    <Input type="password" autoComplete="off" value={draft.payment?.signingSecret ?? ''} onChange={(e) => setPay({ signingSecret: e.target.value })} />
                  </Field>
                  <Field label="Inbound webhook secret">
                    <Input type="password" autoComplete="off" value={draft.payment?.webhookSecret ?? ''} onChange={(e) => setPay({ webhookSecret: e.target.value })} />
                  </Field>
                </div>
              </>
            )}
            {draft.payment?.providerType === 'simulator' && (
              <p className="text-xs text-muted-foreground">
                Endpoint + both HMAC secrets are auto-provisioned. The reference rail runs the
                exact signed instruction → callback loop a production rail would.
              </p>
            )}
          </>
        )}

        {step === 5 && (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">Identity</Badge>
              {draft.name} · {draft.countries.join(', ')} → IN
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">Brand</Badge>
              {draft.displayName || draft.name}
              {draft.primaryColor && (
                <span className="inline-block h-3 w-3 rounded-sm border border-border" style={{ background: draft.primaryColor }} />
              )}
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">KYC</Badge>
              {draft.kycMode === 'delegated' ? 'partner-run (delegated)' : 'SmartRemit-run'} · sanctions always on
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">WhatsApp</Badge>
              {draft.whatsapp?.phoneNumberId ? `number ${draft.whatsapp.phoneNumberId}` : 'not yet — shared number until configured'}
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">Settlement</Badge>
              {draft.payment?.providerType === 'simulator'
                ? 'hosted reference rail (auto-provisioned)'
                : draft.payment?.providerType === 'http'
                  ? `HTTP rail → ${draft.payment?.settlementUrl || '(endpoint missing)'}`
                  : 'mock sandbox'}
            </div>
            <p className="pt-2 text-xs text-muted-foreground">
              Creating also issues the first API key (shown once on the next screen).
            </p>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-between pt-2">
          <Button variant="outline" disabled={step === 0 || pending} onClick={() => setStep((s) => s - 1)}>
            ← Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
              Continue →
            </Button>
          ) : (
            <Button disabled={pending} onClick={commit}>
              {pending ? 'Creating…' : 'Create partner'}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
