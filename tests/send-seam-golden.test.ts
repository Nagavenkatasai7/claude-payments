import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { executeTool, type ToolContext } from '@/lib/tools';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { createPartnerStore } from '@/lib/partner-store';
import { resetRateCacheForTests } from '@/lib/rate';
import { T0_DAILY_CAP_CENTS } from '@/lib/tier-rules';
import type { Db } from '@/db/client';
import type { Customer, PartnerId } from '@/lib/types';
import { fakeRedis, type FakeRedis } from './helpers';
import { freshDb, seedLedgerSpend, seedPartner } from './helpers-db';

// UI redesign M2-4, Task 4.2 step 1: the GOLDEN corpus for the bot's send path.
//
// Captured on UNCHANGED code (before the typed send seam was extracted from
// sendApprovePickerTool / getQuoteTool). Every bot-visible output is recorded:
// the tool result (key order included — the model reads serialised JSON), the
// WhatsApp request the tool makes (card text + CTA url), every Redis key and
// value written (the draft JSON, the active-draft pointer, the card-dedupe key),
// the ledger side effects (blocked rows, audit actions, KYC inquiry) and the
// logger scopes. Only ids and ISO timestamps are normalised — ordinally, so the
// card url, the draft key and draft_id are proven to carry the SAME id.
//
// The refactor must leave this file byte-identical. Regenerate ONLY on unchanged
// code: UPDATE_SEND_SEAM_GOLDEN=1 npx vitest run tests/send-seam-golden.test.ts

const GOLDEN_PATH = join(__dirname, '__golden__', 'send-seam.json');
const UPDATE = process.env.UPDATE_SEND_SEAM_GOLDEN === '1';

const PHONE = '15551234567';
const MOM = '919876543210';
const MOCK_RATE = 85.0;
const SENDER_FULL_NAME = 'Alex Rivera';
const SAVED_BANK = '123456789012|HDFC0001234';
const T0_CAP_USD = T0_DAILY_CAP_CENTS / 100;

let db: Db;
let base: number;

interface Captured {
  sends: Array<{ url: string; body: unknown }>;
  warns: string[];
}

function fxResponse(rate = MOCK_RATE) {
  return { ok: true, text: async () => '', json: async () => ({ rates: { INR: rate } }) };
}

/** fetch routed by URL: Graph API sends are captured; everything else is the FX stub. */
function stubFetch(cap: Captured, opts: { fxDown?: boolean; graphThrows?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('graph.facebook.com')) {
        cap.sends.push({ url: String(url), body: init?.body ? JSON.parse(init.body as string) : null });
        if (opts.graphThrows) throw new Error('network reset');
        return { ok: true, text: async () => '', json: async () => ({}) };
      }
      if (opts.fxDown) throw new Error('net');
      return fxResponse();
    }),
  );
}

async function buildCtx(
  redis: FakeRedis,
  opts: { phone?: string; partnerId?: PartnerId; customer?: Partial<Customer>; noName?: boolean } = {},
): Promise<ToolContext> {
  const phone = opts.phone ?? PHONE;
  const partnerId = opts.partnerId ?? 'default';
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: phone, firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId, optInAt: nowIso,
    ...(opts.noName ? {} : { fullName: SENDER_FULL_NAME }),
    createdAt: nowIso, updatedAt: nowIso,
    ...opts.customer,
  } as Customer);
  return {
    phone,
    partnerId,
    store,
    scheduleStore: createScheduleStore(db),
    draftStore: createDraftStore(redis),
    turn: { isNewConversation: false },
    customerStore,
    dailyVolumeStore: createDailyVolumeStore(store),
    monthlyVolumeStore: createMonthlyVolumeStore(store),
    kycProvider: new MockKycProvider(customerStore, 'https://example.com'),
    partnerStore: createPartnerStore(db),
  };
}

async function savePartner(ctx: ToolContext, id: string, over: Record<string, unknown>) {
  const nowIso = new Date().toISOString();
  await ctx.partnerStore.savePartner({
    id, name: id, countries: ['US'], status: 'active', kycMode: 'ours',
    createdAt: nowIso, updatedAt: nowIso, ...over,
  } as Parameters<ToolContext['partnerStore']['savePartner']>[0]);
}

async function seedB2bBills(ctx: ToolContext) {
  await db.execute(sql`TRUNCATE b2b_invoices`);
  const seed = (id: string, buyerPhone: string, status: 'unpaid' | 'paid', extra: { sellerId?: string } = {}) =>
    ctx.store.saveB2bInvoice({
      id, partnerId: 'default', businessName: 'Globex Trading LLC', buyerPhone,
      lineItems: [{ description: 'Widgets', qty: 1, unitAmountUsd: 400 }], amountUsd: 400, currency: 'USD',
      status, createdAt: new Date().toISOString(), ...extra,
    });
  await seed('inv_mine', ctx.phone, 'unpaid');
  await seed('inv_paid', ctx.phone, 'paid');
  await ctx.store.createSeller({ id: 's_golden', partnerId: 'default', phone: '15557770000', businessName: 'Globex Trading LLC', country: 'US', currency: 'USD' });
  await seed('inv_checkout', ctx.phone, 'unpaid', { sellerId: 's_golden' });
}

const b2bArgs = (over: Record<string, unknown>) => ({
  amount_source: 400, recipient_name: 'Globex Trading LLC', recipient_phone: MOM,
  sender_business_name: 'Acme Imports Ltd', recipient_business_name: 'Globex Trading LLC', ...over,
});

const pick = (over: Record<string, unknown> = {}) => ({
  amount_usd: 200, funding_method: 'bank_transfer', recipient_name: 'Mom', recipient_phone: MOM,
  destination_country: 'IN', ...over,
});

/** One tool call (or a thrown error) as data. */
async function call(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  try {
    return { ok: await executeTool(name, args, ctx) };
  } catch (err) {
    return { threw: err instanceof Error ? err.message : String(err) };
  }
}

interface Scenario {
  name: string;
  /** false ⇒ the Redis dump is left out (the web pointer changes by design, M2-4 Task 4.1). */
  redis?: boolean;
  run: (h: { redis: FakeRedis; cap: Captured }) => Promise<unknown[]>;
}

const SCENARIOS: Scenario[] = [
  // ── send_approve_picker (WhatsApp) ──
  {
    name: 'picker.happy_bank_saved',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      await ctx.store.upsertRecipient('default', PHONE, {
        name: 'Mom', recipientPhone: MOM, payoutMethod: 'bank', payoutDestination: SAVED_BANK, lastUsedAt: new Date().toISOString(),
      });
      stubFetch(cap);
      return [await call('send_approve_picker', pick(), ctx)];
    },
  },
  {
    name: 'picker.happy_upi_saved',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      await ctx.store.upsertRecipient('default', PHONE, {
        name: 'Mom', recipientPhone: MOM, payoutMethod: 'upi', payoutDestination: 'mom@upi', lastUsedAt: new Date().toISOString(),
      });
      stubFetch(cap);
      return [await call('send_approve_picker', pick({ funding_method: 'debit_card' }), ctx)];
    },
  },
  {
    name: 'picker.happy_cold_start_payout_args_ignored',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      stubFetch(cap);
      return [await call('send_approve_picker', pick({ payout_method: 'upi', payout_destination: 'evil@upi', destination_country: undefined, amount_usd: undefined, amount_source: 150 }), ctx)];
    },
  },
  {
    name: 'picker.invalid_phone',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      stubFetch(cap);
      return [await call('send_approve_picker', pick({ recipient_phone: '12' }), ctx)];
    },
  },
  {
    name: 'picker.bad_funding',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      stubFetch(cap);
      return [
        await call('send_approve_picker', pick({ funding_method: 'crypto' }), ctx),
        await call('send_approve_picker', pick({ funding_method: 'bank_pull' }), ctx),
      ];
    },
  },
  {
    name: 'picker.unknown_destination',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      stubFetch(cap);
      return [await call('send_approve_picker', pick({ destination_country: 'ZZ' }), ctx)];
    },
  },
  {
    name: 'picker.missing_destination',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      stubFetch(cap);
      return [await call('send_approve_picker', pick({ destination_country: undefined, recipient_phone: '525512345678' }), ctx)];
    },
  },
  {
    name: 'picker.kyc_gate_unverified',
    run: async ({ redis, cap }) => {
      const dflt = await buildCtx(redis);
      await savePartner(dflt, 'gated', { requireKycBeforeSend: true });
      const ctx = await buildCtx(redis, { partnerId: 'gated', customer: { kycStatus: 'not_started' } });
      stubFetch(cap);
      return [await call('send_approve_picker', pick(), ctx)];
    },
  },
  {
    name: 'picker.sender_name_required',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis, { noName: true });
      stubFetch(cap);
      return [await call('send_approve_picker', pick(), ctx)];
    },
  },
  {
    name: 'picker.t0_daily_cap',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis, { customer: { firstSeenAt: new Date(Date.now() - 86_400_000).toISOString() } });
      await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: T0_CAP_USD - 100, status: 'paid' });
      stubFetch(cap);
      return [await call('send_approve_picker', pick({ amount_usd: 200 }), ctx)];
    },
  },
  {
    name: 'picker.per_transfer_cap',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      stubFetch(cap);
      return [await call('send_approve_picker', pick({ amount_usd: T0_CAP_USD + 200 }), ctx)];
    },
  },
  {
    name: 'picker.sanctions_blocked',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      stubFetch(cap);
      return [await call('send_approve_picker', pick({ recipient_name: 'John Doe' }), ctx)];
    },
  },
  {
    name: 'picker.fx_unavailable',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      stubFetch(cap, { fxDown: true });
      return [await call('send_approve_picker', pick(), ctx)];
    },
  },
  {
    name: 'picker.quote_error_below_min',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      stubFetch(cap);
      return [await call('send_approve_picker', pick({ amount_usd: 0.5 }), ctx)];
    },
  },
  {
    name: 'picker.delegated_partner_gate_off',
    run: async ({ redis, cap }) => {
      const dflt = await buildCtx(redis);
      await savePartner(dflt, 'deleg', { kycMode: 'delegated', requireKycBeforeSend: false });
      const ctx = await buildCtx(redis, { partnerId: 'deleg', customer: { kycStatus: 'not_started' } });
      stubFetch(cap);
      return [await call('send_approve_picker', pick(), ctx)];
    },
  },
  {
    name: 'picker.default_tenant_route_selector',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      stubFetch(cap);
      const routed: ToolContext = {
        ...ctx,
        routeSelector: async () => ({ fxRate: 86, source: 'partner' as const, settlementPartnerId: 'rail-partner-x' }),
      };
      return [await call('send_approve_picker', pick(), routed)];
    },
  },
  {
    name: 'picker.duplicate_card_deduped',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      stubFetch(cap);
      return [await call('send_approve_picker', pick(), ctx), await call('send_approve_picker', pick(), ctx)];
    },
  },
  {
    name: 'picker.send_failure_releases_dedupe',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      stubFetch(cap, { graphThrows: true });
      const first = await call('send_approve_picker', pick(), ctx);
      stubFetch(cap);
      return [first, await call('send_approve_picker', pick(), ctx)];
    },
  },
  {
    name: 'picker.b2b_refusals',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      await seedB2bBills(ctx);
      stubFetch(cap);
      const out: unknown[] = [];
      for (const over of [
        { funding_method: 'ach_pull' },
        { funding_method: 'ach_pull', entity_type: 'business', invoice_id: 'inv_nope' },
        { funding_method: 'ach_pull', entity_type: 'business', invoice_id: 'inv_paid' },
        { funding_method: 'ach_pull', entity_type: 'business', invoice_id: 'inv_checkout' },
        { funding_method: 'ach_pull', entity_type: 'business', invoice_id: 'inv_mine', amount_source: 399 },
      ]) {
        out.push(await call('send_approve_picker', b2bArgs(over), ctx));
      }
      return out;
    },
  },
  {
    name: 'picker.b2b_happy',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      await seedB2bBills(ctx);
      stubFetch(cap);
      return [await call('send_approve_picker', b2bArgs({ funding_method: 'ach_pull', entity_type: 'business', invoice_id: 'inv_mine' }), ctx)];
    },
  },
  {
    name: 'picker.edd_fields_on_draft',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      stubFetch(cap);
      return [await call('send_approve_picker', pick({
        recipient_legal_name: 'Sita Devi', relationship: 'family', purpose: 'family_support',
        source_of_funds: 'salary', occupation: 'not_an_enum',
      }), ctx)];
    },
  },
  {
    name: 'picker.tenant_pair_same_phone',
    run: async ({ redis, cap }) => {
      await seedPartner(db, 'pa', 'Partner A');
      await seedPartner(db, 'pb', 'Partner B');
      const pa = await buildCtx(redis, { partnerId: 'pa' });
      const pb = await buildCtx(redis, { partnerId: 'pb' });
      await pa.store.upsertRecipient('pa', PHONE, {
        name: 'Mom', recipientPhone: MOM, payoutMethod: 'bank', payoutDestination: SAVED_BANK, lastUsedAt: new Date().toISOString(),
      });
      stubFetch(cap);
      return [
        await call('send_approve_picker', pick(), pa),
        await call('send_approve_picker', pick({ amount_usd: 120 }), pb),
        await call('cancel_draft', {}, pb),
      ];
    },
  },
  {
    name: 'cancel_draft.after_picker',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      stubFetch(cap);
      return [
        await call('send_approve_picker', pick(), ctx),
        await call('cancel_draft', {}, ctx),
        await call('cancel_draft', {}, ctx),
      ];
    },
  },
  // ── web channel: the result is pinned; the pointer key changes by design (Task 4.1) ──
  {
    name: 'web.repeat_transfer_result',
    redis: false,
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      await seedLedgerSpend(db, {
        partnerId: 'default', phone: PHONE, amountUsd: 50, status: 'delivered', id: 'past_golden_1',
        createdAt: new Date(Date.now() - 2 * 86_400_000),
      });
      stubFetch(cap);
      return [await call('repeat_transfer', { transfer_id: 'past_golden_1' }, { ...ctx, channel: 'web' })];
    },
  },
  // ── get_quote ──
  {
    name: 'quote.happy',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      stubFetch(cap);
      return [await call('get_quote', { amount_usd: 200, funding_method: 'bank_transfer' }, ctx)];
    },
  },
  {
    name: 'quote.receive_first_routed',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      stubFetch(cap);
      const routed: ToolContext = {
        ...ctx,
        routeSelector: async () => ({ fxRate: 86, source: 'partner' as const, settlementPartnerId: 'rail-partner-x' }),
      };
      return [
        await call('get_quote', { amount_dest: 10000, funding_method: 'bank_transfer' }, routed),
        await call('get_quote', { amount_usd: 100, funding_method: 'debit_card' }, routed),
      ];
    },
  },
  {
    name: 'quote.kyc_gate',
    run: async ({ redis, cap }) => {
      const dflt = await buildCtx(redis);
      await savePartner(dflt, 'gated', { requireKycBeforeSend: true });
      const ctx = await buildCtx(redis, { partnerId: 'gated', customer: { kycStatus: 'not_started' } });
      stubFetch(cap);
      return [await call('get_quote', { amount_usd: 200 }, ctx)];
    },
  },
  {
    name: 'quote.cap_without_kyc_url',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      stubFetch(cap);
      return [await call('get_quote', { amount_usd: T0_CAP_USD + 200 }, ctx)];
    },
  },
  {
    name: 'quote.cap_with_kyc_url',
    run: async ({ redis, cap }) => {
      const dflt = await buildCtx(redis);
      await savePartner(dflt, 'gated', { requireKycBeforeSend: true });
      const ctx = await buildCtx(redis, { partnerId: 'gated' });
      stubFetch(cap);
      return [await call('get_quote', { amount_usd: T0_CAP_USD + 200 }, ctx)];
    },
  },
  {
    name: 'quote.fx_unavailable',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      stubFetch(cap, { fxDown: true });
      return [await call('get_quote', { amount_usd: 200 }, ctx)];
    },
  },
  {
    name: 'quote.errors',
    run: async ({ redis, cap }) => {
      const ctx = await buildCtx(redis);
      stubFetch(cap);
      return [
        await call('get_quote', { amount_usd: 0.5 }, ctx),
        await call('get_quote', { amount_usd: 100, destination_country: 'ZZ' }, ctx),
        await call('get_quote', { amount_usd: 'abc' }, ctx),
      ];
    },
  },
];

/** Replace every draft/transfer id ordinally (first seen → ID_1) and every ISO timestamp. */
function normalizeGolden(raw: string, ids: string[]): string {
  let out = raw;
  const ordered = [...new Set(ids)]
    .filter((id) => out.includes(id))
    .sort((a, b) => out.indexOf(a) - out.indexOf(b));
  ordered.forEach((id, i) => {
    out = out.split(id).join(`ID_${i + 1}`);
  });
  // Epoch-ms stamps (the draft's fxFetchedAt) are written relative to the
  // per-run clock, so tomorrow's run produces the same bytes.
  return out
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<ISO>')
    .replace(/\b1\d{12}\b/g, (ms) => `<NOW${Number(ms) - base >= 0 ? '+' : ''}${Number(ms) - base}ms>`);
}

async function runScenario(s: Scenario): Promise<unknown> {
  resetRateCacheForTests();
  db = await freshDb();
  vi.useFakeTimers({ toFake: ['Date'], now: base });
  const redis = fakeRedis();
  const cap: Captured = { sends: [], warns: [] };
  vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
    try {
      cap.warns.push(String((JSON.parse(String(line)) as { scope?: string }).scope));
    } catch {
      cap.warns.push('non-json');
    }
  });
  const calls = await s.run({ redis, cap });

  const transfers = (await db.execute(
    sql`SELECT id, partner_id, status, compliance_status FROM transfers ORDER BY created_at, id`,
  )) as unknown as { rows: Array<{ id: string; partner_id: string; status: string; compliance_status: string }> };
  const audits = (await db.execute(
    sql`SELECT action, partner_id, subject_id FROM audit_events ORDER BY id`,
  )) as unknown as { rows: Array<{ action: string; partner_id: string; subject_id: string | null }> };
  const kyc = (await db.execute(
    sql`SELECT partner_id, kyc_inquiry_id FROM customers WHERE kyc_inquiry_id IS NOT NULL ORDER BY partner_id`,
  )) as unknown as { rows: Array<{ partner_id: string; kyc_inquiry_id: string }> };

  const keys = [...redis.dump.keys()].sort();
  const snapshot: Record<string, unknown> = {
    calls,
    sends: cap.sends,
    ...(s.redis === false ? {} : { redis: Object.fromEntries(keys.map((k) => [k, redis.dump.get(k)])) }),
    transfers: transfers.rows.filter((r) => r.id !== 'past_golden_1'),
    audits: audits.rows,
    kycInquiries: kyc.rows,
    warns: cap.warns,
  };
  const ids = [
    ...keys.filter((k) => k.startsWith('recipient_draft:')).map((k) => k.slice('recipient_draft:'.length)),
    ...keys.filter((k) => k.startsWith('active_draft:')).map((k) => redis.dump.get(k) ?? ''),
    ...transfers.rows.map((r) => r.id),
  ].filter((id) => id.length > 0);
  // Draft ids consumed before the dump (cancel_draft) survive only in results/sends.
  const raw = JSON.stringify(snapshot);
  for (const m of raw.matchAll(/\/pay\/([A-Za-z0-9_-]{22})/g)) ids.push(m[1]);
  for (const m of raw.matchAll(/"draft_id":"([A-Za-z0-9_-]+)"/g)) ids.push(m[1]);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  const normalized = JSON.parse(normalizeGolden(raw, ids)) as Record<string, unknown>;
  // Redis keys embed random ids, so the order is fixed AFTER normalisation.
  if (normalized.redis) {
    const r = normalized.redis as Record<string, unknown>;
    normalized.redis = Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k]]));
  }
  return normalized;
}

beforeEach(() => {
  // A relative, fixed-per-run clock (CLAUDE.md: no hardcoded dates near time
  // windows): today, 16:00 UTC (noon ET — clear of any ET-day boundary).
  const d = new Date();
  d.setUTCHours(16, 0, 0, 0);
  base = d.getTime();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('send seam golden corpus (bot output pinned byte-for-byte)', () => {
  it('covers every scenario exactly once', () => {
    expect(new Set(SCENARIOS.map((s) => s.name)).size).toBe(SCENARIOS.length);
  });

  if (UPDATE) {
    it('regenerates the golden file (UPDATE_SEND_SEAM_GOLDEN=1, unchanged code only)', async () => {
      const out: Record<string, unknown> = {};
      for (const s of SCENARIOS) out[s.name] = await runScenario(s);
      if (!existsSync(dirname(GOLDEN_PATH))) mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(out, null, 2)}\n`);
    }, 120_000);
    return;
  }

  const golden = existsSync(GOLDEN_PATH)
    ? (JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, unknown>)
    : {};

  it('the golden file lists exactly the scenarios', () => {
    expect(Object.keys(golden).sort()).toEqual(SCENARIOS.map((s) => s.name).sort());
  });

  for (const s of SCENARIOS) {
    it(`${s.name} matches the golden capture`, async () => {
      const actual = await runScenario(s);
      expect(JSON.stringify(actual, null, 2)).toBe(JSON.stringify(golden[s.name], null, 2));
    });
  }
});
