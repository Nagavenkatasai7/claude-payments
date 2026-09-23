import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { reconcileSweep } from '@/lib/reconcile';
import { beginHold, releaseHold } from '@/lib/settlement';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Program-Fix 32 — stale money: unpaid links expire after 7 days (neon-09), and
// money stuck in 'paid' escalates on a 1 h / 6 h / 24 h / daily ladder (neon-10).

// The expiry-race test flips a row to 'paid' between the sweep's list read and
// its guarded cancel. The hook is null for every other test.
const hooks = vi.hoisted(() => ({ afterList: null as null | (() => Promise<void>) }));
vi.mock('@/db/repos/transfer-repo', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/db/repos/transfer-repo')>();
  return {
    ...mod,
    createTransferRepo: (...args: Parameters<typeof mod.createTransferRepo>) => {
      const repo = mod.createTransferRepo(...args);
      return {
        ...repo,
        async listStaleUnfunded(cutoff: Date, limit?: number) {
          const rows = await repo.listStaleUnfunded(cutoff, limit);
          if (hooks.afterList) await hooks.afterList();
          return rows;
        },
      };
    },
  };
});

import {
  escalateStuckPaid,
  expireUnpaidLinks,
  isEscalated,
  stuckRung,
  UNPAID_LINK_EXPIRY_DAYS,
} from '@/lib/stale-money';

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const DAY = 86_400_000;
const HOUR = 3_600_000;

function fixture(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'sm_t1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date().toISOString(), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

let db: Db;
let store: ReturnType<typeof createStore>;

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  const r = await db.execute(q);
  return (r as unknown as { rows: T[] }).rows;
}
const alerts = () =>
  rows<{ dedupe_key: string; payload: { message: string } }>(
    sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'ops.alert' ORDER BY id`,
  );
const audits = (action: string) =>
  rows<{ partner_id: string; actor: string; actor_type: string; subject_id: string; meta: Record<string, unknown> }>(
    sql`SELECT partner_id, actor, actor_type, subject_id, meta FROM audit_events WHERE action = ${action} ORDER BY id`,
  );
const statusOf = async (id: string) => (await store.getTransfer(id))?.status;

beforeEach(async () => {
  hooks.afterList = null;
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'acme');
});

describe('stuckRung — the escalation ladder', () => {
  it('null under 1 h; then 1h, 6h, 24h, and d<N> from day 2 on (the highest rung crossed)', () => {
    expect(stuckRung(59 * 60_000)).toBeNull();
    expect(stuckRung(HOUR)).toBe('1h');
    expect(stuckRung(6 * HOUR - 1)).toBe('1h');
    expect(stuckRung(6 * HOUR)).toBe('6h');
    expect(stuckRung(7 * HOUR)).toBe('6h');
    expect(stuckRung(24 * HOUR)).toBe('24h');
    expect(stuckRung(47 * HOUR)).toBe('24h');
    expect(stuckRung(48 * HOUR)).toBe('d2');
    expect(stuckRung(50 * HOUR)).toBe('d2');
    expect(stuckRung(12 * DAY + HOUR)).toBe('d12');
  });
});

describe('isEscalated — the ops page red badge', () => {
  it('true once a paid transfer has crossed the first rung (60 min); false before, or with no paidAt', () => {
    const now = Date.now();
    expect(isEscalated(new Date(now - 59 * 60_000).toISOString(), now)).toBe(false);
    expect(isEscalated(new Date(now - 61 * 60_000).toISOString(), now)).toBe(true);
    expect(isEscalated(undefined, now)).toBe(false);
  });
});

describe('expireUnpaidLinks (Program-Fix 32, neon-09)', () => {
  it('the owner-decided window is 7 days', () => {
    expect(UNPAID_LINK_EXPIRY_DAYS).toBe(7);
  });

  it('cancels an unfunded awaiting_payment row older than 7 days with ONE transfer.expired audit row; everything else is untouched; a second run changes nothing', async () => {
    const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();
    await store.saveTransfer(fixture({ id: 'x_old', createdAt: ago(8) }));
    await store.saveTransfer(fixture({ id: 'x_young', createdAt: ago(6) }));
    await store.saveTransfer(fixture({ id: 'x_charged', createdAt: ago(30), fundingRef: 'mockfund-x_charged' }));
    await store.saveTransfer(fixture({ id: 'x_review', createdAt: ago(30), status: 'in_review' }));
    await store.saveTransfer(fixture({ id: 'x_paid', createdAt: ago(30), status: 'paid', paidAt: ago(30) }));
    await store.saveTransfer(fixture({ id: 'x_delivered', createdAt: ago(30), status: 'delivered' }));
    await store.saveTransfer(fixture({
      id: 'x_b2b', createdAt: ago(30), transferType: 'b2b', invoiceId: 'inv_1',
      senderEntityType: 'business', recipientEntityType: 'business',
    }));

    expect(await expireUnpaidLinks(db)).toBe(1);
    expect(await statusOf('x_old')).toBe('cancelled');
    expect(await statusOf('x_young')).toBe('awaiting_payment');
    expect(await statusOf('x_charged')).toBe('awaiting_payment');
    expect(await statusOf('x_review')).toBe('in_review');
    expect(await statusOf('x_paid')).toBe('paid');
    expect(await statusOf('x_delivered')).toBe('delivered');
    expect(await statusOf('x_b2b')).toBe('awaiting_payment'); // review S1: B2B invoice rows never expire
    expect(await audits('transfer.expired')).toEqual([
      { partner_id: 'acme', actor: 'system', actor_type: 'system', subject_id: 'x_old', meta: { ageDays: 8 } },
    ]);
    // No customer message, no alert: the sweep writes the status and the audit row only.
    expect(await rows(sql`SELECT id FROM outbox`)).toEqual([]);

    expect(await expireUnpaidLinks(db)).toBe(0);
    expect(await audits('transfer.expired')).toHaveLength(1);
  });

  it('race: a row flipped to paid between the list and the update is NOT cancelled and gets no audit row', async () => {
    await store.saveTransfer(fixture({ id: 'x_race', createdAt: new Date(Date.now() - 8 * DAY).toISOString() }));
    hooks.afterList = async () => {
      await createTransferRepo(db).markPaidIfAwaiting('x_race');
    };
    expect(await expireUnpaidLinks(db)).toBe(0);
    expect(await statusOf('x_race')).toBe('paid');
    expect(await audits('transfer.expired')).toEqual([]);
  });
});

describe('escalateStuckPaid (Program-Fix 32, neon-10)', () => {
  async function paidFor(id: string, interval: string, over: Partial<Transfer> = {}) {
    await store.saveTransfer(fixture({ id, status: 'paid', paidAt: new Date().toISOString(), ...over }));
    await db.execute(sql`UPDATE transfers SET paid_at = now() - ${interval}::interval WHERE id = ${id}`);
  }

  it('61 min ⇒ recon:<id>:1h + ONE transfer.stuck_escalated audit row; a re-run adds nothing', async () => {
    await seedPartner(db, 'railco');
    await paidFor('p_61', '61 minutes', { settlementPartnerId: 'railco' });
    expect(await escalateStuckPaid(db)).toBe(1);
    const a = await alerts();
    expect(a.map((x) => x.dedupe_key)).toEqual(['recon:p_61:1h']);
    expect(a[0].payload.message).toContain('p_61');
    expect(a[0].payload.message).toContain('acme');
    expect(a[0].payload.message).toContain('railco');
    expect(a[0].payload.message).not.toMatch(/\d{7,}/); // ids only — never the sender's phone
    expect(a[0].payload.message).not.toContain('HDFC');
    expect(await audits('transfer.stuck_escalated')).toEqual([
      { partner_id: 'acme', actor: 'system', actor_type: 'system', subject_id: 'p_61', meta: { rung: '1h' } },
    ]);

    expect(await escalateStuckPaid(db)).toBe(0);
    expect(await alerts()).toHaveLength(1);
    expect(await audits('transfer.stuck_escalated')).toHaveLength(1);
  });

  it('7 h gives ONLY :6h; 50 h gives :d2', async () => {
    await paidFor('p_7h', '7 hours');
    await paidFor('p_50h', '50 hours');
    expect(await escalateStuckPaid(db)).toBe(2);
    expect((await alerts()).map((x) => x.dedupe_key).sort()).toEqual(['recon:p_50h:d2', 'recon:p_7h:6h']);
  });

  it('under an hour, or refund_status <> none, gives nothing', async () => {
    await paidFor('p_30m', '30 minutes');
    await paidFor('p_refund', '5 hours');
    await db.execute(sql`UPDATE transfers SET refund_status = 'pending' WHERE id = 'p_refund'`);
    expect(await escalateStuckPaid(db)).toBe(0);
    expect(await alerts()).toEqual([]);
    expect(await audits('transfer.stuck_escalated')).toEqual([]);
  });
});

// compliance-11 is closed by fix 6 (Task 3). This pins why findStuckPaid must
// NOT gain a `compliance_status <> 'flagged'` predicate: a staff-released
// transfer stays 'flagged' forever and is legitimately 'paid'.
describe('compliance pin (compliance-11)', () => {
  beforeEach(async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' },
        webhookSecret: 'w',
      },
      whatsapp: {},
    });
  });

  it('a RELEASED transfer (paid + flagged) is still returned by findStuckPaid and re-instructed ONCE; a HELD one (in_review) never is', async () => {
    const t = fixture({ id: 'c_rel', complianceStatus: 'flagged' });
    await store.saveTransfer(t);
    expect(await beginHold(db, t)).toEqual({ kind: 'held' });
    const integrations = await createIntegrationsRepo(db, provider).getIntegrations('acme');
    expect(await releaseHold(db, (await store.getTransfer('c_rel'))!, integrations)).toEqual({ kind: 'released', webhookDriven: true });
    await db.execute(sql`UPDATE transfers SET paid_at = now() - interval '20 minutes' WHERE id = 'c_rel'`);

    const held = fixture({ id: 'c_held', complianceStatus: 'flagged' });
    await store.saveTransfer(held);
    expect(await beginHold(db, held)).toEqual({ kind: 'held' });
    await db.execute(sql`UPDATE transfers SET paid_at = now() - interval '20 minutes' WHERE id = 'c_held'`);

    const stuck = await createTransferRepo(db).findStuckPaid(15);
    expect(stuck.map((x) => [x.id, x.complianceStatus])).toEqual([['c_rel', 'flagged']]);

    expect((await reconcileSweep(db)).reinstructed).toBe(1);
    expect((await reconcileSweep(db)).reinstructed).toBe(0);
    const keys = (await rows<{ dedupe_key: string }>(sql`SELECT dedupe_key FROM outbox WHERE kind = 'settlement.instruct' ORDER BY id`))
      .map((r) => r.dedupe_key);
    expect(keys).toEqual(['instruct:c_rel', 'reinstruct:c_rel']);
  });
});
