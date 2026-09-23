import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import type { Customer, Staff } from '@/lib/types';

// Program-Fix 37 (MUST-2): the KYC copilot's `copilot.kyc_review` audit row
// names its subject by the keyed auditSubjectId of the RESOLVED row, never the
// raw phone, so audit_events stops accumulating phone numbers.

const PHONE = '15551230000';
let db: Awaited<ReturnType<typeof freshDb>>;
let currentStaff: Staff | null;

const customer: Customer = {
  senderPhone: PHONE,
  firstSeenAt: '2026-01-01T00:00:00Z',
  kycStatus: 'pending',
  kycReviewState: 'pending_review',
  senderCountry: 'US',
  partnerId: 'acme',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

vi.mock('@/lib/auth', () => ({ getCurrentStaff: async () => currentStaff }));
vi.mock('@/db/client', () => ({ getDb: () => db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => ({}) }));
vi.mock('@/lib/store', () => ({ getStore: () => ({}) }));
vi.mock('@/lib/ticket-ai', () => ({ checkCopilotRateLimit: async () => true }));
vi.mock('@/lib/scoped-store', () => ({
  createScopedStore: () => ({
    getCustomer: async (phone: string) => (phone === PHONE ? customer : null),
  }),
}));
vi.mock('@/lib/kyc-case-store', () => ({ getKycCaseStore: () => ({ getAudit: async () => [] }) }));
vi.mock('@/lib/kyc-review-ai', () => ({
  suggestKycReview: async () => ({ summary: 's', suggested_decision: 'need_more', confidence: 'low', top_reasons: [] }),
}));

import { POST } from '@/app/api/copilot/kyc-review/route';
import { auditSubjectId } from '@/lib/customer-ref';

function req(body: unknown): NextRequest {
  return new NextRequest('https://smartremit.test/api/copilot/kyc-review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
  currentStaff = {
    username: 'alice',
    name: 'Alice',
    role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'x',
    createdAt: '2026-01-01T00:00:00Z',
  };
});

describe('/api/copilot/kyc-review audit subject', () => {
  it('records copilot.kyc_review with the keyed cust: subject, never the phone', async () => {
    const res = await POST(req({ subjectId: PHONE, partnerId: 'acme' }));
    expect(res.status).toBe(200);
    const r = await db.execute(sql`SELECT subject_id, meta FROM audit_events WHERE action = 'copilot.kyc_review'`);
    const rows = (r as unknown as { rows: Array<{ subject_id: string }> }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_id).toBe(auditSubjectId('acme', PHONE));
    expect(rows[0].subject_id).toMatch(/^cust:[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain(PHONE);
  });

  it('an unknown customer is a 404 with no audit row', async () => {
    const res = await POST(req({ subjectId: '19998887777' }));
    expect(res.status).toBe(404);
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM audit_events`);
    expect((r as unknown as { rows: Array<{ n: number }> }).rows[0].n).toBe(0);
  });
});
