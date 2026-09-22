import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { createPartnerRequestRepo, createPartnerApplicationRepo } from '@/db/repos/aux-repos';
import { migratePartnerDocsPrivate, type MigrateDeps } from '../scripts/migrate-partner-docs-private';
import type { Db } from '@/db/client';

/**
 * Program-Fix 24 — the owner-run data script that re-issues every document
 * still sitting at a PUBLIC Blob URL into the private store (brief §4 test 10).
 * PGlite is the ledger; fetch / put / del are injected fakes that record their
 * call ORDER. Dry run (default) writes nothing; --apply rewrites rows one
 * transaction each and calls del ONCE, with the old public URLs, only after
 * every rewrite. A failed put leaves every row and every public object untouched.
 */

let db: Db;

const REQ_A = 'preq_A';
const REQ_B = 'preq_B';
const REQ_C = 'preq_C';
const PUB_A = 'https://abc123.public.blob.vercel-storage.com/partner-applications/aaaaaaaa-1-licence-R4nd0m1.pdf';
const PRIV_A = 'https://priv999.private.blob.vercel-storage.com/partner-applications/preq_A/already-private-R4nd0m2.png';
const PUB_B = 'https://abc123.public.blob.vercel-storage.com/partner-applications/bbbbbbbb-1-scan-R4nd0m3.png';
const PUB_B_BAD = 'https://abc123.public.blob.vercel-storage.com/partner-applications/bbbbbbbb-2-notreally-R4nd0m4.pdf';
const PDF_BYTES = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const HTML_BYTES = Uint8Array.from(new TextEncoder().encode('<!DOCTYPE html><html>'));

const PRIVATE_TOKEN = 'test_blob_rw_priv999_testtoken';
const PUBLIC_TOKEN = 'test_blob_rw_pubstore_testtoken';

const objects = new Map<string, Uint8Array<ArrayBuffer>>([
  [PUB_A, PDF_BYTES],
  [PUB_B, PNG_BYTES],
  [PUB_B_BAD, HTML_BYTES],
]);

type Call = { op: 'fetch' | 'put' | 'del'; arg: unknown };
let calls: Call[];
let putShouldFail: (pathname: string) => boolean;
let lines: string[];
/** The ledger's document urls, per row, captured at the moment each del() ran. */
let ledgerAtDel: Array<Record<string, string[]>>;

function deps(): MigrateDeps {
  return {
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push({ op: 'fetch', arg: url });
      const bytes = objects.get(url);
      if (!bytes) return new Response(null, { status: 404 });
      return new Response(bytes, { status: 200 });
    }) as typeof fetch,
    put: (async (pathname: string, _body: unknown, opts: Record<string, unknown>) => {
      calls.push({ op: 'put', arg: { pathname, opts } });
      if (putShouldFail(pathname)) throw new Error(`put failed for https://abc123.public.blob.vercel-storage.com/${pathname}`);
      const p = pathname.replace(/(\.[a-z]+)$/, '-R4ndPriv$1');
      return {
        url: `https://priv999.private.blob.vercel-storage.com/${p}`,
        downloadUrl: `https://priv999.private.blob.vercel-storage.com/${p}?download=1`,
        pathname: p,
        contentType: String(opts.contentType),
        contentDisposition: 'inline',
      };
    }) as unknown as MigrateDeps['put'],
    del: (async (urls: string | string[], opts?: Record<string, unknown>) => {
      calls.push({ op: 'del', arg: { urls, opts } });
      const snapshot: Record<string, string[]> = {};
      for (const r of await rows()) snapshot[r.id] = r.documents.map((d) => d.url);
      ledgerAtDel.push(snapshot);
    }) as unknown as MigrateDeps['del'],
    log: (line: string) => { lines.push(line); },
  };
}

interface AppRow { id: string; partner_request_id: string; documents: Array<{ label: string; url: string; size: number; contentType: string }> }
async function rows(): Promise<AppRow[]> {
  const res = await db.execute(sql`SELECT id, partner_request_id, documents FROM partner_applications ORDER BY id`);
  return (res as unknown as { rows: AppRow[] }).rows;
}

async function seed(): Promise<void> {
  const reqs = createPartnerRequestRepo(db);
  const apps = createPartnerApplicationRepo(db);
  for (const id of [REQ_A, REQ_B, REQ_C]) {
    await reqs.savePartnerRequest({ id, companyName: id, email: `${id}@x.test`, phone: '1', corridors: [], capturedAt: new Date().toISOString() });
  }
  // A: one public PDF + one already-private PNG.
  await apps.saveApplication({
    id: 'papp_A', partnerRequestId: REQ_A, submittedAt: new Date().toISOString(), details: {},
    documents: [
      { label: 'Licence', url: PUB_A, size: 9, contentType: 'application/pdf' },
      { label: 'Scan', url: PRIV_A, size: 10, contentType: 'image/png' },
    ],
  });
  // B: one public PNG + one public "pdf" whose bytes are HTML (sniff mismatch ⇒ skipped).
  await apps.saveApplication({
    id: 'papp_B', partnerRequestId: REQ_B, submittedAt: new Date().toISOString(), details: {},
    documents: [
      { label: 'Scan', url: PUB_B, size: 10, contentType: 'image/png' },
      { label: 'Not really a PDF', url: PUB_B_BAD, size: 21, contentType: 'application/pdf' },
    ],
  });
  // C: no documents at all.
  await apps.saveApplication({ id: 'papp_C', partnerRequestId: REQ_C, submittedAt: new Date().toISOString(), details: {}, documents: [] });
}

beforeEach(async () => {
  db = await freshDb();
  await db.execute(sql`TRUNCATE partner_requests, partner_applications`);
  await seed();
  calls = [];
  lines = [];
  ledgerAtDel = [];
  putShouldFail = () => false;
});

describe('scripts/migrate-partner-docs-private (test 10)', () => {
  it('dry run: counts only — no put, no del, no row rewritten; output carries ids/counts/hosts, never a URL', async () => {
    const before = await rows();
    const report = await migratePartnerDocsPrivate(db, { apply: false, privateToken: PRIVATE_TOKEN, publicToken: PUBLIC_TOKEN }, deps());

    expect(report).toMatchObject({
      applications: 3,
      applicationsWithPublicDocs: 2,
      docsTotal: 4,
      docsPublic: 3,
      docsMigratable: 2,
      docsSkipped: 1,
      rowsRewritten: 0,
      deleted: 0,
      failures: 0,
      applied: false,
    });
    expect(report.hosts).toEqual(['abc123.public.blob.vercel-storage.com']);
    expect(calls.filter((c) => c.op === 'put')).toHaveLength(0);
    expect(calls.filter((c) => c.op === 'del')).toHaveLength(0);
    expect(await rows()).toEqual(before);
    const out = lines.join('\n');
    expect(out).toContain('papp_A');
    expect(out).toContain('papp_B');
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toContain('R4nd0m');
    expect(out).not.toContain(PRIVATE_TOKEN);
    expect(out).not.toContain(PUBLIC_TOKEN);
  });

  it('--apply: rows rewritten to private URLs (one transaction per row); del called ONCE with the old public URLs, after the rewrites', async () => {
    const report = await migratePartnerDocsPrivate(db, { apply: true, privateToken: PRIVATE_TOKEN, publicToken: PUBLIC_TOKEN }, deps());

    expect(report).toMatchObject({ docsMigratable: 2, docsMigrated: 2, docsSkipped: 1, rowsRewritten: 2, deleted: 2, failures: 0, applied: true });

    const after = await rows();
    const a = after.find((r) => r.id === 'papp_A')!;
    const b = after.find((r) => r.id === 'papp_B')!;
    const c = after.find((r) => r.id === 'papp_C')!;
    // A: the public PDF moved under partner-applications/<requestId>/migrated-…; the private one untouched.
    expect(a.documents[0].url).toMatch(new RegExp(`^https://priv999\\.private\\.blob\\.vercel-storage\\.com/partner-applications/${REQ_A}/migrated-0-`));
    expect(a.documents[0].contentType).toBe('application/pdf');
    expect(a.documents[0].label).toBe('Licence');
    expect(a.documents[0].size).toBe(PDF_BYTES.byteLength);
    expect(a.documents[1]).toEqual({ label: 'Scan', url: PRIV_A, size: 10, contentType: 'image/png' });
    // B: the PNG moved; the HTML-disguised "pdf" was skipped and left exactly as it was.
    expect(b.documents[0].url).toMatch(new RegExp(`^https://priv999\\.private\\.blob\\.vercel-storage\\.com/partner-applications/${REQ_B}/migrated-0-`));
    expect(b.documents[0].contentType).toBe('image/png');
    expect(b.documents[1]).toEqual({ label: 'Not really a PDF', url: PUB_B_BAD, size: 21, contentType: 'application/pdf' });
    expect(c.documents).toEqual([]);

    // Every put was PRIVATE with the private token; the request-scoped pathname; the sniffed type.
    const puts = calls.filter((x) => x.op === 'put').map((x) => x.arg as { pathname: string; opts: Record<string, unknown> });
    expect(puts).toHaveLength(2);
    for (const p of puts) {
      expect(p.opts.access).toBe('private');
      expect(p.opts.token).toBe(PRIVATE_TOKEN);
      expect(p.opts.addRandomSuffix).toBe(true);
    }
    expect(puts.map((p) => p.pathname.split('/').slice(0, 2).join('/')).sort()).toEqual([
      `partner-applications/${REQ_A}`,
      `partner-applications/${REQ_B}`,
    ]);

    // del: once, with exactly the two migrated public URLs (never the skipped one), the OLD token,
    // and AFTER every rewrite: at the moment del ran, no row still referenced a migrated public url.
    const dels = calls.filter((x) => x.op === 'del');
    expect(dels).toHaveLength(1);
    const del = dels[0].arg as { urls: string[]; opts: Record<string, unknown> };
    expect([...del.urls].sort()).toEqual([PUB_A, PUB_B].sort());
    expect(del.opts.token).toBe(PUBLIC_TOKEN);
    expect(ledgerAtDel).toHaveLength(1);
    const referencedAtDel = Object.values(ledgerAtDel[0]).flat();
    expect(referencedAtDel).not.toContain(PUB_A);
    expect(referencedAtDel).not.toContain(PUB_B);
    expect(referencedAtDel).toContain(PUB_B_BAD); // the skipped one is still referenced — and not deleted
    // and the last put happened before the del
    const lastPut = calls.map((x) => x.op).lastIndexOf('put');
    expect(calls.findIndex((x) => x.op === 'del')).toBeGreaterThan(lastPut);

    const out = lines.join('\n');
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toContain(PRIVATE_TOKEN);
    expect(out).not.toContain(PUBLIC_TOKEN);
  });

  it('--apply is idempotent: a second run finds nothing public and calls nothing', async () => {
    await migratePartnerDocsPrivate(db, { apply: true, privateToken: PRIVATE_TOKEN, publicToken: PUBLIC_TOKEN }, deps());
    calls = [];
    const again = await migratePartnerDocsPrivate(db, { apply: true, privateToken: PRIVATE_TOKEN, publicToken: PUBLIC_TOKEN }, deps());
    // Only the sniff-mismatch doc is still public — it is skipped again, so nothing is put or deleted.
    expect(again).toMatchObject({ docsPublic: 1, docsMigratable: 0, docsSkipped: 1, rowsRewritten: 0, deleted: 0 });
    expect(calls.filter((x) => x.op === 'put')).toHaveLength(0);
    expect(calls.filter((x) => x.op === 'del')).toHaveLength(0);
  });

  it('a failed put leaves EVERY row and every public object untouched; the error line carries no URL', async () => {
    putShouldFail = (pathname) => pathname.includes(`partner-applications/${REQ_B}/`);
    const before = await rows();
    const report = await migratePartnerDocsPrivate(db, { apply: true, privateToken: PRIVATE_TOKEN, publicToken: PUBLIC_TOKEN }, deps());

    expect(report.failures).toBe(1);
    expect(report.rowsRewritten).toBe(0);
    expect(report.deleted).toBe(0);
    expect(await rows()).toEqual(before);
    // No public object is ever deleted: every del carries only PRIVATE copies (the
    // best-effort cleanup of the copies made before the failure) with the PRIVATE token.
    const dels = calls.filter((x) => x.op === 'del').map((x) => x.arg as { urls: string[]; opts: Record<string, unknown> });
    for (const d of dels) {
      expect(d.opts.token).toBe(PRIVATE_TOKEN);
      for (const u of d.urls) expect(u).toMatch(/^https:\/\/priv999\.private\.blob\.vercel-storage\.com\//);
    }
    expect(dels.flatMap((d) => d.urls)).not.toContain(PUB_A);
    expect(dels.flatMap((d) => d.urls)).not.toContain(PUB_B);
    expect(dels.flatMap((d) => d.urls)).not.toContain(PUB_B_BAD);
    // The ledger was still on the public urls whenever a del ran.
    for (const snap of ledgerAtDel) expect(Object.values(snap).flat()).toContain(PUB_A);
    const out = lines.join('\n');
    expect(out).toContain('papp_B');
    expect(out).toContain('ABORTED');
    expect(out).not.toMatch(/https?:\/\//);
  });

  it('refuses to run --apply without the private token', async () => {
    await expect(
      migratePartnerDocsPrivate(db, { apply: true, privateToken: '', publicToken: PUBLIC_TOKEN }, deps()),
    ).rejects.toThrow(/PARTNER_DOCS_BLOB_READ_WRITE_TOKEN/);
    expect(calls.filter((x) => x.op === 'put')).toHaveLength(0);
  });
});
