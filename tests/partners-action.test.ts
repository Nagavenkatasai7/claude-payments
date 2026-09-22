import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import { createStore } from '@/lib/store';
import { decryptField } from '@/lib/field-crypto';
import { hashApplicationToken } from '@/lib/partner-application-token';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';

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

type EmailPayload = { to: string[]; subject: string; text: string; sealed?: Record<string, string> };

async function emailOutboxRows(): Promise<{ dedupeKey: string; payload: EmailPayload }[]> {
  const res = await db.execute(
    sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'email.send' ORDER BY id`,
  );
  return (
    res as unknown as {
      rows: { dedupe_key: string; payload: EmailPayload }[];
    }
  ).rows.map((r) => ({ dedupeKey: r.dedupe_key, payload: r.payload }));
}

const VALID = {
  company_name: 'Acme Remit Inc.',
  email: 'partners@acme.com',
  phone: '+1 555 123 4567',
  comments: 'We move ~$2M/mo US→IN.',
  corridors: ['US', 'IN'],
  partner_type: 'licensed_mt',
};

async function partnerTypes(): Promise<(string | null)[]> {
  const res = await db.execute(sql`SELECT partner_type FROM partner_requests ORDER BY captured_at`);
  return (res as unknown as { rows: { partner_type: string | null }[] }).rows.map((r) => r.partner_type);
}

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
    // The link is a placeholder rendered from a field-crypto blob at send time (fix 11 / F66).
    expect(invite!.payload.text).toContain('{{apply_link}}');
    expect(invite!.payload.text).not.toContain('/partners/apply/');

    expect(pokeWorkerMock).toHaveBeenCalledTimes(1);
  });

  it('stores the partner type ("I am a:") on the row and names it in the team email', async () => {
    await expect(submitPartnerRequestAction(form(VALID))).rejects.toThrow('REDIRECT:/?partner=ok#partner-with-us');
    expect(await partnerTypes()).toEqual(['licensed_mt']);
    const [lead] = await partnerRequestRows();
    const team = (await emailOutboxRows()).find((e) => e.dedupeKey === `preq:${lead.id}`)!;
    expect(team.payload.text).toContain('Partner type: Licensed money transmitter');
  });

  it.each(['referral', 'business', 'licensed_mt'])('accepts partner_type=%s', async (t) => {
    await expect(submitPartnerRequestAction(form({ ...VALID, partner_type: t }))).rejects.toThrow(
      'REDIRECT:/?partner=ok#partner-with-us',
    );
    expect(await partnerTypes()).toEqual([t]);
  });

  it('rejects a missing partner_type with ?partner=err and persists nothing', async () => {
    await expect(submitPartnerRequestAction(form({ ...VALID, partner_type: '' }))).rejects.toThrow(
      'REDIRECT:/?partner=err#partner-with-us',
    );
    expect(await partnerRequestRows()).toHaveLength(0);
  });

  it('rejects an unknown partner_type (never stored raw; the CHECK would refuse it anyway)', async () => {
    await expect(submitPartnerRequestAction(form({ ...VALID, partner_type: 'admin' }))).rejects.toThrow(
      'REDIRECT:/?partner=err#partner-with-us',
    );
    expect(await partnerRequestRows()).toHaveLength(0);
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

describe('the partner-invite email never persists the raw capability token (fix 11 / F66)', () => {
  function workerDeps(sent: { to: string[]; subject: string; text: string }[]): WorkerDeps {
    return {
      db,
      store: createStore(redis, db),
      sendText: async () => {},
      sendTemplate: async () => {},
      fetchFn: (() => { throw new Error('no network in this test'); }) as unknown as typeof fetch,
      recipientTemplateName: 'transfer_delivered',
      recipientTemplateLang: 'en',
      listStaff: async () => [],
      runAgentTurn: async () => '',
      sendEmail: async (m) => { sent.push(m); },
    };
  }

  async function submitAndGetInvite() {
    await expect(submitPartnerRequestAction(form(VALID))).rejects.toThrow('REDIRECT:/?partner=ok#partner-with-us');
    const [lead] = await partnerRequestRows();
    const invite = (await emailOutboxRows()).find((e) => e.dedupeKey === `partner_app_invite:${lead.id}`)!;
    return { lead, invite };
  }

  it('the email.send payload holds a field-crypto blob, never the raw token or the apply link', async () => {
    const { invite } = await submitAndGetInvite();
    const raw = JSON.stringify(invite.payload);
    expect(raw).not.toMatch(/\/partners\/apply\//);
    expect(raw).not.toMatch(/[0-9a-f]{64}/);
    expect(invite.payload.sealed?.apply_link).toMatch(/^v1\./);
  });

  it('the sealed link decrypts to /partners/apply/<token> whose HASH is on the lead row, and the worker delivers it rendered', async () => {
    const { lead, invite } = await submitAndGetInvite();
    const link = decryptField(invite.payload.sealed!.apply_link);
    expect(link).toMatch(/^https:\/\/smartremit\.test\/partners\/apply\/[0-9a-f]{64}$/);
    // The apply page resolves getByTokenHash(hashApplicationToken(token)).
    expect(hashApplicationToken(link.split('/partners/apply/')[1])).toBe(lead.applicationTokenHash);

    const sent: { to: string[]; subject: string; text: string }[] = [];
    const r = await drainOnce(workerDeps(sent), 'w1');
    expect(r.processed).toBe(2); // team notification + invite
    const delivered = sent.find((m) => m.to[0] === 'partners@acme.com')!;
    expect(delivered.text).toContain(link);
    expect(delivered.text).not.toContain('{{apply_link}}');
  });

  it('a redelivered invite does NOT re-mint: the same link twice, application_token_hash unchanged', async () => {
    const { lead: before } = await submitAndGetInvite();
    const sent: { to: string[]; subject: string; text: string }[] = [];
    await drainOnce(workerDeps(sent), 'w1');
    // "Delivered but not acked": the machinery re-runs the row.
    await db.execute(sql`UPDATE outbox SET status = 'pending', next_attempt_at = now() WHERE dedupe_key = ${`partner_app_invite:${before.id}`}`);
    await drainOnce(workerDeps(sent), 'w1');
    const invites = sent.filter((m) => m.to[0] === 'partners@acme.com');
    expect(invites).toHaveLength(2);
    expect(invites[1].text).toBe(invites[0].text);
    const [after] = await partnerRequestRows();
    expect(after.applicationTokenHash).toBe(before.applicationTokenHash);
  });
});
