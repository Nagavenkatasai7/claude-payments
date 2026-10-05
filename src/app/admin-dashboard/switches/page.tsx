export const dynamic = 'force-dynamic';

import { requirePlatformAdmin } from '@/lib/auth';
import { getDb } from '@/db/client';
import { getPartnerStore } from '@/lib/partner-store';
import { createFeatureFlagRepo, type FlagRow } from '@/db/repos/feature-flag-repo';
import { FLAG_DEFINITIONS, FLAG_KEYS } from '@/lib/flags';
import { isFlagChangeMessage, scopeLabel } from '@/lib/flag-switch';
import { SUPPORTED_DESTINATIONS } from '@/lib/destination-country';
import { STAFF_REASON_MIN, STAFF_REASON_MAX } from '@/lib/send-limits';
import { Sidebar } from '../sidebar';
import { changeFlagAction } from './actions';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

// /admin-dashboard/switches — kill switches (Release safety Batch 2 part A) and
// feature switches (voice notes). Platform ADMIN only. Each switch can be on for
// every partner and corridor, for one partner, or for one corridor (destination
// country), as far as its definition's `scopes` allow (the form offers only
// those). Turning one on or off needs a reason; the action writes an audit row,
// and a kill switch also sends one ops alert. A
// switch takes effect on every server instance within 15 seconds, without a
// deploy. This page is only a view and a form: applyFlagChange is the guard.

const SELECT_CLASS = 'h-9 w-full rounded-md border border-input bg-card px-3 text-sm';

function fmt(d: Date): string {
  return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
}

function ReasonField({ id }: { id: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Reason (required, at least {STAFF_REASON_MIN} characters, recorded in the audit log)</Label>
      <Input id={id} name="reason" type="text" required minLength={STAFF_REASON_MIN} maxLength={STAFF_REASON_MAX} placeholder="e.g. Rail partner reports an outage" />
    </div>
  );
}

export default async function SwitchesPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  await requirePlatformAdmin();
  const params = await searchParams;
  const [rows, partners] = await Promise.all([
    createFeatureFlagRepo(getDb()).listAll(),
    getPartnerStore().listPartners(),
  ]);
  const byKey = new Map<string, FlagRow[]>();
  for (const r of rows) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
  const error = isFlagChangeMessage(params.error) ? params.error : null;

  return (
    <>
      <Sidebar active="switches" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Switches</div>
            <div className="sh-page-sub">
              Kill switches stop money movement at once, without a deploy. A change reaches every server within 15 seconds.
              Each change needs a reason and writes an audit row; a kill switch also sends one ops alert. Sanctions screening is not a switch.
            </div>
          </div>
        </div>

        {error && (
          <Alert variant="destructive" className="mb-4" role="alert">
            <AlertTitle>The switch did not change</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {params.ok === '1' && !error && (
          <Alert className="mb-4" role="status">
            <AlertTitle>Switch saved</AlertTitle>
            <AlertDescription>The change is in the audit log. A kill switch change also sends an ops alert.</AlertDescription>
          </Alert>
        )}

        {FLAG_KEYS.map((key) => {
          const def = FLAG_DEFINITIONS[key];
          const keyRows = byKey.get(key) ?? [];
          const on = keyRows.filter((r) => r.enabled);
          const off = keyRows.filter((r) => !r.enabled);
          return (
            <Card key={key} className="mb-5" data-testid={`switch-${key}`}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {def.label}
                  {on.length > 0 ? (
                    <Badge variant={def.killSwitch ? 'destructive' : 'default'}>ON for {on.length} {on.length === 1 ? 'scope' : 'scopes'}</Badge>
                  ) : (
                    <Badge variant="secondary">off</Badge>
                  )}
                </CardTitle>
                <CardDescription>{def.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                {on.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>On for</TableHead>
                        <TableHead>Since</TableHead>
                        <TableHead>By</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead>Turn off</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {on.map((r) => (
                        <TableRow key={`${r.scopeType}:${r.scopeId}`}>
                          <TableCell>{scopeLabel(r.scopeType, r.scopeId)}</TableCell>
                          <TableCell>{fmt(r.updatedAt)}</TableCell>
                          <TableCell>{r.updatedBy}</TableCell>
                          <TableCell className="max-w-[280px] break-words">{r.reason}</TableCell>
                          <TableCell>
                            <form action={changeFlagAction} className="flex min-w-[260px] flex-col gap-2">
                              <input type="hidden" name="key" value={key} />
                              <input type="hidden" name="scope" value={`${r.scopeType}:${r.scopeId}`} />
                              <input type="hidden" name="enabled" value="off" />
                              <Input name="reason" type="text" required minLength={STAFF_REASON_MIN} maxLength={STAFF_REASON_MAX}
                                aria-label="Reason for turning it off" placeholder="Reason (at least 10 characters)" />
                              <Button type="submit" size="sm" variant="outline">Turn off</Button>
                            </form>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}

                <form action={changeFlagAction} className="space-y-3 rounded-lg border p-4">
                  <input type="hidden" name="key" value={key} />
                  <input type="hidden" name="enabled" value="on" />
                  <div className="space-y-1.5">
                    <Label htmlFor={`${key}-scope`}>Turn on for</Label>
                    <select id={`${key}-scope`} name="scope" className={SELECT_CLASS} defaultValue="global:">
                      {def.scopes.includes('global') && <option value="global:">All partners and corridors</option>}
                      {def.scopes.includes('partner') && (
                        <optgroup label="One partner">
                          {partners.map((p) => (
                            <option key={p.id} value={`partner:${p.id}`}>{p.name} ({p.id})</option>
                          ))}
                        </optgroup>
                      )}
                      {def.scopes.includes('corridor') && (
                        <optgroup label="One corridor (destination country)">
                          {SUPPORTED_DESTINATIONS.map((c) => (
                            <option key={c} value={`corridor:${c}`}>{c}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </div>
                  <ReasonField id={`${key}-reason`} />
                  <Button type="submit" variant={def.killSwitch ? 'destructive' : 'default'}>Turn on</Button>
                </form>

                {off.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Last turned off:{' '}
                    {off.map((r, i) => (
                      <span key={`${r.scopeType}:${r.scopeId}`}>
                        {i > 0 ? '; ' : ''}
                        {scopeLabel(r.scopeType, r.scopeId)} on {fmt(r.updatedAt)} by {r.updatedBy}
                      </span>
                    ))}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </main>
    </>
  );
}
