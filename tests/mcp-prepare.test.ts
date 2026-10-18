import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import type { AgentPrincipal } from '@/lib/agent-auth';
import type { ToolContextDeps } from '@/lib/tool-context';
import { createStore, type Store } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createPartnerStore } from '@/lib/partner-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { resetRateCacheForTests } from '@/lib/rate';
import { recipientRid } from '@/lib/portal-recipients';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { auditSubjectId } from '@/lib/customer-ref';
import { PORTAL_SEND_LIMIT } from '@/lib/portal-send';
import {
  PREPARED_NOT_FOUND,
  PREPARE_TOO_MANY,
  RECIPIENT_NOT_FOUND,
  cancelPreparedTransferTool,
  prepareTransferTool,
  type PrepareDeps,
  type PrepareTransferArgs,
} from '@/lib/mcp/prepare';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AgentAuth } from '@/lib/agent-auth';
import { handleMcpRequest } from '@/lib/mcp/http';
import { fakeRedis, type FakeRedis } from './helpers';
import { freshDb, seedPartner, seedSender } from './helpers-db';

// Stage C2: prepare_transfer makes ONE draft through the portal's own send path (the bot's
// seam), on the web pointer, marked with the app that asked; the customer pays on the pay page.
// cancel_prepared_transfer removes only an unpaid draft this same app prepared for this customer.

const PHONE = '14155550101';
const OTHER_PHONE = '14155550199';
const FULL_ACCOUNT = '123456789012';
const IFSC = 'HDFC0000001';
const RECIPIENT_PHONE = '919812345678';

let db: Db;
let redis: FakeRedis;
let store: Store;
let kyc: MockKycProvider;

function toolDeps(): Partial<ToolContextDeps> {
  const customerStore = createCustomerStore(db, store);
  kyc = new MockKycProvider(customerStore, 'https://example.com');
  return {
    store,
    customerStore,
    scheduleStore: createScheduleStore(db),
    draftStore: createDraftStore(redis),
    dailyVolumeStore: createDailyVolumeStore(store),
    monthlyVolumeStore: createMonthlyVolumeStore(store),
    partnerStore: createPartnerStore(db),
    kycProvider: kyc,
  };
}

const principal = (over: Partial<AgentPrincipal> = {}): AgentPrincipal => ({
  grantId: 'agg_test',
  partnerId: 'pa',
  phone: PHONE,
  clientId: 'agc_claude',
  clientName: 'Claude',
  scopes: ['quotes:read', 'recipients:read', 'transfers:read', 'transfers:prepare'],
  ...over,
});

let deps: PrepareDeps;
const rid = () => recipientRid('pa', PHONE, RECIPIENT_PHONE);
const args = (over: Partial<PrepareTransferArgs> = {}): PrepareTransferArgs => ({ recipient_id: rid(), amount: 200, purpose: 'family_support', ...over });
const drafts = () => [...redis.dump.keys()].filter((k) => k.startsWith('recipient_draft:'));

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  redis = fakeRedis();
  store = createStore(redis, db);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '', json: async () => ({ rates: { INR: 85 } }) })));
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
  await seedSender(db, { partnerId: 'pa', phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
  // The legal name on file that every send needs (sender-identity.ts hasSenderName).
  const customers = createCustomerStore(db, store);
  await customers.saveCustomer({ ...(await customers.getCustomer('pa', PHONE))!, fullName: 'Venu Rao' });
  await store.upsertRecipient('pa', PHONE, {
    name: 'Asha Kumar',
    recipientPhone: RECIPIENT_PHONE,
    payoutMethod: 'bank',
    payoutDestination: `${IFSC} ${FULL_ACCOUNT}`,
    lastUsedAt: new Date().toISOString(),
  });
  await store.upsertRecipient('pb', PHONE, {
    name: 'Other Tenant',
    recipientPhone: '919800000001',
    payoutMethod: 'bank',
    payoutDestination: 'SBIN0000001 999988887777',
    lastUsedAt: new Date().toISOString(),
  });
  deps = { toolDeps: toolDeps(), db, redis };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('prepare_transfer', () => {
  it('a saved recipient → one web draft marked with the app, and the pay link; no account number in the answer', async () => {
    const r = await prepareTransferTool(principal(), args(), deps);
    if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r)}`);
    const id = r.data.prepared_transfer_id as string;
    expect(r.draftId).toBe(id);
    expect(r.data).toMatchObject({
      prepared: true,
      pay_url: expect.stringMatching(new RegExp(`/pay/${id}$`)),
      recipient_name: 'Asha Kumar',
      payout_type: 'bank',
      account_last4: '9012',
      send_amount: 200,
      send_currency: 'USD',
      recipient_currency: 'INR',
      destination_country: 'IN',
      purpose: 'family_support',
      next_step: expect.stringContaining('pay page'),
    });
    expect(r.data.recipient_gets).toBeGreaterThan(0);
    const text = JSON.stringify(r.data);
    for (const s of [FULL_ACCOUNT, IFSC, RECIPIENT_PHONE]) expect(text).not.toContain(s);

    const draft = await createDraftStore(redis).getDraft(id);
    expect(draft).toMatchObject({
      partnerId: 'pa',
      senderPhone: PHONE,
      channel: 'web',
      preparedBy: { clientId: 'agc_claude', appName: 'Claude' },
      purpose: 'family_support',
      fundingMethod: 'bank_transfer',
    });
    // The payout is the saved recipient's, resolved on the server (the pay page skips step 1).
    expect(draft!.recipient.payoutDestination).toContain(FULL_ACCOUNT);
    // The web pointer, never the bot's: a typed WhatsApp "cancel" cannot consume it.
    expect(await createDraftStore(redis).getActiveDraftId('pa', PHONE, 'web')).toBe(id);
    expect(await createDraftStore(redis).getActiveDraftId('pa', PHONE, 'bot')).toBeNull();
  });

  it('a retry with the same details returns the same draft; a changed amount makes a new one', async () => {
    const a = await prepareTransferTool(principal(), args(), deps);
    const b = await prepareTransferTool(principal(), args(), deps);
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(b.data.prepared_transfer_id).toBe(a.data.prepared_transfer_id);
    expect(drafts()).toHaveLength(1);
    const c = await prepareTransferTool(principal(), args({ amount: 150 }), deps);
    if (!c.ok) throw new Error('expected ok');
    expect(c.data.prepared_transfer_id).not.toBe(a.data.prepared_transfer_id);
  });

  it("another tenant's recipient id and made-up ids are not found", async () => {
    const other = recipientRid('pb', PHONE, '919800000001');
    for (const recipient_id of [other, 'r_nope', 'x'.repeat(40)]) {
      expect(await prepareTransferTool(principal(), args({ recipient_id }), deps)).toEqual({ ok: false, message: RECIPIENT_NOT_FOUND });
    }
    expect(drafts()).toEqual([]);
  });

  it('purpose "other" needs a reason; a valid reason is kept on the draft', async () => {
    const missing = await prepareTransferTool(principal(), args({ purpose: 'other' }), deps);
    expect(missing).toEqual({ ok: false, message: expect.stringContaining('purpose_detail') });
    const r = await prepareTransferTool(principal(), args({ purpose: 'other', purpose_detail: 'Wedding gift for my cousin Ravi' }), deps);
    if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r)}`);
    const draft = await createDraftStore(redis).getDraft(r.data.prepared_transfer_id as string);
    expect(draft?.purposeDetail).toBe('Wedding gift for my cousin Ravi');
  });

  it('a reason that matches a scam pattern is refused (the app cannot show the warning); nothing says which words', async () => {
    const r = await prepareTransferTool(principal(), args({ purpose: 'other', purpose_detail: 'to claim my lottery prize' }), deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('portal');
    expect(r.message).not.toMatch(/lottery|prize/);
    expect(drafts()).toEqual([]);
  });

  it('over the daily limit → the cap message, no draft; a refusal is not replayed', async () => {
    const r = await prepareTransferTool(principal(), args({ amount: 9000 }), deps);
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/more than/) });
    expect(drafts()).toEqual([]);
    // The same call again runs again (refusals are never cached), and still refuses.
    expect((await prepareTransferTool(principal(), args({ amount: 9000 }), deps)).ok).toBe(false);
  });

  it('KYC gate on, unverified: the verify message, no draft and NO verification inquiry', async () => {
    await db.execute(sql`UPDATE partners SET require_kyc_before_send = true WHERE id = 'pa'`);
    await seedSender(db, { partnerId: 'pa', phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'pending' });
    deps = { toolDeps: toolDeps(), db, redis };
    const spy = vi.spyOn(kyc, 'startVerification');
    const r = await prepareTransferTool(principal(), args(), deps);
    expect(r).toEqual({ ok: false, message: expect.stringContaining('verify') });
    expect(spy).not.toHaveBeenCalled();
    expect(drafts()).toEqual([]);
  });

  it("shares the portal's per-customer send budget (20 an hour)", async () => {
    for (let i = 0; i < PORTAL_SEND_LIMIT.limit; i++) {
      await checkIpRateLimit(redis, PORTAL_SEND_LIMIT.scope, auditSubjectId('pa', PHONE), { limit: PORTAL_SEND_LIMIT.limit, windowSec: PORTAL_SEND_LIMIT.windowSec });
    }
    expect(await prepareTransferTool(principal(), args(), deps)).toEqual({ ok: false, message: PREPARE_TOO_MANY });
    expect(drafts()).toEqual([]);
  });
});

describe('cancel_prepared_transfer', () => {
  async function prepared(): Promise<string> {
    const r = await prepareTransferTool(principal(), args(), deps);
    if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r)}`);
    return r.data.prepared_transfer_id as string;
  }

  it('cancels an unpaid draft this app prepared; a second cancel finds nothing', async () => {
    const id = await prepared();
    const r = await cancelPreparedTransferTool(principal(), { prepared_transfer_id: id }, deps);
    expect(r).toMatchObject({ ok: true, data: { cancelled: true, prepared_transfer_id: id }, draftId: id });
    expect(await createDraftStore(redis).getDraft(id)).toBeNull();
    expect(await cancelPreparedTransferTool(principal(), { prepared_transfer_id: id }, deps)).toEqual({ ok: false, message: PREPARED_NOT_FOUND });
  });

  it("another app, another customer and another tenant get 'not found', and the draft stays", async () => {
    const id = await prepared();
    for (const p of [principal({ clientId: 'agc_other' }), principal({ phone: OTHER_PHONE }), principal({ partnerId: 'pb' })]) {
      expect(await cancelPreparedTransferTool(p, { prepared_transfer_id: id }, deps)).toEqual({ ok: false, message: PREPARED_NOT_FOUND });
    }
    expect(await createDraftStore(redis).getDraft(id)).not.toBeNull();
  });

  it("a draft the customer made in WhatsApp or the portal (no app marker) cannot be cancelled by an app", async () => {
    const id = await createDraftStore(redis).createDraft(
      {
        senderPhone: PHONE,
        partnerId: 'pa',
        recipient: { name: 'Asha Kumar', recipientPhone: RECIPIENT_PHONE, payoutMethod: 'bank', payoutDestination: '' },
        amountUsd: 50,
        amountSource: 50,
        sourceCurrency: 'USD',
        fundingMethod: 'bank_transfer',
        quote: { feeUsd: 0, fxRate: 85, amountInr: 4250 },
      },
      { pointer: 'web' },
    );
    expect(await cancelPreparedTransferTool(principal(), { prepared_transfer_id: id }, deps)).toEqual({ ok: false, message: PREPARED_NOT_FOUND });
    expect(await createDraftStore(redis).getDraft(id)).not.toBeNull();
  });

  it('junk ids are not found', async () => {
    for (const prepared_transfer_id of ['', '../x', 'a b', '#'.repeat(10)]) {
      expect(await cancelPreparedTransferTool(principal(), { prepared_transfer_id }, deps)).toEqual({ ok: false, message: PREPARED_NOT_FOUND });
    }
  });
});

describe('through the MCP handler', () => {
  async function connect(p: AgentPrincipal) {
    const recorded: unknown[][] = [];
    const auth: AgentAuth = {
      verifyAccessToken: async (token) => (token === 'sra_t' ? { ok: true, principal: p } : { ok: false, reason: 'invalid' }),
      toolsActive: async () => true,
      recordToolCall: async (...a) => {
        recorded.push(a.slice(1));
      },
    };
    const d = { site: async () => ({ partnerId: 'pa', slug: 'send' }), auth, redis, toolDeps: deps.toolDeps, db };
    const c = new Client({ name: 't', version: '0.0.1' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL('https://send.smartremit.ai/api/mcp'), {
        fetch: (url, init) => handleMcpRequest(new Request(url, init), d),
        requestInit: { headers: { Authorization: 'Bearer sra_t' } },
      }),
    );
    return { c, recorded };
  }

  it('prepare then cancel: JSON answers, and each audit row names the draft (never the arguments)', async () => {
    const { c, recorded } = await connect(principal());
    const r = await c.callTool({ name: 'prepare_transfer', arguments: { recipient_id: rid(), amount: 120, purpose: 'gift' } });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    const body = JSON.parse((r.content as Array<{ text: string }>)[0].text) as Record<string, unknown>;
    const id = body.prepared_transfer_id as string;
    expect(body).toMatchObject({ prepared: true, purpose: 'gift', send_amount: 120 });
    const x = await c.callTool({ name: 'cancel_prepared_transfer', arguments: { prepared_transfer_id: id } });
    expect(x.isError).toBeFalsy();
    expect(recorded).toEqual([
      ['prepare_transfer', 'ok', { draftId: id }],
      ['cancel_prepared_transfer', 'ok', { draftId: id }],
    ]);
    await c.close();
  });

  it('a refused prepare is an error result and its audit row carries no draft', async () => {
    const { c, recorded } = await connect(principal());
    const r = await c.callTool({ name: 'prepare_transfer', arguments: { recipient_id: 'r_nope', amount: 120, purpose: 'gift' } });
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content as Array<{ text: string }>)[0].text)).toEqual({ error: RECIPIENT_NOT_FOUND });
    expect(recorded).toEqual([['prepare_transfer', 'error', undefined]]);
    await c.close();
  });

  it('an unknown purpose is refused by the input schema (nothing runs)', async () => {
    const { c, recorded } = await connect(principal());
    const r = await c.callTool({ name: 'prepare_transfer', arguments: { recipient_id: rid(), amount: 120, purpose: 'crypto' } });
    expect(r.isError).toBe(true);
    expect(recorded).toEqual([]);
    expect(drafts()).toEqual([]);
    await c.close();
  });
});

describe('no pay path in the prepare tools (DoD grep)', () => {
  const src = readFileSync(join(process.cwd(), 'src/lib/mcp/prepare.ts'), 'utf8');
  it('the only money entry point is the draft seam: no mint, settlement, payment link or refund', () => {
    expect(src).toMatch(/prepareSendDraft\(ctx, input, \{\s*pointer: 'web'/);
    expect(src).not.toMatch(/\bcreateTransfer(?!Repo)\w*\(|createIdempotencyRepo|beginSettlement|finalizeDraftPayment|createPaymentLink|refundTransfer|requestRefund/);
    // The bot tools it runs: the read-only cap check only.
    expect([...src.matchAll(/executeTool\(\s*'([a-z_]+)'/g)].map((m) => m[1])).toEqual(['check_send_limit']);
    expect(src).not.toMatch(/buildToolContext\(/);
  });
});
