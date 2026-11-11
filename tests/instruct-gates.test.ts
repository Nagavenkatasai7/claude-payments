import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedPartner } from './helpers-db';
import { seedRealMoneyRail } from './helpers-live';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { EnvKeyProvider } from '@/lib/field-crypto';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Fix pack 5 T6 (P9): the sweep skip helper and its stuck alert. The predicate
// slots (funding_mode T14, travel_rule T23) are empty, so instructHeldOnPurpose
// returns null for every row today; alertStuckHeld is the pack 3 I1 rule
// (alertStuckLivegate) for the rows those slots will hold on purpose.

// A switch that makes the real-money read throw (the helper must still return
// null), and a count of its calls. The rest of live-gate stays real.
const liveGateSeam = vi.hoisted(() => ({ throws: false, calls: 0 }));
vi.mock('@/lib/live-gate', async (orig) => {
  const real = await orig<typeof import('@/lib/live-gate')>();
  return {
    ...real,
    realMoneyFor: async (...a: Parameters<typeof real.realMoneyFor>) => {
      liveGateSeam.calls += 1;
      if (liveGateSeam.throws) throw new TypeError('rail read exploded');
      return real.realMoneyFor(...a);
    },
  };
});
const logSpy = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  return {
    ...real,
    logWarn: (...a: Parameters<typeof real.logWarn>) => {
      logSpy.warn(...a);
    },
  };
});

import {
  alertStuckHeld,
  heldStuckDedupeKey,
  instructHeldOnPurpose,
  stuckHeldMessage,
  type InstructHeldReason,
} from '@/lib/instruct-gates';

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const ID = 'ig_t1';
const REASONS: InstructHeldReason[] = ['mockfund', 'fundmode', 'travelrule'];

function fixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: ID, phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 3_600_000).toISOString(), paidAt: new Date(Date.now() - 3_000_000).toISOString(), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

let db: Db;

async function alerts(): Promise<Array<{ k: string; m: string }>> {
  const r = (await db.execute(sql`SELECT dedupe_key AS k, payload->>'message' AS m FROM outbox WHERE kind = 'ops.alert' ORDER BY id`)) as unknown as {
    rows: Array<{ k: string; m: string }>;
  };
  return r.rows;
}
const instructRow = async (id: string, status: string) => {
  await createOutboxRepo(db).enqueue('settlement.instruct', { transferId: id }, { dedupeKey: `instruct:${id}` });
  await db.execute(sql`UPDATE outbox SET status = ${status} WHERE dedupe_key = ${`instruct:${id}`}`);
};

beforeEach(async () => {
  liveGateSeam.throws = false;
  liveGateSeam.calls = 0;
  logSpy.warn.mockReset();
  db = await freshDb();
  await seedPartner(db, 'acme');
});

describe('instructHeldOnPurpose (P9, slots empty)', () => {
  it("a 'test' row -> null, with no rail read", async () => {
    await seedRealMoneyRail(db, 'acme');
    const stop = captureQueries();
    const r = await instructHeldOnPurpose(db, fixture({ environment: 'test' } as Partial<Transfer>));
    const q = stop();
    expect(r).toBeNull();
    expect(q.filter((x) => /partner_integrations|from "partners"/i.test(x.sql))).toEqual([]);
  });

  it('a real-money (http) row -> null (the funding_mode and travel_rule slots are empty)', async () => {
    await seedRealMoneyRail(db, 'acme');
    expect(await instructHeldOnPurpose(db, fixture())).toBeNull();
    expect(liveGateSeam.calls).toBe(1);
  });

  it('a simulator row -> null', async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: { providerType: 'simulator', credentials: { signingSecret: 'sgn' }, webhookSecret: 'whk' },
      whatsapp: {},
    });
    expect(await instructHeldOnPurpose(db, fixture())).toBeNull();
  });

  it('never throws: a failing read -> null, logged by the error NAME with the transfer id only', async () => {
    liveGateSeam.throws = true;
    await expect(instructHeldOnPurpose(db, fixture())).resolves.toBeNull();
    expect(logSpy.warn).toHaveBeenCalledWith('instruct-gates.held', 'TypeError', { transferId: ID });
    expect(JSON.stringify(logSpy.warn.mock.calls)).not.toContain('exploded');
  });
});

describe('alertStuckHeld (P9, the pack 3 I1 rule)', () => {
  it.each(REASONS)('%s: no live settlement.instruct row -> ONE ops.alert <reason>:stuck:<id> with stuckHeldMessage (ids only)', async (reason) => {
    await store().saveTransfer(fixture());
    await instructRow(ID, 'done');
    expect(await alertStuckHeld(db, fixture(), reason)).toBe(true);
    const a = await alerts();
    expect(a).toEqual([{ k: `${reason}:stuck:${ID}`, m: stuckHeldMessage(ID, reason) }]);
    expect(heldStuckDedupeKey(reason, ID)).toBe(`${reason}:stuck:${ID}`);
    for (const pii of ['15551230000', 'Anita', '919876543210', '123456789012', '200']) expect(a[0].m).not.toContain(pii);
  });

  it.each(['pending', 'processing', 'failed'])("a '%s' instruct row (the worker owns it) -> no alert, returns false", async (status) => {
    await instructRow(ID, status);
    expect(await alertStuckHeld(db, fixture(), 'mockfund')).toBe(false);
    expect(await alerts()).toEqual([]);
  });

  it('no instruct row at all -> one alert', async () => {
    expect(await alertStuckHeld(db, fixture(), 'travelrule')).toBe(true);
    expect((await alerts()).map((x) => x.k)).toEqual([`travelrule:stuck:${ID}`]);
  });

  it('a sanctions-blocked row -> no alert, returns false', async () => {
    expect(await alertStuckHeld(db, fixture({ complianceStatus: 'blocked' }), 'fundmode')).toBe(false);
    expect(await alerts()).toEqual([]);
  });

  it('a second call -> no second alert (dedupe)', async () => {
    expect(await alertStuckHeld(db, fixture(), 'mockfund')).toBe(true);
    expect(await alertStuckHeld(db, fixture(), 'mockfund')).toBe(false);
    expect(await alerts()).toHaveLength(1);
  });

  it('the texts name the P9 exits: Issue refund, never "Cancel it"', () => {
    expect(stuckHeldMessage(ID, 'mockfund')).toBe(
      `transfer ${ID} is paid with no delivery confirmation and no instruction waiting, and it is held on purpose (mockfund), so it is not re-instructed. ` +
        `Close it with Issue refund: it completes as nofunds-${ID} without moving money.`,
    );
    expect(stuckHeldMessage(ID, 'fundmode')).toBe(
      `transfer ${ID} is paid with no delivery confirmation and no instruction waiting, and it is held on purpose (fundmode), so it is not re-instructed. ` +
        'Record the right funding mode on the go-live card (then the stuck-paid sweep re-instructs it once) or Issue refund.',
    );
    expect(stuckHeldMessage(ID, 'travelrule')).toBe(
      `transfer ${ID} is paid with no delivery confirmation and no instruction waiting, and it is held on purpose (travelrule), so it is not re-instructed. ` +
        "Issue refund to return the sender's money.",
    );
    for (const r of REASONS) {
      expect(stuckHeldMessage(ID, r)).toContain('Issue refund');
      expect(stuckHeldMessage(ID, r)).not.toMatch(/cancel/i);
    }
  });
});

function store() {
  return createStore(fakeRedis(), db);
}
