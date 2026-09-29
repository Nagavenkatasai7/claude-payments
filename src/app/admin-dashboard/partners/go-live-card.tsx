import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { GoLiveRecord } from '@/db/repos/partner-go-live-repo';
import { STAFF_REASON_MAX, STAFF_REASON_MIN } from '@/lib/send-limits';
import { approveGoLiveAction } from './go-live-actions';
import { computeOnboardingChecklist, goLivePrerequisitesDone, type OnboardingFacts, type OnboardingStepKey } from '@/lib/partner-onboarding';
import { t, type MessageKey } from '@/lib/i18n';

/** What the card shows of the partner's M3-20 checklist: the stored facts and the attestation row. */
export interface GoLiveChecklistView {
  facts: OnboardingFacts;
  /** The latest partner.templates.attest audit row (who attested, when), or null. */
  attestation: { actor: string; at: Date } | null;
}

const STEP_TITLE: Record<OnboardingStepKey, MessageKey> = {
  whatsapp: 'partner.onboarding.step.whatsapp.title',
  templates: 'partner.onboarding.step.templates.title',
  sandboxKey: 'partner.onboarding.step.sandboxKey.title',
  sandboxTransfer: 'partner.onboarding.step.sandboxTransfer.title',
  webhook: 'partner.onboarding.step.webhook.title',
  branding: 'partner.onboarding.step.branding.title',
  goLive: 'partner.onboarding.step.goLive.title',
};

const yesNo = (v: boolean): string => (v ? 'yes' : 'no');

function ChecklistView({ view }: { view: GoLiveChecklistView | 'error' | undefined }) {
  if (view === undefined) return null;
  if (view === 'error') return <p className="text-muted-foreground">The onboarding checklist could not be read. Reload to try again.</p>;
  const { facts, attestation } = view;
  const steps = computeOnboardingChecklist(facts);
  return (
    <div className="flex flex-col gap-2">
      <div className="font-medium">Onboarding checklist</div>
      <ol className="flex flex-col gap-1.5">
        {steps.map((s) => (
          <li key={s.key} className="flex flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <Badge variant="outline" className={s.done ? 'border-success/50 text-success' : 'text-muted-foreground'}>
                {s.done ? 'done' : 'not done'}
              </Badge>
              {s.step}. {t(STEP_TITLE[s.key])}
            </span>
            {s.key === 'whatsapp' && (
              <span className="pl-2 text-xs text-muted-foreground">
                Own number saved: {yesNo(facts.whatsappOwnConfigured)} · Test connection passing: {yesNo(facts.whatsappTestOk)} ·
                Inbound message received: {yesNo(facts.whatsappInboundSeen)}
              </span>
            )}
            {s.key === 'templates' && (
              <span className="pl-2 text-xs text-muted-foreground">
                {attestation
                  ? `Attested by ${attestation.actor} on ${when(attestation.at)}: the authentication and transfer_delivered templates are approved. Verify in WhatsApp Manager before approving.`
                  : 'Not attested yet.'}
              </span>
            )}
            {s.key === 'webhook' && (
              <span className="pl-2 text-xs text-muted-foreground">
                Partner rail: {yesNo(facts.partnerRail)} · Endpoint URL valid: {yesNo(facts.endpointUrlValid)} · Recent test event accepted:{' '}
                {yesNo(facts.recentPingOk)}
              </span>
            )}
          </li>
        ))}
      </ol>
      {!goLivePrerequisitesDone(steps) && (
        <p className="text-destructive">Steps 1 to 6 are not all done, so go-live cannot be approved yet.</p>
      )}
    </div>
  );
}

// UI redesign M3-21: the platform admin's go-live card on /admin-dashboard/partners/[id]. The page
// renders it ONLY for a platform admin (the same predicate as requirePlatformAdmin), and the action
// re-checks with requirePlatformAdmin(). Go-live approval alone never means "live": the partner must
// also be active (#409 review L1), so a suspended partner says so.

const FLASH: Record<string, string> = {
  approved: 'Go-live approved. The partner can now issue live API keys.',
  already: 'Go-live was already approved. Nothing changed.',
  not_requested: 'This partner has not requested go-live, so there is nothing to approve.',
  not_active: 'The partner is not active, so go-live cannot be approved. Reactivate it first.',
  incomplete: 'Steps 1 to 6 of the onboarding checklist are not all done, so go-live was not approved.',
  checklist_unavailable: 'The onboarding checklist could not be read, so go-live was not approved. Try again.',
  reason_required: `Add a reason of at least ${STAFF_REASON_MIN} characters before approving.`,
};

export function goLiveFlash(param: string | undefined): string | undefined {
  return param && Object.hasOwn(FLASH, param) ? FLASH[param] : undefined;
}

const when = (d: Date | null | undefined): string => (d ? d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '');

export function GoLiveCard({
  partnerId,
  partnerStatus,
  goLive,
  flash,
  checklist,
}: {
  partnerId: string;
  partnerStatus: string;
  goLive: GoLiveRecord | null | 'error';
  flash?: string;
  /** The M3-20 onboarding checklist + template attestation. */
  checklist: GoLiveChecklistView | 'error';
}) {
  const record = goLive === 'error' ? null : goLive;
  const approved = Boolean(record?.approvedAt);
  const requested = Boolean(record?.requestedAt);
  // Display only: the action re-checks all of it (go-live-actions.ts precheck).
  const ready = checklist !== 'error' && goLivePrerequisitesDone(computeOnboardingChecklist(checklist.facts));
  const canApprove = goLive !== 'error' && requested && !approved && partnerStatus === 'active' && ready;

  let badge: ReactNode;
  if (goLive === 'error') badge = <Badge variant="outline" className="text-muted-foreground">unavailable</Badge>;
  else if (approved) badge = <Badge variant="outline" className="border-success/50 text-success">approved</Badge>;
  else if (requested) badge = <Badge variant="outline" className="border-warning/50 text-warning">requested</Badge>;
  else badge = <Badge variant="outline" className="text-muted-foreground">not requested</Badge>;

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5">Go-live {badge}</CardTitle>
        <CardDescription>
          Live API keys are issued only after SmartRemit approves go-live. Until then the partner can use sandbox keys only.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-[13px]">
        {goLive === 'error' && <p className="text-muted-foreground">The go-live status could not be read. Reload to try again.</p>}
        {record?.requestedAt && (
          <p>
            Requested {when(record.requestedAt)}
            {record.requestedBy ? ` by ${record.requestedBy}` : ''}.
          </p>
        )}
        {record?.approvedAt && (
          <p>
            Approved {when(record.approvedAt)}
            {record.approvedBy ? ` by ${record.approvedBy}` : ''}.
          </p>
        )}
        <p>Partner status: {partnerStatus}.</p>
        {approved && partnerStatus !== 'active' && (
          <p className="text-destructive">Go-live is approved, but the partner is {partnerStatus}, so it is not live.</p>
        )}
        {!approved && requested && partnerStatus !== 'active' && (
          <p className="text-destructive">The partner is {partnerStatus}: reactivate it before approving go-live.</p>
        )}
        <ChecklistView view={checklist} />
        {flash && <p className="text-muted-foreground">{flash}</p>}
        {canApprove && (
          <form action={approveGoLiveAction} className="flex flex-col gap-3">
            <input type="hidden" name="id" value={partnerId} />
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Reason (required, kept in the audit log)
              <Input
                name="reason"
                required
                minLength={STAFF_REASON_MIN}
                maxLength={STAFF_REASON_MAX}
                placeholder="e.g. Checklist verified, template approved in WhatsApp Manager"
              />
            </label>
            <div>
              <Button type="submit" size="sm">
                Approve go-live
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
