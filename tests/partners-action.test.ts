import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';

/**
 * U1 — the public "Partner with us" lead form server action.
 *
 * submitPartnerRequestAction persists the lead AND enqueues an 'email.send'
 * outbox row in ONE transaction, then redirect()s (which throws by design). We
 * stub the four side-channel seams the action pulls — getDb (→ PGlite), getRedis
 * (→ fakeRedis), next/headers, next/navigation, pokeWorker — and assert the
 * persisted row + the deduped email effect on a real in-process Postgres.
 *
 * redirect() throws, so every call is wrapped in expect(...).rejects to capture
 * the destination (`?partner=ok|err|rate`) while still letting the transaction
 * commit beforehand.
 */

let db: Db;
const redis = fakeRedis();
const pokeWorkerMock = vi.fn();

// next/navigation.redirect throws a tagged error so the caller halts — we mirror
// that so the action's control flow (and our assertions on the destination) hold.
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
vi.mock('@/lib/outbox', () => ({ pokeWorker: () => pokeWorkerMock() }));

import { submitPartnerRequestAction } from '@/app/partners-action';

function form(fields: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => f.append(k, x));
    else f.set(k, v);
  }
  return f;
}

async function partnerRequestRows(): Promise<
  {
    id: string;
    companyName: string;
    email: string;
    corridors: string[];
    applicationTokenHash: string | null;
  }[]
> {
  const res = await db.execute(
    sql`SELECT id, company_name, email, corridors, application_token_hash FROM partner_requests ORDER BY captured_at`,
  );
  return (
    res as unknown as {
      rows: {
        id: string;
        company_name: string;
        email: string;
        corridors: string[];
        application_token_hash: string | null;
      }[];
    }
  ).rows.map((r) => ({
    id: r.id,
    companyName: r.company_name,
    email: r.email,
    corridors: r.corridors,
    applicationTokenHash: r.application_token_hash,
  }));
}

async function emailOutboxRows(): Promise<
  { dedupeKey: string; payload: { to: string[]; subject: string; text: string } }[]
> {
  const res = await db.execute(
    sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'email.send' ORDER BY id`,
  );
  return (
    res as unknown as {
      rows: { dedupe_key: string; payload: { to: string[]; subject: string; text: string } }[];
    }
  ).rows.map((r) => ({ dedupeKey: r.dedupe_key, payload: r.payload }));
}

const VALID = {
  company_name: 'Acme Remit Inc.',
  email: 'partners@acme.com',
  phone: '+1 555 123 4567',
  comments: 'We move ~$2M/mo US→IN.',
  corridors: ['US', 'IN'],
};

beforeEach(async () => {
  db = await freshDb();
  // freshDb()'s TRUNCATE list predates partner_requests — clear it ourselves so
  // leads don't bleed across tests.
  await db.execute(sql`TRUNCATE partner_requests RESTART IDENTITY CASCADE`);
  redis.dump.clear(); // reset the per-IP rate-limit counter between tests
  redirectMock.mockClear();
  pokeWorkerMock.mockClear();
});

describe('submitPartnerRequestAction', () => {
  it('persists the lead (with an application token hash) + enqueues team + partner emails, then redirects ok', async () => {
    await expect(submitPartnerRequestAction(form(VALID))).rejects.toThrow(
      'REDIRECT:/?partner=ok#partner-with-us',
    );

    const rows = await partnerRequestRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].companyName).toBe('Acme Remit Inc.');
    expect(rows[0].email).toBe('partners@acme.com');
    expect(rows[0].corridors).toEqual(['US', 'IN']);
    expect(rows[0].id).toMatch(/^preq_/);
    // The application-invite token's HASH is stored on the row (raw token only in
    // the emailed link). 32-byte token → sha256 → 64 hex chars.
    expect(rows[0].applicationTokenHash).toMatch(/^[0-9a-f]{64}$/);

    const emails = await emailOutboxRows();
    expect(emails).toHaveLength(2);

    // (1) team notification — to the internal lead list.
    const team = emails.find((e) => e.dedupeKey === `preq:${rows[0].id}`);
    expect(team).toBeDefined();
    expect(team!.payload.subject).toBe('New partner request: Acme Remit Inc.');
    expect(team!.payload.to.length).toBeGreaterThan(0);
    expect(team!.payload.text).toContain('Corridors: US, IN');

    // (2) partner invite — to the partner's submitted email, with the apply link.
    const invite = emails.find((e) => e.dedupeKey === `partner_app_invite:${rows[0].id}`);
    expect(invite).toBeDefined();
    expect(invite!.payload.subject).toBe('Complete your SmartRemit partner application');
    expect(invite!.payload.to).toEqual(['partners@acme.com']);
    expect(invite!.payload.text).toContain('/partners/apply/');

    expect(pokeWorkerMock).toHaveBeenCalledTimes(1);
  });

  it('filters corridors to the allow-list (drops bogus values)', async () => {
    await expect(
      submitPartnerRequestAction(form({ ...VALID, corridors: ['US', 'XX', 'Other'] })),
    ).rejects.toThrow('REDIRECT:/?partner=ok#partner-with-us');

    const rows = await partnerRequestRows();
    expect(rows[0].corridors).toEqual(['US', 'Other']);
  });

  it('honeypot: a filled "website" field is dropped silently (no row, looks ok)', async () => {
    await expect(
      submitPartnerRequestAction(form({ ...VALID, website: 'http://spam.example' })),
    ).rejects.toThrow('REDIRECT:/?partner=ok#partner-with-us');

    expect(await partnerRequestRows()).toHaveLength(0);
    expect(await emailOutboxRows()).toHaveLength(0);
    expect(pokeWorkerMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid email with ?partner=err and persists nothing', async () => {
    await expect(
      submitPartnerRequestAction(form({ ...VALID, email: 'not-an-email' })),
    ).rejects.toThrow('REDIRECT:/?partner=err#partner-with-us');
    expect(await partnerRequestRows()).toHaveLength(0);
  });

  it('rejects when no corridor is selected', async () => {
    await expect(
      submitPartnerRequestAction(form({ ...VALID, corridors: [] })),
    ).rejects.toThrow('REDIRECT:/?partner=err#partner-with-us');
    expect(await partnerRequestRows()).toHaveLength(0);
  });

  it('rejects a too-short company name', async () => {
    await expect(
      submitPartnerRequestAction(form({ ...VALID, company_name: 'A' })),
    ).rejects.toThrow('REDIRECT:/?partner=err#partner-with-us');
    expect(await partnerRequestRows()).toHaveLength(0);
  });

  it('rejects a phone with fewer than 7 digits', async () => {
    await expect(
      submitPartnerRequestAction(form({ ...VALID, phone: '12-34' })),
    ).rejects.toThrow('REDIRECT:/?partner=err#partner-with-us');
    expect(await partnerRequestRows()).toHaveLength(0);
  });

  it('rate-limits after 5 requests in the window (6th → ?partner=rate)', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(
        submitPartnerRequestAction(form({ ...VALID, company_name: `Acme ${i}` })),
      ).rejects.toThrow('REDIRECT:/?partner=ok#partner-with-us');
    }
    await expect(submitPartnerRequestAction(form(VALID))).rejects.toThrow(
      'REDIRECT:/?partner=rate#partner-with-us',
    );
    // Only the 5 allowed leads persisted; the rate-limited one did not.
    expect(await partnerRequestRows()).toHaveLength(5);
  });
});
