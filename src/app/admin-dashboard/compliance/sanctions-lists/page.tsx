export const dynamic = 'force-dynamic';

// Fix pack 5 T31 (R08, P28): the platform-only sanctions lists page. Partner-scoped staff get a
// 404 (there is no shared requirePlatformStaff: requireScope() bounces support, and partner scope
// is refused here, as the compliance page hides its list card). Every source's status comes from
// sanctionsListStatus (one row per source under SANCTIONS_LIST=lists, else the OFAC SDN row plus
// the curated India MHA row); each read fails soft to "unavailable". The upload and confirm forms
// show for a platform admin only (the actions re-gate). No list entry or name is ever shown.
// Pack 5 review LC2: an archive card shows, per source, the verified-archive counts the compliance
// card shows for ofac-sdn (archiveSummary) plus the oldest pending version's age (pendingArchiveAge).
import { notFound } from 'next/navigation';
import { requireScope } from '@/lib/auth';
import { getDb } from '@/db/client';
import { createSanctionsListRepo, type ArchiveSummary } from '@/db/repos/sanctions-list-repo';
import { ARCHIVE_LAG_ALERT_DAYS } from '@/lib/sanctions/list-archive';
import { isBlobConfigured } from '@/lib/blob';
import { sanctionsListStatus, type SanctionsListStatus } from '@/lib/sanctions/list-health';
import { sourceFitness, type ListFitness } from '@/lib/sanctions/list-policy';
import { MHA_SOURCE } from '@/lib/sanctions/in-mha-list';
import { t } from '@/lib/i18n';
import { logError } from '@/lib/log';
import { Sidebar } from '../../sidebar';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { confirmMhaListCurrentAction, uploadMhaListAction } from './actions';
import { MhaConfirmForm, MhaUploadForm } from './forms';

interface SourceRow {
  source: string;
  version: string | null;
  checkedAt: string | null;
  entryCount: number | null;
  fitness: ListFitness;
}

function ageText(iso: string, nowMs: number): string {
  const h = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 3_600_000));
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

async function loadRows(now: Date): Promise<{ status: SanctionsListStatus | null; rows: SourceRow[] }> {
  let status: SanctionsListStatus | null = null;
  try {
    status = await sanctionsListStatus(getDb(), now);
  } catch (err) {
    logError('compliance.sanctions-lists-status', err instanceof Error ? err.name : 'unknown');
    return { status: null, rows: [] };
  }
  if (status.members) return { status, rows: status.members };
  const rows: SourceRow[] = [
    { source: 'ofac-sdn', version: status.version, checkedAt: status.checkedAt, entryCount: status.entryCount, fitness: status.fitness },
  ];
  // Outside lists mode the MHA list is not screened; its row still shows what is loaded.
  try {
    const mha = await createSanctionsListRepo(getDb()).activeVersion(MHA_SOURCE);
    const checkedAt = mha?.checkedAt ? mha.checkedAt.toISOString() : null;
    rows.push({
      source: MHA_SOURCE,
      version: mha?.version ?? null,
      checkedAt,
      entryCount: mha?.entryCount ?? null,
      fitness: mha
        ? sourceFitness({ source: MHA_SOURCE, version: mha.version, hash: mha.hash, ...(checkedAt ? { checkedAt } : {}) }, now)
        : 'not_live',
    });
  } catch (err) {
    logError('compliance.sanctions-lists-mha', err instanceof Error ? err.name : 'unknown');
  }
  return { status, rows };
}

interface ArchiveRow {
  source: string;
  summary: ArchiveSummary | null;
  oldestPendingAt: string | null;
}

/** Per source, fail soft: a read that throws shows "unavailable" for that source only. */
async function loadArchiveRows(sources: string[]): Promise<ArchiveRow[]> {
  const repo = createSanctionsListRepo(getDb());
  const out: ArchiveRow[] = [];
  for (const source of sources) {
    try {
      const summary = await repo.archiveSummary(source);
      const age = await repo.pendingArchiveAge(source);
      out.push({ source, summary, oldestPendingAt: age.oldestLoadedAt ? age.oldestLoadedAt.toISOString() : null });
    } catch (err) {
      logError('compliance.sanctions-lists-archive', err instanceof Error ? err.name : 'unknown', { source });
      out.push({ source, summary: null, oldestPendingAt: null });
    }
  }
  return out;
}

export default async function SanctionsListsPage() {
  const { staff, scope } = await requireScope();
  if (scope.kind === 'partner') notFound();
  const now = new Date();
  const { status, rows } = await loadRows(now);
  const archiveRows = await loadArchiveRows(rows.map((r) => r.source));
  const blobConfigured = isBlobConfigured();
  const isAdmin = staff.role === 'admin';

  return (
    <>
      <Sidebar active="compliance" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">{t('admin.compliance.sanctionsLists.title')}</div>
            <div className="sh-page-sub">{t('admin.compliance.sanctionsLists.sub')}</div>
          </div>
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{t('admin.compliance.sanctionsLists.status.title')}</CardTitle>
            {status && (
              <CardDescription>{t('admin.compliance.sanctionsLists.status.setting', { setting: status.listSetting })}</CardDescription>
            )}
          </CardHeader>
          <CardContent>
            {status ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="sanctions-list-rows">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1.5 pr-4 font-medium">{t('admin.compliance.sanctionsLists.col.source')}</th>
                      <th className="py-1.5 pr-4 font-medium">{t('admin.compliance.sanctionsLists.col.version')}</th>
                      <th className="py-1.5 pr-4 font-medium">{t('admin.compliance.sanctionsLists.col.entries')}</th>
                      <th className="py-1.5 pr-4 font-medium">{t('admin.compliance.sanctionsLists.col.checked')}</th>
                      <th className="py-1.5 font-medium">{t('admin.compliance.sanctionsLists.col.fitness')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.source} className="border-t border-border">
                        <td className="py-1.5 pr-4 font-mono">{r.source}</td>
                        <td className="py-1.5 pr-4">{r.version ?? t('admin.compliance.sanctionsLists.none')}</td>
                        <td className="py-1.5 pr-4">{r.entryCount ?? '—'}</td>
                        <td className="py-1.5 pr-4">
                          {r.checkedAt ? ageText(r.checkedAt, now.getTime()) : t('admin.compliance.sanctionsLists.never')}
                        </td>
                        <td className="py-1.5">
                          <Badge variant={r.fitness === 'live' ? 'outline' : 'destructive'}>{r.fitness}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('admin.compliance.sanctionsLists.status.unavailable')}</p>
            )}
          </CardContent>
        </Card>

        {archiveRows.length > 0 && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>{t('admin.compliance.sanctionsLists.archive.title')}</CardTitle>
              <CardDescription>{t('admin.compliance.sanctionsLists.archive.help', { days: ARCHIVE_LAG_ALERT_DAYS })}</CardDescription>
            </CardHeader>
            <CardContent>
              {!blobConfigured && (
                <p className="mb-3 text-sm text-destructive">{t('admin.compliance.sanctionsLists.archive.blobUnconfigured')}</p>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="sanctions-list-archive-rows">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1.5 pr-4 font-medium">{t('admin.compliance.sanctionsLists.col.source')}</th>
                      <th className="py-1.5 pr-4 font-medium">{t('admin.compliance.sanctionsLists.archive.col.archived')}</th>
                      <th className="py-1.5 pr-4 font-medium">{t('admin.compliance.sanctionsLists.archive.col.pending')}</th>
                      <th className="py-1.5 pr-4 font-medium">{t('admin.compliance.sanctionsLists.archive.col.withEntries')}</th>
                      <th className="py-1.5 font-medium">{t('admin.compliance.sanctionsLists.archive.col.oldestPending')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {archiveRows.map((a) => (
                      <tr key={a.source} className="border-t border-border">
                        <td className="py-1.5 pr-4 font-mono">{a.source}</td>
                        {a.summary ? (
                          <>
                            <td className="py-1.5 pr-4">{a.summary.archived}</td>
                            <td className="py-1.5 pr-4">{a.summary.pending}</td>
                            <td className="py-1.5 pr-4">{`${a.summary.withEntries} / ${a.summary.versions}`}</td>
                            <td className="py-1.5">{a.oldestPendingAt ? ageText(a.oldestPendingAt, now.getTime()) : '—'}</td>
                          </>
                        ) : (
                          <td className="py-1.5 text-muted-foreground" colSpan={4}>
                            {t('admin.compliance.sanctionsLists.archive.unavailable')}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {isAdmin && (
          <>
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>{t('admin.compliance.sanctionsLists.upload.title')}</CardTitle>
                <CardDescription>{t('admin.compliance.sanctionsLists.upload.help')}</CardDescription>
              </CardHeader>
              <CardContent>
                <MhaUploadForm action={uploadMhaListAction} />
              </CardContent>
            </Card>
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>{t('admin.compliance.sanctionsLists.confirm.title')}</CardTitle>
                <CardDescription>{t('admin.compliance.sanctionsLists.confirm.help')}</CardDescription>
              </CardHeader>
              <CardContent>
                <MhaConfirmForm action={confirmMhaListCurrentAction} />
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </>
  );
}
