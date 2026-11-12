import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedPartner } from './helpers-db';
import { certifyPartnerForTest, seedOriginatorForTest, seedRealMoneyRail } from './helpers-live';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { EnvKeyProvider } from '@/lib/field-crypto';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Fix pack 5 T6 (P9): the sweep skip helper and its stuck alert. The predicate
// slots are filled (funding_mode T14, travel_rule T23); alertStuckHeld is the pack 3 I1 rule
// (alertStuckLivegate) for the rows those slots will hold on purpose.

// A switch that makes the rail-type read throw (the helper must still return
// null), and a count of its calls. The rest of live-gate stays real. Review
// round 1 (RA1): instructHeldOnPurpose reads readRailProviderType directly.
const liveGateSeam = vi.hoisted(() => ({ throws: false, calls: 0 }));
vi.mock('@/lib/live-gate', async (orig) => {
  const real = await orig<typeof import('@/lib/live-gate')>();
  return {
    ...real,
    readRailProviderType: async (...a: Parameters<typeof real.readRailProviderType>) => {
      liveGateSeam.calls += 1;
      if (liveGateSeam.throws) throw new TypeError('rail read exploded');
      return real.readRailProviderType(...a);
    },
  };
});
// Fix pack 5 T14: a switch that makes the OWNER partner read throw (the G14 read).
const partnerSeam = vi.hoisted(() => ({ throws: false }));
vi.mock('@/db/repos/partner-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/partner-repo')>();
  return {
    ...real,
    createPartnerRepo: (dbx: Parameters<typeof real.createPartnerRepo>[0]) => {
      const r = real.createPartnerRepo(dbx);
      return {
        ...r,
        getPartner: async (id: string) => {
          if (partnerSeam.throws) throw new RangeError('partner read exploded');
          return r.getPartner(id);
        },
      };
    },
  };
});
// Fix pack 5 T23: a switch that makes the travel-rule on-file read throw (the G16 read).
const customerSeam = vi.hoisted(() => ({ throws: false }));
vi.mock('@/db/repos/customer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/customer-repo')>();
  return {
    ...real,
    createCustomerRepo: (...a: Parameters<typeof real.createCustomerRepo>) => {
      const r = real.createCustomerRepo(...a);
      return {
        ...r,
        originatorOnFile: async (...x: Parameters<typeof r.originatorOnFile>) => {
          if (customerSeam.throws) throw new SyntaxError('on-file read exploded');
          return r.originatorOnFile(...x);
        },
      };
    },
  };
});
// Fix pack 5 review round 1 (RA1): a switch that makes the rail-type column read
// (integrations-repo paymentProviderType) throw. readRailProviderType swallows it
// and returns undefined, which realMoneyRail reads as real money.
const integrationsSeam = vi.hoisted(() => ({ throws: false }));
vi.mock('@/db/repos/integrations-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/integrations-repo')>();
  return {
    ...real,
    createIntegrationsRepo: (...a: Parameters<typeof real.createIntegrationsRepo>) => {
      const r = real.createIntegrationsRepo(...a);
      return {
        ...r,
        paymentProviderType: async (...x: Parameters<typeof r.paymentProviderType>) => {
          if (integrationsSeam.throws) throw new Error('rail type read exploded for 15551230000');
          return r.paymentProviderType(...x);
        },
      };
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
  instructNotPaidMessage,
  instructPayability,
  stuckHeldMessage,
  travelRuleBlockIncomplete,
  travelRuleBlocksInstruct,
  travelRuleFor,
  type InstructHeldReason,
} from '@/lib/instruct-gates';

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));

// Truth check F10 (F1): the G3/G4 rule as ONE pure helper, used at G3/G4 and
// again under the row lock at the gate `record` (so the two can never drift).
describe('instructPayability (G3/G4, and the re-check at record)', () => {
  const STATUSES = ['awaiting_payment', 'paid', 'in_review', 'delivered', 'cancelled', 'blocked'] as const;
  const REFUNDS = [undefined, 'none', 'requested', 'pending', 'completed', 'failed'] as const;
  const COMPLIANCE = ['cleared', 'flagged', 'blocked'] as const;
  function expected(status: string, refund: string, compliance: string): 'ok' | 'skip' | 'retry' {
    if (status === 'cancelled' || status === 'delivered' || compliance === 'blocked' || refund === 'pending' || refund === 'completed') return 'skip';
    if (status !== 'paid' || refund !== 'none') return 'retry';
    return 'ok';
  }
  it('a gone row is not payable (skip)', () => {
    expect(instructPayability(null)).toBe('skip');
  });
  it('the table over status x refund status x compliance status', () => {
    let n = 0;
    for (const status of STATUSES) {
      for (const refundStatus of REFUNDS) {
        for (const complianceStatus of COMPLIANCE) {
          const row = { status, refundStatus, complianceStatus } as unknown as Pick<Transfer, 'status' | 'refundStatus' | 'complianceStatus'>;
          expect(instructPayability(row), `${status}/${refundStatus}/${complianceStatus}`).toBe(expected(status, refundStatus ?? 'none', complianceStatus));
          n++;
        }
      }
    }
    expect(n).toBe(STATUSES.length * REFUNDS.length * COMPLIANCE.length);
    // Spot pins.
    expect(instructPayability({ status: 'paid', complianceStatus: 'cleared' } as Transfer)).toBe('ok');
    expect(instructPayability({ status: 'paid', complianceStatus: 'cleared', refundStatus: 'pending' } as Transfer)).toBe('skip');
    expect(instructPayability({ status: 'paid', complianceStatus: 'cleared', refundStatus: 'requested' } as Transfer)).toBe('retry');
    expect(instructPayability({ status: 'paid', complianceStatus: 'blocked', refundStatus: 'requested' } as Transfer)).toBe('skip');
  });
  it('the G4 error text, byte for byte', () => {
    expect(instructNotPaidMessage({ status: 'paid', refundStatus: 'requested' } as Transfer)).toBe(
      'Settlement instruction held: transfer is paid with refund requested — retrying',
    );
    expect(instructNotPaidMessage({ status: 'in_review' } as Transfer)).toBe(
      'Settlement instruction held: transfer is in_review with refund none — retrying',
    );
  });
});
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
  integrationsSeam.throws = false;
  partnerSeam.throws = false;
  customerSeam.throws = false;
  logSpy.warn.mockReset();
  db = await freshDb();
  await seedPartner(db, 'acme');
  // Fix pack 5 T20a (P0 rule 9): the sender's travel-rule data on file, ahead of the T23 gate.
  await seedOriginatorForTest(db, 'acme', '15551230000', { address: true, dob: true });
});

describe('instructHeldOnPurpose (P9; funding_mode slot filled by T14)', () => {
  it("a 'test' row -> null, with no rail read", async () => {
    await seedRealMoneyRail(db, 'acme');
    const stop = captureQueries();
    const r = await instructHeldOnPurpose(db, fixture({ environment: 'test' } as Partial<Transfer>));
    const q = stop();
    expect(r).toBeNull();
    expect(q.filter((x) => /partner_integrations|from "partners"/i.test(x.sql))).toEqual([]);
  });

  it('a real-money (http) partner_collected row whose owner records partner_collected -> null (a match)', async () => {
    await seedRealMoneyRail(db, 'acme');
    await certifyPartnerForTest(db, 'acme');
    expect(await instructHeldOnPurpose(db, fixture())).toBeNull();
    expect(liveGateSeam.calls).toBe(1);
  });

  // Fix pack 5 T14 (P9 slot, G14 predicates).
  it("a real-money mock row (funding_provider 'mock', or NULL with a fundingRef) -> 'mockfund'", async () => {
    await seedRealMoneyRail(db, 'acme');
    await certifyPartnerForTest(db, 'acme');
    expect(await instructHeldOnPurpose(db, fixture({ fundingProvider: 'mock', fundingRef: `mockfund-${ID}` }))).toBe('mockfund');
    expect(await instructHeldOnPurpose(db, fixture({ fundingRef: `mockfund-${ID}` }))).toBe('mockfund');
  });

  it("a real-money mismatch -> 'fundmode' (no record; a Stripe row on a partner_collected owner)", async () => {
    await seedRealMoneyRail(db, 'acme');
    await certifyPartnerForTest(db, 'acme', { fundingMode: null });
    expect(await instructHeldOnPurpose(db, fixture())).toBe('fundmode');
    await certifyPartnerForTest(db, 'acme');
    expect(await instructHeldOnPurpose(db, fixture({ fundingProvider: 'stripe', fundingRef: 'pi_1' }))).toBe('fundmode');
    await certifyPartnerForTest(db, 'acme', { fundingMode: 'partner_psp' });
    expect(await instructHeldOnPurpose(db, fixture({ fundingProvider: 'stripe', fundingRef: 'pi_1' }))).toBeNull();
  });

  it('any simulator row (mock-funded or mismatched) -> null', async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: { providerType: 'simulator', credentials: { signingSecret: 'sgn' }, webhookSecret: 'whk' },
      whatsapp: {},
    });
    expect(await instructHeldOnPurpose(db, fixture({ fundingProvider: 'mock', fundingRef: `mockfund-${ID}` }))).toBeNull();
    expect(await instructHeldOnPurpose(db, fixture())).toBeNull();
  });

  it('the owner read throws -> null, logged by the error NAME only', async () => {
    await seedRealMoneyRail(db, 'acme');
    partnerSeam.throws = true;
    await expect(instructHeldOnPurpose(db, fixture())).resolves.toBeNull();
    expect(logSpy.warn).toHaveBeenCalledWith('instruct-gates.held', 'RangeError', { transferId: ID });
    expect(JSON.stringify(logSpy.warn.mock.calls)).not.toContain('exploded');
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

describe('instructHeldOnPurpose: a failed rail-type read (review round 1, RA1)', () => {
  it("a simulator demo row (environment 'live', funding provider 'mock') whose rail-type read fails -> null (as today), never 'mockfund'; the warn holds ids only", async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: { providerType: 'simulator', credentials: { signingSecret: 'sgn' }, webhookSecret: 'whk' },
      whatsapp: {},
    });
    integrationsSeam.throws = true;
    const t = fixture({ environment: 'live', fundingProvider: 'mock', fundingRef: `mockfund-${ID}` } as Partial<Transfer>);
    await expect(instructHeldOnPurpose(db, t)).resolves.toBeNull();
    expect(logSpy.warn).toHaveBeenCalledWith('instruct-gates.held', 'rail_read_failed', { transferId: ID });
    expect(JSON.stringify(logSpy.warn.mock.calls)).not.toContain('15551230000');
  });

  it('the same row with the read succeeding -> null (simulator is not real money); an http rail -> mockfund as before', async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: { providerType: 'simulator', credentials: { signingSecret: 'sgn' }, webhookSecret: 'whk' },
      whatsapp: {},
    });
    const t = fixture({ environment: 'live', fundingProvider: 'mock', fundingRef: `mockfund-${ID}` } as Partial<Transfer>);
    expect(await instructHeldOnPurpose(db, t)).toBeNull();
    await seedRealMoneyRail(db, 'acme');
    await certifyPartnerForTest(db, 'acme');
    expect(await instructHeldOnPurpose(db, t)).toBe('mockfund');
  });
});

describe('travel_rule slot (P9, P22; filled by T23)', () => {
  const clearOriginator = () =>
    db.execute(sql`UPDATE customers SET residential_address_enc = NULL, date_of_birth_enc = NULL WHERE partner_id = 'acme' AND phone = '15551230000'`);

  it("a real-money row missing its address -> 'travelrule'; null once the address is on file", async () => {
    await seedRealMoneyRail(db, 'acme');
    await certifyPartnerForTest(db, 'acme');
    await clearOriginator();
    expect(await instructHeldOnPurpose(db, fixture())).toBe('travelrule');
    await seedOriginatorForTest(db, 'acme', '15551230000', { address: true });
    expect(await instructHeldOnPurpose(db, fixture())).toBeNull();
  });

  it("a 'test' row with no address -> null, with no read", async () => {
    await seedRealMoneyRail(db, 'acme');
    await clearOriginator();
    const stop = captureQueries();
    expect(await instructHeldOnPurpose(db, fixture({ environment: 'test' } as Partial<Transfer>))).toBeNull();
    const q = stop();
    expect(q.filter((x) => /customers|idempotency_keys/i.test(x.sql))).toEqual([]);
  });

  it('a read error -> null, logged by the error NAME only', async () => {
    await seedRealMoneyRail(db, 'acme');
    await certifyPartnerForTest(db, 'acme');
    customerSeam.throws = true;
    await expect(instructHeldOnPurpose(db, fixture())).resolves.toBeNull();
    expect(logSpy.warn).toHaveBeenCalledWith('instruct-gates.held', 'SyntaxError', { transferId: ID });
    expect(JSON.stringify(logSpy.warn.mock.calls)).not.toContain('exploded');
  });

  it('travelRuleBlocksInstruct: not real money -> false with no read; real money -> the predicate; a read error throws', async () => {
    await clearOriginator();
    const stop = captureQueries();
    expect(await travelRuleBlocksInstruct(db, fixture(), false)).toBe(false);
    expect(stop()).toEqual([]);
    expect(await travelRuleBlocksInstruct(db, fixture(), true)).toBe(true);
    expect(await travelRuleBlocksInstruct(db, fixture(), true, { exempt: true })).toBe(false);
    customerSeam.throws = true;
    await expect(travelRuleBlocksInstruct(db, fixture(), true)).rejects.toThrow(SyntaxError);
  });

  it('travelRuleBlockIncomplete: no rule -> false; null originator or a missing required key -> true (pure)', () => {
    const addr = { band: 'address' as const, address: true as const, dateOfBirth: false };
    const dob = { band: 'address_dob' as const, address: true as const, dateOfBirth: true };
    expect(travelRuleBlockIncomplete(null, null)).toBe(false);
    expect(travelRuleBlockIncomplete(null, { name: 'x' })).toBe(false);
    expect(travelRuleBlockIncomplete(addr, null)).toBe(true);
    expect(travelRuleBlockIncomplete(addr, { name: 'x' })).toBe(true);
    expect(travelRuleBlockIncomplete(addr, { address: 'a' })).toBe(false);
    expect(travelRuleBlockIncomplete(dob, { address: 'a' })).toBe(true);
    expect(travelRuleBlockIncomplete(dob, { address: 'a', date_of_birth: 'd' })).toBe(false);
  });

  it('travelRuleFor: real money b2c -> the band; not real money or b2b -> null (pure)', () => {
    expect(travelRuleFor(fixture(), true)).toEqual({ band: 'address', address: true, dateOfBirth: false });
    expect(travelRuleFor(fixture({ amountUsd: 1500, destinationCountry: 'DE' } as Partial<Transfer>), true)).toEqual({
      band: 'address_dob',
      address: true,
      dateOfBirth: true,
    });
    expect(travelRuleFor(fixture({ transferType: undefined } as Partial<Transfer>), true)).not.toBeNull();
    expect(travelRuleFor(fixture(), false)).toBeNull();
    expect(travelRuleFor(fixture({ transferType: 'b2b' } as Partial<Transfer>), true)).toBeNull();
  });
});

describe('alertStuckHeld (P9, the pack 3 I1 rule)', () => {
  it.each(REASONS)('%s: no live settlement.instruct row -> ONE ops.alert <reason>:stuck:<id> with stuckHeldMessage (ids only)', async (reason) => {
    await store().saveTransfer(fixture());
    await instructRow(ID, 'done');
    expect(await alertStuckHeld(db, fixture(), reason)).toBe(true);
    const a = await alerts();
    // fixture() is a partner-collected row (final check F8: its own variant).
    expect(a).toEqual([{ k: `${reason}:stuck:${ID}`, m: stuckHeldMessage(ID, reason, 'partner_collected', false) }]);
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

  // Review round 2 GE1: a stripe-class row is never sent to Issue refund (it
  // cannot refund a card payment yet); every other class keeps the text above.
  it('a stripe-class row: the fundmode and travelrule texts name partner_psp / the Stripe dashboard, never Issue refund', () => {
    expect(stuckHeldMessage(ID, 'fundmode', 'stripe')).toBe(
      `transfer ${ID} is paid with no delivery confirmation and no instruction waiting, and it is held on purpose (fundmode), so it is not re-instructed. ` +
        "If the partner's own payment provider collects card payments, record the funding mode partner_psp on the go-live card (then the stuck-paid sweep re-instructs it once); " +
        "otherwise return the sender's money in the partner's Stripe dashboard (SmartRemit cannot refund a card payment yet, so the transfer then stays paid and held here).",
    );
    expect(stuckHeldMessage(ID, 'travelrule', 'stripe')).toBe(
      `transfer ${ID} is paid with no delivery confirmation and no instruction waiting, and it is held on purpose (travelrule), so it is not re-instructed. ` +
        "Return the sender's money in the partner's Stripe dashboard (SmartRemit cannot refund a card payment yet, so the transfer then stays paid and held here).",
    );
    for (const r of ['fundmode', 'travelrule'] as const) {
      expect(stuckHeldMessage(ID, r, 'stripe')).not.toContain('Issue refund');
      expect(stuckHeldMessage(ID, r, 'stripe')).not.toMatch(/cancel/i);
    }
    for (const cls of ['mock', 'partner_pull', 'sandbox'] as const) {
      for (const r of REASONS) expect(stuckHeldMessage(ID, r, cls)).toBe(stuckHeldMessage(ID, r));
    }
    for (const r of ['fundmode', 'travelrule'] as const) expect(stuckHeldMessage(ID, r, 'stripe', true)).toBe(stuckHeldMessage(ID, r, 'stripe'));
  });

  // Final check F8 (X1, U1): a partner-collected row. Not routed: Issue refund
  // is admitted, but when the rail never got the transfer no reverse is sent
  // and the refund stays pending. Routed: Issue refund is refused (RF1), so the
  // text never names it. The first sentence is byte for byte; mockfund unchanged.
  it('a partner-collected row: its own fundmode and travelrule texts, routed or not; mockfund unchanged; every other class unchanged', () => {
    const head = (r: string) =>
      `transfer ${ID} is paid with no delivery confirmation and no instruction waiting, and it is held on purpose (${r}), so it is not re-instructed. `;
    expect(stuckHeldMessage(ID, 'fundmode', 'partner_collected', false)).toBe(
      head('fundmode') +
        "Record the right funding mode on the go-live card (then the stuck-paid sweep re-instructs it once) or stop it with Issue refund; if SmartRemit has no record of an instruction for this transfer, no reverse is sent, the refund stays pending and a person arranges the return of the sender's money with the partner.",
    );
    expect(stuckHeldMessage(ID, 'travelrule', 'partner_collected', false)).toBe(
      head('travelrule') +
        "Stop it with Issue refund; if SmartRemit has no record of an instruction for this transfer, no reverse is sent, the refund stays pending and a person arranges the return of the sender's money with the partner.",
    );
    expect(stuckHeldMessage(ID, 'fundmode', 'partner_collected', true)).toBe(
      head('fundmode') +
        "Record the right funding mode on the go-live card (then the stuck-paid sweep re-instructs it once). Issue refund is not available for a transfer that another partner pays out: a person must arrange the return of the sender's money with the owner partner.",
    );
    expect(stuckHeldMessage(ID, 'travelrule', 'partner_collected', true)).toBe(
      head('travelrule') +
        "Issue refund is not available for a transfer that another partner pays out: a person must arrange the return of the sender's money with the owner partner.",
    );
    for (const r of ['fundmode', 'travelrule'] as const) {
      expect(stuckHeldMessage(ID, r, 'partner_collected', true)).not.toMatch(/with Issue refund|or Issue refund/);
      expect(stuckHeldMessage(ID, r, 'partner_collected', false)).not.toMatch(/cancel/i);
    }
    for (const routed of [false, true]) expect(stuckHeldMessage(ID, 'mockfund', 'partner_collected', routed)).toBe(stuckHeldMessage(ID, 'mockfund'));
    for (const cls of ['mock', 'partner_pull', 'sandbox', undefined] as const) {
      for (const r of REASONS) expect(stuckHeldMessage(ID, r, cls, true)).toBe(stuckHeldMessage(ID, r));
    }
  });

  it('alertStuckHeld passes the routed fact: a routed partner-collected row gets the routed text', async () => {
    expect(await alertStuckHeld(db, fixture({ settlementPartnerId: 'railp' }), 'travelrule')).toBe(true);
    expect(await alerts()).toEqual([{ k: `travelrule:stuck:${ID}`, m: stuckHeldMessage(ID, 'travelrule', 'partner_collected', true) }]);
    expect((await alerts())[0].m).not.toBe(stuckHeldMessage(ID, 'travelrule', 'partner_collected', false));
  });

  it('alertStuckHeld reads the class from the row: a stripe-funded row gets the stripe text', async () => {
    expect(await alertStuckHeld(db, fixture({ fundingProvider: 'stripe', fundingRef: 'pi_x' }), 'fundmode')).toBe(true);
    expect(await alerts()).toEqual([{ k: `fundmode:stuck:${ID}`, m: stuckHeldMessage(ID, 'fundmode', 'stripe') }]);
  });
});

function store() {
  return createStore(fakeRedis(), db);
}
