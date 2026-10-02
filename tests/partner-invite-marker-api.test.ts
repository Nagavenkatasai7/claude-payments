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
// The summary poll's two aggregates, so a platform session can be pinned to a real 200.
const transfersSummary = vi.hoisted(() =>
  vi.fn(async () => ({ total: 0, byStatus: {}, needsAttention: 0, latest: null })),
);
const ticketStamp = vi.hoisted(() => vi.fn(async () => null));
vi.mock('@/lib/store', () => ({ getStore: () => ({ transfersSummary }) }));
vi.mock('@/db/client', async () => {
  const actual = await vi.importActual<typeof import('@/db/client')>('@/db/client');
  return { ...actual, getDb: () => ({}) };
});
vi.mock('@/db/repos/ticket-repo', async () => {
  const actual = await vi.importActual<typeof import('@/db/repos/ticket-repo')>('@/db/repos/ticket-repo');
  return { ...actual, createTicketRepo: () => ({ ticketStamp }) };
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
  transfersSummary.mockClear();
  ticketStamp.mockClear();
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
    it(`copilot ${name}: an unmarked platform account passes the marker check (reaches the rate-limit step)`, async () => {
      current = agent({ partnerId: undefined });
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
  it('/api/dashboard/summary: an unmarked platform account passes the marker check (200)', async () => {
    current = agent({ partnerId: undefined });
    const res = await summary();
    expect(res.status).toBe(200);
    expect(transfersSummary).toHaveBeenCalledWith(undefined);
  });
});

// UI M5 (one partner dashboard): these routes serve the legacy dashboard, which is SmartRemit-only.
// Every partner-scoped session (enrolled, unmarked, any legacy role) gets the summary's anonymous
// 401 and the copilots' 403, before any aggregate is read or any copilot budget is spent.
describe('UI M5: legacy staff API routes refuse partner sessions', () => {
  for (const role of ['admin', 'agent', 'support'] as const) {
    it(`/api/dashboard/summary: a partner ${role} → 401 {ok:false}, no aggregate read`, async () => {
      current = agent({ role });
      const res = await summary();
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false });
      expect(transfersSummary).not.toHaveBeenCalled();
      expect(ticketStamp).not.toHaveBeenCalled();
    });
    for (const [name, handler] of Object.entries(COPILOT)) {
      it(`copilot ${name}: a partner ${role} → 403 {ok:false}, no budget used`, async () => {
        current = agent({ role });
        const res = await handler(req());
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ ok: false });
        expect(copilotLimit).not.toHaveBeenCalled();
      });
    }
  }
  it('an empty-string partnerId is never platform scope: summary 401, copilots 403', async () => {
    current = agent({ partnerId: '' });
    expect((await summary()).status).toBe(401);
    for (const handler of Object.values(COPILOT)) expect((await handler(req())).status).toBe(403);
    expect(copilotLimit).not.toHaveBeenCalled();
  });
  it('platform sessions are unchanged: summary 200, every copilot reaches the rate-limit step', async () => {
    for (const role of ['admin', 'agent', 'support'] as const) {
      current = agent({ role, partnerId: undefined });
      expect((await summary()).status).toBe(200);
    }
    current = agent({ role: 'admin', partnerId: undefined });
    for (const handler of Object.values(COPILOT)) {
      copilotLimit.mockClear();
      const res = await handler(req()).catch(() => null);
      expect(res?.status).not.toBe(403);
      expect(copilotLimit).toHaveBeenCalledTimes(1);
    }
  });
});
