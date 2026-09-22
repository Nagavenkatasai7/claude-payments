import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { fakeRedis } from './helpers';
import { hashApplicationToken } from '@/lib/partner-application-token';
import type { PartnerRequest } from '@/lib/types';

/**
 * Program-Fix 24 — partner licence / KYB / AML documents live in a PRIVATE Blob
 * store (brief §4 tests 1–5). The pure helpers in src/lib/blob.ts and the
 * public upload route are exercised with `@vercel/blob` mocked: a local run
 * never has the private token by design.
 */

const putMock = vi.fn();
const getMock = vi.fn();
const delMock = vi.fn();
vi.mock('@vercel/blob', () => ({
  put: (...a: unknown[]) => putMock(...a),
  get: (...a: unknown[]) => getMock(...a),
  del: (...a: unknown[]) => delMock(...a),
}));

const redis = fakeRedis();
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));

const LIVE_TOKEN = 'a'.repeat(64);
const REQUEST_ID = 'preq_Ab_9-Cd_E-fG0hIjKlMnOp';
const liveRequest: PartnerRequest = {
  id: REQUEST_ID,
  companyName: 'Acme Remit Inc.',
  email: 'partners@acme.com',
  phone: '+1 555 123 4567',
  corridors: ['US', 'IN'],
  capturedAt: new Date().toISOString(),
  applicationStatus: 'invited',
  tokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};
vi.mock('@/lib/store', () => ({
  getStore: () => ({
    getPartnerRequestByTokenHash: async (hash: string) =>
      hash === hashApplicationToken(LIVE_TOKEN) ? liveRequest : null,
  }),
}));

import { uploadPartnerDoc, sniffDocType, isPrivatePartnerDocRef } from '@/lib/blob';
import { POST as uploadPOST } from '@/app/api/partner-application/upload/route';

const PRIVATE_TOKEN = 'vercel_blob_rw_privstore_testtoken';
const PUBLIC_TOKEN = 'vercel_blob_rw_pubstore_testtoken';
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]); // %PDF-1.4
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv.priv = process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN;
  savedEnv.pub = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  putMock.mockReset();
  getMock.mockReset();
  delMock.mockReset();
  redis.dump.clear();
});
afterEach(() => {
  if (savedEnv.priv === undefined) delete process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN;
  else process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN = savedEnv.priv;
  if (savedEnv.pub === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = savedEnv.pub;
});

/** Every .ts/.tsx under a root, recursively (the source scan for test 1). */
function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(p);
  }
  return out;
}

describe('uploadPartnerDoc — private put (test 1)', () => {
  it("calls put with access 'private' and the private-store token, never 'public'", async () => {
    process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN = PRIVATE_TOKEN;
    process.env.BLOB_READ_WRITE_TOKEN = PUBLIC_TOKEN;
    putMock.mockResolvedValue({
      url: `https://abc123.private.blob.vercel-storage.com/partner-applications/${REQUEST_ID}/1-x-R4nd0m.pdf`,
      pathname: `partner-applications/${REQUEST_ID}/1-x-R4nd0m.pdf`,
      contentType: 'application/pdf',
    });
    const file = new Blob([PDF_BYTES], { type: 'application/pdf' });
    const doc = await uploadPartnerDoc(file, `partner-applications/${REQUEST_ID}/1-x.pdf`, 'application/pdf');

    expect(putMock).toHaveBeenCalledTimes(1);
    const [pathname, body, opts] = putMock.mock.calls[0] as [string, Blob, Record<string, unknown>];
    expect(pathname).toBe(`partner-applications/${REQUEST_ID}/1-x.pdf`);
    expect(body).toBe(file);
    expect(opts.access).toBe('private');
    expect(opts.token).toBe(PRIVATE_TOKEN);
    expect(opts.token).not.toBe(PUBLIC_TOKEN);
    expect(opts.addRandomSuffix).toBe(true);
    expect(opts.contentType).toBe('application/pdf');
    expect(doc.url).toContain('.private.blob.vercel-storage.com/');
    expect(doc.pathname).toBe(`partner-applications/${REQUEST_ID}/1-x-R4nd0m.pdf`);
    expect(doc.contentType).toBe('application/pdf');
    expect(doc.size).toBe(file.size);
  });

  it("source scan: no `access: 'public'` anywhere under src/ or scripts/", () => {
    const offenders = [...walk(path.resolve('src')), ...walk(path.resolve('scripts'))].filter((f) =>
      /access:\s*['"]public['"]/.test(fs.readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('uploadPartnerDoc — unconfigured (test 2)', () => {
  it('throws "not configured" when only the PUBLIC store token is set — no fallback', async () => {
    process.env.BLOB_READ_WRITE_TOKEN = PUBLIC_TOKEN; // the old public store is still connected
    const file = new Blob([PDF_BYTES], { type: 'application/pdf' });
    await expect(
      uploadPartnerDoc(file, `partner-applications/${REQUEST_ID}/1-x.pdf`, 'application/pdf'),
    ).rejects.toThrow(/not configured/i);
    expect(putMock).not.toHaveBeenCalled();
  });
});

describe('sniffDocType (test 3)', () => {
  it('recognises the three allowed signatures and nothing else', () => {
    expect(sniffDocType(PDF_BYTES)).toBe('application/pdf');
    expect(sniffDocType(PNG_BYTES)).toBe('image/png');
    expect(sniffDocType(JPEG_BYTES)).toBe('image/jpeg');
    expect(sniffDocType(new TextEncoder().encode('<!DOCTYPE html><html>'))).toBeNull();
    expect(sniffDocType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
    expect(sniffDocType(new Uint8Array())).toBeNull();
    // A truncated signature is not a match.
    expect(sniffDocType(new Uint8Array([0x89, 0x50, 0x4e]))).toBeNull();
    expect(sniffDocType(new Uint8Array([0x25, 0x50, 0x44]))).toBeNull();
  });
});

describe('isPrivatePartnerDocRef (test 5)', () => {
  const good = `https://abc123.private.blob.vercel-storage.com/partner-applications/${REQUEST_ID}/x.pdf`;
  it('accepts a private-store https URL under this request\'s prefix', () => {
    expect(isPrivatePartnerDocRef(good, REQUEST_ID)).toBe(true);
    expect(
      isPrivatePartnerDocRef(
        `https://abc123.private.blob.vercel-storage.com/partner-applications/${REQUEST_ID}/1-doc-R4nd0mSuffix.pdf`,
        REQUEST_ID,
      ),
    ).toBe(true);
  });
  it('rejects every hostile form', () => {
    const cases: string[] = [
      // the PUBLIC store — never a valid ref any more
      `https://abc123.public.blob.vercel-storage.com/partner-applications/${REQUEST_ID}/x.pdf`,
      // another request's prefix
      'https://abc123.private.blob.vercel-storage.com/partner-applications/preq_other/x.pdf',
      // prefix with no trailing separator (preq_X vs preq_XY)
      `https://abc123.private.blob.vercel-storage.com/partner-applications/${REQUEST_ID}Z/x.pdf`,
      // traversal that would normalise into another prefix
      `https://abc123.private.blob.vercel-storage.com/partner-applications/${REQUEST_ID}/../preq_other/x.pdf`,
      // host in the query (substring bypass)
      'https://evil.com/?x=private.blob.vercel-storage.com',
      // suffix-domain bypass
      `https://abc123.private.blob.vercel-storage.com.evil.com/partner-applications/${REQUEST_ID}/x.pdf`,
      // userinfo bypass
      `https://abc123.private.blob.vercel-storage.com@evil.com/partner-applications/${REQUEST_ID}/x.pdf`,
      // plain http
      `http://abc123.private.blob.vercel-storage.com/partner-applications/${REQUEST_ID}/x.pdf`,
      // no store id / bare host
      `https://private.blob.vercel-storage.com/partner-applications/${REQUEST_ID}/x.pdf`,
      // a store id with a dot (would be a different label)
      `https://abc.def.private.blob.vercel-storage.com/partner-applications/${REQUEST_ID}/x.pdf`,
      // not a URL at all
      'not a url',
      '',
    ];
    for (const c of cases) expect(isPrivatePartnerDocRef(c, REQUEST_ID), c).toBe(false);
    // an empty / malformed request id never binds anything
    expect(isPrivatePartnerDocRef(good, '')).toBe(false);
    expect(isPrivatePartnerDocRef(good, 'preq/..')).toBe(false);
  });
});

describe('POST /api/partner-application/upload — sniff + request-scoped pathname (test 4)', () => {
  function upload(bytes: Uint8Array, declaredType: string, name = 'licence.pdf'): Promise<Response> {
    const fd = new FormData();
    fd.set('file', new File([Uint8Array.from(bytes)], name, { type: declaredType }));
    fd.set('label', 'Money-transmitter licence');
    const req = new NextRequest(
      `http://localhost/api/partner-application/upload?token=${LIVE_TOKEN}`,
      { method: 'POST', body: fd },
    );
    return uploadPOST(req) as Promise<Response>;
  }

  it('a file declared application/pdf whose bytes are PNG → 400, put never called', async () => {
    process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN = PRIVATE_TOKEN;
    const res = await upload(PNG_BYTES, 'application/pdf');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/unsupported file type/i) });
    expect(putMock).not.toHaveBeenCalled();
  });

  it('HTML bytes declared image/png → 400, put never called', async () => {
    process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN = PRIVATE_TOKEN;
    const res = await upload(new TextEncoder().encode('<!DOCTYPE html><script>1</script>'), 'image/png', 'x.png');
    expect(res.status).toBe(400);
    expect(putMock).not.toHaveBeenCalled();
  });

  it('a good PDF → pathname under partner-applications/<requestId>/, no token characters, sniffed type stored', async () => {
    process.env.PARTNER_DOCS_BLOB_READ_WRITE_TOKEN = PRIVATE_TOKEN;
    putMock.mockImplementation(async (pathname: string) => ({
      url: `https://abc123.private.blob.vercel-storage.com/${pathname.replace(/\.pdf$/, '-R4nd0m.pdf')}`,
      pathname: pathname.replace(/\.pdf$/, '-R4nd0m.pdf'),
      contentType: 'application/pdf',
    }));
    const res = await upload(PDF_BYTES, 'application/pdf', 'my licence (2026).pdf');
    expect(res.status).toBe(200);
    expect(putMock).toHaveBeenCalledTimes(1);
    const [pathname, , opts] = putMock.mock.calls[0] as [string, Blob, Record<string, unknown>];
    expect(pathname.startsWith(`partner-applications/${REQUEST_ID}/`)).toBe(true);
    expect(pathname).not.toContain(LIVE_TOKEN.slice(0, 8)); // 'aaaaaaaa' — the old token prefix
    expect(pathname.endsWith('my_licence__2026_.pdf')).toBe(true);
    expect(opts.access).toBe('private');
    expect(opts.contentType).toBe('application/pdf');
    const body = (await res.json()) as { ok: boolean; doc: { url: string; contentType: string; size: number; label: string } };
    expect(body.ok).toBe(true);
    expect(body.doc.url).toContain(`.private.blob.vercel-storage.com/partner-applications/${REQUEST_ID}/`);
    expect(body.doc.contentType).toBe('application/pdf');
    expect(body.doc.size).toBe(PDF_BYTES.byteLength);
    expect(body.doc.label).toBe('Money-transmitter licence');
  });

  it('private token unset → 503 "not enabled", even with the public token set; put never called', async () => {
    process.env.BLOB_READ_WRITE_TOKEN = PUBLIC_TOKEN;
    const res = await upload(PDF_BYTES, 'application/pdf');
    expect(res.status).toBe(503);
    expect(putMock).not.toHaveBeenCalled();
  });
});
