'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LIVE_CAPABILITIES } from '@/lib/live-controls';
import { STAFF_REASON_MAX, STAFF_REASON_MIN } from '@/lib/send-limits';
import { STEP_UP_FIELD, type StepUpRequired } from '@/lib/staff-step-up-result';
import type { LiveActionResult } from './go-live-actions';

// Fix pack 3 T10 (R15, R13; contract 12): the forms of the LiveCertificationCard. Rendered only
// for a platform admin on a non-default partner; the actions (bound by the page to the route
// partner id) re-gate everything. Every form carries the authenticator code field for the step-up:
// certify and revoke always need it, a contract or counsel record only when the session has no
// step-up in the last 15 minutes. The code is never kept after a submit (an uncontrolled input in a
// form React resets after the action). Inline English, as the GoLiveCard.

export type LiveAction = (formData: FormData) => Promise<LiveActionResult | StepUpRequired>;
type Result = LiveActionResult | StepUpRequired | null;

const CAPABILITY_LABELS: Record<(typeof LIVE_CAPABILITIES)[number], string> = {
  b2b: 'Business payments (B2B)',
  usdc: 'USDC payouts',
  telegram: 'Telegram',
  mcp: 'AI agent tools (MCP)',
  schedules: 'Repeat payments',
};

const INPUT_CLASS = 'h-9 w-full rounded-md border border-input bg-card px-2 text-sm';

function Outcome({ state, done }: { state: Result; done: string }) {
  if (!state) return null;
  return state.ok ? (
    <p role="status" className="text-sm font-semibold text-foreground">
      {done}
    </p>
  ) : (
    <p role="alert" className="text-sm font-semibold text-destructive">
      {state.error}
    </p>
  );
}

export function CodeField({ id }: { id: string }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor={id}>
      Your authenticator code
      <input
        id={id}
        name={STEP_UP_FIELD}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]*"
        maxLength={8}
        className={INPUT_CLASS}
      />
    </label>
  );
}

function ReasonField() {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      Reason (required, kept in the audit log)
      <Input name="reason" required minLength={STAFF_REASON_MIN} maxLength={STAFF_REASON_MAX} />
    </label>
  );
}

function useLive(action: LiveAction) {
  return useActionState<Result, FormData>((_prev, fd) => action(fd), null);
}

export function CertifyForm({ partnerId, action }: { partnerId: string; action: LiveAction }) {
  const [state, submit, pending] = useLive(action);
  return (
    <form action={submit} className="flex flex-col gap-3" data-testid="live-certify-form">
      <ReasonField />
      <CodeField id={`live-certify-code-${partnerId}`} />
      <div>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Checking…' : 'Certify for live money'}
        </Button>
      </div>
      <Outcome state={state} done="Certified for live money." />
    </form>
  );
}

export function RevokeForm({ partnerId, action }: { partnerId: string; action: LiveAction }) {
  const [state, submit, pending] = useLive(action);
  return (
    <form action={submit} className="flex flex-col gap-3" data-testid="live-revoke-form">
      <ReasonField />
      <CodeField id={`live-revoke-code-${partnerId}`} />
      <div>
        <Button type="submit" size="sm" variant="destructive" disabled={pending}>
          {pending ? 'Checking…' : 'Revoke live certification'}
        </Button>
      </div>
      <Outcome state={state} done="Live certification revoked." />
    </form>
  );
}

export function ContractForm({ partnerId, action }: { partnerId: string; action: LiveAction }) {
  const [state, submit, pending] = useLive(action);
  return (
    <form action={submit} className="flex flex-col gap-3" data-testid="live-contract-form">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Contract reference (kept only in the live record, never shown)
        <Input name="ref" required maxLength={200} autoComplete="off" />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Signed on (UTC date)
        <Input name="signedOn" type="date" required />
      </label>
      <CodeField id={`live-contract-code-${partnerId}`} />
      <div>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? 'Saving…' : 'Record contract'}
        </Button>
      </div>
      <Outcome state={state} done="Contract recorded." />
    </form>
  );
}

// Fix pack 5 T17 (P17): the partner's funding mode. Every save asks for the code (the action's
// step-up is always: true); the action refuses partner_psp without Stripe funding and a restricted key.
export function FundingModeForm({ partnerId, action }: { partnerId: string; action: LiveAction }) {
  const [state, submit, pending] = useLive(action);
  return (
    <form action={submit} className="flex flex-col gap-3" data-testid="live-funding-form">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Funding mode
        <select name="mode" className={INPUT_CLASS} defaultValue="partner_collected">
          <option value="partner_collected">Partner collects the sender&apos;s money</option>
          <option value="partner_psp">Partner&apos;s own Stripe account (needs Stripe funding and a restricted key)</option>
        </select>
      </label>
      <CodeField id={`live-funding-code-${partnerId}`} />
      <div>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? 'Saving…' : 'Save funding mode'}
        </Button>
      </div>
      <Outcome state={state} done="Funding mode saved." />
    </form>
  );
}

export function CounselForm({ partnerId, action }: { partnerId: string; action: LiveAction }) {
  const [state, submit, pending] = useLive(action);
  const [cleared, clear, clearing] = useLive(action);
  return (
    <div className="flex flex-col gap-4">
      <form action={submit} className="flex flex-col gap-3" data-testid="live-counsel-form">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Feature
          <select name="capability" className={INPUT_CLASS} defaultValue="b2b">
            {LIVE_CAPABILITIES.map((c) => (
              <option key={c} value={c}>
                {CAPABILITY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Counsel review reference (kept only in the live record, never shown)
          <Input name="counselRef" required maxLength={200} autoComplete="off" />
        </label>
        <CodeField id={`live-counsel-code-${partnerId}`} />
        <div>
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            {pending ? 'Saving…' : 'Record counsel review'}
          </Button>
        </div>
        <Outcome state={state} done="Counsel review recorded." />
      </form>
      <form action={clear} className="flex flex-col gap-3 border-t border-border pt-3" data-testid="live-counsel-clear-form">
        <input type="hidden" name="clear" value="1" />
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Clear the counsel review of
          <select name="capability" className={INPUT_CLASS} defaultValue="b2b">
            {LIVE_CAPABILITIES.map((c) => (
              <option key={c} value={c}>
                {CAPABILITY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-muted-foreground">Clearing it also withdraws the partner&apos;s approval of that feature.</p>
        <CodeField id={`live-counsel-clear-code-${partnerId}`} />
        <div>
          <Button type="submit" size="sm" variant="outline" disabled={clearing}>
            {clearing ? 'Saving…' : 'Clear counsel review'}
          </Button>
        </div>
        <Outcome state={cleared} done="Counsel review cleared." />
      </form>
    </div>
  );
}
