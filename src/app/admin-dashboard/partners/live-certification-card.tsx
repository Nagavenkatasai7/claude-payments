import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { LIVE_CAPABILITIES, type LiveCapability, type LiveControls } from '@/lib/live-controls';
import type { LiveReadiness, LiveReadinessLineId } from '@/lib/live-certification';
import { CertifyForm, ContractForm, CounselForm, RevokeForm, type LiveAction } from './live-certification-forms';

// Fix pack 3 T10 (R15, R13; contract 12): the platform live-money certification card, under the
// GoLiveCard on the admin partner page (platform admins only, never the 'default' tenant). The
// state badge reads ONLY the stored live_controls (never the readiness facts), so a transient
// readiness read failure cannot change it (T14's Playwright check reads it). Shows booleans, dates,
// usernames and line states only: never a contract or counsel reference. Inline English, as the
// GoLiveCard. The actions re-check everything.

export type LiveCertState = 'Not certified' | 'Certified' | 'Revoked';

const LINE_LABELS: Record<LiveReadinessLineId, string> = {
  go_live: 'Go-live approved and the partner is active',
  sanctions_list: 'Sanctions list is live',
  posture: 'Compliance posture signed',
  compliance_users: 'Two compliance users with two-step verification',
  own_whatsapp: 'Own WhatsApp number',
  contract: 'Live contract on record',
  provider_block: 'Provider block',
  funding: 'Funding mode',
  licence_matrix: 'Licence matrix',
  corridor_register: 'Corridor register',
  staff_mfa: 'Staff two-step verification policy',
  dual_control: 'Dual control',
};

const CAPABILITY_LABELS: Record<LiveCapability, string> = {
  b2b: 'Business payments (B2B)',
  usdc: 'USDC payouts',
  telegram: 'Telegram',
  mcp: 'AI agent tools (MCP)',
  schedules: 'Repeat payments',
};

const when = (iso: string | undefined): string => {
  const t = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isNaN(t) ? '' : new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
};
const yesNo = (v: boolean): string => (v ? 'yes' : 'no');

/** From the stored record only: absent -> 'Not certified'; revokedAt not before certifiedAt (or unreadable) -> 'Revoked'. */
export function liveCertState(lc: LiveControls): LiveCertState {
  const c = lc.certification;
  if (!c) return 'Not certified';
  if (c.revokedAt !== undefined && !(Date.parse(c.revokedAt) < Date.parse(c.certifiedAt))) return 'Revoked';
  return 'Certified';
}

function lineState(l: LiveReadiness['lines'][number]): string {
  if (l.state === 'not_built') return `not built (${l.builtIn ?? 'later'})`;
  return l.state === 'pass' ? 'pass' : 'fail';
}

export function LiveCertificationCard({
  partnerId,
  liveControls,
  readiness,
  certifyAction,
  revokeAction,
  contractAction,
  counselAction,
}: {
  partnerId: string;
  liveControls: LiveControls;
  readiness: LiveReadiness | 'error';
  certifyAction: LiveAction;
  revokeAction: LiveAction;
  contractAction: LiveAction;
  counselAction: LiveAction;
}) {
  const state = liveCertState(liveControls);
  const c = liveControls.certification;
  const contract = liveControls.contract;
  const badgeClass =
    state === 'Certified' ? 'border-success/50 text-success' : state === 'Revoked' ? 'border-destructive/50 text-destructive' : 'text-muted-foreground';

  return (
    <Card className="mb-6" data-testid="live-certification-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5">
          Live money certification{' '}
          <Badge variant="outline" className={badgeClass} data-testid="live-cert-state">
            {state}
          </Badge>
        </CardTitle>
        <CardDescription>
          A partner on a real-money rail can mint, take payment and settle live transfers only once SmartRemit certifies it.
          Certifying needs every readiness line to pass.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-[13px]">
        {c && state === 'Certified' && (
          <p>
            Certified {when(c.certifiedAt)} by {c.certifiedBy}.
          </p>
        )}
        {c && state === 'Revoked' && (
          <p>
            Certified {when(c.certifiedAt)} by {c.certifiedBy}; revoked {when(c.revokedAt)}
            {c.revokedBy ? ` by ${c.revokedBy}` : ''}.
          </p>
        )}

        <div className="flex flex-col gap-2">
          <div className="font-medium">Readiness</div>
          {readiness === 'error' ? (
            <p className="text-muted-foreground">The readiness checks could not be read.</p>
          ) : (
            <ol className="flex flex-col gap-1.5" data-testid="live-readiness-lines">
              {readiness.lines.map((l) => (
                <li key={l.id} className="flex items-center gap-2" data-line={l.id}>
                  <Badge variant="outline" className={l.ok ? 'border-success/50 text-success' : 'text-muted-foreground'}>
                    {lineState(l)}
                  </Badge>
                  {LINE_LABELS[l.id]}
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <div className="font-medium">Contract</div>
          {contract ? (
            <p>
              Signed on {contract.signedOn}; recorded by {contract.recordedBy} on {when(contract.recordedAt)}.
            </p>
          ) : (
            <p className="text-muted-foreground">No contract recorded.</p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <div className="font-medium">Live features</div>
          <table className="text-left">
            <thead>
              <tr className="text-muted-foreground">
                <th className="pr-4 font-normal">Feature</th>
                <th className="pr-4 font-normal">Counsel review</th>
                <th className="font-normal">Partner approval</th>
              </tr>
            </thead>
            <tbody>
              {LIVE_CAPABILITIES.map((cap) => {
                const o = liveControls.optIns[cap];
                return (
                  <tr key={cap} data-capability={cap}>
                    <td className="pr-4">{CAPABILITY_LABELS[cap]}</td>
                    <td className="pr-4">{yesNo(Boolean(o?.counselRef))}</td>
                    <td>{yesNo(Boolean(o?.partnerApprovedAt))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {state === 'Certified' ? (
          <RevokeForm partnerId={partnerId} action={revokeAction} />
        ) : (
          <CertifyForm partnerId={partnerId} action={certifyAction} />
        )}
        <ContractForm partnerId={partnerId} action={contractAction} />
        <CounselForm partnerId={partnerId} action={counselAction} />
      </CardContent>
    </Card>
  );
}
