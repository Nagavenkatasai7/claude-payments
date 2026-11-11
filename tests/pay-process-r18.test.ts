/**
 * Fix pack 4 T8 (C9, C10, C8): processTransferPayment's R18 gate and the
 * evidence commit, "authorise, then capture". After the pack 3 live gate and
 * BEFORE any charge, a mandatory payment (certified owner, or a real-money
 * rail; b2c) needs an approved provider block and a current acknowledgement;
 * then the customer's evidence is committed on the locked awaiting row. If it
 * cannot be written, nothing is charged (503). Called directly (the routes
 * thread the evidence from T9).
 */
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { approveDisclosureForTest, certifyPartnerForTest } from './helpers-live';
import { testEvidence } from './helpers-pay-evidence';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { PAY_APPROVAL_NOT_RECORDED_COPY, PAY_RELOAD_REQUIRED_COPY } from '@/lib/pay-outcome';
import { fixedReply } from '@/lib/hold-replies';
import type { Transfer } from '@/lib/types';
import type { PartnerIntegrations } from '@/lib/partner-integrations';

vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: () => {} };
});
vi.mock('@/lib/whatsapp', () => ({
  sendText: vi.fn().mockResolvedValue(undefined),
  sendTransactionOtp: vi.fn().mockResolvedValue(undefined),
  sendTemplate: vi.fn().mockResolvedValue(undefined),
  RECIPIENT_TEMPLATE_NAME: 'transfer_delivered',
  RECIPIENT_TEMPLATE_LANG: 'en',
}));

let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({
    getPartner: async () => null,
    ensureDefaultPartner: async () => ({
      id: 'default', name: 'SmartRemit Default', countries: ['US'], status: 'active',
      requireKycBeforeSend: true,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }),
  }),
}));

// Owner reads are observed, and can be made to throw for one partner id only.
const owner = vi.hoisted(() => ({ reads: [] as string[], throwFor: null as string | null }));
vi.mock('@/db/repos/partner-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/partner-repo')>();
  return {
    ...real,
    createPartnerRepo: (...a: Parameters<typeof real.createPartnerRepo>) => {
      const r = real.createPartnerRepo(...a);
      return {
        ...r,
        getPartner: async (id: string) => {
          owner.reads.push(id);
          if (owner.throwFor === id) throw new Error('owner-read-leak postgres://user:pw@host/db');
          return r.getPartner(id);
        },
      };
    },
  };
});

const rails = vi.hoisted(() => ({ byPartner: {} as Record<string, PartnerIntegrations['payment']> }));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async (id: string) => ({ kyc: {}, whatsapp: {}, payment: rails.byPartner[id] ?? {} }),
  }),
}));

const capture = vi.hoisted(() => vi.fn());
vi.mock('@/lib/providers/funding-provider', async (orig) => {
  const real = await orig<typeof import('@/lib/providers/funding-provider')>();
  return {
    ...real,
    getFundingProvider: () => ({ capture: (...a: unknown[]) => capture(...a), refund: vi.fn(), handleWebhook: vi.fn() }),
  };
});

import { processTransferPayment } from '@/lib/pay-process';

const SENDER = '15551234567';
function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: SENDER, amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85,
    amountInr: 17000, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789 HDFC0001234',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date().toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default',
    amountSource: 200, feeSource: 0, totalChargeSource: 200, ...o,
  };
}

type Row = { action: string; partner_id: string | null; subject_id: string | null; meta: Record<string, unknown> };
const evidenceRows = async (): Promise<Row[]> =>
  ((await db.execute(sql`SELECT action, partner_id, subject_id, meta FROM audit_events
    WHERE action IN ('otp.verified', 'remittance.disclosure_ack') ORDER BY id`)) as unknown as { rows: Row[] }).rows;
const alerts = async () =>
  ((await db.execute(sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'ops.alert'`)) as unknown as {
    rows: Array<{ dedupe_key: string; payload: { message: string } }>;
  }).rows;
const warnLines = (spy: ReturnType<typeof vi.spyOn>, scope: string) =>
  spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(`"scope":"${scope}"`));

const PUBLIC_RAIL = { providerType: 'http', credentials: { settlementUrl: 'https://rail.acme-test.com/settle', signingSecret: 's' } } as const;
const NOT_AVAILABLE = { ok: false, error: fixedReply('cannot_complete'), reason: 'not_available' };
const RELOAD = { ok: false, reason: 'reload_required', error: PAY_RELOAD_REQUIRED_COPY };

/** acme: certified unless `certify: false`; its block approved only with `approve: true`; a mock rail. */
async function acme(o: { certify?: boolean; approve?: boolean } = {}): Promise<void> {
  await seedPartner(db, 'acme');
  if (o.certify ?? true) await certifyPartnerForTest(db, 'acme');
  if (o.approve) await approveDisclosureForTest(db, 'acme');
  rails.byPartner.acme = { providerType: 'mock' };
}
async function acmeHash(): Promise<string> {
  const { resolvePartnerDisclosure } = await import('@/lib/partner-config');
  const { createPartnerRepo } = await import('@/db/repos/partner-repo');
  const h = resolvePartnerDisclosure(await createPartnerRepo(db).getPartner('acme')).hash;
  owner.reads.length = 0;
  return h!;
}
async function pay(t: Transfer, ev?: Parameters<typeof processTransferPayment>[2]) {
  const res = await processTransferPayment(store, t, ev);
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  rails.byPartner = {};
  owner.reads = [];
  owner.throwFor = null;
  capture.mockReset();
  capture.mockResolvedValue({ fundingRef: 'fund-abc' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pay-process: the default tenant (not mandatory, no owner read)', () => {
  it('default owner, mock rail, no evidence -> paid exactly as before; no otp.verified or ack row', async () => {
    const t = makeTransfer({ id: 'd1' });
    await store.saveTransfer(t);
    expect(await pay(t)).toEqual({ status: 200, body: { ok: true, status: 'paid' } });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(await evidenceRows()).toEqual([]);
    expect(owner.reads).not.toContain('default');
  });

  it('default owner + testEvidence() -> paid; one otp.verified row; ack providerKind demo; a demo snapshot', async () => {
    const t = makeTransfer({ id: 'd2' });
    await store.saveTransfer(t);
    expect(await pay(t, testEvidence({ routeId: 'd2' }))).toEqual({ status: 200, body: { ok: true, status: 'paid' } });
    const rows = await evidenceRows();
    expect(rows.map((r) => r.action)).toEqual(['otp.verified', 'remittance.disclosure_ack']);
    expect(rows[0]).toMatchObject({ partner_id: 'default', subject_id: 'd2' });
    expect(rows[1].meta).toMatchObject({ providerKind: 'demo' });
    const snap = await createTransferRepo(db).getDisclosureSnapshot('d2', 'default');
    expect(snap?.provider.kind).toBe('demo');
    expect(snap?.provider.approved).toBe(false);
    expect(owner.reads).not.toContain('default');
  });
});

describe('pay-process: the R18 gate (C10)', () => {
  it('certified owner on a mock rail, block unapproved -> 409 PAY_NOT_AVAILABLE, never charged, no row', async () => {
    await acme();
    const t = makeTransfer({ id: 'c1', partnerId: 'acme' });
    await store.saveTransfer(t);
    expect(await pay(t, testEvidence({ routeId: 'c1' }))).toEqual({ status: 409, body: NOT_AVAILABLE });
    expect(capture).not.toHaveBeenCalled();
    expect(await evidenceRows()).toEqual([]);
    expect((await store.getTransfer('c1'))?.status).toBe('awaiting_payment');
  });

  it('certified owner, approved block, no ack -> 409 reload_required, never charged, no row', async () => {
    await acme({ approve: true });
    const t = makeTransfer({ id: 'c2', partnerId: 'acme' });
    await store.saveTransfer(t);
    expect(await pay(t, testEvidence({ routeId: 'c2', ack: false }))).toEqual({ status: 409, body: RELOAD });
    expect(capture).not.toHaveBeenCalled();
    expect(await evidenceRows()).toEqual([]);
  });

  it('no evidence at all -> the same 409 reload_required', async () => {
    await acme({ approve: true });
    const t = makeTransfer({ id: 'c3', partnerId: 'acme' });
    await store.saveTransfer(t);
    expect(await pay(t)).toEqual({ status: 409, body: RELOAD });
    expect(capture).not.toHaveBeenCalled();
  });

  it('approved, ack, shownHash !== hash -> 409 reload_required', async () => {
    await acme({ approve: true });
    const t = makeTransfer({ id: 'c4', partnerId: 'acme' });
    await store.saveTransfer(t);
    expect(await pay(t, testEvidence({ routeId: 'c4', shownHash: `dh1:${'0'.repeat(64)}` }))).toEqual({ status: 409, body: RELOAD });
    expect(capture).not.toHaveBeenCalled();
    expect(await evidenceRows()).toEqual([]);
  });

  it('approved, ack, shownHash null -> paid', async () => {
    await acme({ approve: true });
    const t = makeTransfer({ id: 'c5', partnerId: 'acme' });
    await store.saveTransfer(t);
    expect(await pay(t, testEvidence({ routeId: 'c5' }))).toEqual({ status: 200, body: { ok: true, status: 'paid' } });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('approved, ack, shownHash === hash -> paid, rows + snapshot', async () => {
    await acme({ approve: true });
    const hash = await acmeHash();
    const t = makeTransfer({ id: 'c6', partnerId: 'acme' });
    await store.saveTransfer(t);
    expect(await pay(t, testEvidence({ routeId: 'c6', shownHash: hash }))).toEqual({ status: 200, body: { ok: true, status: 'paid' } });
    const rows = await evidenceRows();
    expect(rows.map((r) => r.action)).toEqual(['otp.verified', 'remittance.disclosure_ack']);
    expect(rows.every((r) => r.partner_id === 'acme')).toBe(true);
    expect(rows[1].meta).toMatchObject({ providerKind: 'configured', shownHash: hash });
    const snap = await createTransferRepo(db).getDisclosureSnapshot('c6', 'acme');
    expect(snap).toMatchObject({ configHash: hash, shownHash: hash, provider: { kind: 'configured', approved: true } });
    expect(owner.reads).toContain('acme');
  });

  it('uncertified owner on a certified routed http rail, block unapproved -> 409 not_available (real money makes it mandatory)', async () => {
    await acme({ certify: false });
    await seedPartner(db, 'railp');
    await certifyPartnerForTest(db, 'railp');
    rails.byPartner.railp = { ...PUBLIC_RAIL, credentials: { ...PUBLIC_RAIL.credentials } };
    const t = makeTransfer({ id: 'r1', partnerId: 'acme', settlementPartnerId: 'railp' });
    await store.saveTransfer(t);
    expect(await pay(t, testEvidence({ routeId: 'r1' }))).toEqual({ status: 409, body: NOT_AVAILABLE });
    expect(capture).not.toHaveBeenCalled();
    expect(await evidenceRows()).toEqual([]);
  });

  it('owner read throws on a real-money routed rail -> not_available; the warn names the error only', async () => {
    await acme({ approve: true });
    await seedPartner(db, 'railp');
    await certifyPartnerForTest(db, 'railp');
    rails.byPartner.railp = { ...PUBLIC_RAIL, credentials: { ...PUBLIC_RAIL.credentials } };
    owner.throwFor = 'acme';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = makeTransfer({ id: 'r2', partnerId: 'acme', settlementPartnerId: 'railp' });
    await store.saveTransfer(t);
    expect(await pay(t, testEvidence({ routeId: 'r2' }))).toEqual({ status: 409, body: NOT_AVAILABLE });
    expect(capture).not.toHaveBeenCalled();
    const lines = warnLines(warn, 'pay.owner-read');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).msg).toBe('Error');
    expect(lines[0]).not.toContain('postgres://');
  });

  it('owner read throws on a mock rail, uncertified -> paid', async () => {
    await acme({ certify: false });
    owner.throwFor = 'acme';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = makeTransfer({ id: 'r3', partnerId: 'acme' });
    await store.saveTransfer(t);
    expect(await pay(t, testEvidence({ routeId: 'r3' }))).toEqual({ status: 200, body: { ok: true, status: 'paid' } });
    expect(capture).toHaveBeenCalledTimes(1);
    // A null disclosure: the ack row names no provider kind and no snapshot is stored.
    expect((await evidenceRows())[1].meta).toMatchObject({ providerKind: null });
    expect(await createTransferRepo(db).getDisclosureSnapshot('r3', 'acme')).toBeNull();
  });

  it('order: a bad URL is still 400 Payment failed; an uncertified http rail is still the pack 3 not_available (live gate first)', async () => {
    await acme();
    rails.byPartner.acme = { providerType: 'http', credentials: { settlementUrl: 'http://10.0.0.5/settle', signingSecret: 's' } };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t1 = makeTransfer({ id: 'o1', partnerId: 'acme' });
    await store.saveTransfer(t1);
    expect(await pay(t1, testEvidence({ routeId: 'o1' }))).toEqual({ status: 400, body: { ok: false, error: 'Payment failed' } });

    await seedPartner(db, 'beta');
    rails.byPartner.beta = { ...PUBLIC_RAIL, credentials: { ...PUBLIC_RAIL.credentials } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t2 = makeTransfer({ id: 'o2', partnerId: 'beta' });
    await store.saveTransfer(t2);
    expect(await pay(t2, testEvidence({ routeId: 'o2' }))).toEqual({ status: 409, body: NOT_AVAILABLE });
    expect(warnLines(warn, 'pay.live-refused')).toHaveLength(1);
    expect(warnLines(warn, 'pay.disclosure-refused')).toHaveLength(0);
    expect(capture).not.toHaveBeenCalled();
    expect(await evidenceRows()).toEqual([]);
  });

  it('b2b partner-pulled row with evidence -> no owner read, the otp.verified row written, capture skipped, settles', async () => {
    await acme({ approve: false });
    const t = makeTransfer({ id: 'b1', partnerId: 'acme', transferType: 'b2b', fundingMethod: 'ach_pull' });
    await store.saveTransfer(t);
    const res = await pay(t, testEvidence({ routeId: 'b1', ack: false, surface: 'b2b' }));
    expect(res).toEqual({ status: 200, body: { ok: true, status: 'paid' } });
    expect(capture).not.toHaveBeenCalled();
    expect(owner.reads).not.toContain('acme');
    const rows = await evidenceRows();
    expect(rows.map((r) => r.action)).toEqual(['otp.verified']);
    expect(rows[0].meta).toMatchObject({ surface: 'b2b' });
  });
});

describe('pay-process: the evidence commit (C8)', () => {
  it('commit not_awaiting (row saved as paid, a stale awaiting object passed) -> 200 paid, never charged', async () => {
    const t = makeTransfer({ id: 'n1' });
    await store.saveTransfer({ ...t, status: 'paid' });
    expect(await pay(t, testEvidence({ routeId: 'n1' }))).toEqual({ status: 200, body: { ok: true, status: 'paid' } });
    expect(capture).not.toHaveBeenCalled();
    expect(await evidenceRows()).toEqual([]);
  });

  it('commit not_awaiting with a blocked current row -> 400', async () => {
    const t = makeTransfer({ id: 'n2' });
    await store.saveTransfer({ ...t, status: 'blocked', complianceStatus: 'blocked' });
    expect(await pay(t, testEvidence({ routeId: 'n2' }))).toEqual({ status: 400, body: { ok: false, error: "We can't process this transfer." } });
    expect(capture).not.toHaveBeenCalled();
  });

  async function failAudit(): Promise<void> {
    await db.execute(sql.raw(`CREATE FUNCTION fail_pp_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'evidence-leak %', NEW.subject_id; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER fail_pp_audit BEFORE INSERT ON audit_events FOR EACH ROW
      WHEN (NEW.action = 'otp.verified') EXECUTE FUNCTION fail_pp_audit()`));
    onTestFinished(async () => {
      await db.execute(sql.raw('DROP TRIGGER IF EXISTS fail_pp_audit ON audit_events'));
      await db.execute(sql.raw('DROP FUNCTION IF EXISTS fail_pp_audit()'));
    });
  }

  it('commit throws -> 503 approval_not_recorded, never charged, still awaiting; one name-only warn; ONE deduped ops alert', async () => {
    await failAudit();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = makeTransfer({ id: 'f1' });
    await store.saveTransfer(t);
    expect(await pay(t, testEvidence({ routeId: 'f1' }))).toEqual({
      status: 503,
      body: { ok: false, reason: 'approval_not_recorded', error: PAY_APPROVAL_NOT_RECORDED_COPY },
    });
    expect(capture).not.toHaveBeenCalled();
    expect((await store.getTransfer('f1'))?.status).toBe('awaiting_payment');
    const lines = warnLines(warn, 'pay.evidence-unavailable');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).msg).toMatch(/^[A-Za-z]*Error$/);
    expect(lines[0]).not.toContain('evidence-leak');
    expect(lines[0]).not.toContain('insert into');
    const a = await alerts();
    expect(a).toHaveLength(1);
    expect(a[0].dedupe_key).toBe(`payevidence:${new Date().toISOString().slice(0, 13)}`);
    for (const v of [SENDER, 'Mom', '919876543210', '17000', 'f1', '123456789']) expect(a[0].payload.message).not.toContain(v);
    expect(a[0].payload.message).toContain('nothing was charged');

    // A second failure in the same hour adds no alert.
    const t2 = makeTransfer({ id: 'f2' });
    await store.saveTransfer(t2);
    expect((await pay(t2, testEvidence({ routeId: 'f2' }))).status).toBe(503);
    expect(await alerts()).toHaveLength(1);
    expect(capture).not.toHaveBeenCalled();
  });

  it('the alert enqueue itself fails -> still 503, nothing charged, one warn with the error name', async () => {
    await failAudit();
    await db.execute(sql.raw(`CREATE FUNCTION fail_pp_alert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'alert-leak'; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER fail_pp_alert BEFORE INSERT ON outbox FOR EACH ROW
      WHEN (NEW.kind = 'ops.alert') EXECUTE FUNCTION fail_pp_alert()`));
    onTestFinished(async () => {
      await db.execute(sql.raw('DROP TRIGGER IF EXISTS fail_pp_alert ON outbox'));
      await db.execute(sql.raw('DROP FUNCTION IF EXISTS fail_pp_alert()'));
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = makeTransfer({ id: 'f3' });
    await store.saveTransfer(t);
    expect((await pay(t, testEvidence({ routeId: 'f3' }))).status).toBe(503);
    expect(capture).not.toHaveBeenCalled();
    const lines = warnLines(warn, 'pay.evidence-alert');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).msg).toMatch(/^[A-Za-z]*Error$/);
    expect(lines[0]).not.toContain('alert-leak');
    expect(await alerts()).toEqual([]);
  });
});

// Review R1-P1 A1: an awaiting row whose bank debit is bound (fundingIntentRef,
// fundingState 'pending') is funded: its R18 and evidence answers keep their
// reason and status but never say that nothing was charged.
describe('pay-process: a funded awaiting row (review R1-P1 A1)', () => {
  async function boundRow(id: string): Promise<Transfer> {
    const t = makeTransfer({ id, partnerId: 'acme' });
    await store.saveTransfer(t);
    expect(await createTransferRepo(db).bindFundingIntent(id, 'acme', 'stripe', `pi_${id}`)).toBeTruthy();
    const bound = await store.getTransfer(id);
    expect(bound).toMatchObject({ fundingIntentRef: `pi_${id}`, fundingState: 'pending', status: 'awaiting_payment' });
    return bound!;
  }

  it('R18 reload_required on a bound row -> 409 reload_required, funded, the text has no "charged"', async () => {
    await acme({ approve: true });
    const t = await boundRow('fa1');
    const res = await pay(t, testEvidence({ routeId: 'fa1', ack: false }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, reason: 'reload_required', funded: true });
    expect(res.body.error).not.toMatch(/charged/i);
    expect(capture).not.toHaveBeenCalled();
  });

  it('the evidence commit throws on a bound row -> 503 approval_not_recorded, funded, the text has no "charged"', async () => {
    await acme({ approve: true });
    const t = await boundRow('fa2');
    await failAuditFunded();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const res = await pay(t, testEvidence({ routeId: 'fa2' }));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, reason: 'approval_not_recorded', funded: true });
    expect(res.body.error).not.toMatch(/charged/i);
    expect(capture).not.toHaveBeenCalled();
  });

  async function failAuditFunded(): Promise<void> {
    await db.execute(sql.raw(`CREATE FUNCTION fail_pp_audit_f() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'evidence-leak %', NEW.subject_id; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER fail_pp_audit_f BEFORE INSERT ON audit_events FOR EACH ROW
      WHEN (NEW.action = 'otp.verified') EXECUTE FUNCTION fail_pp_audit_f()`));
    onTestFinished(async () => {
      await db.execute(sql.raw('DROP TRIGGER IF EXISTS fail_pp_audit_f ON audit_events'));
      await db.execute(sql.raw('DROP FUNCTION IF EXISTS fail_pp_audit_f()'));
    });
  }
});
