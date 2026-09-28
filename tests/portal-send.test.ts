import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Db } from '@/db/client';
import { buildToolContext, type ToolContextDeps } from '@/lib/tool-context';
import { executeTool } from '@/lib/tools';
import { getQuoteTyped } from '@/lib/send-seam';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createPartnerStore } from '@/lib/partner-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { resetRateCacheForTests } from '@/lib/rate';
import {
  loadSendReview,
  markReviewDrafted,
  narrowSendLimits,
  nonMintingKyc,
  parseAmount,
  parsePrefill,
  portalToolContext,
  quoteForPortal,
  saveSendReview,
  sendLimitsForPortal,
  toPrepareSendInput,
  validateSendForm,
  webFormTurn,
  PORTAL_FUNDING_METHODS,
  type SendFormValue,
} from '@/lib/portal-send';
import { fakeRedis, type FakeRedis } from './helpers';
import { sql } from 'drizzle-orm';
import { freshDb, seedLedgerSpend, seedPartner, seedSender } from './helpers-db';

// UI redesign M2-9, Task 9.1: the portal Send adapter. The same tool context as the bot (one builder,
// web channel) with a NON-MINTING KYC provider; quote and limits are the bot's own functions.

const PHONE = '14155550101';
let db: Db;
let redis: FakeRedis;

function stubFx() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, text: async () => '', json: async () => ({ rates: { INR: 85 } }) })),
  );
}

function deps(kyc?: MockKycProvider): Partial<ToolContextDeps> & { kycProvider: MockKycProvider } {
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  return {
    store,
    customerStore,
    scheduleStore: createScheduleStore(db),
    draftStore: createDraftStore(redis),
    dailyVolumeStore: createDailyVolumeStore(store),
    monthlyVolumeStore: createMonthlyVolumeStore(store),
    partnerStore: createPartnerStore(db),
    kycProvider: kyc ?? new MockKycProvider(customerStore, 'https://example.com'),
  };
}

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  redis = fakeRedis();
  stubFx();
  await seedPartner(db, 'pa', 'Partner A');
  await seedSender(db, { partnerId: 'pa', phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const owner = { partnerId: 'pa', phone: PHONE };
const gateOn = () => db.execute(sql`UPDATE partners SET require_kyc_before_send = true WHERE id = 'pa'`);

describe('portalToolContext', () => {
  it('is the one builder on the web channel: host partner + session phone, a web form turn, routeSelector present', () => {
    const d = deps();
    const ctx = portalToolContext(owner, d);
    const bot = buildToolContext({ partnerId: 'pa', phone: PHONE, channel: 'web', turn: webFormTurn(), deps: d });
    const plain = (c: object) =>
      Object.fromEntries(Object.entries(c).filter(([k, v]) => typeof v !== 'function' && k !== 'kycProvider'));
    expect(plain(ctx)).toEqual(plain(bot));
    expect(ctx.channel).toBe('web');
    expect(ctx.partnerId).toBe('pa');
    expect(ctx.phone).toBe(PHONE);
    expect(ctx.turn).toEqual({ isNewConversation: false });
    expect(typeof ctx.routeSelector).toBe('function');
  });

  it('the KYC provider never starts an inquiry (no providerRef, so nothing is recorded)', async () => {
    const d = deps();
    const spy = vi.spyOn(d.kycProvider, 'startVerification');
    const ctx = portalToolContext(owner, d);
    expect(await ctx.kycProvider.startVerification({ customerId: PHONE, senderPhone: PHONE })).toEqual({ url: '', providerRef: '' });
    expect(spy).not.toHaveBeenCalled();
    const wrapped = nonMintingKyc(d.kycProvider);
    const status = vi.spyOn(d.kycProvider, 'getStatus');
    await wrapped.getStatus('ref');
    expect(status).toHaveBeenCalledWith('ref');
  });
});

describe('quoteForPortal — parity with the bot', () => {
  it('equals getQuoteTyped on the bot context (the same numbers)', async () => {
    const d = deps();
    const input = { amountSource: 200, sourceCurrency: 'USD' as const, destinationCountry: 'IN' as const, fundingMethod: 'bank_transfer' as const };
    const web = await quoteForPortal(owner, input, d);
    const bot = await getQuoteTyped(buildToolContext({ partnerId: 'pa', phone: PHONE, channel: 'whatsapp', turn: webFormTurn(), deps: d }), input);
    expect(web.kind).toBe('quote');
    expect(web).toEqual(bot);
  });

  it('a verified customer inside the 3-day window, over the cap (gate on): the cap arm, and NO provider inquiry', async () => {
    await gateOn();
    await seedSender(db, { partnerId: 'pa', phone: PHONE, firstSeenDaysAgo: 1, kycStatus: 'verified' });
    const d = deps();
    const spy = vi.spyOn(d.kycProvider, 'startVerification');
    const r = await quoteForPortal(owner, { amountSource: 2000, sourceCurrency: 'USD', destinationCountry: 'IN', fundingMethod: 'bank_transfer' }, d);
    expect(r.kind).toBe('cap');
    expect(spy).not.toHaveBeenCalled();
    // The bot context (real provider) would have started one: the side effect the portal suppresses.
    const botR = await getQuoteTyped(buildToolContext({ partnerId: 'pa', phone: PHONE, channel: 'web', turn: webFormTurn(), deps: d }), {
      amountSource: 2000, sourceCurrency: 'USD', destinationCountry: 'IN', fundingMethod: 'bank_transfer',
    });
    expect(botR.kind).toBe('cap');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('sendLimitsForPortal', () => {
  it('reads check_send_limit (the same figures as the bot tool) and narrows it', async () => {
    const d = deps();
    const r = await sendLimitsForPortal(owner, { amountSource: 100, sourceCurrency: 'USD' }, d);
    const bot = await executeTool('check_send_limit', { amount_usd: 100, source_currency: 'USD' },
      buildToolContext({ partnerId: 'pa', phone: PHONE, channel: 'web', turn: webFormTurn(), deps: d }));
    expect(r).toEqual({
      kind: 'limits',
      withinCap: bot.within_cap,
      tier: bot.tier,
      reason: bot.reason,
      dailyCapUsd: bot.daily_cap_usd,
      perTransferCapUsd: bot.per_transfer_cap_usd,
      todayRemainingUsd: bot.today_remaining_usd,
      eddRequired: false,
    });
  });

  it('EDD: a send taking the month to $3,000 → eddRequired', async () => {
    const d = deps();
    await seedLedgerSpend(db, { partnerId: 'pa', phone: PHONE, amountUsd: 2900, status: 'paid' });
    const r = await sendLimitsForPortal(owner, { amountSource: 200, sourceCurrency: 'USD' }, d);
    expect(r).toMatchObject({ kind: 'limits', eddRequired: true });
  });

  it('a verified T0 customer (gate on): check_send_limit starts NO inquiry', async () => {
    await gateOn();
    await seedSender(db, { partnerId: 'pa', phone: PHONE, firstSeenDaysAgo: 1, kycStatus: 'verified' });
    const d = deps();
    const spy = vi.spyOn(d.kycProvider, 'startVerification');
    const r = await sendLimitsForPortal(owner, { amountSource: 50, sourceCurrency: 'USD' }, d);
    expect(r).toMatchObject({ kind: 'limits', tier: 'T0', withinCap: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it('narrowSendLimits: the KYC gate record → kyc_required; an unknown shape → unavailable (never raw)', () => {
    expect(narrowSendLimits({ within_cap: false, reason: 'kyc_required', kyc_url: '' })).toEqual({ kind: 'kyc_required' });
    expect(narrowSendLimits({ error: 'FX down' })).toEqual({ kind: 'unavailable' });
    expect(narrowSendLimits({ within_cap: true, tier: 'T1' })).toEqual({ kind: 'unavailable' });
  });
});

describe('toPrepareSendInput — consumer only', () => {
  it('sets exactly the consumer fields; the name is clamped', () => {
    const r = toPrepareSendInput({
      recipientPhone: '919876543210',
      recipientName: `  Mom‮ ${'x'.repeat(200)}`,
      amountSource: 100,
      sourceCurrency: 'USD',
      destinationCountry: 'IN',
      fundingMethod: 'bank_transfer',
    });
    expect(r).not.toBeNull();
    expect(Object.keys(r!).sort()).toEqual(['amountSource', 'destinationCountry', 'fundingMethod', 'recipientName', 'recipientPhone', 'sourceCurrency']);
    expect([...r!.recipientName].length).toBeLessThanOrEqual(80);
    expect(r!.recipientName).not.toContain('‮');
  });

  it('refuses a name that clamps to nothing, and a non-consumer funding method', () => {
    const base = { recipientPhone: '919876543210', amountSource: 1, sourceCurrency: 'USD' as const, destinationCountry: 'IN' as const };
    expect(toPrepareSendInput({ ...base, recipientName: '​', fundingMethod: 'bank_transfer' })).toBeNull();
    expect(toPrepareSendInput({ ...base, recipientName: 'Mom', fundingMethod: 'ach_pull' as never })).toBeNull();
  });
});

describe('edge validation', () => {
  const form = (f: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(f)) fd.set(k, v);
    return fd;
  };
  const good = { amount: '150.50', currency: 'USD', destination: 'IN', funding: 'bank_transfer', recipient: 'new', name: 'Mom', phone: '+91 98765 43210' };

  it('accepts a good new-recipient form', () => {
    const r = validateSendForm(form(good), { allowedCurrencies: ['USD'] });
    expect(r).toEqual({
      ok: true,
      value: { amountSource: 150.5, sourceCurrency: 'USD', destinationCountry: 'IN', fundingMethod: 'bank_transfer', recipient: { kind: 'new', name: 'Mom', phone: '919876543210' } },
    });
  });

  it('refuses ach_pull (it would make the send B2B) and any non-consumer funding', () => {
    for (const funding of ['ach_pull', 'bank_pull', 'card', '']) {
      const r = validateSendForm(form({ ...good, funding }), { allowedCurrencies: ['USD'] });
      expect(r.ok, funding).toBe(false);
    }
    expect(PORTAL_FUNDING_METHODS).not.toContain('ach_pull');
  });

  it('refuses a bad amount, currency, destination, rid, name or phone', () => {
    const bad: Array<[Record<string, string>, string]> = [
      [{ amount: '0' }, 'amount'], [{ amount: '1.234' }, 'amount'], [{ amount: '-5' }, 'amount'], [{ amount: 'abc' }, 'amount'],
      [{ currency: 'EUR' }, 'currency'], [{ destination: 'ZZ' }, 'destination'], [{ recipient: 'nope' }, 'recipient'],
      [{ name: '' }, 'name'], [{ phone: '123' }, 'phone'],
    ];
    for (const [over, field] of bad) {
      const r = validateSendForm(form({ ...good, ...over }), { allowedCurrencies: ['USD', 'GBP'] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(Object.keys(r.errors), JSON.stringify(over)).toContain(field);
    }
  });

  it('a single-currency partner needs no currency field; a saved rid is carried as-is', () => {
    const rid = 'a'.repeat(32);
    const r = validateSendForm(form({ amount: '10', destination: 'IN', funding: 'debit_card', recipient: rid }), { allowedCurrencies: ['USD'] });
    expect(r).toMatchObject({ ok: true, value: { sourceCurrency: 'USD', recipient: { kind: 'saved', rid } } });
  });

  it('parseAmount', () => {
    expect(parseAmount('1,000.00')).toBe(1000);
    expect(parseAmount('0.00')).toBeNull();
    expect(parseAmount(' 12.5 ')).toBe(12.5);
    expect(parseAmount(12 as never)).toBeNull();
  });
});

describe('H2: the Send pre-fill (initial values only; doubtful values dropped silently)', () => {
  it('keeps a valid amount, ISO2 destination and rid', () => {
    expect(parsePrefill({ amount: '250', to: 'IN', r: 'b'.repeat(32) }, { ceilingUsd: 2999, sourceCurrency: 'USD' })).toEqual({ amount: '250.00', to: 'IN', rid: 'b'.repeat(32) });
  });
  it('drops anything doubtful', () => {
    expect(parsePrefill({ amount: '0.5', to: 'in' }, { ceilingUsd: 2999, sourceCurrency: 'USD' })).toEqual({});
    expect(parsePrefill({ amount: '99999', to: 'ZZ' }, { ceilingUsd: 2999, sourceCurrency: 'USD' })).toEqual({});
    expect(parsePrefill({ amount: '1e3', to: ['IN', 'MX'], r: 'x' }, { ceilingUsd: 2999, sourceCurrency: 'USD' })).toEqual({});
    expect(parsePrefill({ amount: '12.345', to: 'IND' }, { ceilingUsd: 2999, sourceCurrency: 'USD' })).toEqual({});
    expect(parsePrefill({ amount: '<script>' }, { ceilingUsd: 2999, sourceCurrency: 'USD' })).toEqual({});
  });
  it('the USD ceiling is not applied to another send currency (units differ)', () => {
    expect(parsePrefill({ amount: '50000' }, { ceilingUsd: 2999, sourceCurrency: 'INR' })).toEqual({ amount: '50000.00' });
  });
});

describe('the review slot', () => {
  const v: SendFormValue = { amountSource: 100, sourceCurrency: 'USD', destinationCountry: 'IN', fundingMethod: 'bank_transfer', recipient: { kind: 'new', name: 'Mom', phone: '919876543210' } };

  it('is bound to (partner, phone): another tenant or phone reads nothing; no PII in the key', async () => {
    const id = await saveSendReview(redis, owner, v);
    expect(await loadSendReview(redis, owner)).toEqual({ ...v, id });
    expect(await loadSendReview(redis, { partnerId: 'pb', phone: PHONE })).toBeNull();
    expect(await loadSendReview(redis, { partnerId: 'pa', phone: '14155550102' })).toBeNull();
    for (const k of redis.dump.keys()) {
      expect(k).not.toContain(PHONE);
      expect(k).not.toContain('pa');
      expect(k).not.toContain(createHash('sha256').update(`pa|${PHONE}`).digest('hex')); // keyed, not a bare hash
    }
  });

  it('a new save replaces the old one (a new id); markReviewDrafted only lands on the same id', async () => {
    const id1 = await saveSendReview(redis, owner, v);
    const id2 = await saveSendReview(redis, owner, { ...v, amountSource: 200 });
    expect(id2).not.toBe(id1);
    await markReviewDrafted(redis, owner, id1, 'drft_abcdef');
    expect((await loadSendReview(redis, owner))?.draftId).toBeUndefined();
    await markReviewDrafted(redis, owner, id2, 'drft_abcdef');
    expect(await loadSendReview(redis, owner)).toMatchObject({ id: id2, amountSource: 200, draftId: 'drft_abcdef' });
  });

  it('a malformed slot reads as none', async () => {
    await saveSendReview(redis, owner, v);
    const [k] = [...redis.dump.keys()].filter((x) => x.startsWith('psend:'));
    await redis.set(k, JSON.stringify({ id: 'x', amountSource: 1 }));
    expect(await loadSendReview(redis, owner)).toBeNull();
    await redis.set(k, 'not json');
    expect(await loadSendReview(redis, owner)).toBeNull();
  });
});

describe('no web mint (money-path DoD grep)', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  }
  it('no mint entry point (createTransfer*, createIdempotencyRepo, beginSettlement, finalizeDraftPayment) appears in the portal app or portal libs', () => {
    const root = process.cwd();
    const files = [
      ...walk(join(root, 'src/app/portal')),
      ...readdirSync(join(root, 'src/lib')).filter((n) => n.startsWith('portal-')).map((n) => join(root, 'src/lib', n)),
    ].filter((f) => /\.(ts|tsx)$/.test(f));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      // The mint entry points (createTransferRepo is the read repo; the request-key guard's comment mentions pay-finalize's idempotency by name).
      expect(src, f).not.toMatch(/\bcreateTransfer(?!Repo)\w*\(|createIdempotencyRepo|beginSettlement|finalizeDraftPayment/);
    }
  });
});
