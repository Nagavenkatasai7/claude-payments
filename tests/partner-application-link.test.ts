import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import { hashApplicationToken } from '@/lib/partner-application-token';

// Program-Fix 49C (partner-02): a staff decision (approved / rejected) must never
// reopen the single-use application link. The three token-gated entry points —
// the page, the submit action and the upload route — accept ONLY an 'invited'
// row. These rows deliberately KEEP a live token hash (the decision action also
// clears it; this pins the status check on its own, belt and braces).

let db: Db;
const redis = fakeRedis();

vi.mock('next/navigation', () => ({
  redirect: (p: string) => { throw new Error(`REDIRECT:${p}`); },
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.9' }),
}));
vi.mock('@/db/client', async (orig) => ({ ...((await orig()) as object), getDb: () => db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));

import PartnerApplyPage from '@/app/partners/apply/[token]/page';
import { submitPartnerApplicationAction } from '@/app/partners/apply/[token]/actions';
import { POST as uploadPOST } from '@/app/api/partner-application/upload/route';

const TOKENS = { invited: 'e'.repeat(64), approved: 'f'.repeat(64), rejected: '9'.repeat(64), completed: '8'.repeat(64) } as const;
type Status = keyof typeof TOKENS;

async function seed(status: Status): Promise<void> {
  await db.execute(sql`
    INSERT INTO partner_requests
      (id, company_name, email, phone, corridors, captured_at, application_token_hash, token_expires_at, application_status)
    VALUES
      (${`preq_link_${status}`}, 'Acme Remit Inc.', 'partners@acme.test', '+1 555 0100', ${JSON.stringify(['US'])}::jsonb, now(),
       ${hashApplicationToken(TOKENS[status])}, ${new Date(Date.now() + 86_400_000).toISOString()}, ${status})
  `);
}

async function renderPage(token: string): Promise<{ title?: string; tree: unknown }> {
  const el = (await PartnerApplyPage({
    params: Promise.resolve({ token }),
    searchParams: Promise.resolve({}),
  })) as { props?: { title?: string } };
  return { title: el.props?.title, tree: el };
}

async function applicationCount(): Promise<number> {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM partner_applications`);
  return Number((r as unknown as { rows: Array<{ n: number }> }).rows[0].n);
}

function submitForm(token: string): FormData {
  const f = new FormData();
  f.set('token', token);
  f.set('legalName', 'Acme Remit Inc.');
  f.set('countryOfIncorporation', 'United States');
  f.set('primaryContact', 'Jane jane@acme.test');
  return f;
}

function uploadReq(token: string): NextRequest {
  const fd = new FormData();
  fd.set('file', new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])], { type: 'application/pdf' }), 'a.pdf');
  fd.set('label', 'License');
  return new NextRequest(`https://example.test/api/partner-application/upload?token=${token}`, { method: 'POST', body: fd });
}

beforeEach(async () => {
  db = await freshDb();
  await db.execute(sql`TRUNCATE partner_requests, partner_applications RESTART IDENTITY CASCADE`);
  redis.dump.clear();
  for (const s of Object.keys(TOKENS) as Status[]) await seed(s);
});

describe('a decided application\'s link is dead (page, action, upload)', { retry: 0 }, () => {
  for (const status of ['approved', 'rejected'] as const) {
    it(`${status}: the page shows the no-longer-available card (not the form, not "we are reviewing")`, async () => {
      const { title } = await renderPage(TOKENS[status]);
      expect(title).toMatch(/no longer available/i);
    });

    it(`${status}: the submit action persists nothing and leaves the status alone`, async () => {
      await expect(submitPartnerApplicationAction(submitForm(TOKENS[status]))).rejects.toThrow(/^REDIRECT:\/partners\/apply\//);
      expect(await applicationCount()).toBe(0);
      const r = await db.execute(sql`SELECT application_status FROM partner_requests WHERE id = ${`preq_link_${status}`}`);
      expect((r as unknown as { rows: Array<{ application_status: string }> }).rows[0].application_status).toBe(status);
    });

    it(`${status}: the upload route answers 404 before touching storage`, async () => {
      const res = await uploadPOST(uploadReq(TOKENS[status]));
      expect(res.status).toBe(404);
    });
  }

  it('completed still shows the thank-you card; invited still renders the form', async () => {
    expect((await renderPage(TOKENS.completed)).title).toMatch(/thank you/i);
    expect((await renderPage(TOKENS.invited)).title).toBeUndefined();
  });
});
