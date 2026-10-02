import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-6: the six staff API routes that read the session directly (getCurrentStaff,
// not a require* gate) refuse the /partner-only 'finance' role. The five copilot routes already
// refuse it through their role allowlists (403; pinned here, code unchanged). dashboard/summary
// had no role check: it now answers 401 for any role outside the closed legacy set, the same
// response as an anonymous caller. The real isLegacyDashboardStaff (src/lib/legacy-dashboard-staff.ts) is used.
let currentStaff: Staff | null = null;
let db: Db;

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, getCurrentStaff: async () => currentStaff };
});
vi.mock('@/db/client', async () => {
  const actual = await vi.importActual<typeof import('@/db/client')>('@/db/client');
  return { ...actual, getDb: () => db };
});
// M3-9: the routes read the invite MFA marker (exists) for partner-scoped accounts.
vi.mock('@/lib/redis', async () => {
  const { fakeRedis } = await import('./helpers');
  const r = fakeRedis();
  return { getRedis: () => r };
});
vi.mock('@/lib/ticket-ai', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ticket-ai')>('@/lib/ticket-ai');
  return { ...actual, checkCopilotRateLimit: async () => true };
});
const transfersSummary = vi.hoisted(() =>
  vi.fn(async () => ({ total: 0, byStatus: {}, needsAttention: 0, latest: null })),
);
vi.mock('@/lib/store', () => ({ getStore: () => ({ transfersSummary }) }));

import { GET as summaryGET } from '@/app/api/dashboard/summary/route';
import { POST as reviewTriagePOST } from '@/app/api/copilot/review-triage/route';
import { POST as summarizePOST } from '@/app/api/copilot/summarize/route';
import { POST as kycReviewPOST } from '@/app/api/copilot/kyc-review/route';
import { POST as opsDiagnosePOST } from '@/app/api/copilot/ops-diagnose/route';
import { POST as draftReplyPOST } from '@/app/api/copilot/draft-reply/route';

function mk(o: Partial<Staff>): Staff {
  return {
    username: 'u1',
    name: 'U',
    role: 'admin',
    permissions: { canCancel: false, canResend: false, canAssign: false, canRevealPii: false },
    passwordHash: 'x',
    createdAt: '2026-01-01T00:00:00Z',
    ...o,
  };
}
const FINANCE = 'finance' as Staff['role'];

function post(path: string): NextRequest {
  return new NextRequest(`https://smartremit.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

const COPILOT = [
  ['review-triage', reviewTriagePOST],
  ['summarize', summarizePOST],
  ['kyc-review', kycReviewPOST],
  ['ops-diagnose', opsDiagnosePOST],
  ['draft-reply', draftReplyPOST],
] as const;

beforeEach(async () => {
  db = await freshDb();
  currentStaff = null;
  transfersSummary.mockClear();
});

describe('M3-6: /api/dashboard/summary refuses finance', () => {
  it('a partner-scoped finance session → 401 (same as anonymous), with no ledger read', async () => {
    currentStaff = mk({ role: FINANCE, partnerId: 'pa' });
    const res = await summaryGET();
    expect(res.status).toBe(401);
    expect(transfersSummary).not.toHaveBeenCalled();
  });
  it('a role outside the closed set → 401 (fail closed)', async () => {
    currentStaff = mk({ role: 'root' as Staff['role'], partnerId: 'pa' });
    expect((await summaryGET()).status).toBe(401);
    expect(transfersSummary).not.toHaveBeenCalled();
  });
  it('anonymous → 401 (unchanged)', async () => {
    expect((await summaryGET()).status).toBe(401);
  });
  it('a platform admin or agent session is not refused (200) and reads unscoped', async () => {
    currentStaff = mk({ role: 'admin' });
    expect((await summaryGET()).status).toBe(200);
    currentStaff = mk({ role: 'agent' });
    expect((await summaryGET()).status).toBe(200);
    expect(transfersSummary).toHaveBeenLastCalledWith(undefined);
  });
  it('UI M5: a partner agent session → 401 (the legacy dashboard is SmartRemit-only), no ledger read', async () => {
    currentStaff = mk({ role: 'agent', partnerId: 'pa' });
    expect((await summaryGET()).status).toBe(401);
    expect(transfersSummary).not.toHaveBeenCalled();
  });
});

describe('M3-6: the five copilot routes already refuse finance (pinned; code unchanged)', () => {
  it.each(COPILOT)('%s: a finance session → 403', async (name, handler) => {
    currentStaff = mk({ role: FINANCE, partnerId: 'pa' });
    expect((await handler(post(`/api/copilot/${name}`))).status).toBe(403);
  });
  it.each(COPILOT)('%s: a platform admin session is not refused (not 401/403)', async (name, handler) => {
    currentStaff = mk({ role: 'admin' });
    const status = (await handler(post(`/api/copilot/${name}`))).status;
    expect(status).not.toBe(401);
    expect(status).not.toBe(403);
  });
});
