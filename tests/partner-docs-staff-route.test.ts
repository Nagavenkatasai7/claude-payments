import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createStore } from '@/lib/store';
import { scopeOf } from '@/lib/staff-scope';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

/**
 * Program-Fix 24 — the ONLY staff read path for partner documents:
 * GET /admin-dashboard/partner-requests/[id]/documents/[index] (brief §4 tests
 * 7–9). PGlite holds the ledger + audit_events; `@vercel/blob` `get` is mocked.
 * Invariant 3: requireScope self-gate, 404 for any non-platform scope with NO
 * audit row, the document resolved from the ledger by (requestId, index), and
 * the audit row written BEFORE any bytes (an audit failure ⇒ 500, get never
 * called). Invariant 4: the four response headers.
 */

let db: Db;
let store: ReturnType<typeof createStore>;
let currentStaff: Staff | null;
let failAudit = false;

class RedirectError extends Error {
  constructor(readonly to: string) { super(`NEXT_REDIRECT:${to}`); }
}

// The REAL requireScope rule (src/lib/auth.ts:57-61): no session ⇒ /login,
// support ⇒ /admin-dashboard/tickets, otherwise staff + scopeOf(staff).
vi.mock('@/lib/auth', () => ({
  requireScope: async () => {
    if (!currentStaff) throw new RedirectError('/login');
    if (currentStaff.role === 'support') throw new RedirectError('/admin-dashboard/tickets');
    return { staff: currentStaff, scope: scopeOf(currentStaff) };
  },
  requireStaff: async () => {
    if (!currentStaff) throw new RedirectError('/login');
    return currentStaff;
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => { throw new RedirectError(p); },
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('@/lib/store', async (orig) => {
  const real = await orig<typeof import('@/lib/store')>();
  return { ...real, getStore: () => store };
});
vi.mock('@/db/repos/aux-repos', async (orig) => {
  const real = await orig<typeof import('@/db/repos/aux-repos')>();
  return {
    ...real,
    createAuditRepo: (dbx: Parameters<typeof real.createAuditRepo>[0]) => {
      const r = real.createAuditRepo(dbx);
      return {
        ...r,
        record: async (e: Parameters<typeof r.record>[0]) => {
          if (failAudit) throw new Error('audit insert failed');
          return r.record(e);
        },
      };
    },
  };
});
// The Sidebar is an async server component (renderToStaticMarkup cannot render
// it) and is not under test — the documents card is.
vi.mock('@/app/admin-dashboard/sidebar', () => ({ Sidebar: () => null }));

const getMock = vi.fn();
vi.mock('@vercel/blob', () => ({
  put: vi.fn(),
  del: vi.fn(),
  get: (...a: unknown[]) => getMock(...a),
}));

import { createPartnerRequestRepo, createPartnerApplicationRepo } from '@/db/repos/aux-repos';
import { GET } from '@/app/admin-dashboard/partner-requests/[id]/documents/[index]/route';
import PartnerApplicationPage from '@/app/admin-dashboard/partner-requests/[id]/page';

const REQ = 'preq_Ab_9-Cd_E-fG0hIjKlMnOp';
const APP = 'papp_Zz_1-Yy_2-Xx3wVuTsRqPo';
const PRIVATE_URL = `https://abc123.private.blob.vercel-storage.com/partner-applications/${REQ}/1-licence-R4nd0m.pdf`;
const LEGACY_PUBLIC_URL = 'https://abc123.public.blob.vercel-storage.com/partner-applications/aaaaaaaa-1-old-R4nd0m.pdf';
const HOSTILE_URL = `https://evil.example/partner-applications/${REQ}/x.pdf`;
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
// A read-write token's shape is `<vendor>_blob_rw_<storeId>_<rest>`; segment 3 is the
// store id. Joined at runtime from plain words: OUR store is abc123, so PRIVATE_URL is on
// our host, and no token-shaped literal exists for a secret scanner to trip on.
const PRIVATE_TOKEN = ['fake', 'blob', 'rw', 'abc123', 'for-tests'].join('_');
// A ref on SOMEONE ELSE's private store: valid shape, our request's prefix, wrong store id.
const FOREIGN_STORE_URL = `https://zzz999.private.blob.vercel-storage.com/partner-applications/${REQ}/1-licence-R4nd0m.pdf`;

function staff(o: Partial<Staff>): Staff {
  return {
    username: 'u', name: 'U', role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'x', createdAt: '2026-01-01T00:00:00Z',
    ...o,
  };
}
const PLATFORM_ADMIN = staff({ username: 'platform.admin' });
const PARTNER_ADMIN = staff({ username: 'acme.admin', partnerId: 'default' });
const PARTNER_AGENT = staff({ username: 'acme.agent', role: 'agent', partnerId: 'default' });
const SUPPORT = staff({ username: 'help.desk', role: 'support' });

function bodyStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) { c.enqueue(bytes); c.close(); },
  });
}
function blobResult(contentType = 'application/pdf') {
  return {
    statusCode: 200 as const,
    stream: bodyStream(PDF_BYTES),
    headers: new Headers(),
    blob: {
      url: PRIVATE_URL, downloadUrl: PRIVATE_URL, pathname: `partner-applications/${REQ}/1-licence-R4nd0m.pdf`,
      contentDisposition: 'inline', cacheControl: 'private', uploadedAt: new Date(), etag: '"x"',
      contentType, size: PDF_BYTES.byteLength,
    },
  };
}

async function auditRows(): Promise<Array<{ actor: string; action: string; subject_id: string | null; meta: Record<string, unknown> | null }>> {
  const res = await db.execute(sql`SELECT actor, action, subject_id, meta FROM audit_events ORDER BY id`);
  return (res as unknown as { rows: Array<{ actor: string; action: string; subject_id: string | null; meta: Record<string, unknown> | null }> }).rows;
}

function get(id: string, index: string): Promise<Response> {
  const req = new NextRequest(`http://localhost/admin-dashboard/partner-requests/${id}/documents/${index}`);
  return GET(req, { params: Promise.resolve({ id, index }) }) as Promise<Response>;
}

async function seed(docs: Array<{ label: string; url: string; size: number; contentType: string }>): Promise<void> {
  await createPartnerRequestRepo(db).savePartnerRequest({
    id: REQ, companyName: 'Acme Remit Inc.', email: 'partners@acme.com', phone: '15551234567',
    corridors: ['US', 'IN'], capturedAt: new Date().toISOString(),
  });
  await createPartnerApplicationRepo(db).saveApplication({
    id: APP, partnerRequestId: REQ,
    details: { legalName: 'Acme Remit Inc.', countryOfIncorporation: 'US', primaryContact: 'Jane' },
    documents: docs,
    submittedAt: new Date().toISOString(),
  });
}

const savedToken = process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN;
beforeEach(async () => {
  db = await freshDb();
  await db.execute(sql`TRUNCATE partner_requests, partner_applications`);
  store = createStore(fakeRedis(), db);
  currentStaff = PLATFORM_ADMIN;
  failAudit = false;
  getMock.mockReset();
  process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN = PRIVATE_TOKEN;
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN;
  else process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN = savedToken;
});

describe('GET …/documents/[index] — platform admin (test 7)', () => {
  it('streams the object with the four headers, after exactly ONE partner_doc.view audit row', async () => {
    await seed([{ label: 'Licence', url: PRIVATE_URL, size: 9, contentType: 'application/pdf' }]);
    let auditRowsWhenGetRan = -1;
    getMock.mockImplementation(async () => {
      auditRowsWhenGetRan = (await auditRows()).length;
      return blobResult();
    });

    const res = await get(REQ, '0');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(res.headers.get('content-disposition')).not.toContain('Licence'); // no client-controlled text
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF_BYTES);

    // get() was called with the LEDGER url (never client input) and the private token.
    expect(getMock).toHaveBeenCalledTimes(1);
    const [url, opts] = getMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe(PRIVATE_URL);
    expect(opts.access).toBe('private');
    expect(opts.token).toBe(PRIVATE_TOKEN);

    // The audit row existed BEFORE get() ran, and there is exactly one.
    expect(auditRowsWhenGetRan).toBe(1);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'platform.admin', action: 'partner_doc.view', subject_id: APP });
    expect(rows[0].meta).toMatchObject({ requestId: REQ, index: 0 });
    expect(JSON.stringify(rows[0].meta)).not.toContain('blob.vercel-storage.com'); // no URL in the audit row
  });

  it('serves an unexpected stored content type as application/octet-stream (still attachment + nosniff)', async () => {
    await seed([{ label: 'Licence', url: PRIVATE_URL, size: 9, contentType: 'application/pdf' }]);
    getMock.mockResolvedValue(blobResult('text/html'));
    const res = await get(REQ, '0');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('a private object the store no longer has → 404 (the attempt is still audited)', async () => {
    await seed([{ label: 'Licence', url: PRIVATE_URL, size: 9, contentType: 'application/pdf' }]);
    getMock.mockResolvedValue(null);
    const res = await get(REQ, '0');
    expect(res.status).toBe(404);
    expect(await auditRows()).toHaveLength(1);
  });
});

describe('GET …/documents/[index] — refusals (test 8)', () => {
  it('a partner-scoped admin gets 404 and NO audit row; get never called', async () => {
    await seed([{ label: 'Licence', url: PRIVATE_URL, size: 9, contentType: 'application/pdf' }]);
    currentStaff = PARTNER_ADMIN;
    const res = await get(REQ, '0');
    expect(res.status).toBe(404);
    expect(await auditRows()).toHaveLength(0);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('a partner-scoped agent gets 404 and NO audit row', async () => {
    await seed([{ label: 'Licence', url: PRIVATE_URL, size: 9, contentType: 'application/pdf' }]);
    currentStaff = PARTNER_AGENT;
    const res = await get(REQ, '0');
    expect(res.status).toBe(404);
    expect(await auditRows()).toHaveLength(0);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('a support role is redirected by requireScope (the throw propagates); nothing audited', async () => {
    await seed([{ label: 'Licence', url: PRIVATE_URL, size: 9, contentType: 'application/pdf' }]);
    currentStaff = SUPPORT;
    await expect(get(REQ, '0')).rejects.toThrow('NEXT_REDIRECT:/admin-dashboard/tickets');
    expect(await auditRows()).toHaveLength(0);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('no session → the /login redirect propagates', async () => {
    currentStaff = null;
    await expect(get(REQ, '0')).rejects.toThrow('NEXT_REDIRECT:/login');
  });

  it('an out-of-range or non-canonical index → 404, no audit row', async () => {
    await seed([{ label: 'Licence', url: PRIVATE_URL, size: 9, contentType: 'application/pdf' }]);
    for (const index of ['1', '-1', 'abc', '0.0', '01', '', '1e0', ' 0']) {
      const res = await get(REQ, index);
      expect(res.status, `index=${JSON.stringify(index)}`).toBe(404);
    }
    expect(await auditRows()).toHaveLength(0);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('an unknown request, or a request with no application → 404', async () => {
    expect((await get('preq_nope', '0')).status).toBe(404);
    await createPartnerRequestRepo(db).savePartnerRequest({
      id: REQ, companyName: 'Acme', email: 'a@acme.com', phone: '1', corridors: [], capturedAt: new Date().toISOString(),
    });
    expect((await get(REQ, '0')).status).toBe(404);
    expect(await auditRows()).toHaveLength(0);
  });

  it('a legacy PUBLIC-host ref → 404, get never called (no proxying of the old store)', async () => {
    await seed([{ label: 'Old licence', url: LEGACY_PUBLIC_URL, size: 9, contentType: 'application/pdf' }]);
    const res = await get(REQ, '0');
    expect(res.status).toBe(404);
    expect(getMock).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it('a ref that is not bound to this request (hostile host, or another request\'s prefix) → 404, get never called', async () => {
    await seed([
      { label: 'evil', url: HOSTILE_URL, size: 9, contentType: 'application/pdf' },
      { label: 'other', url: 'https://abc123.private.blob.vercel-storage.com/partner-applications/preq_other/x.pdf', size: 9, contentType: 'application/pdf' },
    ]);
    expect((await get(REQ, '0')).status).toBe(404);
    expect((await get(REQ, '1')).status).toBe(404);
    expect(getMock).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it('a ref on a DIFFERENT private store (not the one our token opens) → 404, get never called, no audit row', async () => {
    await seed([{ label: 'Licence', url: FOREIGN_STORE_URL, size: 9, contentType: 'application/pdf' }]);
    const res = await get(REQ, '0');
    expect(res.status).toBe(404);
    expect(getMock).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it('an audit-write failure → 500 and get is never called', async () => {
    await seed([{ label: 'Licence', url: PRIVATE_URL, size: 9, contentType: 'application/pdf' }]);
    failAudit = true;
    const res = await get(REQ, '0');
    expect(res.status).toBe(500);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('SF2: private token SET but not of the <vendor>_blob_rw_<storeId>_… shape → 503 (not a silent 404), no audit row, get never called', async () => {
    await seed([{ label: 'Licence', url: PRIVATE_URL, size: 9, contentType: 'application/pdf' }]);
    process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN = 'nonsense';
    const res = await get(REQ, '0');
    expect(res.status).toBe(503);
    expect(getMock).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it('SF3: a store read failure → 502, and the error log carries the error NAME only — never the object URL', async () => {
    await seed([{ label: 'Licence', url: PRIVATE_URL, size: 9, contentType: 'application/pdf' }]);
    class BlobError extends Error { constructor(m: string) { super(m); this.name = 'BlobError'; } }
    getMock.mockRejectedValue(new BlobError(`Failed to fetch blob: 403 Forbidden ${PRIVATE_URL}`));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await get(REQ, '0');
      expect(res.status).toBe(502);
      const logged = spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      expect(logged).toContain('BlobError');
      expect(logged).not.toContain('blob.vercel-storage.com');
      expect(logged).not.toContain('Forbidden');
    } finally {
      spy.mockRestore();
    }
  });

  it('private token unset → 503, get never called (no fallback to the public store)', async () => {
    await seed([{ label: 'Licence', url: PRIVATE_URL, size: 9, contentType: 'application/pdf' }]);
    delete process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN;
    process.env.BLOB_READ_WRITE_TOKEN = ['fake', 'blob', 'rw', 'pubstore', 'for-tests'].join('_');
    try {
      const res = await get(REQ, '0');
      expect(res.status).toBe(503);
      expect(getMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.BLOB_READ_WRITE_TOKEN;
    }
  });
});

describe('partner-requests/[id] page — documents link through the audited route (test 9)', () => {
  it('renders /admin-dashboard/partner-requests/<id>/documents/<i> and never the Blob URL', async () => {
    await seed([
      { label: 'Licence', url: PRIVATE_URL, size: 9, contentType: 'application/pdf' },
      { label: 'AML policy', url: `https://abc123.private.blob.vercel-storage.com/partner-applications/${REQ}/2-aml-R4nd0m.pdf`, size: 9, contentType: 'application/pdf' },
    ]);
    const html = renderToStaticMarkup(await PartnerApplicationPage({ params: Promise.resolve({ id: REQ }) }));
    expect(html).toContain(`/admin-dashboard/partner-requests/${REQ}/documents/0`);
    expect(html).toContain(`/admin-dashboard/partner-requests/${REQ}/documents/1`);
    expect(html).toContain('Licence');
    expect(html).not.toContain('blob.vercel-storage.com');
  });
});
