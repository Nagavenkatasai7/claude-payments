import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner, seedSender } from './helpers-db';

// UI redesign M2-11b (plan Task 11.5, review round 1 M7): the automatic receipt email on delivery,
// pinned at the ONE chokepoint every `delivered` writer goes through (Store.updateTransferFromWebhook
// → deliverTransfer). The two writers themselves are covered end to end in
// tests/delivery-receipt-writers.test.ts.

// Controllable failures: the prefs read (fail open) and the in-transaction enqueue (same tx).
const faults = vi.hoisted(() => ({ prefsThrow: false, enqueueThrow: false }));
vi.mock('@/lib/portal-prefs', async (orig) => {
  const real = await orig<typeof import('@/lib/portal-prefs')>();
  return {
    ...real,
    getPortalPrefs: async (...a: Parameters<typeof real.getPortalPrefs>) => {
      if (faults.prefsThrow) throw new Error('relation "customer_portal_prefs" failed for 14155550123 user@example.com');
      return real.getPortalPrefs(...a);
    },
  };
});
vi.mock('@/db/repos/outbox-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/outbox-repo')>();
  return {
    ...real,
    createOutboxRepo: (...a: Parameters<typeof real.createOutboxRepo>) => {
      const repo = real.createOutboxRepo(...a);
      return {
        ...repo,
        enqueue: async (...e: Parameters<typeof repo.enqueue>) => {
          if (faults.enqueueThrow && e[0] === 'email.send') {
            // A REAL database error on the same handle first: without a savepoint this aborts the
            // whole delivered transaction (Postgres: "current transaction is aborted").
            const { sql: rawSql } = await import('drizzle-orm');
            await (a[0] as { execute: (q: unknown) => Promise<unknown> }).execute(rawSql`SELECT 1/0`).catch(() => undefined);
            throw new Error(`Failed query: insert into outbox params: ${JSON.stringify(e[1])}`);
          }
          return repo.enqueue(...e);
        },
      };
    },
  };
});
const logWarnSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  return { ...real, logWarn: (...a: unknown[]) => { logWarnSpy(...a); } };
});

import { createStore } from '@/lib/store';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { emailVerifiedTag, markEmailVerified, setEmailReceipts } from '@/lib/portal-prefs';
import { renderSealedText } from '@/lib/sealed-text';
import { createRewardRepo } from '@/db/repos/reward-repo';
import { completePaymentStage2 } from '@/lib/payment';

const PHONE = '14155550123';
const EMAIL = 'user@example.com';
const FULL_ACCOUNT = '123456789012';

let db: Db;

function transfer(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'rc_t1', phone: PHONE, amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: `HDFC0001234 ${FULL_ACCOUNT}`, fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 60_000).toISOString(), paidAt: new Date().toISOString(), partnerId: 'pa',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

/** A customer on `partnerId` with a verified address and (by default) receipts ON. */
async function optIn(partnerId: string, opts: { receipts?: boolean; verified?: boolean; email?: string } = {}) {
  await seedSender(db, { partnerId, phone: PHONE });
  const email = opts.email ?? EMAIL;
  await createCustomerRepo(db, async () => null).setEmail(partnerId, PHONE, email);
  if (opts.verified ?? true) await markEmailVerified(db, partnerId, PHONE, emailVerifiedTag(partnerId, PHONE, email));
  await setEmailReceipts(db, partnerId, PHONE, opts.receipts ?? true);
}

type Row = { kind: string; dedupe_key: string | null; payload: Record<string, unknown> };
async function emailRows(): Promise<Row[]> {
  const r = (await db.execute(sql`SELECT kind, dedupe_key, payload FROM outbox WHERE kind = 'email.send' ORDER BY id`)) as unknown as { rows: Row[] };
  return r.rows;
}
async function statusOf(id: string): Promise<string | undefined> {
  const r = (await db.execute(sql`SELECT status FROM transfers WHERE id = ${id}`)) as unknown as { rows: Array<{ status: string }> };
  return r.rows[0]?.status;
}

const store = () => createStore(fakeRedis(), db);

beforeEach(async () => {
  db = await freshDb();
  faults.prefsThrow = false;
  faults.enqueueThrow = false;
  logWarnSpy.mockClear();
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
  // The end-customer brand is always SmartRemit (resolvePartnerBranding, 2026-10-04), whatever the display name.
  await db.execute(sql`UPDATE partners SET display_name = 'Partner A' WHERE id = 'pa'`);
  await db.execute(sql`UPDATE partners SET display_name = 'Partner B' WHERE id = 'pb'`);
  // M2-14 (#417 L2): receipts need the portal ON (platform switch + this partner enabled).
  process.env.CUSTOMER_PORTAL_ENABLED = '1';
  await db.execute(sql`INSERT INTO partner_portal_settings (partner_id, portal_enabled_at) VALUES ('pa', now()), ('pb', now())`);
});
afterEach(() => {
  delete process.env.CUSTOMER_PORTAL_ENABLED;
});

describe('automatic receipt on delivery — the shared delivered transition (Store.updateTransferFromWebhook)', () => {
  it('receipts ON + verified → delivered AND exactly one sealed email.send row (rcpt-auto:<id>)', async () => {
    await optIn('pa');
    await store().saveTransfer(transfer());
    const updated = await store().updateTransferFromWebhook('rc_t1', 'delivered');
    expect(updated?.status).toBe('delivered');
    const rows = await emailRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe('rcpt-auto:rc_t1');
    expect(rows[0].payload.to).toEqual([EMAIL]);
    expect(rows[0].payload.subject).toBe('Your SmartRemit transfer receipt');
    expect(rows[0].payload.text).toBe('{{receipt_body}}');
  });

  it('M2-14 (#417 L2): the portal switched off (platform flag, or this partner not enabled) → delivered, no email', async () => {
    await optIn('pa');
    delete process.env.CUSTOMER_PORTAL_ENABLED;
    await store().saveTransfer(transfer());
    expect((await store().updateTransferFromWebhook('rc_t1', 'delivered'))?.status).toBe('delivered');
    expect(await emailRows()).toHaveLength(0);

    process.env.CUSTOMER_PORTAL_ENABLED = '1';
    await db.execute(sql`UPDATE partner_portal_settings SET portal_enabled_at = NULL WHERE partner_id = 'pa'`);
    await store().saveTransfer(transfer({ id: 'rc_t2' }));
    expect((await store().updateTransferFromWebhook('rc_t2', 'delivered'))?.status).toBe('delivered');
    expect(await emailRows()).toHaveLength(0);
  });

  it('M2-14 (#417 L2): the receipt body ends with how to stop these emails', async () => {
    await optIn('pa');
    await store().saveTransfer(transfer());
    await store().updateTransferFromWebhook('rc_t1', 'delivered');
    const rows = await emailRows();
    const body = renderSealedText(String(rows[0].payload.text), rows[0].payload.sealed);
    expect(body).toMatch(/turn off email receipts/i);
    expect(body).toContain('Notifications');
  });

  it('B3: a transfer that carried a reward gets the reward line in its receipt', async () => {
    await optIn('pa');
    await store().saveTransfer(transfer({ feeUsd: 0, feeSource: 0, totalChargeUsd: 200, totalChargeSource: 200 }));
    await createRewardRepo(db).insertRedemption({
      transferId: 'rc_t1', partnerId: 'pa', phone: PHONE, month: '2026-10',
      reward: { kind: 'first_transfer', discountUsd: 5, detail: {} }, giveBackUsd: 0, giveBackWithheld: false,
    });
    await store().updateTransferFromWebhook('rc_t1', 'delivered');
    const [row] = await emailRows();
    const body = renderSealedText(String(row.payload.text), row.payload.sealed);
    expect(body).toContain('Fee: $0.00\nReward: first transfer free (saved $5.00).');
  });

  it('the body is sealed at rest and carries the MASKED destination only', async () => {
    await optIn('pa');
    await store().saveTransfer(transfer());
    await store().updateTransferFromWebhook('rc_t1', 'delivered');
    const [row] = await emailRows();
    const raw = JSON.stringify(row.payload);
    expect(raw).not.toContain(FULL_ACCOUNT);
    expect(raw).not.toContain('Anita'); // the whole body is ciphertext
    // The worker's email.send path opens it exactly like the manual receipt.
    const body = renderSealedText(String(row.payload.text), row.payload.sealed);
    expect(body).toContain('rc_t1');
    expect(body).toContain('****9012');
    expect(body).not.toContain(FULL_ACCOUNT);
    expect(body).toContain('Delivered');
  });

  it('a replayed delivered transition → still ONE row (non-null only on the real transition)', async () => {
    await optIn('pa');
    await store().saveTransfer(transfer());
    expect(await store().updateTransferFromWebhook('rc_t1', 'delivered')).not.toBeNull();
    expect(await store().updateTransferFromWebhook('rc_t1', 'delivered')).toBeNull();
    expect(await emailRows()).toHaveLength(1);
  });

  it('receipts OFF → delivered, no email', async () => {
    await optIn('pa', { receipts: false });
    await store().saveTransfer(transfer());
    expect((await store().updateTransferFromWebhook('rc_t1', 'delivered'))?.status).toBe('delivered');
    expect(await emailRows()).toHaveLength(0);
  });

  it('receipts ON but the address is not verified → no email', async () => {
    await optIn('pa', { verified: false });
    await store().saveTransfer(transfer());
    expect((await store().updateTransferFromWebhook('rc_t1', 'delivered'))?.status).toBe('delivered');
    expect(await emailRows()).toHaveLength(0);
  });

  it('the address changed after verification (tag mismatch) → no email', async () => {
    await optIn('pa');
    await createCustomerRepo(db, async () => null).setEmail('pa', PHONE, 'new@example.com'); // tag is for the old address
    await store().saveTransfer(transfer());
    expect((await store().updateTransferFromWebhook('rc_t1', 'delivered'))?.status).toBe('delivered');
    expect(await emailRows()).toHaveLength(0);
  });

  it('a sandbox (test) transfer never emails', async () => {
    await optIn('pa');
    await store().saveTransfer(transfer({ environment: 'test' }));
    expect((await store().updateTransferFromWebhook('rc_t1', 'delivered'))?.status).toBe('delivered');
    expect(await emailRows()).toHaveLength(0);
  });

  it("another tenant's prefs are never used: same phone opted in on B, transfer on A → no email", async () => {
    await optIn('pb');
    await seedSender(db, { partnerId: 'pa', phone: PHONE }); // A knows the customer, no prefs, no address
    await store().saveTransfer(transfer({ partnerId: 'pa' }));
    expect((await store().updateTransferFromWebhook('rc_t1', 'delivered'))?.status).toBe('delivered');
    expect(await emailRows()).toHaveLength(0);
  });

  it("the tenant comes from the transfer: opted in on BOTH, A's transfer mails A's address, branded SmartRemit", async () => {
    await optIn('pa', { email: 'a@example.com' });
    await optIn('pb', { email: 'b@example.com' });
    await store().saveTransfer(transfer({ partnerId: 'pa' }));
    await store().updateTransferFromWebhook('rc_t1', 'delivered');
    const rows = await emailRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.to).toEqual(['a@example.com']);
    expect(rows[0].payload.subject).toBe('Your SmartRemit transfer receipt');
  });

  it('a prefs read failure NEVER blocks delivery: delivered commits, no email, a warning without PII', async () => {
    await optIn('pa');
    await store().saveTransfer(transfer());
    faults.prefsThrow = true;
    expect((await store().updateTransferFromWebhook('rc_t1', 'delivered'))?.status).toBe('delivered');
    expect(await statusOf('rc_t1')).toBe('delivered');
    expect(await emailRows()).toHaveLength(0);
    expect(logWarnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logWarnSpy.mock.calls[0]);
    expect(logged).toContain('rc_t1');
    expect(logged).not.toContain(PHONE);
    expect(logged).not.toContain(EMAIL);
  });

  it('an enqueue failure never holds back delivery (owner 2026-09-28): the flip commits, no receipt, a PII-free warning', async () => {
    await optIn('pa');
    await store().saveTransfer(transfer());
    faults.enqueueThrow = true;
    const updated = await store().updateTransferFromWebhook('rc_t1', 'delivered');
    expect(updated?.status).toBe('delivered');
    expect(await statusOf('rc_t1')).toBe('delivered');
    expect(await emailRows()).toHaveLength(0);
    expect(logWarnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logWarnSpy.mock.calls[0]);
    expect(logged).toContain('rc_t1');
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain(PHONE);
    // A replayed callback is not a transition: still no receipt, still delivered.
    faults.enqueueThrow = false;
    expect(await store().updateTransferFromWebhook('rc_t1', 'delivered')).toBeNull();
    expect(await emailRows()).toHaveLength(0);
  });

  it('the rcpt-auto:<id> dedupe key alone holds: a pre-existing receipt row → delivered, still ONE row', async () => {
    await optIn('pa');
    await store().saveTransfer(transfer());
    await db.execute(sql`INSERT INTO outbox (kind, payload, next_attempt_at, dedupe_key) VALUES ('email.send', '{}'::jsonb, now(), 'rcpt-auto:rc_t1')`);
    expect((await store().updateTransferFromWebhook('rc_t1', 'delivered'))?.status).toBe('delivered');
    expect(await emailRows()).toHaveLength(1);
  });

  it('awaiting_payment (cleared) → delivered directly also sends the receipt', async () => {
    await optIn('pa');
    await store().saveTransfer(transfer({ status: 'awaiting_payment', paidAt: undefined }));
    expect((await store().updateTransferFromWebhook('rc_t1', 'delivered'))?.status).toBe('delivered');
    expect(await emailRows()).toHaveLength(1);
  });

  it('a refused delivery (refund in progress) → null, no email', async () => {
    await optIn('pa');
    await store().saveTransfer(transfer({ refundStatus: 'requested' }));
    expect(await store().updateTransferFromWebhook('rc_t1', 'delivered')).toBeNull();
    expect(await statusOf('rc_t1')).toBe('paid');
    expect(await emailRows()).toHaveLength(0);
  });

  it("the 'paid' transition is unchanged: never a receipt", async () => {
    await optIn('pa');
    await store().saveTransfer(transfer({ status: 'awaiting_payment', paidAt: undefined }));
    expect((await store().updateTransferFromWebhook('rc_t1', 'paid'))?.status).toBe('paid');
    expect(await emailRows()).toHaveLength(0);
  });

  it('completePaymentStage2 (payment.ts) delivers through the same transition → one receipt', async () => {
    await optIn('pa');
    await store().saveTransfer(transfer());
    const r = await completePaymentStage2(store(), 'rc_t1', { brand: 'Partner A' });
    expect(r.transfer.status).toBe('delivered');
    expect(r.senderMessages).toHaveLength(1);
    expect(await emailRows()).toHaveLength(1);
  });
});
