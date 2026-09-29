/**
 * M2-6: the pay route's request_otp branch reads the recorded auth template of
 * the TRANSFER's partner (partner_portal_settings) and hands it to
 * sendTransactionOtp together with that partner's own creds. Partner A's
 * template is never used for partner B's transfer; a lookup failure falls back
 * to today's behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createTransactionOtpStore } from '@/lib/transaction-otp';
import { partners, partnerPortalSettings } from '@/db/schema';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Transfer, Customer } from '@/lib/types';

vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: (_cb: () => unknown) => {} };
});

const sendTransactionOtp = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/lib/whatsapp', () => ({
  sendText: vi.fn().mockResolvedValue(undefined),
  sendTransactionOtp,
  sendTemplate: vi.fn().mockResolvedValue(undefined),
  RECIPIENT_TEMPLATE_NAME: 'transfer_delivered',
  RECIPIENT_TEMPLATE_LANG: 'en',
}));

let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let customerStore: ReturnType<typeof createCustomerStore>;
let txOtp: ReturnType<typeof createTransactionOtpStore>;
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => store }));
vi.mock('@/lib/customer-store', async (orig) => ({ ...(await orig<typeof import('@/lib/customer-store')>()), getCustomerStore: () => customerStore }));
vi.mock('@/lib/transaction-otp', async (orig) => ({ ...(await orig<typeof import('@/lib/transaction-otp')>()), getTransactionOtpStore: () => txOtp }));
// Drafts by id (the web/portal pay path pays a DRAFT id); empty ⇒ the existing-transfer branch.
const draftsById = vi.hoisted(() => new Map<string, { senderPhone: string; partnerId?: string }>());
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft: async (id: string) => draftsById.get(id) ?? null }) }));
const brandByPartner = vi.hoisted(() => new Map<string, string>([['pa', 'Acme A'], ['pb', 'Bravo B']]));
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({
    getPartner: async (pid: string) => (brandByPartner.has(pid) ? { id: pid, name: pid, displayName: brandByPartner.get(pid) } : null),
    ensureDefaultPartner: async () => null,
  }),
}));
const recordChannelHealth = vi.hoisted(() => vi.fn().mockResolvedValue(false));
vi.mock('@/lib/channel-health', async (orig) => ({ ...(await orig<typeof import('@/lib/channel-health')>()), recordChannelHealth }));

// Per-partner WhatsApp integrations: which partners have their own number.
const integrationsByPartner = vi.hoisted(() => new Map<string, { phoneNumberId?: string; token?: string }>());
const integrationsFail = vi.hoisted(() => new Set<string>());
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async (pid: string) => {
      if (integrationsFail.has(pid)) throw new Error('integrations read failed');
      return { kyc: {}, payment: {}, whatsapp: integrationsByPartner.get(pid) ?? {} };
    },
  }),
}));

const getPortalSettingsSpy = vi.hoisted(() => ({ fail: false, calls: [] as string[] }));
vi.mock('@/db/repos/portal-settings-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/portal-settings-repo')>();
  return {
    ...real,
    getPortalSettings: async (d: Parameters<typeof real.getPortalSettings>[0], pid: string) => {
      getPortalSettingsSpy.calls.push(pid);
      if (getPortalSettingsSpy.fail) throw new Error('relation "partner_portal_settings" does not exist');
      return real.getPortalSettings(d, pid);
    },
  };
});

vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

import { POST } from '@/app/api/pay/[transferId]/route';

const PHONE = '15551234567';
const T0 = '2026-05-01T00:00:00.000Z';
const CREDS_A = { phoneNumberId: 'pn_a', token: 'tok_a' };
const CREDS_B = { phoneNumberId: 'pn_b', token: 'tok_b' };

function transferFor(id: string, partnerId: string): Transfer {
  return {
    id, phone: PHONE, amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85, amountInr: 17000,
    recipientName: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: 'ACCT-123',
    fundingMethod: 'bank_transfer', complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date(Date.now() - 60_000).toISOString(), sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN',
    destinationCurrency: 'INR', partnerId, amountSource: 200, feeSource: 0, totalChargeSource: 200,
  } as Transfer;
}
const customerFor = (partnerId: string): Customer =>
  ({ senderPhone: PHONE, firstSeenAt: T0, kycStatus: 'verified', fullName: 'Test Sender', senderCountry: 'US', partnerId, createdAt: T0, updatedAt: T0 }) as Customer;

const requestOtp = (tid: string) =>
  POST(
    new NextRequest('http://x/api/pay/' + tid, {
      method: 'POST', body: JSON.stringify({ action: 'request_otp' }), headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ transferId: tid }) },
  );

beforeEach(async () => {
  const r = fakeRedis();
  db = await freshDb();
  store = createStore(r, db);
  customerStore = createCustomerStore(db, store);
  txOtp = createTransactionOtpStore(r, { randomInt: () => 654321 });
  await db.insert(partners).values([{ id: 'pa', name: 'A' }, { id: 'pb', name: 'B' }]);
  await db.insert(partnerPortalSettings).values({ partnerId: 'pa', authTemplateName: 'a_login_code', authTemplateLang: 'en_US' });
  for (const pid of ['pa', 'pb']) {
    await store.saveTransfer(transferFor(`t_${pid}`, pid));
    await customerStore.saveCustomer(customerFor(pid));
  }
  integrationsByPartner.clear();
  integrationsFail.clear();
  recordChannelHealth.mockClear();
  draftsById.clear();
  getPortalSettingsSpy.fail = false;
  getPortalSettingsSpy.calls = [];
  sendTransactionOtp.mockClear();
});

describe('POST /api/pay/[transferId] request_otp — partner auth template (M2-6)', { retry: 0 }, () => {
  it("partner with its own number + a recorded template → the template goes with THAT partner's creds", async () => {
    integrationsByPartner.set('pa', CREDS_A);
    const res = await requestOtp('t_pa');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: true });
    expect(sendTransactionOtp).toHaveBeenCalledOnce();
    expect(sendTransactionOtp).toHaveBeenCalledWith(PHONE, '654321', CREDS_A, 'Acme A', { name: 'a_login_code', lang: 'en_US' }, expect.any(Object));
    expect(getPortalSettingsSpy.calls).toEqual(['pa']);
  });

  it("tenant isolation: B's transfer (own number, no template) never gets A's template", async () => {
    integrationsByPartner.set('pa', CREDS_A);
    integrationsByPartner.set('pb', CREDS_B);
    const res = await requestOtp('t_pb');
    expect(res.status).toBe(200);
    expect(sendTransactionOtp).toHaveBeenCalledOnce();
    const args = sendTransactionOtp.mock.calls[0];
    expect(args[2]).toEqual(CREDS_B);
    expect(args[4]).toBeUndefined();
    expect(getPortalSettingsSpy.calls).toEqual(['pb']);
  });

  it('a recorded template but NO own number → no settings read, today\'s shared-number call', async () => {
    const res = await requestOtp('t_pa');
    expect(res.status).toBe(200);
    expect(sendTransactionOtp).toHaveBeenCalledOnce();
    const args = sendTransactionOtp.mock.calls[0];
    expect(args[2]).toBeUndefined();
    expect(args[4]).toBeUndefined();
    expect(getPortalSettingsSpy.calls).toEqual([]);
  });

  it('the settings lookup throws → template undefined, the code still goes out (today\'s behaviour), 200 sent', async () => {
    integrationsByPartner.set('pa', CREDS_A);
    getPortalSettingsSpy.fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await requestOtp('t_pa');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: true });
    expect(sendTransactionOtp).toHaveBeenCalledOnce();
    const args = sendTransactionOtp.mock.calls[0];
    expect(args[2]).toEqual(CREDS_A);
    expect(args[4]).toBeUndefined();
    const logged = warn.mock.calls.flat().map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join('\n');
    expect(logged).not.toContain('654321');
    expect(logged).not.toContain(PHONE);
    warn.mockRestore();
  });

  it("draft path: a draft of B (own number) never gets A's template; the draft's tenant decides", async () => {
    integrationsByPartner.set('pa', CREDS_A);
    integrationsByPartner.set('pb', CREDS_B);
    draftsById.set('d_pb', { senderPhone: PHONE, partnerId: 'pb' });
    const res = await requestOtp('d_pb');
    expect(res.status).toBe(200);
    expect(sendTransactionOtp).toHaveBeenCalledOnce();
    const args = sendTransactionOtp.mock.calls[0];
    expect(args[2]).toEqual(CREDS_B);
    expect(args[4]).toBeUndefined();
    expect(getPortalSettingsSpy.calls).toEqual(['pb']);
  });

  it("draft path: a draft of A (own number + template) → A's template on A's creds", async () => {
    integrationsByPartner.set('pa', CREDS_A);
    integrationsByPartner.set('pb', CREDS_B);
    draftsById.set('d_pa', { senderPhone: PHONE, partnerId: 'pa' });
    const res = await requestOtp('d_pa');
    expect(res.status).toBe(200);
    expect(sendTransactionOtp).toHaveBeenCalledWith(PHONE, '654321', CREDS_A, 'Acme A', { name: 'a_login_code', lang: 'en_US' }, expect.any(Object));
    expect(getPortalSettingsSpy.calls).toEqual(['pa']);
  });
});

// ── M2-14: the enablement blocker (#393) — no silent shared-number fallback ──
describe('POST /api/pay/[transferId] request_otp — fail closed off the partner number (M2-14)', { retry: 0 }, () => {
  it("ENABLEMENT BLOCKER: a non-default partner's creds lookup throws → 502 otp_send_failed, nothing sent, no code minted", async () => {
    integrationsFail.add('pa');
    const issue = vi.spyOn(txOtp, 'issue');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await requestOtp('t_pa');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, reason: 'otp_send_failed' });
    expect(sendTransactionOtp).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it('the DEFAULT partner keeps its shared number when the creds lookup throws (the shared number is its own)', async () => {
    await store.saveTransfer(transferFor('t_default', 'default'));
    integrationsFail.add('default');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await requestOtp('t_default');
    expect(res.status).toBe(200);
    expect(sendTransactionOtp).toHaveBeenCalledOnce();
    expect(sendTransactionOtp.mock.calls[0][2]).toBeUndefined();
  });

  it("the tenant can't be resolved (the draft's legacy lookup throws) → 502, nothing sent, no code minted", async () => {
    draftsById.set('d_legacy', { senderPhone: PHONE }); // pre-fix-1 draft: no partnerId
    vi.spyOn(store, 'legacyTenantOf').mockRejectedValue(new Error('db down'));
    const issue = vi.spyOn(txOtp, 'issue');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await requestOtp('d_legacy');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, reason: 'otp_send_failed' });
    expect(sendTransactionOtp).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it('a partially configured channel (token without number) → 502, never the shared number; incomplete_config recorded', async () => {
    integrationsByPartner.set('pa', { token: 'tok_only' });
    const res = await requestOtp('t_pa');
    expect(res.status).toBe(502);
    expect(sendTransactionOtp).not.toHaveBeenCalled();
    expect(recordChannelHealth).toHaveBeenCalledWith('pa', 'incomplete_config');
  });

  it('a partner deliberately on the shared number (no WhatsApp field set) still gets the code on the shared number, with its brand', async () => {
    const res = await requestOtp('t_pb');
    expect(res.status).toBe(200);
    const args = sendTransactionOtp.mock.calls[0];
    expect(args[2]).toBeUndefined();
    expect(args[3]).toBe('Bravo B');
  });

  it("the hooks: a template failure records auth_template_failed with the Graph code for THIS partner; the window check reads THIS partner's marker", async () => {
    integrationsByPartner.set('pa', CREDS_A);
    const lastInbound = vi.spyOn(store, 'getLastInboundAt').mockResolvedValue(null);
    sendTransactionOtp.mockImplementationOnce(async (...a: unknown[]) => {
      const hooks = a[5] as { inWindow: () => Promise<boolean>; onTemplateFailure: (i: { status?: number; code?: number }) => Promise<void> };
      await hooks.onTemplateFailure({ status: 404, code: 132001 });
      expect(await hooks.inWindow()).toBe(false);
      throw new Error('template failed, outside window');
    });
    const res = await requestOtp('t_pa');
    expect(res.status).toBe(502);
    expect(recordChannelHealth).toHaveBeenCalledWith('pa', 'auth_template_failed', { code: 132001 });
    expect(lastInbound).toHaveBeenCalledWith('pa', PHONE);
  });
});
