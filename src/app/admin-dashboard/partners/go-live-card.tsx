import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { GoLiveRecord } from '@/db/repos/partner-go-live-repo';
import { STAFF_REASON_MAX, STAFF_REASON_MIN } from '@/lib/send-limits';
import { approveGoLiveAction } from './go-live-actions';

// UI redesign M3-21: the platform admin's go-live card on /admin-dashboard/partners/[id]. The page
// renders it ONLY for a platform admin (the same predicate as requirePlatformAdmin), and the action
// re-checks with requirePlatformAdmin(). Go-live approval alone never means "live": the partner must
// also be active (#409 review L1), so a suspended partner says so.

const FLASH: Record<string, string> = {
  approved: 'Go-live approved. The partner can now issue live API keys.',
  already: 'Go-live was already approved. Nothing changed.',
  not_requested: 'This partner has not requested go-live, so there is nothing to approve.',
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
  /** The onboarding checklist + template attestation (M3-20). Absent until that lands. */
  checklist?: ReactNode;
}) {
  const record = goLive === 'error' ? null : goLive;
  const approved = Boolean(record?.approvedAt);
  const requested = Boolean(record?.requestedAt);
  const canApprove = goLive !== 'error' && requested && !approved;

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
        {approved && partnerStatus !== 'active' && (
          <p className="text-destructive">Go-live is approved, but the partner is {partnerStatus}, so it is not live.</p>
        )}
        {checklist ?? (
          <p className="text-muted-foreground">
            Before approving, check the partner&apos;s setup (WhatsApp number and templates, settlement endpoint, a delivered
            sandbox transfer) on the tabs of this page.
          </p>
        )}
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
