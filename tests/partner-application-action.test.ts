import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import { hashApplicationToken } from '@/lib/partner-application-token';

/**
 * U2 — the public, token-gated detailed partner application submit action.
 *
 * submitPartnerApplicationAction re-validates the URL token (hash → lookup → not
 * expired → not completed), persists a partner_applications row AND flips the
 * partner_requests row to 'completed' in ONE transaction, then redirect()s
 * (which throws by design). We stub the four side-channel seams — getDb (→
 * PGlite), getRedis (→ fakeRedis), next/headers, next/navigation — and assert on
 * a real in-process Postgres.
 *
 * The security surface under test: only a LIVE token writes anything; a missing /
 * expired / completed token must redirect to the page (which shows the friendly
 * status) and persist nothing.
 */

let db: Db;
const redis = fakeRedis();

const redirectMock = vi.fn((p: string): never => {
  throw new Error(`REDIRECT:${p}`);
});

vi.mock('next/navigation', () => ({ redirect: (p: string) => redirectMock(p) }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.7' }),
}));
vi.mock('@/db/client', async (orig) => ({
  ...((await orig()) as object),
  getDb: () => db,
}));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));

import { submitPartnerApplicationAction } from '@/app/partners/apply/[token]/actions';

const LIVE_TOKEN = 'a'.repeat(64);
const EXPIRED_TOKEN = 'b'.repeat(64);
const COMPLETED_TOKEN = 'c'.repeat(64);
const UNKNOWN_TOKEN = 'd'.repeat(64);

function form(fields: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => f.append(k, x));
    else f.set(k, v);
  }
  return f;
}

const VALID_DETAILS = {
  legalName: 'Acme Remit Inc.',
  countryOfIncorporation: 'United States',
  primaryContact: 'Jane Doe jane@acme.com',
  tradingName: 'Acme Money',
  amlProgram: 'Full risk-based AML program.',
  corridors: 'US→IN',
};

async function seedRequest(opts: {
  token: string;
  status?: string;
  expiresAt?: Date;
  id: string;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO partner_requests
      (id, company_name, email, phone, corridors, captured_at,
       application_token_hash, token_expires_at, application_status)
    VALUES
      (${opts.id}, 'Acme Remit Inc.', 'partners@acme.com', '+1 555 123 4567',
       ${JSON.stringify(['US', 'IN'])}::jsonb, now(),
       ${hashApplicationToken(opts.token)},
       ${(opts.expiresAt ?? new Date(Date.now() + 86_400_000)).toISOString()},
       ${opts.status ?? 'invited'})
  `);
}

interface AppRow {
  id: string;
  partner_request_id: string;
  details: Record<string, unknown>;
  documents: unknown[];
}

async function applicationRows(): Promise<AppRow[]> {
  const res = await db.execute(
    sql`SELECT id, partner_request_id, details, documents FROM partner_applications ORDER BY submitted_at`,
  );
  return (res as unknown as { rows: AppRow[] }).rows;
}

async function requestStatus(id: string): Promise<string | undefined> {
  const res = await db.execute(
    sql`SELECT application_status FROM partner_requests WHERE id = ${id}`,
  );
  return (res as unknown as { rows: { application_status: string }[] }).rows[0]?.application_status;
}

beforeEach(async () => {
  db = await freshDb();
  // freshDb's TRUNCATE list predates these tables — clear them ourselves.
  await db.execute(sql`TRUNCATE partner_requests, partner_applications RESTART IDENTITY CASCADE`);
  redis.dump.clear();
  redirectMock.mockClear();
});

describe('submitPartnerApplicationAction', () => {
  it('valid live token → saves application + flips request to completed, then redirects', async () => {
    await seedRequest({ token: LIVE_TOKEN, id: 'preq_live' });

    await expect(
      submitPartnerApplicationAction(form({ token: LIVE_TOKEN, ...VALID_DETAILS, documents: '[]' })),
    ).rejects.toThrow(`REDIRECT:/partners/apply/${LIVE_TOKEN}`);

    const apps = await applicationRows();
    expect(apps).toHaveLength(1);
    expect(apps[0].id).toMatch(/^papp_/);
    expect(apps[0].partner_request_id).toBe('preq_live');
    expect(apps[0].details.legalName).toBe('Acme Remit Inc.');
    expect(apps[0].details.countryOfIncorporation).toBe('United States');
    expect(apps[0].details.corridors).toBe('US→IN');
    expect(apps[0].documents).toEqual([]);

    expect(await requestStatus('preq_live')).toBe('completed');
  });

  it('stores only Vercel-Blob-hosted document refs and rejects host-spoof bypasses', async () => {
    await seedRequest({ token: LIVE_TOKEN, id: 'preq_docs' });

    const docs = JSON.stringify([
      // Accepted: genuine Vercel Blob host.
      {
        label: 'Money-transmitter license',
        url: 'https://abc.public.blob.vercel-storage.com/partner-applications/x.pdf',
        size: 1234,
        contentType: 'application/pdf',
      },
      // Rejected: unrelated host.
      { label: 'evil1', url: 'https://evil.example/x.pdf', size: 9, contentType: 'application/pdf' },
      // Rejected: host string in the QUERY (substring-match bypass).
      {
        label: 'evil2',
        url: 'https://evil.com/x?a=blob.vercel-storage.com',
        size: 9,
        contentType: 'application/pdf',
      },
      // Rejected: suffix-domain bypass.
      {
        label: 'evil3',
        url: 'https://blob.vercel-storage.com.evil.com/x',
        size: 9,
        contentType: 'application/pdf',
      },
      // Rejected: userinfo bypass.
      {
        label: 'evil4',
        url: 'https://public.blob.vercel-storage.com@evil.com/x',
        size: 9,
        contentType: 'application/pdf',
      },
    ]);

    await expect(
      submitPartnerApplicationAction(form({ token: LIVE_TOKEN, ...VALID_DETAILS, documents: docs })),
    ).rejects.toThrow(`REDIRECT:/partners/apply/${LIVE_TOKEN}`);

    const apps = await applicationRows();
    expect(apps[0].documents).toHaveLength(1);
    expect((apps[0].documents[0] as { url: string }).url).toContain(
      '.public.blob.vercel-storage.com',
    );
  });

  it('missing required field → ?error=missing and persists nothing', async () => {
    await seedRequest({ token: LIVE_TOKEN, id: 'preq_req' });

    await expect(
      submitPartnerApplicationAction(
        form({ token: LIVE_TOKEN, countryOfIncorporation: 'US', primaryContact: 'x', documents: '[]' }),
      ),
    ).rejects.toThrow(`REDIRECT:/partners/apply/${LIVE_TOKEN}?error=missing`);

    expect(await applicationRows()).toHaveLength(0);
    expect(await requestStatus('preq_req')).toBe('invited'); // NOT flipped
  });

  it('expired token → redirects to the page, persists nothing', async () => {
    await seedRequest({
      token: EXPIRED_TOKEN,
      id: 'preq_exp',
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(
      submitPartnerApplicationAction(form({ token: EXPIRED_TOKEN, ...VALID_DETAILS, documents: '[]' })),
    ).rejects.toThrow(`REDIRECT:/partners/apply/${EXPIRED_TOKEN}`);

    expect(await applicationRows()).toHaveLength(0);
    expect(await requestStatus('preq_exp')).toBe('invited');
  });

  it('already-completed token → redirects, persists nothing (single-use)', async () => {
    await seedRequest({ token: COMPLETED_TOKEN, id: 'preq_done', status: 'completed' });

    await expect(
      submitPartnerApplicationAction(
        form({ token: COMPLETED_TOKEN, ...VALID_DETAILS, documents: '[]' }),
      ),
    ).rejects.toThrow(`REDIRECT:/partners/apply/${COMPLETED_TOKEN}`);

    expect(await applicationRows()).toHaveLength(0);
  });

  it('unknown token → redirects, persists nothing', async () => {
    await expect(
      submitPartnerApplicationAction(form({ token: UNKNOWN_TOKEN, ...VALID_DETAILS, documents: '[]' })),
    ).rejects.toThrow(`REDIRECT:/partners/apply/${UNKNOWN_TOKEN}`);

    expect(await applicationRows()).toHaveLength(0);
  });

  it('empty token → redirects to / and persists nothing', async () => {
    await expect(
      submitPartnerApplicationAction(form({ token: '', ...VALID_DETAILS, documents: '[]' })),
    ).rejects.toThrow('REDIRECT:/');

    expect(await applicationRows()).toHaveLength(0);
  });

  it('rate-limits after 10 submissions in the window (11th → ?error=rate)', async () => {
    // Each successful submit flips its own request to completed; use fresh
    // requests/tokens so only the rate limit (not single-use) stops us.
    for (let i = 0; i < 10; i++) {
      const tok = `e${i}`.padEnd(64, '0');
      await seedRequest({ token: tok, id: `preq_rl_${i}` });
      await expect(
        submitPartnerApplicationAction(form({ token: tok, ...VALID_DETAILS, documents: '[]' })),
      ).rejects.toThrow(`REDIRECT:/partners/apply/${tok}`);
    }
    const tok11 = 'f'.repeat(64);
    await seedRequest({ token: tok11, id: 'preq_rl_11' });
    await expect(
      submitPartnerApplicationAction(form({ token: tok11, ...VALID_DETAILS, documents: '[]' })),
    ).rejects.toThrow(`REDIRECT:/partners/apply/${tok11}?error=rate`);

    expect(await applicationRows()).toHaveLength(10);
  });
});
