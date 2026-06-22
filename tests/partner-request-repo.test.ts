import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { freshDb } from './helpers-db';
import { createPartnerRequestRepo } from '@/db/repos/aux-repos';
import { sendEmail } from '@/lib/email';
import type { Db } from '@/db/client';

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

describe('partner-request repo (PGlite)', () => {
  it('saves and lists partner requests newest-first, round-tripping all fields', async () => {
    const repo = createPartnerRequestRepo(db);
    await repo.savePartnerRequest({
      id: 'preq_1', companyName: 'Acme Remit', email: 'a@acme.com', phone: '15551112222',
      corridors: ['US', 'IN'], comments: 'Looking to launch US→India.',
      capturedAt: '2026-06-20T10:00:00.000Z',
    });
    await repo.savePartnerRequest({
      id: 'preq_2', companyName: 'Globex', email: 'b@globex.com', phone: '15553334444',
      corridors: ['GB'], // no comments
      capturedAt: '2026-06-21T10:00:00.000Z',
    });

    const all = await repo.listPartnerRequests();
    expect(all.map((r) => r.id)).toEqual(['preq_2', 'preq_1']); // newest-first

    const acme = all.find((r) => r.id === 'preq_1')!;
    expect(acme.companyName).toBe('Acme Remit');
    expect(acme.email).toBe('a@acme.com');
    expect(acme.phone).toBe('15551112222');
    expect(acme.corridors).toEqual(['US', 'IN']);
    expect(acme.comments).toBe('Looking to launch US→India.');

    // comments omitted (not empty-string) when absent
    expect(all.find((r) => r.id === 'preq_2')!.comments).toBeUndefined();
  });
});

describe('sendEmail — no-op when unconfigured', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does NOT call fetch and never throws when RESEND_API_KEY is unset', async () => {
    // RESEND_API_KEY is unset in the test env ⇒ sendEmail must short-circuit so
    // the outbox never dead-letters just because email isn't configured.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(sendEmail({ to: ['x@y.com'], subject: 's', text: 't' })).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
