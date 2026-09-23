export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requirePlatformAdmin } from '@/lib/auth';
import { getPartnerStore } from '@/lib/partner-store';
import { getPartnerApiKeyStore, type ApiKeyPublic } from '@/lib/partner-api-key';
import { Sidebar } from '../sidebar';
import { IssueKeyButton } from '../partners/issue-key-button';
import { revokeApiKeyAction } from '../partners/actions';
import { displayKeyPrefix, keyModeFromId, scopesForMode } from '@/lib/partner-api-scopes';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

// /admin-dashboard/api-keys — every partner's API credentials on one page
// (Stage 5; platform ADMIN only). Issue/revoke reuse the partner-detail
// actions, which carry their own auth + cross-tenant guards — this page is
// only a view over them. Key material: last-4 + status, never the hash.
// Fix 44: prefix, mode and scopes all derive from keyModeFromId (the one rule);
// "last used" makes a rotation cut-over visible (issue new → watch the old key
// go quiet → revoke it).

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default async function ApiKeysPage() {
  await requirePlatformAdmin();
  const partners = await getPartnerStore().listPartners();
  const keyStore = getPartnerApiKeyStore();
  const keysByPartner = new Map<string, ApiKeyPublic[]>();
  for (const p of partners) {
    keysByPartner.set(p.id, await keyStore.list(p.id));
  }

  return (
    <>
      <Sidebar active="api-keys" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">API keys</div>
            <div className="sh-page-sub">
              Partner API credentials — plaintext is shown exactly once at issue; only a salted
              hash is stored. Auth: <code>Authorization: Bearer &lt;key&gt;</code> on{' '}
              <code>/api/partner/v1/*</code>.
            </div>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/docs">API docs →</Link>
          </Button>
        </div>

        {partners.map((p) => {
          const keys = keysByPartner.get(p.id) ?? [];
          const active = keys.filter((k) => !k.revokedAt);
          return (
            <Card key={p.id} className="mb-5">
              <CardHeader className="flex flex-row items-start justify-between space-y-0">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    {p.name}
                    <Badge variant={p.status === 'active' ? 'secondary' : 'destructive'}>{p.status}</Badge>
                  </CardTitle>
                  <CardDescription>
                    {active.length} active {active.length === 1 ? 'key' : 'keys'} ·{' '}
                    <Link href={`/admin-dashboard/partners/${p.id}`} className="text-primary underline-offset-2 hover:underline">
                      partner detail →
                    </Link>
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                {keys.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No keys issued yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Key</TableHead>
                        <TableHead>Mode</TableHead>
                        <TableHead>Scopes</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead>Last used</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {keys.map((k) => {
                        const mode = keyModeFromId(k.keyId);
                        const scopes = scopesForMode(mode);
                        return (
                        <TableRow key={k.keyId}>
                          <TableCell className="font-mono text-xs">
                            {displayKeyPrefix(mode)}…{k.last4} <span className="text-muted-foreground">({k.keyId})</span>
                          </TableCell>
                          <TableCell>
                            <Badge variant={mode === 'live' ? 'secondary' : 'outline'}>{mode}</Badge>
                          </TableCell>
                          <TableCell className="max-w-[16rem] text-xs text-muted-foreground" title={scopes.join(', ')}>
                            {mode === 'live' ? `all (${scopes.length})` : scopes.join(', ')}
                          </TableCell>
                          <TableCell>{fmtDate(k.createdAt)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {k.lastUsedAt ? fmtDate(k.lastUsedAt) : 'never'}
                          </TableCell>
                          <TableCell>
                            {k.revokedAt ? (
                              <Badge variant="outline" className="text-muted-foreground">
                                revoked {fmtDate(k.revokedAt)}
                              </Badge>
                            ) : (
                              <Badge variant="secondary">active</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {!k.revokedAt && (
                              <form action={revokeApiKeyAction.bind(null, p.id)}>
                                <input type="hidden" name="keyId" value={k.keyId} />
                                <Button type="submit" size="sm" variant="outline" className="text-destructive">
                                  Revoke
                                </Button>
                              </form>
                            )}
                          </TableCell>
                        </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
                <IssueKeyButton partnerId={p.id} />
              </CardContent>
            </Card>
          );
        })}
      </main>
    </>
  );
}
