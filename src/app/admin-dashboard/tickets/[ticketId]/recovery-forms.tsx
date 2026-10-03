'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { RECOVERY_CHECKS, RECOVERY_DECLINE_REASONS, type RecoveryActionResult } from '@/lib/customer-mfa-recovery-rules';
import { STEP_UP_FIELD, type StepUpRequired } from '@/lib/staff-step-up-result';
import { approveMfaRecoveryAction, declineMfaRecoveryAction } from '../recovery-actions';

// The decision forms of the platform two-step recovery card (lost-features p4 B4). Rendered only
// for a platform admin on an open request; the actions re-gate everything. A platform approver has
// staff 2FA (the action refuses otherwise), so the approve form always carries the authenticator
// code for the step-up: within 15 minutes of a step-up on this session it is not needed, and a
// wrong one comes back as the step-up's own message. The code is never kept after a submit.

const CHECK_LABELS: Record<(typeof RECOVERY_CHECKS)[number], string> = {
  id_document: 'Checked an ID document',
  recent_transfer: 'Customer confirmed a recent transfer',
  kyc_name: 'Legal name matches the verified identity',
  callback: 'Called back the number on file',
};
const REASON_LABELS: Record<(typeof RECOVERY_DECLINE_REASONS)[number], string> = {
  not_verified: 'Could not confirm it is the customer',
  no_response: 'The customer did not respond',
  duplicate: 'Duplicate request',
};
const DONE = {
  approved: 'Two-step verification is off. The customer was signed out and told on WhatsApp.',
  already_off: 'Two-step verification was already off. The request is closed.',
  declined: 'Request declined. The customer was told on WhatsApp.',
} as const;

type Result = RecoveryActionResult | StepUpRequired | null;

function Outcome({ state }: { state: Result }) {
  if (!state) return null;
  return state.ok ? (
    <p role="status" className="text-sm font-semibold text-foreground">
      {DONE[state.outcome]}
    </p>
  ) : (
    <p role="alert" className="text-sm font-semibold text-destructive">
      {state.error}
    </p>
  );
}

export function PlatformRecoveryForms({ ticketId, waitUntil }: { ticketId: string; waitUntil: string }) {
  const [approved, approve, approving] = useActionState<Result, FormData>((_p, fd) => approveMfaRecoveryAction(fd), null);
  const [declined, decline, declining] = useActionState<Result, FormData>((_p, fd) => declineMfaRecoveryAction(fd), null);
  if (approved?.ok || declined?.ok) return <Outcome state={approved?.ok ? approved : declined} />;
  return (
    <div className="space-y-4">
      <form action={approve} className="space-y-2">
        <input type="hidden" name="ticketId" value={ticketId} />
        <fieldset className="space-y-1">
          <legend className="text-xs font-semibold text-muted-foreground uppercase">What did you check?</legend>
          <p className="text-xs text-muted-foreground">
            An ID document, or a recent transfer the customer confirmed. Without an ID document check, this can be approved
            from {waitUntil}.
          </p>
          {RECOVERY_CHECKS.map((c) => (
            <label key={c} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="check" value={c} className="size-4" />
              {CHECK_LABELS[c]}
            </label>
          ))}
        </fieldset>
        <label className="block text-xs font-semibold text-muted-foreground uppercase" htmlFor={`stepup-${ticketId}`}>
          Your authenticator code
        </label>
        <input
          id={`stepup-${ticketId}`}
          name={STEP_UP_FIELD}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]*"
          maxLength={8}
          className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
        />
        <Button type="submit" size="sm" variant="destructive" disabled={approving}>
          {approving ? 'Checking…' : 'Turn off two-step verification'}
        </Button>
        <Outcome state={approved} />
      </form>

      <form action={decline} className="space-y-2 border-t border-border pt-3">
        <input type="hidden" name="ticketId" value={ticketId} />
        <label className="block text-xs font-semibold text-muted-foreground uppercase" htmlFor={`reason-${ticketId}`}>
          Decline reason
        </label>
        <select id={`reason-${ticketId}`} name="reason" defaultValue="not_verified" className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm">
          {RECOVERY_DECLINE_REASONS.map((r) => (
            <option key={r} value={r}>
              {REASON_LABELS[r]}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" variant="outline" disabled={declining}>
          {declining ? 'Declining…' : 'Decline request'}
        </Button>
        <Outcome state={declined} />
      </form>
    </div>
  );
}
