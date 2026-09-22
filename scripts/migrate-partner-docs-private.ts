/**
 * ONE-OFF data script (Program-Fix 24): re-issue every partner-application
 * document that still sits at a world-readable PUBLIC Blob URL into the PRIVATE
 * store, rewrite the row, then delete the old public objects.
 *
 * DRY RUN by default — reads the ledger and the public objects, sniffs them,
 * prints application ids, counts and hosts, and writes NOTHING. Prints no URL,
 * no pathname suffix, no token and no file content, ever.
 *
 *   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/migrate-partner-docs-private.ts
 *
 * Apply ONLY after the dry-run counts look right (the audit saw 2 documents on
 * 4 applications) and the new build is deployed (the staff route must be able
 * to read the private refs):
 *
 *   … scripts/migrate-partner-docs-private.ts --apply
 *
 * Needs PARTNER_DOCS_BLOB_READ_WRITE_TOKEN (the private store, for `put`) and
 * BLOB_READ_WRITE_TOKEN (the OLD public store, for `del`). Three phases, so a
 * failure leaves the ledger consistent:
 *   1. copy: fetch + sniff + `put` (access: 'private') EVERY migratable object
 *      into the private store under `partner-applications/<requestId>/migrated-…`.
 *      Any failure here ⇒ stop: no row is rewritten, no public object deleted,
 *      the private copies made so far are best-effort deleted;
 *   2. rewrite: one transaction per application row (only the migrated urls
 *      change; a sniff-mismatch document is SKIPPED, reported and left as-is);
 *   3. delete: only after EVERY row is rewritten, ONE `del()` of the old public
 *      urls with the old token. Re-running is safe: private refs are ignored.
 * After it has run clean, the old public store and BLOB_READ_WRITE_TOKEN can be
 * deleted entirely (nothing else writes to that store).
 */
import { del as blobDel, put as blobPut } from '@vercel/blob';
import { eq } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import { partnerApplications } from '@/db/schema';
import { isLegacyPublicPartnerDocRef, isPartnerDocType, isPrivatePartnerDocRef, sniffDocType, type PartnerDocType } from '@/lib/blob';
import type { PartnerApplicationDocument } from '@/lib/types';

export interface MigrateDeps {
  fetchImpl: typeof fetch;
  put: typeof blobPut;
  del: typeof blobDel;
  log: (line: string) => void;
}

export interface MigrateOptions {
  apply: boolean;
  privateToken: string;
  publicToken: string;
}

export interface MigrateReport {
  applied: boolean;
  applications: number;
  applicationsWithPublicDocs: number;
  docsTotal: number;
  docsPublic: number;
  /** Public docs whose bytes matched their declared type — the ones that move. */
  docsMigratable: number;
  /** Public docs skipped: fetch failed or the sniff disagreed with the declared type. */
  docsSkipped: number;
  docsMigrated: number;
  rowsRewritten: number;
  deleted: number;
  failures: number;
  /** Distinct public hosts seen (never a full URL). */
  hosts: string[];
}

interface Row {
  id: string;
  partnerRequestId: string;
  documents: PartnerApplicationDocument[];
}

interface Copy {
  rowId: string;
  index: number;
  oldUrl: string;
  newDoc: PartnerApplicationDocument;
  newUrl: string;
}

/** Error text with every URL removed — put/fetch errors embed them. */
function safeError(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return msg.replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return '?'; }
}

const EXT: Record<PartnerDocType, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

export async function migratePartnerDocsPrivate(
  db: Db,
  opts: MigrateOptions,
  deps: MigrateDeps,
): Promise<MigrateReport> {
  if (opts.apply && !opts.privateToken) {
    throw new Error('--apply needs PARTNER_DOCS_BLOB_READ_WRITE_TOKEN (the private store) — refusing to run.');
  }
  if (opts.apply && !opts.publicToken) {
    throw new Error('--apply needs BLOB_READ_WRITE_TOKEN (the old public store, for del) — refusing to run.');
  }
  const { log } = deps;
  const report: MigrateReport = {
    applied: opts.apply, applications: 0, applicationsWithPublicDocs: 0, docsTotal: 0, docsPublic: 0,
    docsMigratable: 0, docsSkipped: 0, docsMigrated: 0, rowsRewritten: 0, deleted: 0, failures: 0, hosts: [],
  };
  const hosts = new Set<string>();

  const rows = (await db
    .select({ id: partnerApplications.id, partnerRequestId: partnerApplications.partnerRequestId, documents: partnerApplications.documents })
    .from(partnerApplications)
    .orderBy(partnerApplications.id)) as Row[];
  report.applications = rows.length;

  // ── Phase 1: copy every migratable public object into the private store. ──
  const copies: Copy[] = [];
  const failedRows = new Set<string>();
  for (const row of rows) {
    const docs = Array.isArray(row.documents) ? row.documents : [];
    report.docsTotal += docs.length;
    const publicIdx = docs
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => typeof d?.url === 'string' && isLegacyPublicPartnerDocRef(d.url));
    if (publicIdx.length === 0) continue;
    report.applicationsWithPublicDocs += 1;
    report.docsPublic += publicIdx.length;
    let migratable = 0;
    let skipped = 0;
    for (const { d, i } of publicIdx) {
      hosts.add(hostOf(d.url));
      let bytes: Buffer;
      try {
        const res = await deps.fetchImpl(d.url);
        if (!res.ok) { skipped += 1; log(`  ${row.id} doc[${i}]: SKIP — public object fetch returned ${res.status}`); continue; }
        bytes = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        skipped += 1;
        log(`  ${row.id} doc[${i}]: SKIP — fetch failed (${safeError(err)})`);
        continue;
      }
      const sniffed = sniffDocType(bytes.subarray(0, 8));
      if (sniffed === null || sniffed !== d.contentType) {
        skipped += 1;
        // `d.contentType` on a pre-fix row is applicant-supplied text: print it only through the allow-list.
        const declared = typeof d.contentType === 'string' && isPartnerDocType(d.contentType) ? d.contentType : 'other';
        log(`  ${row.id} doc[${i}]: SKIP — bytes do not match declared type (declared ${declared}, sniffed ${sniffed ?? 'unknown'}); left as-is, review by hand`);
        continue;
      }
      migratable += 1;
      if (!opts.apply) continue;
      const pathname = `partner-applications/${row.partnerRequestId}/migrated-${i}-${Date.now()}.${EXT[sniffed]}`;
      try {
        const result = await deps.put(pathname, bytes, {
          access: 'private',
          addRandomSuffix: true,
          contentType: sniffed,
          token: opts.privateToken,
        });
        if (!isPrivatePartnerDocRef(result.url, row.partnerRequestId)) {
          throw new Error('private store returned a url that does not bind to the request prefix');
        }
        copies.push({
          rowId: row.id,
          index: i,
          oldUrl: d.url,
          newUrl: result.url,
          newDoc: { label: d.label, url: result.url, size: bytes.byteLength, contentType: sniffed },
        });
      } catch (err) {
        report.failures += 1;
        failedRows.add(row.id);
        log(`  ${row.id} doc[${i}]: FAILED — private put (${safeError(err)})`);
      }
    }
    report.docsMigratable += migratable;
    report.docsSkipped += skipped;
    log(`  ${row.id} (request ${row.partnerRequestId}): ${publicIdx.length} public, ${migratable} migratable, ${skipped} skipped`);
  }
  report.hosts = [...hosts].sort();

  if (!opts.apply) {
    log(`\nDRY RUN — nothing written. Re-run with --apply to move ${report.docsMigratable} document(s) on ${report.applicationsWithPublicDocs} application(s).`);
    return report;
  }

  if (report.failures > 0) {
    // Nothing rewritten, nothing deleted. Best-effort cleanup of the private
    // copies made in this run so a re-run does not leave duplicates behind.
    if (copies.length > 0) {
      try {
        await deps.del(copies.map((c) => c.newUrl), { token: opts.privateToken });
      } catch (err) {
        log(`  cleanup of ${copies.length} private copies failed (${safeError(err)}) — harmless duplicates in the private store`);
      }
    }
    log(`\nABORTED — ${report.failures} put failure(s) (rows: ${[...failedRows].join(', ')}). No row rewritten, no public object deleted. Fix and re-run.`);
    return report;
  }

  // ── Phase 2: rewrite each row in its own transaction. ──
  const byRow = new Map<string, Copy[]>();
  for (const c of copies) byRow.set(c.rowId, [...(byRow.get(c.rowId) ?? []), c]);
  const rewrittenOldUrls: string[] = [];
  for (const row of rows) {
    const rowCopies = byRow.get(row.id);
    if (!rowCopies || rowCopies.length === 0) continue;
    const next = (Array.isArray(row.documents) ? row.documents : []).map((d, i) => {
      const c = rowCopies.find((x) => x.index === i);
      return c ? c.newDoc : d;
    });
    try {
      await db.transaction(async (tx) => {
        await tx.update(partnerApplications).set({ documents: next }).where(eq(partnerApplications.id, row.id));
      });
      report.rowsRewritten += 1;
      report.docsMigrated += rowCopies.length;
      rewrittenOldUrls.push(...rowCopies.map((c) => c.oldUrl));
      log(`  ${row.id}: rewritten (${rowCopies.length} document(s) now private)`);
    } catch (err) {
      report.failures += 1;
      log(`  ${row.id}: FAILED — row rewrite (${safeError(err)})`);
    }
  }

  if (report.failures > 0) {
    log(`\nSTOPPED before delete — ${report.failures} row(s) failed to rewrite; ${report.rowsRewritten} rewritten. No public object deleted (the old store can be deleted whole once every row is private). Re-run after fixing.`);
    return report;
  }

  // ── Phase 3: one delete of the old public objects, only now. ──
  if (rewrittenOldUrls.length > 0) {
    try {
      await deps.del(rewrittenOldUrls, { token: opts.publicToken });
      report.deleted = rewrittenOldUrls.length;
      log(`  deleted ${rewrittenOldUrls.length} old public object(s)`);
    } catch (err) {
      report.failures += 1;
      log(`  delete of ${rewrittenOldUrls.length} old public object(s) FAILED (${safeError(err)}) — rows are already private; delete the old store by hand`);
    }
  }
  log(`\nDONE — ${report.docsMigrated} document(s) on ${report.rowsRewritten} application(s) moved to the private store; ${report.deleted} public object(s) deleted; ${report.docsSkipped} skipped.`);
  return report;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — source .env.local first.');
    process.exit(1);
  }
  const apply = process.argv.includes('--apply');
  const host = (() => { try { return new URL(process.env.DATABASE_URL ?? '').host; } catch { return '?'; } })();
  console.log(`\nPartner-document re-issue (fix 24) against ${host} — ${new Date().toISOString()} — ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`private store token: ${process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN ? 'set' : 'MISSING'} · old public store token: ${process.env.BLOB_READ_WRITE_TOKEN ? 'set' : 'MISSING'}`);
  const report = await migratePartnerDocsPrivate(
    getDb(),
    {
      apply,
      privateToken: process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN ?? '',
      publicToken: process.env.BLOB_READ_WRITE_TOKEN ?? '',
    },
    { fetchImpl: fetch, put: blobPut, del: blobDel, log: (line) => console.log(line) },
  );
  console.log(
    `\nSUMMARY: applications=${report.applications} withPublicDocs=${report.applicationsWithPublicDocs} docs=${report.docsTotal} ` +
    `public=${report.docsPublic} migratable=${report.docsMigratable} skipped=${report.docsSkipped} migrated=${report.docsMigrated} ` +
    `rowsRewritten=${report.rowsRewritten} deleted=${report.deleted} failures=${report.failures} hosts=${report.hosts.join(',') || '-'}\n`,
  );
  if (report.failures > 0) process.exit(1);
}

if (process.argv[1]?.endsWith('migrate-partner-docs-private.ts')) {
  main().then(() => process.exit(0)).catch((e) => { console.error('migrate-partner-docs-private failed:', safeError(e)); process.exit(1); });
}
