import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { fakeRedis } from './helpers';
import type { Staff } from '@/lib/types';

// UI redesign M3-9 (O10 = yes): the six staff API routes of the legacy dashboard refuse an account
// that still carries the invite MFA marker (not enrolled), with their EXISTING refusal status: the
// summary poll answers like an anonymous caller (401, as for finance in M3-6), the copilot routes
// with their role refusal (403). The check runs before the copilot rate-limit budget is touched.
const redis = fakeRedis();
let current: Staff | null = null;
const copilotLimit = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@/lib/auth', () => ({ getCurrentStaff: async () => current }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis) };
});
vi.mock('@/lib/ticket-ai', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ticket-ai')>('@/lib/ticket-ai');
  return { ...actual, checkCopilotRateLimit: copilotLimit };
});

import { GET as summary } from '@/app/api/dashboard/summary/route';
import { POST as draftReply } from '@/app/api/copilot/draft-reply/route';
import { POST as summarize } from '@/app/api/copilot/summarize/route';
import { POST as reviewTriage } from '@/app/api/copilot/review-triage/route';
import { POST as kycReview } from '@/app/api/copilot/kyc-review/route';
import { POST as opsDiagnose } from '@/app/api/copilot/ops-diagnose/route';
import { MFA_PENDING_PREFIX } from '@/lib/partner-mfa-gate';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
const agent = (o: Partial<Staff> = {}): Staff => ({
  username: 'invitee',
  name: 'I',
  role: 'admin',
  permissions: perms,
  passwordHash: 'x',
  createdAt: '2026-01-01T00:00:00Z',
  partnerId: 'pa',
  ...o,
});
const req = () =>
  new NextRequest('https://smartremit.ai/api/copilot/x', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });

// ops-diagnose already refuses EVERY partner-scoped account (platform ops only), so it is pinned
// separately below and was not edited.
const COPILOT = { draftReply, summarize, reviewTriage, kycReview } as const;

beforeEach(() => {
  redis.dump.clear();
  copilotLimit.mockClear();
  current = agent();
});

describe('legacy staff API routes and the invite marker (M3-9, O10)', () => {
  it('/api/dashboard/summary: a marked, unenrolled partner account gets the anonymous 401', async () => {
    await redis.set(`${MFA_PENDING_PREFIX}invitee`, '1');
    const res = await summary();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false });
  });
  for (const [name, handler] of Object.entries(COPILOT)) {
    it(`copilot ${name}: a marked account → 403 before the rate-limit budget is touched`, async () => {
      await redis.set(`${MFA_PENDING_PREFIX}invitee`, '1');
      const res = await handler(req());
      expect(res.status).toBe(403);
      expect(copilotLimit).not.toHaveBeenCalled();
    });
    it(`copilot ${name}: an unmarked account passes the marker check (reaches the rate-limit step)`, async () => {
      await handler(req()).catch(() => undefined);
      expect(copilotLimit).toHaveBeenCalled();
    });
  }
  it('copilot opsDiagnose: a marked (partner-scoped) account keeps its existing 403, no budget used', async () => {
    await redis.set(`${MFA_PENDING_PREFIX}invitee`, '1');
    const res = await opsDiagnose(req());
    expect(res.status).toBe(403);
    expect(copilotLimit).not.toHaveBeenCalled();
  });
  it('/api/dashboard/summary: an unmarked partner account passes the marker check', async () => {
    const res = await summary().catch(() => null);
    expect(res?.status).not.toBe(401);
  });
});
