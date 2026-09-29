import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { SendLimitChange } from '@/db/repos/aux-repos';
import { PLATFORM_SEND_LIMITS, SEND_LIMIT_HARD_CEILING_CENTS, SEND_LIMIT_REASON_MAX } from '@/lib/send-limits';
import type { EffectiveSendLimits, PartnerSendLimits, SendLimitOverride, SendLimitSource } from '@/lib/types';

// Program fix 16b: the shared "Send limits" card for the customer and partner
// detail pages. Read-only for everyone; the raise/clear form renders ONLY when
// `canEdit` (the page passes scopeOf(staff).kind === 'platform'). The form is a
// convenience — the server action self-gates with requirePlatformAdmin() and
// validates every field again; nothing here is a guard.

const DL_CLASS =
  'grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm [&_dt]:text-muted-foreground [&_dd]:min-w-0 [&_dd]:break-words';

const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US')}`;
const sourceLabel: Record<SendLimitSource, string> = {
  customer: 'customer override',
  partner: 'partner default',
  platform: 'platform',
};

/** UI redesign M3-12: a customer entry the tenant's own admin set (setScope 'partner'). */
const isPartnerSet = (scope: SendLimitsCardProps['scope'], stored: SendLimitOverride | undefined): boolean =>
  scope === 'customer' && stored?.setScope === 'partner';

/**
 * The provenance shown next to one effective figure. On the CUSTOMER card a figure that comes from
 * a partner-set entry reads as set by the partner; SmartRemit-set and legacy entries (and every
 * partner-level card) read as before.
 */
export function sendLimitSourceLabel(
  source: SendLimitSource,
  scope: SendLimitsCardProps['scope'],
  stored: SendLimitOverride | undefined,
): string {
  return source === 'customer' && isPartnerSet(scope, stored) ? 'set by the partner for this customer' : sourceLabel[source];
}

export interface SendLimitsCardProps {
  scope: 'customer' | 'partner';
  effective: EffectiveSendLimits;
  /** The stored entry at THIS level (customer override or partner default), if any. */
  stored: PartnerSendLimits | undefined;
  lastChange: SendLimitChange | null;
  canEdit: boolean;
  action: (formData: FormData) => Promise<void>;
  /** Hidden fields the action keys the write on (partnerId + phone, or id). */
  hidden: Record<string, string>;
  /** The partner form also carries the tighten-only T0 field. */
  showT0?: boolean;
}

export function SendLimitsCard(p: SendLimitsCardProps) {
  const { effective, stored } = p;
  const storedExpiry = typeof stored?.expiresAt === 'string' ? stored.expiresAt : undefined;
  const expired = storedExpiry !== undefined && Date.parse(storedExpiry) <= Date.now();
  const ceilingUsd = SEND_LIMIT_HARD_CEILING_CENTS / 100;
  const idPrefix = `sl-${p.scope}`;
  const partnerSet = isPartnerSet(p.scope, stored);
  const label = (source: SendLimitSource) => sendLimitSourceLabel(source, p.scope, stored);

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Send limits</CardTitle>
        <CardDescription>
          {p.scope === 'customer'
            ? 'The effective caps for this sender: customer override, else partner default, else platform.'
            : 'The default caps for this partner’s senders: partner default, else platform (a customer override beats both).'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className={DL_CLASS}>
          <dt>Per transfer</dt>
          <dd>{usd(effective.perTransferCapCents)} <span className="text-muted-foreground">({label(effective.source.perTransferCapCents)})</span></dd>
          <dt>Daily, verified (T1)</dt>
          <dd>{usd(effective.t1DailyCapCents)} <span className="text-muted-foreground">({label(effective.source.t1DailyCapCents)})</span></dd>
          <dt>Daily, first 3 days (T0)</dt>
          <dd>{usd(effective.t0DailyCapCents)} <span className="text-muted-foreground">({label(effective.source.t0DailyCapCents)})</span></dd>
          {partnerSet && stored && (
            <>
              <dt>Set by</dt>
              <dd>
                The partner{typeof stored.setBy === 'string' ? ` (${stored.setBy})` : ''}
                {typeof stored.setAt === 'string' ? `, ${new Date(stored.setAt).toLocaleString()}` : ''}:{' '}
                per transfer {typeof stored.perTransferCapCents === 'number' ? usd(stored.perTransferCapCents) : '—'},
                daily {typeof stored.t1DailyCapCents === 'number' ? usd(stored.t1DailyCapCents) : '—'}
                <span className="text-muted-foreground"> (always held at or below the platform and partner caps)</span>
              </dd>
            </>
          )}
          <dt>Expiry</dt>
          <dd>
            {storedExpiry
              ? `${new Date(storedExpiry).toLocaleString()}${expired ? ' (lapsed — back to the level below)' : ''}`
              : stored ? 'none' : '—'}
          </dd>
          <dt>Last change</dt>
          <dd>
            {p.lastChange ? (
              <>
                <strong>{p.lastChange.actor}</strong>
                {p.lastChange.meta.actorScope === 'partner' ? ' (partner)' : ''} · {new Date(p.lastChange.at).toLocaleString()} ·{' '}
                {p.lastChange.action === 'send_limits.clear' ? 'cleared' : 'set'}
                {typeof p.lastChange.meta.reason === 'string' ? ` — ${p.lastChange.meta.reason}` : ''}
              </>
            ) : '—'}
          </dd>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">
          A raise lifts only the dollar caps, up to {usd(SEND_LIMIT_HARD_CEILING_CENTS)} per transfer and per day.
          A single transfer is also bounded by the daily cap, so raise both fields together.
          Sanctions screening, EDD ($3,000/month) and the first-3-days tier gate still apply. Every change is audited.
        </p>

        {p.canEdit && (
          <form action={p.action} className="mt-4 space-y-3 rounded-lg border p-4">
            {Object.entries(p.hidden).map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`${idPrefix}-per`}>Per-transfer limit (USD)</Label>
                <Input id={`${idPrefix}-per`} name="perTransferUsd" type="number" inputMode="numeric" min={1} max={ceilingUsd} step={1}
                  defaultValue={stored?.perTransferCapCents ? stored.perTransferCapCents / 100 : ''} placeholder={`1 – ${ceilingUsd.toLocaleString('en-US')}`} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${idPrefix}-t1`}>Daily limit, verified (USD)</Label>
                <Input id={`${idPrefix}-t1`} name="t1DailyUsd" type="number" inputMode="numeric" min={1} max={ceilingUsd} step={1}
                  defaultValue={stored?.t1DailyCapCents ? stored.t1DailyCapCents / 100 : ''} placeholder={`1 – ${ceilingUsd.toLocaleString('en-US')}`} />
              </div>
              {p.showT0 && (
                <div className="space-y-1.5">
                  <Label htmlFor={`${idPrefix}-t0`}>Daily limit, first 3 days (USD, tighten only)</Label>
                  <Input id={`${idPrefix}-t0`} name="t0DailyUsd" type="number" inputMode="numeric" min={1} max={PLATFORM_SEND_LIMITS.t0DailyCapCents / 100} step={1}
                    defaultValue={stored?.t0DailyCapCents ? stored.t0DailyCapCents / 100 : ''} placeholder={`1 – ${PLATFORM_SEND_LIMITS.t0DailyCapCents / 100}`} />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor={`${idPrefix}-exp`}>Expires (optional, end of day UTC)</Label>
                <Input id={`${idPrefix}-exp`} name="expiresAt" type="date" defaultValue={storedExpiry ? storedExpiry.slice(0, 10) : ''} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-reason`}>Reason (required, recorded in the audit log)</Label>
              <Input id={`${idPrefix}-reason`} name="reason" type="text" required maxLength={SEND_LIMIT_REASON_MAX} placeholder="e.g. QA large-amount test" />
            </div>
            {partnerSet && (
              <p className="text-xs text-muted-foreground">
                The partner set this limit. Saving it with the same values changes nothing, and the partner keeps control.
                Changing any value replaces it with a SmartRemit limit that the partner cannot edit or clear while it is live.
                Clear removes it, and the partner can then set it again.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit">Save limits</Button>
              <Button type="submit" name="clear" value="on" variant="outline">Clear override</Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
