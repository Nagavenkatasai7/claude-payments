/**
 * Task 9 — the consumer pay route maps finalizeDraftPayment's fx_unavailable
 * arm to a retryable 503 (never the generic 400 "link no longer active").
 */
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { FX_UNAVAILABLE_MESSAGE } from '@/lib/rate';

vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: (_cb: () => unknown) => {} };
});
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));
vi.mock('@/lib/transaction-otp', () => ({
  getTransactionOtpStore: () => ({ issue: async () => ({ ok: true, code: '000000' }), verify: async () => ({ ok: true }) }),
}));
// A live draft (so the OTP phone resolves) and no minted transfer for its id.
vi.mock('@/lib/draft-store', () => ({
  getDraftStore: () => ({ getDraft: async () => ({ senderPhone: '15551234567', partnerId: 'default' }) }),
}));
vi.mock('@/lib/store', () => ({ getStore: () => ({ getTransfer: async () => null }) }));
vi.mock('@/lib/customer-store', () => ({ getCustomerStore: () => ({}) }));
vi.mock('@/lib/partner-store', () => ({ getPartnerStore: () => ({}) }));
vi.mock('@/lib/monthly-volume-store', () => ({ getMonthlyVolumeStore: () => ({}) }));
vi.mock('@/lib/daily-volume-store', () => ({ getDailyVolumeStore: () => ({}) }));
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));
const finalizeDraftPayment = vi.hoisted(() => vi.fn());
vi.mock('@/lib/pay-finalize', () => ({ finalizeDraftPayment }));

import { POST } from '@/app/api/pay/[transferId]/route';

const DRAFT = 'draft_fx_1';
const post = () =>
  POST(
    new NextRequest('http://x/api/pay/' + DRAFT, {
      method: 'POST', body: JSON.stringify({ otp: '000000' }), headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ transferId: DRAFT }) },
  );

describe('POST /api/pay/[transferId] — fx_unavailable (Task 9)', () => {
  it('maps fx_unavailable to 503 with the customer-safe message and reason', async () => {
    finalizeDraftPayment.mockResolvedValueOnce({ ok: false, error: 'fx_unavailable' });
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: FX_UNAVAILABLE_MESSAGE, reason: 'fx_unavailable' });
  });

  it('the other refusal arms keep their 400 (regression)', async () => {
    finalizeDraftPayment.mockResolvedValueOnce({ ok: false, error: 'cap' });
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('That amount exceeds your current limit.');
  });
});
