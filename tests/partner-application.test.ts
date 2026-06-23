import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { createPartnerRequestRepo, createPartnerApplicationRepo } from '@/db/repos/aux-repos';
import {
  issueApplicationToken,
  hashApplicationToken,
  isApplicationTokenExpired,
} from '@/lib/partner-application-token';
import { uploadPartnerDoc } from '@/lib/blob';
import type { Db } from '@/db/client';

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  // freshDb's TRUNCATE list predates these tables — clear them so tests isolate.
  await db.execute(sql`TRUNCATE partner_requests, partner_applications`);
});

describe('partner-application token helper', () => {
  it('issues a 64-hex token, its sha256 hash (stored, not the token), and a 30-day expiry', () => {
    const now = new Date('2026-06-23T00:00:00.000Z');
    const { token, hash, expiresAt } = issueApplicationToken(now);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashApplicationToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);
    expect(Date.parse(expiresAt) - now.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('isApplicationTokenExpired: missing/past ⇒ true, future ⇒ false', () => {
    const now = new Date('2026-06-23T00:00:00.000Z');
    expect(isApplicationTokenExpired(undefined, now)).toBe(true);
    expect(isApplicationTokenExpired('2026-06-22T00:00:00.000Z', now)).toBe(true);
    expect(isApplicationTokenExpired('2026-07-22T00:00:00.000Z', now)).toBe(false);
  });
});

describe('partner-request application extensions (PGlite)', () => {
  const seed = async () => {
    const repo = createPartnerRequestRepo(db);
    await repo.savePartnerRequest({
      id: 'preq_x', companyName: 'Acme', email: 'a@acme.com', phone: '15551112222',
      corridors: ['US'], capturedAt: '2026-06-20T10:00:00.000Z',
    });
    return repo;
  };

  it('stores the token hash + expiry; getByTokenHash resolves it; status starts invited', async () => {
    const repo = await seed();
    const { token, hash, expiresAt } = issueApplicationToken();
    await repo.setApplicationToken('preq_x', hash, expiresAt);
    const got = await repo.getByTokenHash(hashApplicationToken(token));
    expect(got?.id).toBe('preq_x');
    expect(got?.applicationStatus).toBe('invited');
    expect(got?.tokenExpiresAt).toBe(new Date(expiresAt).toISOString());
    expect(await repo.getByTokenHash('deadbeef')).toBeNull(); // unknown hash
  });

  it('markApplicationCompleted flips status (single-use kill)', async () => {
    const repo = await seed();
    const { hash, expiresAt } = issueApplicationToken();
    await repo.setApplicationToken('preq_x', hash, expiresAt);
    await repo.markApplicationCompleted('preq_x');
    expect((await repo.getByTokenHash(hash))?.applicationStatus).toBe('completed');
  });
});

describe('partner-application repo (PGlite)', () => {
  it('saves + reads the detailed application by request id, round-tripping details + documents', async () => {
    const repo = createPartnerApplicationRepo(db);
    await repo.saveApplication({
      id: 'papp_1', partnerRequestId: 'preq_x',
      details: { legalName: 'Acme Remit LLC', countryOfIncorporation: 'US', expectedMonthlyVolumeUsd: '500000' },
      documents: [{ label: 'License', url: 'https://blob/x', size: 1234, contentType: 'application/pdf' }],
      submittedAt: '2026-06-22T12:00:00.000Z',
    });
    const got = await repo.getByRequestId('preq_x');
    expect(got?.id).toBe('papp_1');
    expect(got?.details.legalName).toBe('Acme Remit LLC');
    expect(got?.documents[0].url).toBe('https://blob/x');
    expect(await repo.getByRequestId('nope')).toBeNull();
    expect((await repo.listApplications())).toHaveLength(1);
  });
});

describe('uploadPartnerDoc — friendly error when unconfigured', () => {
  it('throws a clear "not configured" error (not a generic crash) when BLOB_READ_WRITE_TOKEN is unset', async () => {
    const file = new Blob(['hello'], { type: 'application/pdf' });
    await expect(uploadPartnerDoc(file, 'test.pdf')).rejects.toThrow(/not configured/i);
  });
});
