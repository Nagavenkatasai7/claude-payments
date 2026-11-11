import type { ResolvedDisclosure } from '@/lib/partner-config';

// Fix pack 4 T6 (C23): the provider block's approval state on the admin partner page, inside the
// "Remittance disclosure (draft)" card (after "Customers see", before the form). Server component,
// no hooks: the card sits in a Radix Tabs panel that a static render of the page does not show, so
// this part is rendered and unit-tested on its own (tests/admin-disclosure-approval-state.test.ts).
//
// Only a partner admin with two-step sign-in approves a block (setDisclosure, C11); a SmartRemit
// save strips the stamp, and on a certified partner its payments then wait for a fresh approval, so
// the form warns before the save. The default (demo) tenant is never approved: nothing renders.
// Inline English like the rest of the page; the fixed texts are flagged for counsel (O-PR4-c).
// Renders a username and a date only, as escaped text.

const day = (iso: string | undefined): string => (iso ? iso.slice(0, 10) : '');

export function DisclosureApprovalState({
  shown,
  approval,
  certified,
}: {
  shown: ResolvedDisclosure;
  approval?: { by: string; at: string };
  certified: boolean;
}) {
  if (shown.demo) return null;
  const approved = shown.partnerApproved && approval !== undefined;
  return (
    <div data-testid="disclosure-approval-state" data-approved={approved ? 'true' : 'false'} className="mt-3 space-y-2 text-sm">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Approval</dt>
        <dd>{approved ? `Approved by ${approval.by} on ${day(approval.at)}` : 'Not approved'}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">A SmartRemit save never approves this block; it clears an existing approval.</p>
      {certified && (
        <p data-testid="disclosure-platform-warning" className="rounded-md border border-warning/50 p-2 text-xs font-semibold text-warning">
          This partner is certified for live money. Saving here clears the partner&apos;s approval, and its payments stop until a
          partner admin with two-step sign-in approves the block again.
        </p>
      )}
    </div>
  );
}
