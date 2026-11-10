/**
 * Fix pack 2 T4 (R02): the automatic re-screen release of LIST_UNAVAILABLE
 * holds. sweepListUnavailableHolds re-screens each in_review row held because
 * the sanctions list was not live, once a screen can stand for it, and
 * releases it through ONE settlement transaction (releaseRescreenedHold) only
 * when every name screened before was screened again. No person can release
 * such a hold (dashboard-ops tests).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner, captureQueries } from './helpers-db';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import { beginHold } from '@/lib/settlement';
import { releaseTransfer, rejectTransfer } from '@/lib/dashboard-ops';
import {
  LARGE_AMOUNT_REASON,
  LIST_UNAVAILABLE_REASON,
  POSSIBLE_MATCH_REASON,
  RECIPIENT_WATCHLIST_REASON,
  SENDER_IDENTITY_MISSING_REASON,
  SENDER_SCREENING_REASON,
} from '@/lib/compliance-config';
import { primeOfacSource, restoreOfacSource, seedLiveEvidence, setRailProviderType } from './helpers-sanctions';

// The worker poke, observed (the real one schedules via next/server after()).
const poke = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/outbox', async (orig) => {
  const real = await orig<typeof import('@/lib/outbox')>();
  return { ...real, pokeWorker: () => { poke.calls++; } };
});

// The list fitness read, counted (the "no held rows -> no warm" case).
const fitnessReads = vi.hoisted(() => ({ n: 0 }));
vi.mock('@/lib/sanctions/list-health', async (orig) => {
  const real = await orig<typeof import('@/lib/sanctions/list-health')>();
  return {
    ...real,
    sanctionsListFitnessNow: async (now: Date) => {
      fitnessReads.n++;
      return real.sanctionsListFitnessNow(now);
    },
  };
});

// Per-row hooks on the name resolution: a row that always throws, and a reject
// that commits while the sweep is between its reads and its transaction.
const names = vi.hoisted(() => ({ throwFor: new Set<string>(), before: null as null | ((id: string) => Promise<void>) }));
vi.mock('@/lib/pay-rescreen', async (orig) => {
  const real = await orig<typeof import('@/lib/pay-rescreen')>();
  return {
    ...real,
    resolveRescreenNames: async (...a: Parameters<typeof real.resolveRescreenNames>) => {
      const id = a[1].id;
      if (names.throwFor.has(id)) throw new Error('names unavailable');
      if (names.before) await names.before(id);
      return real.resolveRescreenNames(...a);
    },
  };
});

import { sweepListUnavailableHolds } from '@/lib/list-hold-rescreen';

const H = 3_600_000;
const SENDER_PHONE = '15551230000';
const SENDER = 'Alex Sender';
const REL = { actor: 'plat', reason: 'checked' };

let db: Db;
let store: ReturnType<typeof createStore>;
let customerStore: ReturnType<typeof createCustomerStore>;
const originalList = process.env.SANCTIONS_LIST;

function base(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: SENDER_PHONE, amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - H).toISOString(), partnerId: 'acme', environment: 'live',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...o,
  } as Transfer;
}

async function seedSender(partnerId: string, fullName: string | undefined): Promise<void> {
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: SENDER_PHONE, firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId, optInAt: nowIso, createdAt: nowIso, updatedAt: nowIso,
    ...(fullName !== undefined ? { fullName } : {}),
  });
}

/**
 * A row held at pay time because the list was not live: the mint's evidence
 * (a not-live screen of `screened`), then beginHold adding LIST_UNAVAILABLE.
 */
async function heldRow(
  o: Partial<Transfer> & { id: string },
  screened: { recipientName?: string; senderName?: string | null; addReasons?: string[] } = {},
): Promise<Transfer> {
  const t = base(o);
  await store.saveTransfer(t);
  const sender = screened.senderName === null ? undefined : (screened.senderName ?? SENDER);
  await seedLiveEvidence(
    db,
    { id: t.id, partnerId: t.partnerId, recipientName: screened.recipientName ?? t.recipientName, ...(sender !== undefined ? { senderName: sender } : {}) },
    { listFitness: 'not_live' },
  );
  expect(await beginHold(db, t, { addReasons: screened.addReasons ?? [LIST_UNAVAILABLE_REASON] })).toEqual({ kind: 'held' });
  return t;
}

type AuditRow = { actor: string; actor_type: string; action: string; subject_id: string | null; meta: Record<string, unknown> };
async function auditRows(subject?: string): Promise<AuditRow[]> {
  const r = await db.execute(sql`SELECT actor, actor_type, action, subject_id, meta FROM audit_events ORDER BY id`);
  const rows = (r as unknown as { rows: AuditRow[] }).rows;
  return subject ? rows.filter((x) => x.subject_id === subject) : rows;
}

async function outbox(): Promise<Array<{ kind: string; dedupe_key: string | null; payload: Record<string, unknown> }>> {
  const r = await db.execute(sql`SELECT kind, dedupe_key, payload FROM outbox ORDER BY id`);
  return (r as unknown as { rows: Array<{ kind: string; dedupe_key: string | null; payload: Record<string, unknown> }> }).rows;
}
const keys = async () => (await outbox()).map((r) => r.dedupe_key);

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  customerStore = createCustomerStore(db, store);
  await seedPartner(db, 'acme');
  await seedSender('acme', SENDER);
  poke.calls = 0;
  fitnessReads.n = 0;
  names.throwFor = new Set();
  names.before = null;
});
afterEach(() => restoreOfacSource(originalList));

describe('sweepListUnavailableHolds (fix pack 2 T4)', { retry: 0 }, () => {
  it('fresh list + clean + same names -> paid, one instruct: (http) or mocksettle:, one system transfer.release, reasons unchanged', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await setRailProviderType(db, 'acme', 'http');
    await seedPartner(db, 'mockp');
    await seedSender('mockp', SENDER);
    await heldRow({ id: 'lh_http' });
    await heldRow({ id: 'lh_mock', partnerId: 'mockp' });

    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 2, stillHeld: 0, blocked: 0 });
    for (const id of ['lh_http', 'lh_mock']) {
      const after = await store.getTransfer(id);
      expect(after?.status).toBe('paid');
      expect(after?.complianceStatus).toBe('flagged');
      expect(after?.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON]);
      const releases = (await auditRows(id)).filter((a) => a.action === 'transfer.release');
      expect(releases).toEqual([{
        actor: 'system:list-rescreen', actor_type: 'system', action: 'transfer.release', subject_id: id,
        meta: { previousStatus: 'in_review', newStatus: 'paid', trigger: 'list_rescreen' },
      }]);
      // The re-screen's own evidence row, recorded in the release transaction.
      const screens = (await auditRows(id)).filter((a) => a.action === 'sanctions.screen');
      expect(screens).toHaveLength(2);
      expect(screens[1].meta.decision).toBe('clear');
    }
    const k = await keys();
    expect(k.filter((x) => x?.startsWith('instruct:'))).toEqual(['instruct:lh_http']);
    expect(k.filter((x) => x?.startsWith('mocksettle:'))).toEqual(['mocksettle:lh_mock']);
    expect(poke.calls).toBe(1);
  });

  it('second sweep -> nothing new', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await setRailProviderType(db, 'acme', 'http');
    await heldRow({ id: 'lh_twice' });
    await sweepListUnavailableHolds(db, new Date());
    const ob = await outbox();
    const au = await auditRows();
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 0, stillHeld: 0, blocked: 0 });
    expect(await outbox()).toEqual(ob);
    expect(await auditRows()).toEqual(au);
  });

  it('two sweeps in Promise.all -> one rail effect', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await setRailProviderType(db, 'acme', 'http');
    await heldRow({ id: 'lh_race' });
    const [a, b] = await Promise.all([sweepListUnavailableHolds(db, new Date()), sweepListUnavailableHolds(db, new Date())]);
    expect(a.released + b.released).toBe(1);
    expect((await keys()).filter((x) => x?.startsWith('instruct:'))).toEqual(['instruct:lh_race']);
    expect((await auditRows('lh_race')).filter((x) => x.action === 'transfer.release')).toHaveLength(1);
  });

  it('http + stale list -> untouched, zero audit rows', async () => {
    primeOfacSource({ checkedAgoMs: 37 * H });
    await setRailProviderType(db, 'acme', 'http');
    await heldRow({ id: 'lh_stale' });
    const au = await auditRows();
    const ob = await outbox();
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 0, stillHeld: 0, blocked: 0 });
    expect(await auditRows()).toEqual(au);
    expect(await outbox()).toEqual(ob);
    const after = await store.getTransfer('lh_stale');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON]);
    expect(poke.calls).toBe(0);
  });

  it('Partner-API mint with a body sender name, held LIST_UNAVAILABLE, fresh list -> not released, SENDER_IDENTITY_MISSING added, no instruct', async () => {
    // The Partner-API body sender name is screened at mint and never stored
    // (ensureCustomer stores no name), so the owner row has no fullName.
    primeOfacSource({ checkedAgoMs: H });
    await setRailProviderType(db, 'acme', 'http');
    await db.execute(sql`DELETE FROM customers WHERE partner_id = 'acme'`);
    await seedSender('acme', undefined);
    await heldRow({ id: 'lh_api' }, { senderName: 'Body Sender Name' });
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 0, stillHeld: 1, blocked: 0 });
    const after = await store.getTransfer('lh_api');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceStatus).toBe('flagged');
    expect(after?.complianceReasons).toEqual([SENDER_IDENTITY_MISSING_REASON]);
    expect((await keys()).filter((x) => x?.startsWith('instruct:') || x?.startsWith('mocksettle:'))).toEqual([]);
    const rescreen = (await auditRows('lh_api')).filter((a) => a.action === 'transfer.rescreen');
    expect(rescreen).toHaveLength(1);
    expect(rescreen[0].actor).toBe('system:list-rescreen');
    expect(rescreen[0].meta).toEqual({
      previousReasons: [LIST_UNAVAILABLE_REASON],
      newReasons: [SENDER_IDENTITY_MISSING_REASON],
      decision: 'clear',
      uncovered: ['sender'],
    });
    expect(poke.calls).toBe(0);
  });

  it('payment-link mint with link.customerName only -> not released', async () => {
    // A link screens link.customerName as the sender; the customer row the
    // link creates carries no legal name.
    primeOfacSource({ checkedAgoMs: H });
    await db.execute(sql`DELETE FROM customers WHERE partner_id = 'acme'`);
    await seedSender('acme', undefined);
    await heldRow({ id: 'lh_link' }, { senderName: 'Link Customer Name' });
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 0, stillHeld: 1, blocked: 0 });
    const after = await store.getTransfer('lh_link');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceReasons).toEqual([SENDER_IDENTITY_MISSING_REASON]);
  });

  it('payee.legalName screened at mint -> covered via alsoRecipientNames, released', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await setRailProviderType(db, 'acme', 'http');
    const t = await heldRow(
      { id: 'lh_payee', recipientName: 'Priya', recipientLegalName: 'Priya Legal Sharma' },
      { recipientName: 'Priya Legal Sharma' },
    );
    // The mint screened the display name too.
    await seedLiveEvidence(db, { id: t.id, partnerId: t.partnerId, recipientName: 'Priya', senderName: SENDER }, { listFitness: 'not_live' });
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 1, stillHeld: 0, blocked: 0 });
    expect((await store.getTransfer('lh_payee'))?.status).toBe('paid');
    expect(await keys()).toContain('instruct:lh_payee');
  });

  it('possible match -> still in_review [POSSIBLE_MATCH], transfer.rescreen audit', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await setRailProviderType(db, 'acme', 'http');
    await heldRow({ id: 'lh_possible', recipientName: 'Banco Ejemplo Nacionel' });
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 0, stillHeld: 1, blocked: 0 });
    const after = await store.getTransfer('lh_possible');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceStatus).toBe('flagged');
    expect(after?.complianceReasons).toEqual([POSSIBLE_MATCH_REASON]);
    const rescreen = (await auditRows('lh_possible')).filter((a) => a.action === 'transfer.rescreen');
    expect(rescreen.map((r) => r.meta)).toEqual([{
      previousReasons: [LIST_UNAVAILABLE_REASON],
      newReasons: [POSSIBLE_MATCH_REASON],
      decision: 'possible_match',
      uncovered: [],
    }]);
    expect(JSON.stringify(rescreen).toLowerCase()).not.toContain('banco');
    expect((await keys()).filter((x) => x?.startsWith('instruct:'))).toEqual([]);
    // A person decides now: the row left the sweep.
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 0, stillHeld: 0, blocked: 0 });
  });

  it('match -> blocked, LIST_UNAVAILABLE dropped, listrescreenblock alert; never selected again; staff release refused', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await setRailProviderType(db, 'acme', 'http');
    // A card-charged hold (review round 3, M6: the charged copy needs a charge).
    await heldRow({ id: 'lh_match', recipientName: 'Testa Fixturelli', fundingMethod: 'credit_card', fundingRef: 'pi_lh_match' });
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 0, stillHeld: 0, blocked: 1 });
    const after = await store.getTransfer('lh_match');
    expect(after?.status).toBe('in_review'); // charged: Reject cancels and refunds it
    expect(after?.complianceStatus).toBe('blocked');
    expect(after?.complianceReasons).toEqual([RECIPIENT_WATCHLIST_REASON]);
    const alerts = (await outbox()).filter((r) => r.dedupe_key === 'listrescreenblock:lh_match');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('ops.alert');
    expect(String(alerts[0].payload.message)).toMatch(/charged, blocked by the re-screen, not paid out; reject and refund it/);
    expect(String(alerts[0].payload.message).toLowerCase()).not.toContain('testa');
    expect((await keys()).filter((x) => x?.startsWith('instruct:'))).toEqual([]);
    expect(poke.calls).toBe(1);

    const au = await auditRows();
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 0, stillHeld: 0, blocked: 0 });
    expect(await auditRows()).toEqual(au);

    const ob = await outbox();
    await expect(releaseTransfer(store, db, 'lh_match', REL)).rejects.toThrow(/Cannot release/);
    expect((await store.getTransfer('lh_match'))?.status).toBe('in_review');
    expect(await outbox()).toEqual(ob);
  });

  // Review round 3 (M6): a partner-pulled hold was never charged here, so the
  // alert says nothing was charged or paid out and the transfer must be rejected.
  it('M6: a partner-pulled (ach_pull) hold with no fundingRef matches: the alert says nothing was charged, never "It is charged" or refund', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await setRailProviderType(db, 'acme', 'http');
    await db.execute(sql`UPDATE partners SET support_config = ${JSON.stringify({ complianceAlertEmail: 'compliance@acme.example' })}::jsonb WHERE id = 'acme'`);
    await heldRow({ id: 'lh_pull', recipientName: 'Testa Fixturelli', fundingMethod: 'ach_pull', transferType: 'b2b' });
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 0, stillHeld: 0, blocked: 1 });
    const rows = await outbox();
    const alert = String(rows.find((r) => r.dedupe_key === 'listrescreenblock:lh_pull')?.payload.message);
    expect(alert).not.toContain('It is charged');
    expect(alert).not.toMatch(/refund/i);
    expect(alert).toContain('Nothing was charged or paid out; reject it.');
    // The block notices keep the uncharged copy too.
    expect(String(rows.find((r) => r.dedupe_key === 'sanctionsblock:lh_pull')?.payload.message)).toContain('Nothing paid out');
    expect(String(rows.find((r) => r.dedupe_key === 'sanctionsblockmail:lh_pull:acme')?.payload.text)).not.toContain('charged');
    for (const m of [alert]) expect(m.toLowerCase()).not.toMatch(/testa|fixturelli/);
  });

  // Review round 3 (M2): a charged hold's block notices say the sender was charged.
  it('M2: a card-charged LIST_UNAVAILABLE hold matches: the block alert and the partner email say the sender was charged', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await setRailProviderType(db, 'acme', 'http');
    await db.execute(sql`UPDATE partners SET support_config = ${JSON.stringify({ complianceAlertEmail: 'compliance@acme.example' })}::jsonb WHERE id = 'acme'`);
    await heldRow({ id: 'lh_card', recipientName: 'Testa Fixturelli', fundingMethod: 'credit_card', fundingRef: 'pi_lh_card' });
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 0, stillHeld: 0, blocked: 1 });
    const rows = await outbox();
    const block = String(rows.find((r) => r.dedupe_key === 'sanctionsblock:lh_card')?.payload.message);
    const mail = String(rows.find((r) => r.dedupe_key === 'sanctionsblockmail:lh_card:acme')?.payload.text);
    expect(block).toContain('the sender was charged');
    expect(block).not.toContain('Nothing paid out');
    expect(mail).toContain('after the sender was charged');
  });

  it('hold re-screen match -> notices stage hold_rescreen', async () => {
    // Fix pack 2 T5 (R04): the sanctions.block audit, the ops alert and the
    // partner email, in the block's transaction.
    primeOfacSource({ checkedAgoMs: H });
    await setRailProviderType(db, 'acme', 'http');
    await db.execute(sql`UPDATE partners SET support_config = ${JSON.stringify({ complianceAlertEmail: 'compliance@acme.example' })}::jsonb WHERE id = 'acme'`);
    await heldRow({ id: 'lh_notice', recipientName: 'Testa Fixturelli' });
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 0, stillHeld: 0, blocked: 1 });
    expect((await keys()).filter((k) => k?.startsWith('sanctionsblock'))).toEqual(['sanctionsblock:lh_notice', 'sanctionsblockmail:lh_notice:acme']);
    const block = (await auditRows('lh_notice')).filter((r) => r.action === 'sanctions.block');
    expect(block).toHaveLength(1);
    expect(block[0].meta).toMatchObject({ stage: 'hold_rescreen', environment: 'live', realMoney: true, quiet: false, alerted: true, partnerNotified: true });
  });

  it('30 blocked rows and 30 waiting http rows (stale list) do not stop a newer mock-rail hold being released', async () => {
    primeOfacSource({ checkedAgoMs: 37 * H });
    await setRailProviderType(db, 'acme', 'http');
    await seedPartner(db, 'mockp');
    await seedSender('mockp', SENDER);
    const old = (i: number) => new Date(Date.now() - 2 * H + i * 1000).toISOString();
    for (let i = 0; i < 30; i++) {
      await store.saveTransfer(base({
        id: `lh_blk${i}`, status: 'in_review', paidAt: old(i), complianceStatus: 'blocked',
        complianceReasons: [RECIPIENT_WATCHLIST_REASON, LIST_UNAVAILABLE_REASON],
      }));
      await store.saveTransfer(base({
        id: `lh_wait${i}`, status: 'in_review', paidAt: old(i), complianceStatus: 'flagged',
        complianceReasons: [LIST_UNAVAILABLE_REASON],
      }));
    }
    await heldRow({ id: 'lh_newer', partnerId: 'mockp' });
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 1, stillHeld: 0, blocked: 0 });
    expect((await store.getTransfer('lh_newer'))?.status).toBe('paid');
    expect(await keys()).toContain('mocksettle:lh_newer');
    expect((await store.getTransfer('lh_wait0'))?.status).toBe('in_review');
  });

  it('a row that throws every run does not stop the next row', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await heldRow({ id: 'lh_bad' });
    await heldRow({ id: 'lh_good' });
    names.throwFor.add('lh_bad');
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 1, stillHeld: 0, blocked: 0, failed: 1 });
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 0, stillHeld: 0, blocked: 0, failed: 1 });
    expect((await store.getTransfer('lh_good'))?.status).toBe('paid');
    expect((await store.getTransfer('lh_bad'))?.status).toBe('in_review');
    expect((await store.getTransfer('lh_bad'))?.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON]);
  });

  // Pack 2 review R4 (E6): a row that throws stays held at the head of the
  // oldest-first scan. That is made visible: ONE ops alert per hour with the
  // count of failed rows only (no ids, no names), and the count in the result.
  it('rows that throw -> one listsweeperror:<hour> alert with the count only, deduped within the hour', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await heldRow({ id: 'lh_err_a' });
    await heldRow({ id: 'lh_err_b' });
    await heldRow({ id: 'lh_err_ok' });
    names.throwFor.add('lh_err_a');
    names.throwFor.add('lh_err_b');
    const now = new Date();
    expect(await sweepListUnavailableHolds(db, now)).toEqual({ released: 1, stillHeld: 0, blocked: 0, failed: 2 });
    expect(await sweepListUnavailableHolds(db, now)).toEqual({ released: 0, stillHeld: 0, blocked: 0, failed: 2 });
    const alerts = (await outbox()).filter((r) => r.kind === 'ops.alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].dedupe_key).toBe(`listsweeperror:${Math.floor(now.getTime() / H)}`);
    expect(Object.keys(alerts[0].payload)).toEqual(['message']);
    const msg = String(alerts[0].payload.message);
    expect(msg).toMatch(/2 held transfer/);
    expect(msg).not.toContain('lh_err');
    expect(msg).not.toContain(SENDER);
    expect(msg).not.toContain('Anita');
  });

  it('no row throws -> no listsweeperror alert, no failed field', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await heldRow({ id: 'lh_noerr' });
    expect(await sweepListUnavailableHolds(db, new Date())).toStrictEqual({ released: 1, stillHeld: 0, blocked: 0 });
    expect((await keys()).filter((k) => k?.startsWith('listsweeperror:'))).toEqual([]);
  });

  it('LIST_UNAVAILABLE + LARGE -> held with LARGE only', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await heldRow({ id: 'lh_large' }, { addReasons: [LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON] });
    expect((await store.getTransfer('lh_large'))?.complianceReasons).toEqual([LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON]);
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 0, stillHeld: 1, blocked: 0 });
    const after = await store.getTransfer('lh_large');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceReasons).toEqual([LARGE_AMOUNT_REASON]);
  });

  it('legacy row at $1500 -> LARGE re-derived', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await heldRow({ id: 'lh_legacy', amountUsd: 1500, totalChargeUsd: 1505, amountSource: 1500, totalChargeSource: 1505 });
    expect((await store.getTransfer('lh_legacy'))?.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON]);
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 0, stillHeld: 1, blocked: 0 });
    expect((await store.getTransfer('lh_legacy'))?.complianceReasons).toEqual([LARGE_AMOUNT_REASON]);
  });

  it('sandbox row -> mock effect', async () => {
    // A 'test' row on an http partner is never real money: the stale list does
    // not stop it and the rail effect is the mock settle.
    primeOfacSource({ checkedAgoMs: 37 * H });
    await setRailProviderType(db, 'acme', 'http');
    await heldRow({ id: 'lh_sandbox', environment: 'test' });
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 1, stillHeld: 0, blocked: 0 });
    const k = await keys();
    expect(k).toContain('mocksettle:lh_sandbox');
    expect(k.filter((x) => x?.startsWith('instruct:'))).toEqual([]);
  });

  it('a reject racing the sweep -> moved', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await heldRow({ id: 'lh_reject' });
    names.before = async (id) => {
      await rejectTransfer(createStore(fakeRedis(), db), db, id, { actor: 'plat', reason: 'no' });
    };
    const au = (await auditRows('lh_reject')).length;
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 0, stillHeld: 0, blocked: 0 });
    const after = await store.getTransfer('lh_reject');
    expect(after?.status).toBe('cancelled');
    // Only the reject's own audit row: the sweep wrote nothing (no evidence, no release).
    const rows = await auditRows('lh_reject');
    expect(rows.slice(au).map((r) => r.action)).toEqual(['transfer.reject']);
    expect((await keys()).filter((x) => x?.startsWith('mocksettle:') || x?.startsWith('instruct:'))).toEqual([]);
  });

  // Fix pack 2 T6 (R06): the sweep never releases a real-money row whose sender
  // has an active screening hold; it swaps LIST_UNAVAILABLE for the sender reason.
  it('an active sender hold -> still held with SENDER_SCREENING_REASON, not released', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await setRailProviderType(db, 'acme', 'http');
    await db.execute(sql`UPDATE customers SET watchlist_hit = true, screening_flagged_at = now() WHERE partner_id = 'acme' AND phone = ${SENDER_PHONE}`);
    await heldRow({ id: 'lh_sender' });
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 0, stillHeld: 1, blocked: 0 });
    const after = await store.getTransfer('lh_sender');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceReasons).toEqual([SENDER_SCREENING_REASON]);
    expect((await keys()).filter((x) => x?.startsWith('instruct:'))).toEqual([]);
    // And a platform person still cannot release it while the hold is active.
    await expect(releaseTransfer(store, db, 'lh_sender', REL)).rejects.toThrow('Cannot release: clear the sender screening hold first.');
  });

  it('a sender hold on a mock rail is not read: released as before', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await db.execute(sql`UPDATE customers SET watchlist_hit = true, screening_flagged_at = now() WHERE partner_id = 'acme' AND phone = ${SENDER_PHONE}`);
    await heldRow({ id: 'lh_sender_mock' });
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 1, stillHeld: 0, blocked: 0 });
  });

  // Pack 2 review round 3 (M1): a sender stamp that commits after the sweep's
  // unlocked flags read is seen by the locked re-read in the release
  // transaction (transfer, then customer, FOR UPDATE): still held, not released.
  it('M1: http, a sender stamp after the unlocked read -> still held with SENDER_SCREENING_REASON, no instruct', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await setRailProviderType(db, 'acme', 'http');
    await heldRow({ id: 'lh_sender_race' });
    names.before = async () => {
      await db.execute(sql`UPDATE customers SET pep_hit = true, screening_flagged_at = now() WHERE partner_id = 'acme' AND phone = ${SENDER_PHONE}`);
    };
    const stop = captureQueries();
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 0, stillHeld: 1, blocked: 0 });
    const qs = stop().map((q) => q.sql.toLowerCase());
    const after = await store.getTransfer('lh_sender_race');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceReasons).toEqual([SENDER_SCREENING_REASON]);
    expect((await keys()).filter((x) => x?.startsWith('instruct:'))).toEqual([]);
    const tLock = qs.findIndex((q) => q.includes('"transfers"') && q.includes('for update'));
    const cLock = qs.findIndex((q) => q.includes('"customers"') && q.includes('for update'));
    expect(tLock).toBeGreaterThanOrEqual(0);
    expect(cLock).toBeGreaterThan(tLock);
  });

  it('M1: a mock rail release takes no customers lock and adds no customers read (not real money)', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await heldRow({ id: 'lh_sender_mock2' });
    const stop = captureQueries();
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 1, stillHeld: 0, blocked: 0 });
    const customerQs = stop().filter((q) => q.sql.includes('"customers"'));
    // The names on file are read (resolveRescreenNames, one plain select); never a lock.
    expect(customerQs.filter((q) => q.sql.toLowerCase().includes('for update'))).toEqual([]);
    expect(customerQs).toHaveLength(1);
  });

  // Pack 2 review F3 (C2): the sweep runs before the worker drain on every full
  // run, so it has a time budget: it never STARTS a row once the budget is
  // spent, and reports the rows it left for the next run.
  it('time budget: a row whose re-screen spends the budget -> the next row is not started (left for the next run)', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await heldRow({ id: 'lh_budget_a' });
    await heldRow({ id: 'lh_budget_b' });
    const clock = { t: 1_000_000 };
    names.before = async () => { clock.t += 10_000; };
    const r = await sweepListUnavailableHolds(db, new Date(), { budgetMs: 5_000, clock: () => clock.t });
    expect(r).toEqual({ released: 1, stillHeld: 0, blocked: 0, deferred: 1 });
    const statuses = [(await store.getTransfer('lh_budget_a'))?.status, (await store.getTransfer('lh_budget_b'))?.status].sort();
    expect(statuses).toEqual(['in_review', 'paid']);
    // The row left behind is untouched (only its mint evidence) and the next run takes it.
    names.before = null;
    expect(await sweepListUnavailableHolds(db, new Date(), { budgetMs: 5_000, clock: () => clock.t })).toEqual({ released: 1, stillHeld: 0, blocked: 0 });
  });

  it('time budget: the default leaves a normal sweep unchanged (no deferred field)', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await heldRow({ id: 'lh_budget_d1' });
    await heldRow({ id: 'lh_budget_d2' });
    expect(await sweepListUnavailableHolds(db, new Date())).toStrictEqual({ released: 2, stillHeld: 0, blocked: 0 });
  });

  it('no held rows -> no warm, one query', async () => {
    primeOfacSource({ checkedAgoMs: H });
    const stop = captureQueries();
    expect(await sweepListUnavailableHolds(db, new Date())).toEqual({ released: 0, stillHeld: 0, blocked: 0 });
    const qs = stop();
    expect(qs).toHaveLength(1);
    expect(fitnessReads.n).toBe(0);
  });
});
