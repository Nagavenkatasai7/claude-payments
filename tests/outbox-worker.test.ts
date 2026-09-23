import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { sql } from 'drizzle-orm';
import { createOutboxRepo, MAX_ATTEMPTS, LEASE_MS } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { drainOnce, ROW_DEADLINE_MS, type WorkerDeps } from '@/lib/outbox-worker';
import { FALLBACK_REPLY } from '@/lib/agent-fallback';
import { EnvKeyProvider, encryptField } from '@/lib/field-crypto';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import { RAIL_TIMEOUT_MS } from '@/lib/providers/http-payment-provider';
import { handleRailFailure } from '@/lib/rail-failure';
import { createCustomerStore } from '@/lib/customer-store';

// Spy on the integrations repo FACTORY: partnerContext() builds one repo per
// resolution, so "how many were built during a drain" is an engine-independent
// measure of the per-batch creds memoization (fix 11).
const integrationsRepoSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/db/repos/integrations-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/integrations-repo')>();
  return {
    ...real,
    createIntegrationsRepo: (...args: Parameters<typeof real.createIntegrationsRepo>) => {
      integrationsRepoSpy.calls++;
      return real.createIntegrationsRepo(...args);
    },
  };
});

// Program-Fix 31 PR B: a pass-through customer repo whose getCustomer can be
// made to throw, proving the compliance block fails OPEN (the instruction
// still goes out, originator null) and never dead-letters settlement.instruct.
const customerRepoFault = vi.hoisted(() => ({ throwOnGet: false }));
vi.mock('@/db/repos/customer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/customer-repo')>();
  return {
    ...real,
    createCustomerRepo: (...args: Parameters<typeof real.createCustomerRepo>) => {
      const repo = real.createCustomerRepo(...args);
      return {
        ...repo,
        getCustomer: async (...a: Parameters<typeof repo.getCustomer>) => {
          if (customerRepoFault.throwOnGet) throw new Error('decrypt failed for 15551230000');
          return repo.getCustomer(...a);
        },
      };
    },
  };
});

// The durability engine's failure paths: retry with backoff, dead-letter with
// exactly-one ops alert, and the settlement.instruct happy path (signed POST +
// write-once providerRef) — all on real Postgres.

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));

function transferFixture(): Transfer {
  return {
    id: 'wk_t1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: '2026-06-09T00:00:00.000Z', paidAt: '2026-06-09T00:01:00.000Z', partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
  } as Transfer;
}

let db: Db;
let store: ReturnType<typeof createStore>;
let outbox: ReturnType<typeof createOutboxRepo>;
const sendText = vi.fn(async (..._a: unknown[]) => {});
const sendTemplate = vi.fn(async (..._a: unknown[]) => {});
const fetchFn = vi.fn();
const runAgentTurn = vi.fn(async (..._a: unknown[]) => '');

function deps(): WorkerDeps {
  return {
    db, store,
    sendText: sendText as unknown as WorkerDeps['sendText'],
    sendTemplate: sendTemplate as unknown as WorkerDeps['sendTemplate'],
    fetchFn: fetchFn as unknown as typeof fetch,
    recipientTemplateName: 'transfer_delivered',
    recipientTemplateLang: 'en',
    listStaff: async () => [],
    runAgentTurn: runAgentTurn as unknown as WorkerDeps['runAgentTurn'],
  };
}

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  outbox = createOutboxRepo(db);
  await seedPartner(db, 'acme');
  sendText.mockReset();
  sendTemplate.mockReset();
  fetchFn.mockReset();
  runAgentTurn.mockReset();
  runAgentTurn.mockResolvedValue('');
});

describe('drainOnce — settlement.instruct (the real-rail outbound leg)', () => {
  beforeEach(async () => {
    await store.saveTransfer(transferFixture());
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 'sgn' },
        webhookSecret: 'whk',
      },
      whatsapp: {},
    });
  });

  it('POSTs the SIGNED instruction with the DECRYPTED account and persists providerRef once', async () => {
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'rail-xyz' }) });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'instruct:wk_t1' });

    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://rail.example/settle');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.reference).toBe('wk_t1');
    // Unrouted: the instruction's partner_id is the OWNING partner's.
    expect(body.partner_id).toBe('acme');
    // The instruction carries the REAL account (decrypted read), not the mask.
    expect(JSON.stringify(body)).toContain('123456789012');
    expect((init.headers as Record<string, string>)['x-signature']).toMatch(/^[0-9a-f]{64}$/);
    expect((await store.getTransfer('wk_t1'))!.paymentProviderRef).toBe('rail-xyz');
  });

  it('an instruct row for a transfer that is no longer paid (cancelled / rejected) sends NOTHING and is marked done', async () => {
    await store.saveTransfer({ ...transferFixture(), status: 'cancelled' });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'instruct:wk_t1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    const left = (await db.execute(sql`SELECT status FROM outbox WHERE dedupe_key = 'instruct:wk_t1'`)) as unknown as { rows: Array<{ status: string }> };
    expect(left.rows[0].status).toBe('done');
  });

  const rowStatus = async (key: string) =>
    ((await db.execute(sql`SELECT status FROM outbox WHERE dedupe_key = ${key}`)) as unknown as { rows: Array<{ status: string }> }).rows[0].status;

  it('an instruct row for a PAID transfer with a refund in flight (pending) sends NOTHING and is done (never pay out AND refund)', async () => {
    await store.saveTransfer({ ...transferFixture(), refundStatus: 'pending' });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'reinstruct:wk_t1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await rowStatus('reinstruct:wk_t1')).toBe('done');
  });

  it('an instruct row for a DELIVERED transfer sends nothing and is done (already paid out)', async () => {
    await store.saveTransfer({ ...transferFixture(), status: 'delivered' });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'instruct:wk_t1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await rowStatus('instruct:wk_t1')).toBe('done');
  });

  it("a PAID transfer whose refund is only REQUESTED keeps its instruct row RETRYABLE (not done): a dismissed request must still pay out", async () => {
    await store.saveTransfer({ ...transferFixture(), refundStatus: 'requested' });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'instruct:wk_t1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(0);
    expect(r.failed).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await rowStatus('instruct:wk_t1')).toBe('failed');

    // Staff dismiss the request (refund back to none) → the retry sends.
    await store.saveTransfer({ ...transferFixture(), refundStatus: 'none' });
    await db.execute(sql`UPDATE outbox SET next_attempt_at = now() WHERE dedupe_key = 'instruct:wk_t1'`);
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'rail-late' }) });
    const retry = await drainOnce(deps(), 'w1');
    expect(retry.processed).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await rowStatus('instruct:wk_t1')).toBe('done');
  });

  it('rail failure → retry with backoff; at MAX_ATTEMPTS → dead + EXACTLY ONE ops alert', async () => {
    fetchFn.mockResolvedValue({ ok: false, status: 503, text: async () => 'down' });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' });

    // First failure: retried, not dead, no alert.
    let r = await drainOnce(deps(), 'w1');
    expect(r.failed).toBe(1);
    expect(r.dead).toBe(0);
    expect(await outbox.listDead()).toHaveLength(0);

    // Fast-forward to the brink of death, then fail once more.
    await db.execute(
      sql`UPDATE outbox SET attempts = ${MAX_ATTEMPTS - 1}, next_attempt_at = now() WHERE kind = 'settlement.instruct'`,
    );
    r = await drainOnce(deps(), 'w1');
    expect(r.dead).toBe(1);
    expect(await outbox.listDead()).toHaveLength(1);

    // The death enqueued a deduped ops.alert; with OPS_ALERT_PHONE set it sends.
    process.env.OPS_ALERT_PHONE = '15715466207';
    r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((sendText.mock.calls[0] as unknown[])[0]).toBe('15715466207');
    expect((sendText.mock.calls[0] as unknown[])[1]).toContain('DEAD');
    // Re-dying the same row can never alert twice (dedupe key).
    const again = await outbox.enqueue('ops.alert', { message: 'dup' }, { dedupeKey: `dead:${(await outbox.listDead())[0].id}` });
    expect(again).toBe(false);
  });
});

describe('drainOnce — settlement.instruct compliance block (Program-Fix 31)', { retry: 0 }, () => {
  const SENDER_NAME = 'Test Sender Person';
  beforeEach(async () => {
    customerRepoFault.throwOnGet = false;
    await store.saveTransfer({ ...transferFixture(), recipientLegalName: 'Anita Legal', purpose: 'family_support' });
    const { createCustomerRepo } = await import('@/db/repos/customer-repo');
    // Seeded under the OWNER ('acme') with the default key provider — the
    // same one the worker's repo uses, so a positive read proves the wiring.
    await createCustomerRepo(db, async () => null).saveCustomer({
      senderPhone: '15551230000', firstSeenAt: '2026-01-01T00:00:00.000Z', kycStatus: 'verified',
      kycVerifiedAt: '2026-01-05T00:00:00.000Z', fullName: SENDER_NAME, dateOfBirth: '1980-01-02',
      residentialAddress: '1 Secret Lane', govIdType: 'passport', govIdNumber: 'X99887766',
      idLast4: '7766', idDocType: 'passport', senderCountry: 'US', partnerId: 'acme',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    } as Parameters<ReturnType<typeof createCustomerRepo>['saveCustomer']>[0]);
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 'sgn' },
        webhookSecret: 'whk',
      },
      whatsapp: {},
    });
  });
  afterEach(() => {
    customerRepoFault.throwOnGet = false;
  });

  it('the POSTed body = every legacy key unchanged + compliance v1 with the OWNER-keyed originator; x-signature verifies over the final body', async () => {
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'rail-c1' }) });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'instruct:wk_t1' });
    expect((await drainOnce(deps(), 'w1')).processed).toBe(1);

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const raw = String(init.body);
    const body = JSON.parse(raw) as Record<string, unknown> & { compliance: Record<string, unknown> };
    const { buildSettlementInstruction } = await import('@/lib/providers/http-payment-provider');
    const decrypted = await createTransferRepo(db).getTransfer('wk_t1', { decrypt: true });
    const { compliance, ...legacy } = body;
    expect(legacy).toEqual(JSON.parse(JSON.stringify({ ...buildSettlementInstruction(decrypted!), partner_id: 'acme' })));
    expect(Object.keys(body).at(-1)).toBe('compliance');
    expect(compliance.version).toBe(1);
    expect(compliance.originator).toEqual({
      entity_type: 'individual', name: SENDER_NAME, country: 'US', phone: '15551230000',
      id_type: 'passport', id_last4: '7766',
    });
    expect(compliance.beneficiary).toMatchObject({ name: 'Anita Legal' });
    expect(compliance.kyc).toMatchObject({ status: 'verified', tier: 'T1' });
    expect(compliance.purpose_code).toBeNull();
    for (const v of ['1980-01-02', 'Secret Lane', 'X99887766']) expect(raw).not.toContain(v);
    expect((init.headers as Record<string, string>)['x-signature']).toBe(createHmac('sha256', 'sgn').update(raw).digest('hex'));
    expect((await store.getTransfer('wk_t1'))!.paymentProviderRef).toBe('rail-c1');
  });

  it('carries the fix 14 screening reference (list source/version/decision) when the evidence row exists — never the party hashes', async () => {
    await createAuditRepo(db).record({
      partnerId: 'acme', actor: 'system:sanctions', actorType: 'system', action: 'sanctions.screen', subjectId: 'wk_t1',
      meta: {
        listSource: 'mock-watchlist', listVersion: 'v-test', listHash: 'h'.repeat(64), screenedAt: '2026-06-09T00:00:00.000Z',
        decision: 'clear', parties: [{ role: 'recipient', inputHash: 'f'.repeat(64), matched: false, matchScore: 0 }],
      },
    });
    // Its createdAt window is the fixture's 2026-06-09; the audit row's `at`
    // is now(), so move the transfer's createdAt to now to fall in the window.
    await store.saveTransfer({ ...transferFixture(), createdAt: new Date().toISOString() });
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'rail-c2' }) });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'instruct:wk_t1' });
    await drainOnce(deps(), 'w1');
    const raw = String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body);
    const screening = (JSON.parse(raw) as { compliance: { screening: Record<string, unknown> } }).compliance.screening;
    expect(screening).toMatchObject({
      status: 'cleared', list_source: 'mock-watchlist', list_version: 'v-test', decision: 'clear',
      screened_at: '2026-06-09T00:00:00.000Z',
    });
    expect(raw).not.toContain('f'.repeat(64));
    expect(raw).not.toContain('h'.repeat(64));
  });

  it('no evidence row ⇒ the screening list fields are omitted', async () => {
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'rail-c3' }) });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'instruct:wk_t1' });
    await drainOnce(deps(), 'w1');
    const body = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body)) as { compliance: { screening: Record<string, unknown> } };
    expect(Object.keys(body.compliance.screening).sort()).toEqual(['reasons', 'screened_at', 'status']);
  });

  it('FAIL-OPEN: getCustomer throws ⇒ the instruction is STILL POSTed (originator null), the row is done, a warn names the transfer id only', async () => {
    customerRepoFault.throwOnGet = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'rail-c4' }) });
      await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'instruct:wk_t1' });
      const r = await drainOnce(deps(), 'w1');
      expect(r.processed).toBe(1);
      expect(r.failed).toBe(0);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const raw = String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body);
      const body = JSON.parse(raw) as { reference: string; compliance: Record<string, unknown> };
      expect(body.reference).toBe('wk_t1');
      expect(body.compliance.version).toBe(1);
      expect(body.compliance.originator).toBeNull();
      expect(raw).not.toContain(SENDER_NAME);
      const rows = (await db.execute(sql`SELECT status FROM outbox WHERE dedupe_key = 'instruct:wk_t1'`)) as unknown as { rows: Array<{ status: string }> };
      expect(rows.rows[0].status).toBe('done');
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('instruct.compliance_block'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('wk_t1');
      expect(lines[0]).not.toContain('15551230000');
      expect(lines[0]).not.toContain('decrypt failed');
    } finally {
      warn.mockRestore();
    }
  });

  it('ROUTED: the rail partner gets originator null + routed true, the kyc status still read under the OWNER, and no sender name or phone anywhere in the body', async () => {
    await seedPartner(db, 'railp');
    await store.saveTransfer({ ...transferFixture(), settlementPartnerId: 'railp' });
    await createIntegrationsRepo(db, provider).saveIntegrations('railp', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://railp.example/settle', signingSecret: 'railp_sgn' },
        webhookSecret: 'railp_whk',
      },
      whatsapp: {},
    });
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'railp-c5' }) });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'instruct:wk_t1' });
    await drainOnce(deps(), 'w1');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://railp.example/settle');
    const raw = String(init.body);
    const body = JSON.parse(raw) as { partner_id: string; compliance: Record<string, unknown> };
    expect(body.partner_id).toBe('railp');
    expect(body.compliance.originator).toBeNull();
    expect(body.compliance.routed).toBe(true);
    expect(body.compliance.kyc).toMatchObject({ status: 'verified' });
    expect(raw).not.toContain(SENDER_NAME);
    expect(raw).not.toContain('15551230000');
    expect((init.headers as Record<string, string>)['x-signature']).toBe(createHmac('sha256', 'railp_sgn').update(raw).digest('hex'));
  });
});

describe('drainOnce — settlement.instruct (ROUTED via settlementPartnerId)', () => {
  beforeEach(async () => {
    // Owner 'acme' has its OWN rail config — which must NOT be used when routed.
    await seedPartner(db, 'railp');
    await store.saveTransfer({ ...transferFixture(), settlementPartnerId: 'railp' });
    const repo = createIntegrationsRepo(db, provider);
    await repo.saveIntegrations('acme', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://owner.example/settle', signingSecret: 'owner_sgn' },
        webhookSecret: 'owner_whk',
      },
      whatsapp: {},
    });
    await repo.saveIntegrations('railp', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://railp.example/settle', signingSecret: 'railp_sgn' },
        webhookSecret: 'railp_whk',
      },
      whatsapp: {},
    });
  });

  it("POSTs to the SETTLEMENT partner's URL, signed with THEIR secret, carrying THEIR partner_id", async () => {
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'railp-ref' }) });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'instruct:wk_t1' });

    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://railp.example/settle'); // NOT the owner's rail
    const raw = String(init.body);
    const body = JSON.parse(raw) as Record<string, unknown>;
    // The simulator rail verifies with the partner_id IN the instruction — when
    // routed it must be the settlement partner's id, signed with THEIR secret.
    expect(body.partner_id).toBe('railp');
    expect(body.reference).toBe('wk_t1');
    const expectedSig = createHmac('sha256', 'railp_sgn').update(raw).digest('hex');
    expect((init.headers as Record<string, string>)['x-signature']).toBe(expectedSig);
    expect((await store.getTransfer('wk_t1'))!.paymentProviderRef).toBe('railp-ref');
  });
});

describe('drainOnce — rail.callback (the reference rail settle leg)', () => {
  it('POSTs the signed paid_out callback to the public webhook', async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: { providerType: 'simulator', credentials: { settlementUrl: 'https://rail.example/x', signingSecret: 's' }, webhookSecret: 'whk_cb' },
      whatsapp: {},
    });
    fetchFn.mockResolvedValue({ ok: true });
    await outbox.enqueue('rail.callback', { reference: 'wk_t1', partner_id: 'acme' });

    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/payment-webhook/simulator');
    expect(JSON.parse(String(init.body))).toEqual({ reference: 'wk_t1', status: 'paid_out' });
    expect((init.headers as Record<string, string>)['x-signature']).toMatch(/^[0-9a-f]{64}$/);
  });
});

// Program-Fix 8: the reference rail's failure mode rides the same row.
describe('drainOnce — rail.callback carries a failure status through (fix 8)', () => {
  beforeEach(async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: { providerType: 'simulator', credentials: { settlementUrl: 'https://x', signingSecret: 's' }, webhookSecret: 'whk_cb' },
      whatsapp: {},
    });
    fetchFn.mockResolvedValue({ ok: true });
  });

  it('status + reason pass through into the SIGNED body', async () => {
    await outbox.enqueue('rail.callback', { reference: 'wk_t1', partner_id: 'acme', status: 'failed', reason: 'account_unreachable' });
    expect((await drainOnce(deps(), 'w1')).processed).toBe(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/payment-webhook/simulator');
    expect(JSON.parse(String(init.body))).toEqual({ reference: 'wk_t1', status: 'failed', reason: 'account_unreachable' });
    expect((init.headers as Record<string, string>)['x-signature'])
      .toBe(createHmac('sha256', 'whk_cb').update(String(init.body)).digest('hex'));
  });

  it('a non-string status / reason falls back to paid_out with no reason key', async () => {
    await outbox.enqueue('rail.callback', { reference: 'wk_t1', partner_id: 'acme', status: 7, reason: null });
    await drainOnce(deps(), 'w1');
    expect(JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ reference: 'wk_t1', status: 'paid_out' });
  });
});

describe('drainOnce — email.send (partner-lead notification)', () => {
  it('calls the injected sendEmail with the recipients + subject and marks done', async () => {
    const sent: { to: string[]; subject: string; text: string }[] = [];
    const d: WorkerDeps = { ...deps(), sendEmail: async (m) => { sent.push(m); } };
    await outbox.enqueue(
      'email.send',
      { to: ['venkat@smartremit.ai', 'rohan@smartremit.ai'], subject: 'New partner request: Acme Remit', text: 'Company: Acme Remit\nEmail: a@acme.com' },
      { dedupeKey: 'preq:abc123' },
    );
    const r = await drainOnce(d, 'w1');
    expect(r.processed).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['venkat@smartremit.ai', 'rohan@smartremit.ai']);
    expect(sent[0].subject).toContain('Acme Remit');
  });

  it('renders {{placeholders}} from field-crypto SEALED values at send time; the row holds only ciphertext (fix 11 / F66)', async () => {
    const sent: { to: string[]; subject: string; text: string }[] = [];
    const d: WorkerDeps = { ...deps(), sendEmail: async (m) => { sent.push(m); } };
    const link = 'https://smartremit.test/partners/apply/deadbeef';
    await outbox.enqueue(
      'email.send',
      { to: ['lead@acme.com'], subject: 'Complete', text: 'Go:\n\n{{apply_link}}\n\nThanks', sealed: { apply_link: encryptField(link) } },
      { dedupeKey: 'partner_app_invite:preq_x' },
    );
    const r = await drainOnce(d, 'w1');
    expect(r.processed).toBe(1);
    expect(sent[0].text).toBe(`Go:\n\n${link}\n\nThanks`);
    const row = (await db.execute(sql`SELECT payload FROM outbox WHERE dedupe_key = 'partner_app_invite:preq_x'`)) as unknown as {
      rows: Array<{ payload: unknown }>;
    };
    expect(JSON.stringify(row.rows[0].payload)).not.toContain('deadbeef');
  });

  it('a placeholder with no sealed blob FAILS the row (retryable) with a last_error naming only the placeholder', async () => {
    const d: WorkerDeps = { ...deps(), sendEmail: async () => {} };
    await outbox.enqueue('email.send', { to: ['lead@acme.com'], subject: 's', text: '{{apply_link}}', sealed: {} });
    const r = await drainOnce(d, 'w1');
    expect(r.failed).toBe(1);
    const row = (await db.execute(sql`SELECT last_error FROM outbox WHERE kind = 'email.send'`)) as unknown as {
      rows: Array<{ last_error: string }>;
    };
    expect(row.rows[0].last_error).toBe('sealed-text: no sealed value for {{apply_link}}');
  });
});

describe('drainOnce — email.send reports skips honestly (Program-Fix 39)', () => {
  type AuditRow = { action: string; actor: string; actor_type: string; subject_id: string | null; meta: Record<string, unknown> };
  async function audits(): Promise<AuditRow[]> {
    const r = (await db.execute(
      sql`SELECT action, actor, actor_type, subject_id, meta FROM audit_events WHERE action LIKE 'email.%' ORDER BY id`,
    )) as unknown as { rows: AuditRow[] };
    return r.rows;
  }
  async function alertKeys(): Promise<string[]> {
    const r = (await db.execute(
      sql`SELECT dedupe_key FROM outbox WHERE kind = 'ops.alert' ORDER BY id`,
    )) as unknown as { rows: Array<{ dedupe_key: string }> };
    return r.rows.map((x) => x.dedupe_key);
  }
  async function statusOf(key: string): Promise<string> {
    const r = (await db.execute(sql`SELECT status FROM outbox WHERE dedupe_key = ${key}`)) as unknown as {
      rows: Array<{ status: string }>;
    };
    return r.rows[0].status;
  }

  it('skipped send writes one email.skipped audit row and one alert per day', async () => {
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2030-01-02T10:00:00Z'));
      const d: WorkerDeps = { ...deps(), sendEmail: async () => 'skipped_unconfigured' };
      await outbox.enqueue('email.send', { to: ['ops@example.test'], subject: 'New partner request: A', text: 't' }, { dedupeKey: 'preq:preq_aaa' });
      await outbox.enqueue('email.send', { to: ['lead@example.test'], subject: 'Complete', text: 't' }, { dedupeKey: 'partner_app_invite:preq_aaa' });
      const r = await drainOnce(d, 'w1');
      expect(r.processed).toBe(2);
      // No retry storm: both rows end done.
      expect(await statusOf('preq:preq_aaa')).toBe('done');
      expect(await statusOf('partner_app_invite:preq_aaa')).toBe('done');

      const rows = await audits();
      expect(rows).toHaveLength(2);
      for (const a of rows) {
        expect(a).toMatchObject({ action: 'email.skipped', actor: 'outbox', actor_type: 'system', subject_id: 'preq_aaa' });
        expect(a.meta.reason).toBe('unconfigured');
        expect(typeof a.meta.outboxId).toBe('number');
        // Never an address in the audit meta.
        expect(JSON.stringify(a.meta)).not.toContain('@');
      }
      expect(rows.map((a) => a.meta.dedupePrefix)).toEqual(['preq', 'partner_app_invite']);
      // ONE alert for the day, however many sends skipped.
      expect(await alertKeys()).toEqual(['email-unconfigured:2030-01-02']);

      // Next UTC day: one more alert.
      vi.setSystemTime(new Date('2030-01-03T00:05:00Z'));
      await outbox.enqueue('email.send', { to: ['ops@example.test'], subject: 's', text: 't' }, { dedupeKey: 'preq:preq_bbb' });
      await drainOnce(d, 'w1');
      expect((await alertKeys()).filter((k) => k.startsWith('email-unconfigured:'))).toEqual([
        'email-unconfigured:2030-01-02',
        'email-unconfigured:2030-01-03',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skipped_no_recipients writes an audit row with reason 'no_recipients' and raises NO alert", async () => {
    const d: WorkerDeps = { ...deps(), sendEmail: async () => 'skipped_no_recipients' };
    await outbox.enqueue('email.send', { to: [], subject: 's', text: 't' }, { dedupeKey: 'preq:preq_ccc' });
    await drainOnce(d, 'w1');
    expect(await statusOf('preq:preq_ccc')).toBe('done');
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ reason: 'no_recipients', dedupePrefix: 'preq' });
    expect(await alertKeys()).toEqual([]);
  });

  it('an ops-alert EMAIL mirror (opsmail:) that skips is audited but raises NO alert (no ping-pong with fix 26)', async () => {
    const d: WorkerDeps = { ...deps(), sendEmail: async () => 'skipped_unconfigured' };
    await outbox.enqueue('email.send', { to: ['ops@example.test'], subject: 'SmartRemit ops alert', text: 't' }, { dedupeKey: 'opsmail:41' });
    await drainOnce(d, 'w1');
    expect(await statusOf('opsmail:41')).toBe('done');
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_id).toBeNull();
    expect(rows[0].meta).toMatchObject({ reason: 'unconfigured', dedupePrefix: null });
    expect(await alertKeys()).toEqual([]);
  });

  it('resend key → same preq subject', async () => {
    const d: WorkerDeps = { ...deps(), sendEmail: async () => 'skipped_unconfigured' };
    await outbox.enqueue('email.send', { to: ['lead@example.test'], subject: 's', text: 't' }, { dedupeKey: 'partner_app_invite:preq_ddd:r0123456789ab' });
    await drainOnce(d, 'w1');
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_id).toBe('preq_ddd');
    expect(rows[0].meta.dedupePrefix).toBe('partner_app_invite');
  });

  it("a 'sent' outcome and a void-returning sender both write NO audit row and NO alert", async () => {
    await outbox.enqueue('email.send', { to: ['x@example.test'], subject: 's', text: 't' }, { dedupeKey: 'preq:preq_eee' });
    await drainOnce({ ...deps(), sendEmail: async () => 'sent' }, 'w1');
    await outbox.enqueue('email.send', { to: ['x@example.test'], subject: 's', text: 't' }, { dedupeKey: 'preq:preq_fff' });
    await drainOnce({ ...deps(), sendEmail: async () => {} }, 'w1');
    expect(await audits()).toEqual([]);
    expect(await alertKeys()).toEqual([]);
  });
});

describe('drainOnce — plain sends resolve WhatsApp creds at DRAIN time (fix 11 / F49·F54·F58)', () => {
  const ACME_WA = { phoneNumberId: 'pn_acme', token: 'tok_acme' };
  async function byoWhatsApp(partnerId: string, whatsapp: Record<string, string>) {
    await createIntegrationsRepo(db, provider).saveIntegrations(partnerId, {
      kyc: {}, payment: { providerType: 'mock' }, whatsapp,
    });
  }

  it('whatsapp.text resolves the partner creds from payload.partnerId', async () => {
    await byoWhatsApp('acme', ACME_WA);
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'hi', partnerId: 'acme' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(sendText).toHaveBeenCalledWith('15551230000', 'hi', ACME_WA);
  });

  it('whatsapp.template resolves the partner creds from payload.partnerId', async () => {
    await byoWhatsApp('acme', ACME_WA);
    await outbox.enqueue('whatsapp.template', {
      to: '919876543210', template: 'transfer_delivered', lang: 'en', params: ['a'], partnerId: 'acme',
    });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(sendTemplate).toHaveBeenCalledWith('919876543210', 'transfer_delivered', 'en', ['a'], ACME_WA);
  });

  it('no partnerId ⇒ the shared env number (creds undefined), exactly as before', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'hi' });
    await outbox.enqueue('whatsapp.template', { to: '919876543210', template: 'transfer_delivered', lang: 'en', params: ['a'] });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(2);
    expect(sendText).toHaveBeenCalledWith('15551230000', 'hi', undefined);
    expect(sendTemplate).toHaveBeenCalledWith('919876543210', 'transfer_delivered', 'en', ['a'], undefined);
  });

  it('a partner with no integrations row, a half-configured channel, or no partner row degrades to the shared number — never dead-letters', async () => {
    await seedPartner(db, 'ghostp'); // partner row, no integrations row
    await byoWhatsApp('acme', { phoneNumberId: 'pn_only' }); // no token ⇒ waCredsFrom ⇒ undefined
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'a', partnerId: 'ghostp' });
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'b', partnerId: 'acme' });
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'c', partnerId: 'never_seeded' });
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ processed: 3, failed: 0, dead: 0 });
    expect(sendText).toHaveBeenCalledTimes(3);
    for (const call of sendText.mock.calls) expect((call as unknown[])[2]).toBeUndefined();
  });

  it('a token ROTATED after enqueue is used at drain time with no re-enqueue — and the row never held either token', async () => {
    await byoWhatsApp('acme', { phoneNumberId: 'pn_acme', token: 'tok_v1' });
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'hi', partnerId: 'acme' }, { dedupeKey: 'rot:1' });
    await byoWhatsApp('acme', { phoneNumberId: 'pn_acme', token: 'tok_v2' });
    await drainOnce(deps(), 'w1');
    expect(sendText).toHaveBeenCalledWith('15551230000', 'hi', { phoneNumberId: 'pn_acme', token: 'tok_v2' });
    const row = (await db.execute(sql`SELECT payload FROM outbox WHERE dedupe_key = 'rot:1'`)) as unknown as {
      rows: Array<{ payload: unknown }>;
    };
    expect(JSON.stringify(row.rows[0].payload)).not.toMatch(/tok_v1|tok_v2|creds/);
  });

  it('per-batch memoization: five rows for ONE partner cost ONE integrations resolution', async () => {
    await byoWhatsApp('acme', ACME_WA);
    for (let i = 0; i < 5; i++) {
      await outbox.enqueue('whatsapp.text', { to: '15551230000', body: `m${i}`, partnerId: 'acme' });
    }
    integrationsRepoSpy.calls = 0;
    const r = await drainOnce(deps(), 'w1', 10);
    expect(r.processed).toBe(5);
    expect(integrationsRepoSpy.calls).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(5);
    for (const call of sendText.mock.calls) expect((call as unknown[])[2]).toEqual(ACME_WA);
  });

  // Legacy rows are INSERTed raw: they are what a PRE-fix-11 release wrote, and
  // outbox-repo.enqueue's test-only tripwire (fix 11) refuses a creds payload.
  // Program-Fix 12 (second PR) removed the fix 18 transition shim that honoured
  // them: a payload never carries send credentials, so such a row FAILS CLOSED
  // — it is never sent on the persisted number and never on the shared number.
  const LEGACY_TOKEN = 'tok_FAKE_LEGACY_ONLY';
  async function insertLegacyRow(kind: 'whatsapp.text' | 'whatsapp.template', extra = '') {
    const body = kind === 'whatsapp.text' ? '"body":"legacy"' : '"template":"transfer_delivered","lang":"en","params":["a"]';
    const payload = `{"to":"15551230000",${body}${extra},"creds":{"phoneNumberId":"111","token":"${LEGACY_TOKEN}"}}`;
    await db.execute(sql`INSERT INTO outbox (kind, payload, dedupe_key) VALUES
      (${kind}, ${payload}::jsonb, ${`legacy:${kind}`})`);
  }
  async function legacyRows() {
    const row = (await db.execute(
      sql`SELECT status, attempts, last_error FROM outbox WHERE dedupe_key LIKE 'legacy:%'`,
    )) as unknown as { rows: Array<{ status: string; attempts: number; last_error: string | null }> };
    return row.rows;
  }

  it('NO SHIM (fix 12b): a legacy row with creds and no partnerId throws legacy_creds_payload — never sent, RETRIED with backoff, no token in last_error', async () => {
    await insertLegacyRow('whatsapp.text');
    await insertLegacyRow('whatsapp.template');
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ processed: 0, failed: 2, dead: 0 });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
    const rows = await legacyRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('failed');
      expect(row.last_error).toBe('legacy_creds_payload');
      expect(row.last_error).not.toMatch(/111|tok_/);
    }
  });

  it('NO SHIM (fix 12b): partnerId null / "" with creds is NOT a resolvable partner — fails closed exactly like a missing partnerId', async () => {
    await insertLegacyRow('whatsapp.text', ',"partnerId":null');
    await insertLegacyRow('whatsapp.template', ',"partnerId":""');
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ processed: 0, failed: 2, dead: 0 });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
    for (const row of await legacyRows()) expect(row.last_error).toBe('legacy_creds_payload');
  });

  it('NO SHIM (fix 12b): at the attempt ceiling a legacy row is DEAD with exactly one dead:<id> alert, and neither last_error nor the alert carries the token', async () => {
    await insertLegacyRow('whatsapp.text');
    await db.execute(sql`UPDATE outbox SET attempts = ${MAX_ATTEMPTS - 1} WHERE dedupe_key = 'legacy:whatsapp.text'`);
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ processed: 0, failed: 0, dead: 1 });
    expect(sendText).not.toHaveBeenCalled();
    const [row] = await legacyRows();
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.last_error).toBe('legacy_creds_payload');
    expect(row.last_error).not.toMatch(new RegExp(LEGACY_TOKEN));
    const alerts = (await db.execute(
      sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'ops.alert'`,
    )) as unknown as { rows: Array<{ dedupe_key: string; payload: { message: string } }> };
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0].dedupe_key).toMatch(/^dead:\d+$/);
    expect(alerts.rows[0].payload.message).toContain('legacy_creds_payload');
    expect(JSON.stringify(alerts.rows[0].payload)).not.toMatch(new RegExp(LEGACY_TOKEN));
    // The dead row keeps its payload: listSecretsAtRest (the regression detector) still counts it.
    expect(await outbox.listSecretsAtRest()).toEqual([{ kind: 'whatsapp.text', status: 'dead', n: 1 }]);
  });

  // Review follow-up (PR #286): the guard is `!= null`, deliberately WIDER than
  // listSecretsAtRest's jsonb_typeof = 'object' detector. Pin every non-object
  // shape so nobody narrows it to an object check later.
  it.each([
    ['"abc"', '"abc"'],
    ['[]', '[]'],
    ['0', '0'],
    ['false', 'false'],
    ['{}', '{}'],
  ])('NO SHIM (fix 12b): a non-object "creds": %s with no partnerId still fails closed', async (_label, json) => {
    const payload = `{"to":"15551230000","body":"odd","creds":${json}}`;
    await db.execute(sql`INSERT INTO outbox (kind, payload, dedupe_key) VALUES ('whatsapp.text', ${payload}::jsonb, 'legacy:odd')`);
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ processed: 0, failed: 1, dead: 0 });
    expect(sendText).not.toHaveBeenCalled();
    const [row] = await legacyRows();
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe('legacy_creds_payload');
  });

  it('"creds": null holds nothing (same reading as listSecretsAtRest / 0016): no partnerId ⇒ the shared number', async () => {
    await db.execute(sql`INSERT INTO outbox (kind, payload) VALUES
      ('whatsapp.text', '{"to":"15551230000","body":"nullcreds","creds":null}'::jsonb)`);
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ processed: 1, failed: 0, dead: 0 });
    expect(sendText).toHaveBeenCalledWith('15551230000', 'nullcreds', undefined);
  });

  it('partnerId WINS over a persisted creds object — a stale or foreign token can never be pinned by a payload', async () => {
    await byoWhatsApp('acme', { phoneNumberId: 'pn_acme', token: 'tok_live' });
    await db.execute(sql`INSERT INTO outbox (kind, payload) VALUES
      ('whatsapp.text', '{"to":"15551230000","body":"both","partnerId":"acme","creds":{"phoneNumberId":"pn_stale","token":"tok_stale"}}'::jsonb)`);
    await drainOnce(deps(), 'w1');
    expect(sendText).toHaveBeenCalledWith('15551230000', 'both', { phoneNumberId: 'pn_acme', token: 'tok_live' });
  });

  // Review follow-up (PR #286): a partnerId that resolves to NO creds (ghost
  // partner) still wins over a persisted creds object — the row degrades to
  // the shared number like any ghost-partner row, and the payload token is
  // never used. Pins the check order: partnerId first, then the creds guard.
  it('a GHOST partnerId beside a persisted creds object sends on the shared number — never on the persisted token', async () => {
    await insertLegacyRow('whatsapp.text', ',"partnerId":"never_seeded"');
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ processed: 1, failed: 0, dead: 0 });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith('15551230000', 'legacy', undefined);
    expect(JSON.stringify(sendText.mock.calls)).not.toMatch(new RegExp(LEGACY_TOKEN));
  });

  it('an unknown kind dead-letters instead of looping forever', async () => {
    await db.execute(sql`INSERT INTO outbox (kind, payload) VALUES ('bogus.kind', '{}'::jsonb)`);
    await db.execute(sql`UPDATE outbox SET attempts = ${MAX_ATTEMPTS - 1}`);
    const r = await drainOnce(deps(), 'w1');
    expect(r.dead).toBe(1);
  });
});

describe('drainOnce — agent.turn (the durable inbound turn)', () => {
  it('runs the agent and sends a non-empty reply (default number: no creds)', async () => {
    runAgentTurn.mockResolvedValue('Here is your quote!');
    await outbox.enqueue(
      'agent.turn',
      { phone: '15551230000', messageText: 'send $200 to mom', turn: { isNewConversation: true } },
      { dedupeKey: 'wamid:abc123' },
    );

    const r = await drainOnce(deps(), 'w1');
    // Program-Fix 34A: the reply is its own whatsapp.text row (review S2: claimed
    // and sent right after the turn, in the same drain) — 2 rows processed.
    expect(r.processed).toBe(2);
    expect(runAgentTurn).toHaveBeenCalledWith(
      '15551230000', 'send $200 to mom', { isNewConversation: true }, undefined,
      expect.objectContaining({ routedPartnerId: null, signal: expect.any(AbortSignal) }),
    );
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith('15551230000', 'Here is your quote!', undefined);
  });

  it("resolves the ROUTED partner's creds at run time and replies from their number", async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: { providerType: 'mock' },
      whatsapp: { phoneNumberId: 'pn_acme', token: 'tok_acme' },
    });
    runAgentTurn.mockResolvedValue('hola');
    await outbox.enqueue('agent.turn', {
      phone: '15551230000', messageText: 'hi', turn: {}, routedPartnerId: 'acme',
    });

    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(2); // the turn + its reply row (review S2: same drain)
    const creds = (runAgentTurn.mock.calls[0] as unknown[])[3];
    expect(creds).toMatchObject({ phoneNumberId: 'pn_acme' });
    // Program-Fix 34A: the reply row carries partnerId 'acme'; its creds resolve at drain.
    expect(sendText).toHaveBeenCalledWith('15551230000', 'hola', expect.objectContaining({ phoneNumberId: 'pn_acme' }));
    expect(((runAgentTurn.mock.calls[0] as unknown[])[4] as { routedPartnerId: string }).routedPartnerId).toBe('acme'); // the routed tenant reaches the agent
  });

  it('a routedPartnerId that names NO partner runs NO turn (fail closed — never under another tenant) and raises one deduped ops alert', async () => {
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'hi', turn: {}, routedPartnerId: 'ghost_partner' }, { dedupeKey: 'wamid:ghost1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(runAgentTurn).not.toHaveBeenCalled(); // never falls back to the default tenant
    expect(sendText).not.toHaveBeenCalled();
    const alerts = (await db.execute(sql`SELECT dedupe_key FROM outbox WHERE kind = 'ops.alert'`)) as unknown as { rows: Array<{ dedupe_key: string }> };
    expect(alerts.rows.map((a) => a.dedupe_key)).toEqual([expect.stringMatching(/^badtenant:\d+$/)]);
  });

  it('a routedPartnerId naming a SUSPENDED partner is treated the same: no turn, no reply, one deduped badtenant alert (its still-valid app secret must not drive turns under ANY tenant)', async () => {
    await seedPartner(db, 'dormant');
    const repo = createPartnerRepo(db);
    await repo.savePartner({ ...(await repo.getPartner('dormant'))!, status: 'suspended', updatedAt: new Date().toISOString() }); // the non-active value Partner['status'] allows — check src/lib/types.ts
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'hi', turn: {}, routedPartnerId: 'dormant' }, { dedupeKey: 'wamid:dormant1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    const alerts = (await db.execute(sql`SELECT dedupe_key FROM outbox WHERE kind = 'ops.alert'`)) as unknown as { rows: Array<{ dedupe_key: string }> };
    expect(alerts.rows.map((a) => a.dedupe_key)).toEqual([expect.stringMatching(/^badtenant:\d+$/)]);
  });

  it('an empty reply sends nothing; an agent failure retries instead of eating the message', async () => {
    runAgentTurn.mockResolvedValue('   ');
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'ok', turn: {} });
    let r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(sendText).not.toHaveBeenCalled();

    runAgentTurn.mockRejectedValue(new Error('ollama blip'));
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'again', turn: {} });
    r = await drainOnce(deps(), 'w1');
    expect(r.failed).toBe(1); // retried with backoff — NOT lost
  });
});

describe('drainOnce — funding.refund (the money-back leg)', () => {
  function refundFixture(over: Partial<Transfer> = {}): Transfer {
    return {
      ...transferFixture(),
      status: 'cancelled',
      fundingRef: 'mockfund-wk_t1',
      refundStatus: 'pending',
      ...over,
    } as Transfer;
  }

  it("completes the refund and queues the customer message with the OWNING partner's creds (never the settlement partner's)", async () => {
    // Routed transfer: brand owner 'acme', settles via 'railp'. The refund
    // message must ride the OWNER's WhatsApp number — that's who the customer
    // has been talking to.
    await seedPartner(db, 'railp');
    const repo = createIntegrationsRepo(db, provider);
    await repo.saveIntegrations('acme', {
      kyc: {}, payment: { providerType: 'mock' },
      whatsapp: { phoneNumberId: 'pn_acme', token: 'tok_acme' },
    });
    await repo.saveIntegrations('railp', {
      kyc: {}, payment: { providerType: 'mock' },
      whatsapp: { phoneNumberId: 'pn_railp', token: 'tok_railp' },
    });
    await store.saveTransfer(refundFixture({ settlementPartnerId: 'railp' }));
    await outbox.enqueue('funding.refund', { transferId: 'wk_t1' }, { dedupeKey: 'refund:wk_t1' });

    let r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);

    const t = await store.getTransfer('wk_t1');
    expect(t?.refundStatus).toBe('completed');
    expect(t?.refundRef).toBe('mockrefund-wk_t1'); // the (real) mock provider's deterministic ref
    expect(t?.refundedAt).toBeTruthy();

    const rows = (await db.execute(
      sql`SELECT kind, dedupe_key, payload FROM outbox WHERE kind = 'whatsapp.text'`,
    )) as unknown as { rows: Array<{ kind: string; dedupe_key: string; payload: Record<string, unknown> }> };
    expect(rows.rows.map(({ kind, dedupe_key }) => ({ kind, dedupe_key }))).toEqual([
      { kind: 'whatsapp.text', dedupe_key: 'refundmsg:wk_t1' },
    ]);
    // fix 11 / F54: the refund message persists the OWNING partnerId, never creds.
    expect(rows.rows[0].payload.partnerId).toBe('acme');
    expect(JSON.stringify(rows.rows[0].payload)).not.toMatch(/creds|tok_acme|tok_railp/);

    // Second pass delivers the message — owner creds, refund copy, no reasons.
    r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    const [to, body, creds] = sendText.mock.calls[0] as [string, string, unknown];
    expect(to).toBe('15551230000');
    expect(body).toContain('refunded');
    expect(body).toContain('wk_t1');
    expect(body.toLowerCase()).not.toContain('compliance');
    expect(creds).toEqual({ phoneNumberId: 'pn_acme', token: 'tok_acme' });
  });

  it('a replay after completion is a clean no-op: provider untouched, no second message', async () => {
    const refund = vi.fn(async (t: Transfer) => ({ refundRef: `mockrefund-${t.id}` }));
    const d: WorkerDeps = {
      ...deps(),
      fundingProvider: {
        capture: async (t) => ({ fundingRef: `mockfund-${t.id}` }),
        refund,
        handleWebhook: async () => null,
      },
    };
    await store.saveTransfer(refundFixture());
    await outbox.enqueue('funding.refund', { transferId: 'wk_t1' }, { dedupeKey: 'refund:wk_t1' });
    await drainOnce(d, 'w1'); // refund + message enqueue
    await drainOnce(d, 'w1'); // message send
    expect(refund).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);

    // A second effect row (e.g. an ops retry after a presumed failure that
    // actually succeeded) replays the handler against a completed refund.
    await outbox.enqueue('funding.refund', { transferId: 'wk_t1' }, { dedupeKey: 'refund:wk_t1:retry:1' });
    const r = await drainOnce(d, 'w1');
    expect(r.processed).toBe(1); // clean no-op, not an error
    expect(refund).toHaveBeenCalledTimes(1); // provider NOT charged with a second refund
    const msgs = (await db.execute(
      sql`SELECT count(*)::int AS n FROM outbox WHERE kind = 'whatsapp.text'`,
    )) as unknown as { rows: Array<{ n: number }> };
    expect(msgs.rows[0].n).toBe(1); // no second customer message
  });

  it('a provider failure retries with backoff (attempts increments; refund stays pending) and dead-letters at the cap', async () => {
    const d: WorkerDeps = {
      ...deps(),
      fundingProvider: {
        capture: async (t) => ({ fundingRef: `mockfund-${t.id}` }),
        refund: async () => { throw new Error('PSP 503'); },
        handleWebhook: async () => null,
      },
    };
    await store.saveTransfer(refundFixture());
    await outbox.enqueue('funding.refund', { transferId: 'wk_t1' }, { dedupeKey: 'refund:wk_t1' });

    let r = await drainOnce(d, 'w1');
    expect(r.failed).toBe(1);
    expect((await store.getTransfer('wk_t1'))?.refundStatus).toBe('pending'); // never falsely completed
    let row = (await db.execute(
      sql`SELECT attempts, status FROM outbox WHERE kind = 'funding.refund'`,
    )) as unknown as { rows: Array<{ attempts: number; status: string }> };
    expect(row.rows[0]).toEqual({ attempts: 1, status: 'failed' });

    await db.execute(sql`UPDATE outbox SET next_attempt_at = now() WHERE kind = 'funding.refund'`);
    r = await drainOnce(d, 'w1');
    expect(r.failed).toBe(1);
    row = (await db.execute(
      sql`SELECT attempts, status FROM outbox WHERE kind = 'funding.refund'`,
    )) as unknown as { rows: Array<{ attempts: number; status: string }> };
    expect(row.rows[0]).toEqual({ attempts: 2, status: 'failed' });

    // At MAX_ATTEMPTS the row dies and the EXISTING dead-letter alert flow fires.
    await db.execute(sql`
      UPDATE outbox SET attempts = ${MAX_ATTEMPTS - 1}, next_attempt_at = now()
      WHERE kind = 'funding.refund'
    `);
    r = await drainOnce(d, 'w1');
    expect(r.dead).toBe(1);
    const alerts = (await db.execute(
      sql`SELECT dedupe_key FROM outbox WHERE kind = 'ops.alert'`,
    )) as unknown as { rows: Array<{ dedupe_key: string }> };
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0].dedupe_key).toMatch(/^dead:\d+$/);
  });

  it('a vanished transfer is an idempotent no-op', async () => {
    await outbox.enqueue('funding.refund', { transferId: 'ghost' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(sendText).not.toHaveBeenCalled();
  });
});

// Program-Fix 8: no re-instruct after a rail failure, and the partner-pulled
// reverse from a rail-failed row.
describe('drainOnce — after a rail failure (fix 8)', () => {
  beforeEach(async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 'sgn' },
        webhookSecret: 'whk',
      },
      whatsapp: {},
    });
  });

  it('a reinstruct:<id> row queued BEFORE the failure landed is marked done WITHOUT a fetch, and no new reinstruct row appears', async () => {
    await store.saveTransfer({ ...transferFixture(), fundingRef: 'mockfund-wk_t1' });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'reinstruct:wk_t1' });
    // The rail's failure lands: cancelled + refund pending in one transaction.
    expect((await handleRailFailure(db, 'wk_t1', { code: 'failed', reason: 'account_unreachable' })).kind).toBe('failed');
    expect(await createTransferRepo(db).findStuckPaid(0)).toEqual([]);

    const r = await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalledWith('https://rail.example/settle', expect.anything());
    const row = (await db.execute(sql`SELECT status FROM outbox WHERE dedupe_key = 'reinstruct:wk_t1'`)) as unknown as { rows: Array<{ status: string }> };
    expect(row.rows[0].status).toBe('done');
    expect(r.failed).toBe(0);
    const keys = ((await db.execute(sql`SELECT dedupe_key FROM outbox ORDER BY id`)) as unknown as { rows: Array<{ dedupe_key: string }> }).rows.map((x) => x.dedupe_key);
    expect(keys.filter((k) => k?.startsWith('reinstruct:'))).toEqual(['reinstruct:wk_t1']);
  });

  it('a rail-failed B2B bank_pull row drains as the SIGNED REVERSE (no funds-provider refund) and completes the refund', async () => {
    const refund = vi.fn();
    const d: WorkerDeps = {
      ...deps(),
      fundingProvider: { capture: async (t) => ({ fundingRef: `mockfund-${t.id}` }), refund, handleWebhook: async () => null },
    };
    await store.saveTransfer({
      ...transferFixture(), fundingMethod: 'bank_pull', transferType: 'b2b', achTokenRef: 'bankpull_x',
      sourceCountry: 'GB', sourceCurrency: 'GBP',
    } as Transfer);
    expect(await handleRailFailure(db, 'wk_t1', { code: 'returned', reason: 'x' })).toEqual({ kind: 'failed', refundStarted: true });
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'simrail-reverse-wk_t1' }) });

    const r = await drainOnce(d, 'w1'); // refund (reverse) + notice + alert rows
    expect(r.failed).toBe(0);
    expect(refund).not.toHaveBeenCalled();
    const reverseCall = fetchFn.mock.calls.find(([u]) => u === 'https://rail.example/settle') as [string, RequestInit];
    expect(reverseCall).toBeTruthy();
    const body = JSON.parse(String(reverseCall[1].body)) as Record<string, unknown>;
    expect(body).toMatchObject({ action: 'reverse', reference: 'reverse-wk_t1', partner_id: 'acme', funding: { method: 'bank_debit', token: 'bankpull_x' } });
    expect((reverseCall[1].headers as Record<string, string>)['x-signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.getTransfer('wk_t1')).toMatchObject({ status: 'cancelled', refundStatus: 'completed', refundRef: 'simrail-reverse-wk_t1' });
    // The rail-failure notice said "reversed"; the completion message follows.
    const texts = sendText.mock.calls.map((c) => String(c[1]));
    expect(texts.some((t) => /reversed/.test(t))).toBe(true);
  });
});

describe('reconciliation query feed', () => {
  it('findStuckPaid sees a webhook-driven transfer stranded in paid', async () => {
    await store.saveTransfer({ ...transferFixture(), paidAt: '2026-06-09T00:00:00.000Z' });
    const stuck = await createTransferRepo(db).findStuckPaid(15);
    expect(stuck.map((t) => t.id)).toEqual(['wk_t1']);
  });
});

describe('drainOnce — funding.refund on a B2B ach_pull (NON-CUSTODIAL partner reverse, not a PSP refund)', () => {
  beforeEach(async () => {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 'sgn' },
        webhookSecret: 'whk',
      },
      whatsapp: {},
    });
  });

  it('POSTs a SIGNED reverse instruction to the rail and completes the refund — no funds-provider capture', async () => {
    // A paid ach_pull transfer with a reversal already requested+approved
    // (refundStatus pending), exactly as reverseB2bSettlement leaves it.
    await store.saveTransfer({
      ...transferFixture(),
      fundingMethod: 'ach_pull',
      transferType: 'b2b',
      achTokenRef: 'ach_deadbeef',
      senderBusinessName: 'Raj Trading Co',
      recipientBusinessName: 'Wilson HK Ltd',
      refundStatus: 'pending',
    } as Transfer);
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'reverse-rail-9' }) });
    await outbox.enqueue('funding.refund', { transferId: 'wk_t1' }, { dedupeKey: 'refund:wk_t1' });

    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);

    // The ONLY outbound HTTP is the signed reverse instruction to the partner rail.
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://rail.example/settle');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.action).toBe('reverse'); // return-ACH path, NOT a fresh payout
    // DISTINCT reference from the original settle (reverse-<id>) so a rail that
    // dedupes on reference cannot swallow the reverse as a replay of the settle.
    expect(body.reference).toBe('reverse-wk_t1');
    expect(body.partner_id).toBe('acme');
    expect((init.headers as Record<string, string>)['x-signature']).toMatch(/^[0-9a-f]{64}$/);

    // Refund lifecycle completes off the rail ack; the customer hears "reversed".
    const t = (await store.getTransfer('wk_t1'))!;
    expect(t.refundStatus).toBe('completed');
    expect(t.refundRef).toBe('reverse-rail-9');
    const dead = await outbox.listDead();
    expect(dead).toHaveLength(0);
  });
});

describe('drainOnce — settlement URL fails CLOSED (Program-Fix 22, acceptance tests 7 and 9)', () => {
  const lastError = async (kind: string) =>
    ((await db.execute(sql`SELECT status, attempts, last_error FROM outbox WHERE kind = ${kind}`)) as unknown as {
      rows: Array<{ status: string; attempts: number; last_error: string | null }>;
    }).rows[0];

  async function railAt(settlementUrl: string) {
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: { providerType: 'http', credentials: { settlementUrl, signingSecret: 'sgn' }, webhookSecret: 'whk' },
      whatsapp: {},
    });
  }

  it('settlement.instruct: a stored http://10.0.0.5 URL never reaches fetchFn; the row fails with a fixed reason, backs off, dies at MAX_ATTEMPTS with the ops alert, and providerRef is never written', async () => {
    await store.saveTransfer(transferFixture());
    await railAt('http://10.0.0.5/settle');
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'never' }) });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'instruct:wk_t1' });

    let r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ processed: 0, failed: 1, dead: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
    let row = await lastError('settlement.instruct');
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('settlement_url_refused:scheme'); // the reason only — never the URL
    expect((await store.getTransfer('wk_t1'))!.paymentProviderRef).toBeFalsy();

    await db.execute(sql`UPDATE outbox SET attempts = ${MAX_ATTEMPTS - 1}, next_attempt_at = now() WHERE kind = 'settlement.instruct'`);
    r = await drainOnce(deps(), 'w1');
    expect(r.dead).toBe(1);
    row = await lastError('settlement.instruct');
    expect(row.status).toBe('dead');
    expect(row.last_error).toBe('settlement_url_refused:scheme');
    expect(fetchFn).not.toHaveBeenCalled();
    const alerts = (await db.execute(sql`SELECT dedupe_key, payload FROM outbox WHERE kind = 'ops.alert'`)) as unknown as {
      rows: Array<{ dedupe_key: string; payload: unknown }>;
    };
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0].dedupe_key).toMatch(/^dead:\d+$/);
    expect(JSON.stringify(alerts.rows[0].payload)).not.toContain('10.0.0.5');
    expect((await store.getTransfer('wk_t1'))!.paymentProviderRef).toBeFalsy();
  });

  it.each([
    ['https://169.254.169.254/latest', 'ip_literal'],
    ['https://user:pw@rail.acme.com/settle', 'userinfo'],
    ['https://rail.acme.com:8443/settle', 'port'],
    ['https://localhost/settle', 'internal_host'],
  ])('settlement.instruct refuses %s with %s before any fetch', async (url, reason) => {
    await store.saveTransfer(transferFixture());
    await railAt(url);
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'instruct:wk_t1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.failed).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await lastError('settlement.instruct')).last_error).toBe(`settlement_url_refused:${reason}`);
  });

  it('funding.refund (partner reverse): the same refusal, fetchFn never called, refund stays pending, dead at the cap', async () => {
    await store.saveTransfer({
      ...transferFixture(),
      fundingMethod: 'ach_pull',
      transferType: 'b2b',
      achTokenRef: 'ach_deadbeef',
      refundStatus: 'pending',
    } as Transfer);
    await railAt('http://10.0.0.5/settle');
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'never' }) });
    await outbox.enqueue('funding.refund', { transferId: 'wk_t1' }, { dedupeKey: 'refund:wk_t1' });

    let r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ processed: 0, failed: 1, dead: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await lastError('funding.refund')).last_error).toBe('settlement_url_refused:scheme');
    expect((await store.getTransfer('wk_t1'))!.refundStatus).toBe('pending');

    await db.execute(sql`UPDATE outbox SET attempts = ${MAX_ATTEMPTS - 1}, next_attempt_at = now() WHERE kind = 'funding.refund'`);
    r = await drainOnce(deps(), 'w1');
    expect(r.dead).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await store.getTransfer('wk_t1'))!.refundStatus).toBe('pending');
    expect((await store.getTransfer('wk_t1'))!.refundRef).toBeFalsy();
  });

  it('the existing https://rail.example fixture still drains through the injected fetchFn (test 8)', async () => {
    await store.saveTransfer(transferFixture());
    await railAt('https://rail.example/settle');
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'rail-ok' }) });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'instruct:wk_t1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await store.getTransfer('wk_t1'))!.paymentProviderRef).toBe('rail-ok');
  });

  it('providerRef hardening (test 9): a hostile ack keeps the deterministic rail-<id>; a reverse keeps reverse-<id>', async () => {
    await store.saveTransfer(transferFixture());
    await railAt('https://rail.example/settle');
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: '<script>' + 'x'.repeat(300) }) });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'instruct:wk_t1' });
    expect((await drainOnce(deps(), 'w1')).processed).toBe(1);
    expect((await store.getTransfer('wk_t1'))!.paymentProviderRef).toBe('rail-wk_t1');

    // A 129-char token is refused too; 128 of the allowed alphabet is kept.
    await store.saveTransfer({ ...transferFixture(), id: 'wk_t2' });
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'a'.repeat(129) }) });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t2' }, { dedupeKey: 'instruct:wk_t2' });
    expect((await drainOnce(deps(), 'w1')).processed).toBe(1);
    expect((await store.getTransfer('wk_t2'))!.paymentProviderRef).toBe('rail-wk_t2');

    await store.saveTransfer({
      ...transferFixture(), id: 'wk_t3', fundingMethod: 'ach_pull', transferType: 'b2b', achTokenRef: 'ach_x', refundStatus: 'pending',
    } as Transfer);
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'rev ref with spaces' }) });
    await outbox.enqueue('funding.refund', { transferId: 'wk_t3' }, { dedupeKey: 'refund:wk_t3' });
    expect((await drainOnce(deps(), 'w1')).processed).toBe(1);
    expect((await store.getTransfer('wk_t3'))!.refundRef).toBe('reverse-wk_t3');
  });
});

describe('drainOnce — lease reclaim (a worker killed mid-row)', () => {
  it('a row abandoned by a dead worker is re-handled on the next drain and marked done', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'hi' });
    const [row] = await outbox.claimBatch(1, 'w_dead'); // w_dead never comes back
    await db.execute(sql`UPDATE outbox SET lease_until = now() - interval '10 minutes' WHERE id = ${row.id}`);

    const r = await drainOnce(deps(), 'w_new');
    expect(r.processed).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    const res = await db.execute(sql`SELECT status, attempts, lease_owner FROM outbox WHERE id = ${row.id}`);
    const [{ status, attempts, lease_owner }] =
      (res as unknown as { rows: Array<{ status: string; attempts: number; lease_owner: string | null }> }).rows;
    expect(status).toBe('done');
    expect(attempts).toBe(2); // the reclaim counted as a retry
    expect(lease_owner).toBeNull();
  });

  it('a LIVE lease is left alone — no double execution', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'hi' });
    await outbox.claimBatch(1, 'w_alive');
    const r = await drainOnce(deps(), 'w_other');
    expect(r.processed + r.failed + r.dead).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('a NON-agent row that exceeds the per-row deadline fails RETRYABLY and does not starve the rest of the batch', async () => {
    // A hung Graph POST that ignores its own signal (the deadline is the backstop).
    sendText.mockImplementationOnce(() => new Promise<void>(() => {})); // never resolves
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'slow' });
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'next' });

    const r = await drainOnce(deps(), 'w1', 10, { rowDeadlineMs: 50 });
    expect(r).toMatchObject({ failed: 1, processed: 1, dead: 0 });
    const res = await db.execute(sql`SELECT status, last_error FROM outbox WHERE payload->>'body' = 'slow'`);
    const [{ status, last_error }] = (res as unknown as { rows: Array<{ status: string; last_error: string }> }).rows;
    expect(status).toBe('failed');
    expect(last_error).toMatch(/row deadline/);
    expect(ROW_DEADLINE_MS).toBeLessThan(45_000); // under TIME_BUDGET_MS (route.ts:36) and maxDuration
  });

  it('a deadline-failed row is NOT re-claimable while its abandoned handler may still run (backoff ≥ LEASE_MS)', async () => {
    // The abandoned send keeps running inside the live invocation (up to maxDuration);
    // a second worker must not be able to run the same row beside it.
    sendText.mockImplementationOnce(() => new Promise<void>(() => {})); // never resolves
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'slow' });
    const r = await drainOnce(deps(), 'w1', 10, { rowDeadlineMs: 50 });
    expect(r).toMatchObject({ failed: 1, dead: 0 });

    // Immediately: nothing to re-run.
    await drainOnce(deps(), 'w2');
    expect(sendText).toHaveBeenCalledTimes(1);
    // Even a few seconds later (past the ordinary 2^1 = 2s backoff) it stays parked.
    await db.execute(sql`UPDATE outbox SET next_attempt_at = next_attempt_at - interval '5 seconds' WHERE payload->>'body' = 'slow'`);
    await drainOnce(deps(), 'w3');
    expect(sendText).toHaveBeenCalledTimes(1);
    const res = await db.execute(
      sql`SELECT extract(epoch FROM (next_attempt_at - now()))::float AS wait_s FROM outbox WHERE payload->>'body' = 'slow'`,
    );
    const [{ wait_s }] = (res as unknown as { rows: Array<{ wait_s: number }> }).rows;
    expect(wait_s).toBeGreaterThan(LEASE_MS / 1000 - 10); // ≥ ~5 min, past maxDuration
  });

  it('markDone is owner-checked: a handler whose lease was taken mid-run does not mark the row done', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'hi' });
    sendText.mockImplementationOnce(async () => {
      await db.execute(sql`UPDATE outbox SET lease_owner = 'w_new' WHERE kind = 'whatsapp.text'`);
    });
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ processed: 0, failed: 0, dead: 0 });
    const res = await db.execute(sql`SELECT status, lease_owner FROM outbox WHERE kind = 'whatsapp.text'`);
    const [{ status, lease_owner }] = (res as unknown as { rows: Array<{ status: string; lease_owner: string }> }).rows;
    expect(status).toBe('processing');
    expect(lease_owner).toBe('w_new');
  });

  it('markFailed is owner-checked: a throwing handler whose lease was taken mid-run is \'lost\' — no failed/dead count', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'hi' });
    sendText.mockImplementationOnce(async () => {
      await db.execute(sql`UPDATE outbox SET lease_owner = 'w_new' WHERE kind = 'whatsapp.text'`);
      throw new Error('graph 500');
    });
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ processed: 0, failed: 0, dead: 0 });
    const res = await db.execute(sql`SELECT status, lease_owner, last_error FROM outbox WHERE kind = 'whatsapp.text'`);
    const [{ status, lease_owner, last_error }] =
      (res as unknown as { rows: Array<{ status: string; lease_owner: string; last_error: string | null }> }).rows;
    expect(status).toBe('processing');
    expect(lease_owner).toBe('w_new');
    expect(last_error).toBeNull();
  });

  it('agent.turn receives an AbortSignal that fires BEFORE the row deadline (COOP_GRACE_MS), and a turn that honours it (fallback reply) is marked DONE with its reply SENT', async () => {
    // `runAgentTurn` is declared `vi.fn(async (..._a: unknown[]) => '')` at :39 — an implementation
    // whose 5th parameter is annotated `opts?: { signal?: AbortSignal }` does not type-check under
    // strictFunctionTypes (tsconfig includes tests/), so keep the rest-`unknown[]` shape and cast.
    runAgentTurn.mockImplementation(async (..._a: unknown[]) => {
      const opts = _a[4] as { signal?: AbortSignal } | undefined;
      expect(opts?.signal).toBeInstanceOf(AbortSignal); // 5th argument: (phone, message, turn, waCreds, opts)
      await new Promise((res) => opts!.signal!.addEventListener('abort', res, { once: true }));
      return "Sorry, I'm having trouble right now. Could you send that again?"; // the agent's own FALLBACK_REPLY on abort
    });
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'slow', turn: {} });
    // rowDeadlineMs 200 ⇒ the COOPERATIVE signal fires at max(1, 200 − COOP_GRACE_MS) = 1ms,
    // the hard race timer at 200ms. The agent returns inside that grace, so the row
    // is a normal completion even though `signal.aborted` is true — the worker
    // discriminates on the row's `abandoned` flag (set only by the race timer).
    const r = await drainOnce(deps(), 'w1', 10, { rowDeadlineMs: 200 });
    // Program-Fix 34A: the reply drains as its own row — review S2: in the same drain.
    expect(r).toMatchObject({ processed: 2, failed: 0, dead: 0 });
    await drainOnce(deps(), 'w1'); // the botfallback alert
    const toCustomer = sendText.mock.calls.filter((c) => (c as unknown[])[0] === '15551230000');
    expect(toCustomer).toHaveLength(1);
    expect(String((toCustomer[0] as unknown[])[1])).toMatch(/send that again/);
  });

  it('agent.turn that IGNORES the deadline is TERMINAL (dead + one deduped alert), never retried, and its late reply is never sent', async () => {
    // A tool hung past the signal: the handler promise is abandoned by withRowDeadline…
    let resolveLate!: (v: string) => void;
    runAgentTurn.mockImplementation(() => new Promise<string>((res) => { resolveLate = res; }));
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'slow', turn: {} });

    const r = await drainOnce(deps(), 'w1', 10, { rowDeadlineMs: 50 });
    expect(r).toMatchObject({ processed: 0, failed: 0, dead: 1 });
    const res = await db.execute(sql`SELECT status, last_error FROM outbox WHERE kind = 'agent.turn'`);
    const [{ status, last_error }] = (res as unknown as { rows: Array<{ status: string; last_error: string }> }).rows;
    expect(status).toBe('dead'); // NOT 'failed': a retry would re-run the same inbound message beside the abandoned turn
    expect(last_error).toMatch(/row deadline/);
    const alerts = (await db.execute(sql`SELECT dedupe_key FROM outbox WHERE kind = 'ops.alert'`)) as unknown as { rows: Array<{ dedupe_key: string }> };
    expect(alerts.rows.map((a) => a.dedupe_key)).toHaveLength(1);
    expect(alerts.rows[0].dedupe_key).toMatch(/^dead:/);
    // A second drain does NOT re-run the turn (terminal), and only drains the alert.
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    await drainOnce(deps(), 'w2');
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    // …and when the abandoned turn finally resolves, the worker's agent.turn branch sees the row's
    // `abandoned` flag (set by the race timer — NOT `signal.aborted`, which is also true on the
    // cooperative path above) and SKIPS sendText.
    resolveLate('late reply');
    await new Promise((res) => setTimeout(res, 10));
    expect(sendText.mock.calls.map((c) => String((c as unknown[])[1]))).not.toContain('late reply');
  });

  it('an agent.turn that could still be running at hardStopAt is RELEASED unstarted — never started, killed by the platform and re-run beside its ghost — while a money row still starts', async () => {
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'hi', turn: {} });
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'fits' });
    // 10s of invocation left, 40s row deadline: the non-idempotent turn cannot fit; the send can.
    const r = await drainOnce(deps(), 'w1', 10, { rowDeadlineMs: 40_000, hardStopAt: Date.now() + 10_000 });
    expect(r).toMatchObject({ processed: 1, released: 1, failed: 0, dead: 0 });
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(await outbox.countPending()).toBe(1); // the turn waits for the next invocation, attempt refunded
  });

  it('stopAfter RELEASES unstarted rows (owner-only, attempt refunded) instead of parking them under a 5-minute lease', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'a' });
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'b' });
    const r = await drainOnce(deps(), 'w1', 10, { stopAfter: Date.now() - 1 });
    expect(r).toMatchObject({ released: 2, processed: 0 });
    expect(sendText).not.toHaveBeenCalled();
    expect(await outbox.countPending()).toBe(2);
    const r2 = await drainOnce(deps(), 'w2');
    expect(r2.processed).toBe(2);
  });
});

describe('drainOnce — outbound deadlines (rail-09 / obs-03)', () => {
  const timeoutError = () =>
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

  beforeEach(async () => {
    await store.saveTransfer(transferFixture());
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 'sgn' },
        webhookSecret: 'whk',
      },
      whatsapp: {},
    });
  });

  it('settlement.instruct POSTs with an AbortSignal carrying the rail deadline', async () => {
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({}) });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' });
    await drainOnce(deps(), 'w1');
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal!.aborted).toBe(false);
    expect(RAIL_TIMEOUT_MS).toBe(15_000);
  });

  it('an aborted rail POST is a RETRYABLE failure (failed + backoff), not a dead letter on attempt 1', async () => {
    fetchFn.mockRejectedValue(timeoutError());
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ failed: 1, dead: 0, processed: 0 });
    expect(await outbox.listDead()).toHaveLength(0);
    const res = await db.execute(sql`SELECT status, last_error, next_attempt_at FROM outbox WHERE kind = 'settlement.instruct'`);
    const [{ status, last_error, next_attempt_at }] =
      (res as unknown as { rows: Array<{ status: string; last_error: string; next_attempt_at: string }> }).rows;
    expect(status).toBe('failed');
    expect(last_error).toMatch(/aborted/i);
    expect(new Date(next_attempt_at).getTime()).toBeGreaterThan(Date.now()); // rides the 2^attempts backoff
  });

  it('an aborted settlement.instruct never writes providerRef', async () => {
    fetchFn.mockRejectedValue(timeoutError());
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' });
    await drainOnce(deps(), 'w1');
    expect((await store.getTransfer('wk_t1'))!.paymentProviderRef).toBeFalsy();
  });

  it('rail.callback and the non-custodial reverse POST also carry the deadline signal', async () => {
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({}) });
    await outbox.enqueue('rail.callback', { reference: 'wk_t1', partner_id: 'acme' });
    await store.saveTransfer({
      ...transferFixture(), fundingMethod: 'ach_pull', transferType: 'b2b',
      achTokenRef: 'ach_deadbeef', refundStatus: 'pending',
    } as Transfer);
    await outbox.enqueue('funding.refund', { transferId: 'wk_t1' }, { dedupeKey: 'refund:wk_t1' });

    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    for (const call of fetchFn.mock.calls) {
      const [, init] = call as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });
});

describe('drainOnce — poison rows dead-letter on reclaim (Program-Fix 12 / Task 8)', () => {
  // A row that KILLS its function never reaches markFailed: the platform kill
  // leaves it 'processing', claimBatch reclaims it after LEASE_MS with
  // attempts + 1, and it runs again. markFailed dead-letters at >= MAX_ATTEMPTS
  // and retryDead resets attempts to 0, so attempts > MAX_ATTEMPTS can only
  // arise through a reclaim: the guard dead-letters it WITHOUT running the
  // handler, on the existing single dead:<id> alert path.
  async function alertKeys(): Promise<string[]> {
    const r = await db.execute(sql`SELECT dedupe_key FROM outbox WHERE kind = 'ops.alert' ORDER BY id`);
    return (r as unknown as { rows: Array<{ dedupe_key: string }> }).rows.map((x) => x.dedupe_key);
  }

  it('a processing row at MAX_ATTEMPTS with an expired lease is dead-lettered, never handled, with ONE dead:<id> alert', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', text: 'poison' });
    const [row] = await outbox.claimBatch(1, 'w_killed');
    await db.execute(
      sql`UPDATE outbox SET attempts = ${MAX_ATTEMPTS}, lease_until = now() - interval '1 minute' WHERE id = ${row.id}`,
    );

    const r = await drainOnce(deps(), 'w_next');
    expect(r).toMatchObject({ processed: 0, failed: 0, dead: 1, released: 0 });
    expect(sendText).not.toHaveBeenCalled();
    const after = (await db.execute(
      sql`SELECT status, attempts, last_error, lease_owner FROM outbox WHERE id = ${row.id}`,
    )) as unknown as { rows: Array<{ status: string; attempts: number; last_error: string; lease_owner: string | null }> };
    expect(after.rows[0]).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS + 1, lease_owner: null });
    expect(after.rows[0].last_error).toMatch(/reclaimed past MAX_ATTEMPTS/);
    expect(await alertKeys()).toEqual([`dead:${row.id}`]);

    // Draining again adds nothing: the dead row is not claimable and the alert is deduped.
    const again = await drainOnce(deps(), 'w_next2');
    expect(again.dead).toBe(0);
    expect(await alertKeys()).toEqual([`dead:${row.id}`]);
  });

  it('a row reclaimed BELOW the ceiling still runs (a reclaim is an ordinary retry)', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', text: 'fine' });
    const [row] = await outbox.claimBatch(1, 'w_killed');
    await db.execute(
      sql`UPDATE outbox SET attempts = ${MAX_ATTEMPTS - 1}, lease_until = now() - interval '1 minute' WHERE id = ${row.id}`,
    );
    const r = await drainOnce(deps(), 'w_next');
    expect(r).toMatchObject({ processed: 1, dead: 0 });
    expect(sendText).toHaveBeenCalledTimes(1);
  });
});

describe('drainOnce — the poison guard runs before the budget and hard-stop releases (Program-Fix 12 review follow-up)', () => {
  // Pins deviation 6: the guard sits before the stopAfter release and the
  // TERMINAL_ON_DEADLINE hard-stop release. A poison row released instead would
  // get one attempt refunded and be reclaimed again next drain, forever.
  async function alertKeys(): Promise<string[]> {
    const r = await db.execute(sql`SELECT dedupe_key FROM outbox WHERE kind = 'ops.alert' ORDER BY id`);
    return (r as unknown as { rows: Array<{ dedupe_key: string }> }).rows.map((x) => x.dedupe_key);
  }

  it('with stopAfter already passed, a poison whatsapp.text row is dead-lettered, not released', async () => {
    await outbox.enqueue('whatsapp.text', { to: '15551230000', text: 'poison' });
    const [row] = await outbox.claimBatch(1, 'w_killed');
    await db.execute(
      sql`UPDATE outbox SET attempts = ${MAX_ATTEMPTS}, lease_until = now() - interval '1 minute' WHERE id = ${row.id}`,
    );
    const r = await drainOnce(deps(), 'w_next', 10, { stopAfter: 0 });
    expect(r).toMatchObject({ processed: 0, failed: 0, dead: 1, released: 0 });
    expect(sendText).not.toHaveBeenCalled();
    const after = (await db.execute(sql`SELECT status, attempts FROM outbox WHERE id = ${row.id}`)) as unknown as {
      rows: Array<{ status: string; attempts: number }>;
    };
    expect(after.rows[0]).toEqual({ status: 'dead', attempts: MAX_ATTEMPTS + 1 });
    expect(await alertKeys()).toEqual([`dead:${row.id}`]);
  });

  it('with a hardStopAt too tight for an agent.turn, a poison agent.turn row is dead-lettered, not released', async () => {
    await outbox.enqueue('agent.turn', { phone: '15551230000', messageText: 'poison', turn: {} });
    const [row] = await outbox.claimBatch(1, 'w_killed');
    await db.execute(
      sql`UPDATE outbox SET attempts = ${MAX_ATTEMPTS}, lease_until = now() - interval '1 minute' WHERE id = ${row.id}`,
    );
    // hardStopAt = now: any TERMINAL_ON_DEADLINE row that is NOT poison would be released here.
    const r = await drainOnce(deps(), 'w_next', 10, { hardStopAt: Date.now() });
    expect(r).toMatchObject({ processed: 0, failed: 0, dead: 1, released: 0 });
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(await alertKeys()).toEqual([`dead:${row.id}`]);
  });
});

// ── Program-Fix 34A: no silent turns, one turn per phone, reply via the outbox ──
describe('outbox repo — agent.turn gate + uncharged defer (Program-Fix 34A)', () => {
  const P = '15551230000';
  const rowsOf = async () =>
    ((await db.execute(sql`SELECT id, status, attempts, next_attempt_at > now() AS future FROM outbox ORDER BY id`)) as unknown as {
      rows: Array<{ id: number; status: string; attempts: number; future: boolean }>;
    }).rows;

  it('deferUncharged refunds the claim, parks the row pending and NOT due, and is owner-only', async () => {
    await outbox.enqueue('agent.turn', { phone: P, messageText: 'hi', turn: {}, routedPartnerId: null });
    const [row] = await outbox.claimBatch(10, 'w1');
    expect(await outbox.deferUncharged(row.id, 'w_other', 3)).toBe(false); // not ours
    expect(await outbox.deferUncharged(row.id, 'w1', 3)).toBe(true);
    const [after] = await rowsOf();
    expect(after).toMatchObject({ status: 'pending', attempts: 0, future: true });
    expect(await outbox.claimBatch(10, 'w2')).toHaveLength(0); // not re-claimed on the next pass
  });

  it('agentTurnGate: an older waiting turn for the same phone + tenant blocks; dead/done rows, other phones and other tenants do not; NULL tenant matches NULL', async () => {
    await outbox.enqueue('agent.turn', { phone: P, messageText: '1', turn: {}, routedPartnerId: null }); // shared number
    await outbox.enqueue('agent.turn', { phone: P, messageText: '2', turn: {}, routedPartnerId: null });
    await outbox.enqueue('agent.turn', { phone: P, messageText: '3', turn: {}, routedPartnerId: 'acme' });
    await outbox.enqueue('agent.turn', { phone: '15559990000', messageText: '4', turn: {}, routedPartnerId: null });
    const ids = (await rowsOf()).map((r) => Number(r.id));
    expect(await outbox.agentTurnGate(ids[0], '', P, 600)).toEqual({ olderWaiting: false, pastBound: false });
    expect(await outbox.agentTurnGate(ids[1], '', P, 600)).toEqual({ olderWaiting: true, pastBound: false });
    expect((await outbox.agentTurnGate(ids[2], 'acme', P, 600)).olderWaiting).toBe(false); // another tenant
    expect((await outbox.agentTurnGate(ids[3], '', '15559990000', 600)).olderWaiting).toBe(false); // another phone
    await db.execute(sql`UPDATE outbox SET status = 'dead' WHERE id = ${ids[0]}`);
    expect((await outbox.agentTurnGate(ids[1], '', P, 600)).olderWaiting).toBe(false); // a dead row never blocks
    await db.execute(sql`UPDATE outbox SET created_at = now() - interval '11 minutes' WHERE id = ${ids[1]}`);
    expect((await outbox.agentTurnGate(ids[1], '', P, 600)).pastBound).toBe(true);
  });

  it('agentTurnGate (review M1): an in-flight reply row for the same phone + tenant blocks; its OWN reply, other phones/tenants and done/dead replies do not', async () => {
    await outbox.enqueue('agent.turn', { phone: P, messageText: '1', turn: {}, routedPartnerId: null });
    await outbox.enqueue('agent.turn', { phone: P, messageText: '2', turn: {}, routedPartnerId: 'acme' });
    const [t1, t2] = (await rowsOf()).map((r) => Number(r.id));
    await db.execute(sql`UPDATE outbox SET status = 'done' WHERE kind = 'agent.turn'`);
    // An older turn's reply (shared number ⇒ no partnerId) is still queued.
    await outbox.enqueue('whatsapp.text', { to: P, body: 'older reply' }, { dedupeKey: 'reply:1' });
    expect((await outbox.agentTurnGate(t1 + 100, '', P, 600)).olderWaiting).toBe(true);
    expect((await outbox.agentTurnGate(t2 + 100, 'acme', P, 600)).olderWaiting).toBe(false); // another tenant
    expect((await outbox.agentTurnGate(t1 + 100, '', '15559990000', 600)).olderWaiting).toBe(false); // another phone
    // A plain (non-reply) text to the phone never blocks a turn.
    await db.execute(sql`UPDATE outbox SET status = 'done' WHERE dedupe_key = 'reply:1'`);
    await outbox.enqueue('whatsapp.text', { to: P, body: 'staff note' }, { dedupeKey: 'ticketmsg:x:1' });
    expect((await outbox.agentTurnGate(t1 + 100, '', P, 600)).olderWaiting).toBe(false);
    // A routed reply blocks only its own tenant.
    await outbox.enqueue('whatsapp.text', { to: P, body: 'acme reply', partnerId: 'acme' }, { dedupeKey: `reply:${t2}` });
    expect((await outbox.agentTurnGate(t2 + 100, 'acme', P, 600)).olderWaiting).toBe(true);
    // A re-run turn whose OWN reply is already queued is never blocked by it.
    expect((await outbox.agentTurnGate(t2, 'acme', P, 600)).olderWaiting).toBe(false);
  });
});

describe('drainOnce — agent.turn pipeline (Program-Fix 34A)', () => {
  const P = '15551230000';
  const customerSends = () =>
    sendText.mock.calls.filter((c) => (c as unknown[])[0] === P).map((c) => String((c as unknown[])[1]));
  const outboxRows = async (kind: string) =>
    ((await db.execute(sql`SELECT id, status, attempts, dedupe_key, payload FROM outbox WHERE kind = ${kind} ORDER BY id`)) as unknown as {
      rows: Array<{ id: number; status: string; attempts: number; dedupe_key: string | null; payload: Record<string, unknown> }>;
    }).rows;
  const makeDue = () => db.execute(sql`UPDATE outbox SET next_attempt_at = now() WHERE status IN ('pending','failed')`);

  it('the reply is its OWN whatsapp.text row (reply:<turn id>, partnerId for a routed turn); it is sent on the next drain', async () => {
    runAgentTurn.mockResolvedValue('hi');
    await outbox.enqueue('agent.turn', { phone: P, messageText: 'hello', turn: {}, routedPartnerId: 'acme' });
    const [turn] = await outboxRows('agent.turn');
    // The turn itself never sends: its handler only enqueues (spy on the handler's view).
    runAgentTurn.mockImplementationOnce(async () => { expect(customerSends()).toEqual([]); return 'hi'; });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(2); // the turn, then its reply row claimed inline (review S2)
    const texts = await outboxRows('whatsapp.text');
    expect(texts).toHaveLength(1);
    expect(texts[0].dedupe_key).toBe(`reply:${turn.id}`);
    expect(texts[0].status).toBe('done');
    expect(texts[0].payload).toEqual({ to: P, body: 'hi', partnerId: 'acme', category: 'essential' });
    expect(customerSends()).toEqual(['hi']);
  });

  it('a shared-number turn enqueues a reply with NO partnerId; a card-only turn (\'\') enqueues nothing', async () => {
    runAgentTurn.mockResolvedValueOnce('yo').mockResolvedValueOnce('');
    await outbox.enqueue('agent.turn', { phone: P, messageText: 'a', turn: {}, routedPartnerId: null });
    await drainOnce(deps(), 'w1');
    expect((await outboxRows('whatsapp.text'))[0].payload).toEqual({ to: P, body: 'yo', category: 'essential' });
    await outbox.enqueue('agent.turn', { phone: P, messageText: 'b', turn: {}, routedPartnerId: null });
    await drainOnce(deps(), 'w1');
    await drainOnce(deps(), 'w1');
    expect(await outboxRows('whatsapp.text')).toHaveLength(1);
    expect(customerSends()).toEqual(['yo']);
  });

  it('a failed reply SEND retries the send, never the model (runAgentTurn runs once)', async () => {
    runAgentTurn.mockResolvedValue('answer');
    sendText.mockRejectedValueOnce(new Error('graph 503'));
    await outbox.enqueue('agent.turn', { phone: P, messageText: 'q', turn: {} });
    let r = await drainOnce(deps(), 'w1'); // the turn, then its reply send fails (claimed inline)
    expect(r).toMatchObject({ processed: 1, failed: 1 });
    await makeDue();
    r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls.filter((c) => (c as unknown[])[1] === 'answer')).toHaveLength(2); // 1 failed + 1 ok
  });

  it('per-phone lock: a held lock DEFERS the turn uncharged (pending, attempts 0, released — never failed/dead); after release it runs; another phone runs meanwhile', async () => {
    await store.tryTurnLock('acme', P, 'other-holder');
    runAgentTurn.mockImplementation(async (...a: unknown[]) => `re:${String(a[1])}`);
    await outbox.enqueue('agent.turn', { phone: P, messageText: 'blocked', turn: {}, routedPartnerId: 'acme' });
    await outbox.enqueue('agent.turn', { phone: '15559990000', messageText: 'free', turn: {}, routedPartnerId: 'acme' });
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ processed: 2, released: 1, failed: 0, dead: 0 }); // 'free' + its reply
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect((runAgentTurn.mock.calls[0] as unknown[])[1]).toBe('free');
    const [blocked] = (await outboxRows('agent.turn')).filter((x) => (x.payload as { messageText: string }).messageText === 'blocked');
    expect(blocked).toMatchObject({ status: 'pending', attempts: 0 });
    await store.releaseTurnLock('acme', P, 'other-holder');
    await makeDue();
    await drainOnce(deps(), 'w1');
    expect(runAgentTurn).toHaveBeenCalledTimes(2);
    expect((runAgentTurn.mock.calls[1] as unknown[])[1]).toBe('blocked');
  });

  it('the turn takes and RELEASES the lock (token = row id), so the next turn for the phone is not blocked', async () => {
    const trySpy = vi.spyOn(store, 'tryTurnLock');
    const relSpy = vi.spyOn(store, 'releaseTurnLock');
    runAgentTurn.mockResolvedValue('ok');
    await outbox.enqueue('agent.turn', { phone: P, messageText: 'x', turn: {} });
    const [turn] = await outboxRows('agent.turn');
    await drainOnce(deps(), 'w1');
    expect(trySpy).toHaveBeenCalledWith('default', P, String(turn.id));
    expect(relSpy).toHaveBeenCalledWith('default', P, String(turn.id));
    expect(await store.tryTurnLock('default', P, 'next')).toBe(true); // released
  });

  it('a throwing Redis lock FAILS OPEN: the turn runs', async () => {
    vi.spyOn(store, 'tryTurnLock').mockRejectedValue(new Error('upstash down'));
    vi.spyOn(store, 'releaseTurnLock').mockRejectedValue(new Error('upstash down'));
    runAgentTurn.mockResolvedValue('still here');
    await outbox.enqueue('agent.turn', { phone: P, messageText: 'x', turn: {} });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(2); // the turn + its reply
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('20 same-phone turns behind a lock held past the old ~254 s retry budget all complete; none is dead-lettered and no attempt is spent waiting', async () => {
    await store.tryTurnLock('default', P, 'long-holder');
    runAgentTurn.mockImplementation(async (...a: unknown[]) => `re:${String(a[1])}`);
    for (let i = 0; i < 20; i++) await outbox.enqueue('agent.turn', { phone: P, messageText: `m${i}`, turn: {} });
    for (let pass = 0; pass < 12; pass++) { // 12 passes > MAX_ATTEMPTS: a charged retry would have died
      await drainOnce(deps(), 'w1', 10);
      await makeDue();
    }
    expect(runAgentTurn).not.toHaveBeenCalled();
    let turns = await outboxRows('agent.turn');
    expect(turns.every((t) => t.status === 'pending' && t.attempts === 0)).toBe(true);
    await store.releaseTurnLock('default', P, 'long-holder');
    for (let pass = 0; pass < 30; pass++) {
      await drainOnce(deps(), 'w1', 10);
      await makeDue();
    }
    turns = await outboxRows('agent.turn');
    expect(turns.every((t) => t.status === 'done')).toBe(true);
    expect(await outbox.listDead()).toHaveLength(0);
    expect(runAgentTurn.mock.calls.map((c) => (c as unknown[])[1])).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`)); // in order
  });

  it('FIFO: rows for one phone run and reply in id order under two CONCURRENT drains', async () => {
    // The OLDEST turn is the slowest: without the FIFO guard + lock, the
    // concurrent drain would answer 'two' before 'one'.
    runAgentTurn.mockImplementation(async (...a: unknown[]) => {
      await new Promise((res) => setTimeout(res, String(a[1]) === 'one' ? 40 : 5));
      return `re:${String(a[1])}`;
    });
    for (const m of ['one', 'two', 'three']) await outbox.enqueue('agent.turn', { phone: P, messageText: m, turn: {} });
    for (let pass = 0; pass < 12; pass++) {
      await Promise.all([drainOnce(deps(), 'wA', 1), drainOnce(deps(), 'wB', 1)]);
      await makeDue();
    }
    expect(runAgentTurn.mock.calls.map((c) => (c as unknown[])[1])).toEqual(['one', 'two', 'three']);
    expect(customerSends()).toEqual(['re:one', 're:two', 're:three']);
    expect(await outbox.listDead()).toHaveLength(0);
  });

  it('past the 10-minute bound, a BLOCKED turn gets exactly one fallback reply + one turnbusy alert and is done (never dead-lettered)', async () => {
    await store.tryTurnLock('default', P, 'stuck-holder');
    await outbox.enqueue('agent.turn', { phone: P, messageText: 'late', turn: {} });
    await db.execute(sql`UPDATE outbox SET created_at = now() - interval '11 minutes' WHERE kind = 'agent.turn'`);
    const [turn] = await outboxRows('agent.turn');
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(2); // the turn (answered with the fallback) + that reply row
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect((await outboxRows('agent.turn'))[0].status).toBe('done');
    const texts = await outboxRows('whatsapp.text');
    expect(texts).toHaveLength(1);
    expect(texts[0].dedupe_key).toBe(`reply:${turn.id}`);
    expect(texts[0].payload.body).toBe(FALLBACK_REPLY);
    const alerts = await outboxRows('ops.alert');
    expect(alerts.map((a) => a.dedupe_key)).toEqual([expect.stringMatching(new RegExp(`^turnbusy:default:${P}:\\d+$`))]);
    expect(String(alerts[0].payload.message)).not.toContain(P); // counts only — no phone, no content
    for (let i = 0; i < 3; i++) { await drainOnce(deps(), 'w1'); await makeDue(); }
    expect(customerSends().filter((b) => b === FALLBACK_REPLY)).toHaveLength(1);
  });

  it('past the bound, a turn stuck behind an older FAILED turn (in backoff) also gets its fallback', async () => {
    await outbox.enqueue('agent.turn', { phone: P, messageText: 'older', turn: {} });
    await outbox.enqueue('agent.turn', { phone: P, messageText: 'newer', turn: {} });
    await db.execute(sql`UPDATE outbox SET status = 'failed', next_attempt_at = now() + interval '1 hour' WHERE payload ->> 'messageText' = 'older'`);
    await db.execute(sql`UPDATE outbox SET created_at = now() - interval '11 minutes' WHERE payload ->> 'messageText' = 'newer'`);
    await drainOnce(deps(), 'w1');
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect((await outboxRows('whatsapp.text')).map((t) => t.payload.body)).toEqual([FALLBACK_REPLY]);
  });

  it('past the bound but NOT blocked, the turn simply runs (the bound caps busy-waiting, not age)', async () => {
    runAgentTurn.mockResolvedValue('real answer');
    await outbox.enqueue('agent.turn', { phone: P, messageText: 'late but free', turn: {} });
    await db.execute(sql`UPDATE outbox SET created_at = now() - interval '11 minutes' WHERE kind = 'agent.turn'`);
    await drainOnce(deps(), 'w1');
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect((await outboxRows('whatsapp.text')).map((t) => t.payload.body)).toEqual(['real answer']);
  });

  it('two fallback turns in one hour raise ONE botfallback alert (counts only, no content)', async () => {
    runAgentTurn.mockResolvedValue(FALLBACK_REPLY);
    await outbox.enqueue('agent.turn', { phone: P, messageText: 'a', turn: {} });
    await outbox.enqueue('agent.turn', { phone: '15559990000', messageText: 'b', turn: {} });
    await drainOnce(deps(), 'w1');
    const alerts = (await outboxRows('ops.alert')).filter((a) => String(a.dedupe_key).startsWith('botfallback:'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].dedupe_key).toMatch(/^botfallback:\d+$/);
    expect(String(alerts[0].payload.message)).not.toContain(P);
    expect((await outboxRows('whatsapp.text'))).toHaveLength(2); // both customers still get the line
  });
});

describe('drainOnce — agent.turn ordering with inline cards (Program-Fix 34A review M1/S1)', () => {
  const P = '15551230000';
  const makeDue = () => db.execute(sql`UPDATE outbox SET next_attempt_at = now() WHERE status IN ('pending','failed')`);

  it('a card sent inline by turn 2 never overtakes turn 1 text reply', async () => {
    const order: string[] = [];
    sendText.mockImplementation(async (_to: unknown, body: unknown) => { order.push(`text:${String(body)}`); });
    runAgentTurn.mockImplementation(async (...a: unknown[]) => {
      if (String(a[1]) === 'two') { order.push('card:two'); return ''; }
      return `re:${String(a[1])}`;
    });
    for (const m of ['one', 'two']) await outbox.enqueue('agent.turn', { phone: P, messageText: m, turn: {} });
    for (let pass = 0; pass < 4; pass++) { await drainOnce(deps(), 'w1', 10); await makeDue(); }
    expect(order).toEqual(['text:re:one', 'card:two']);
  });

  it("S2: a turn's reply goes out before the NEXT customer's turn in the same batch runs", async () => {
    const order: string[] = [];
    sendText.mockImplementation(async (to: unknown, body: unknown) => { order.push(`text:${String(to)}:${String(body)}`); });
    runAgentTurn.mockImplementation(async (...a: unknown[]) => { order.push(`turn:${String(a[0])}`); return `re:${String(a[1])}`; });
    await outbox.enqueue('agent.turn', { phone: P, messageText: 'a', turn: {} });
    await outbox.enqueue('agent.turn', { phone: '15559990000', messageText: 'b', turn: {} });
    const r = await drainOnce(deps(), 'w1', 10);
    expect(order).toEqual([
      `turn:${P}`, `text:${P}:re:a`,
      'turn:15559990000', 'text:15559990000:re:b',
    ]);
    expect(r).toMatchObject({ processed: 4, failed: 0, dead: 0 });
  });

  it('S2: a reply claimed inline still honours the budget — past stopAfter it is released, not sent', async () => {
    runAgentTurn.mockResolvedValue('late');
    await outbox.enqueue('agent.turn', { phone: P, messageText: 'a', turn: {} });
    const now = Date.now();
    runAgentTurn.mockImplementation(async () => { vi.setSystemTime(now + 60_000); return 'late'; });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    try {
      const r = await drainOnce(deps(), 'w1', 10, { stopAfter: now + 30_000 });
      expect(r.processed).toBe(1);
      expect(sendText).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
    await makeDue();
    await drainOnce(deps(), 'w1', 10);
    expect(sendText.mock.calls.map((c) => String((c as unknown[])[1]))).toEqual(['late']);
  });
});

// Program-Fix 29: the timestamped rail signature on every rail POST, key
// rotation, the amount echo and the held-row guard.
describe('drainOnce — rail signature v2, rotation, amount (fix 29)', () => {
  const v2Of = (init: RequestInit) => (init.headers as Record<string, string>)['x-smartremit-signature'];
  const parseV2 = (h: string) => {
    const parts = h.split(',');
    return { t: Number(parts[0].slice(2)), v1: parts.slice(1).map((p) => p.slice(3)) };
  };
  const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

  beforeEach(async () => {
    await store.saveTransfer(transferFixture());
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', {
      kyc: {},
      payment: {
        providerType: 'simulator',
        credentials: {
          settlementUrl: 'https://rail.example/settle', signingSecret: 'sgn',
          previousSigningSecret: 'sgn_old', previousSigningSecretUntil: FUTURE,
          previousWebhookSecret: 'whk_old', previousWebhookSecretUntil: FUTURE,
        },
        webhookSecret: 'whk',
      },
      whatsapp: {},
    });
  });

  it('settlement.instruct carries BOTH headers: legacy exact with the current secret, v2 with one v1 per active secret', async () => {
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'r1' }) });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'instruct:wk_t1' });
    await drainOnce(deps(), 'w1');
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const raw = String(init.body);
    expect((init.headers as Record<string, string>)['x-signature']).toBe(createHmac('sha256', 'sgn').update(raw).digest('hex'));
    const { t, v1 } = parseV2(v2Of(init));
    expect(Math.abs(t - Date.now() / 1000)).toBeLessThan(60);
    expect(v1).toEqual([
      createHmac('sha256', 'sgn').update(`${t}.${raw}`).digest('hex'),
      createHmac('sha256', 'sgn_old').update(`${t}.${raw}`).digest('hex'),
    ]);
  });

  it('rail.callback signs v2 with the webhook secrets and echoes the amount when the row carries it', async () => {
    fetchFn.mockResolvedValue({ ok: true });
    await outbox.enqueue('rail.callback', {
      reference: 'wk_t1', partner_id: 'acme', amount: { destination: 16600, destination_currency: 'INR' },
    });
    await drainOnce(deps(), 'w1');
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const raw = String(init.body);
    expect(JSON.parse(raw)).toEqual({ reference: 'wk_t1', status: 'paid_out', amount: { destination: 16600, destination_currency: 'INR' } });
    expect((init.headers as Record<string, string>)['x-signature']).toBe(createHmac('sha256', 'whk').update(raw).digest('hex'));
    const { t, v1 } = parseV2(v2Of(init));
    expect(v1).toEqual([
      createHmac('sha256', 'whk').update(`${t}.${raw}`).digest('hex'),
      createHmac('sha256', 'whk_old').update(`${t}.${raw}`).digest('hex'),
    ]);
  });

  it('reverse instruction carries both headers too', async () => {
    await store.saveTransfer({
      ...transferFixture(), fundingMethod: 'ach_pull', transferType: 'b2b', achTokenRef: 'ach_x', refundStatus: 'pending',
    } as Transfer);
    fetchFn.mockResolvedValue({ ok: true, json: async () => ({ providerRef: 'rev-1' }) });
    await outbox.enqueue('funding.refund', { transferId: 'wk_t1' }, { dedupeKey: 'refund:wk_t1' });
    await drainOnce(deps(), 'w1');
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-signature']).toBe(createHmac('sha256', 'sgn').update(String(init.body)).digest('hex'));
    expect(v2Of(init)).toMatch(/^t=\d+,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
  });

  it('HELD: a transfer with a railamount:<id> marker is NEVER re-instructed (no POST, row done)', async () => {
    await outbox.enqueue('ops.alert', { message: 'held' }, { dedupeKey: 'railamount:wk_t1' });
    await outbox.enqueue('settlement.instruct', { transferId: 'wk_t1' }, { dedupeKey: 'reinstruct:wk_t1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.failed).toBe(0);
    expect(fetchFn).not.toHaveBeenCalledWith('https://rail.example/settle', expect.anything());
    const row = (await db.execute(sql`SELECT status FROM outbox WHERE dedupe_key = 'reinstruct:wk_t1'`)) as unknown as { rows: Array<{ status: string }> };
    expect(row.rows[0].status).toBe('done');
  });

  it('outboxRepo.hasDedupeKey: true only for an existing key, and survives a payload scrub', async () => {
    expect(await outbox.hasDedupeKey('railamount:wk_t1')).toBe(false);
    await outbox.enqueue('ops.alert', { message: 'x' }, { dedupeKey: 'railamount:wk_t1' });
    expect(await outbox.hasDedupeKey('railamount:wk_t1')).toBe(true);
    await db.execute(sql`UPDATE outbox SET status = 'done', payload = '{}'::jsonb`);
    expect(await outbox.hasDedupeKey('railamount:wk_t1')).toBe(true);
    expect(await outbox.hasDedupeKey('railamount:other')).toBe(false);
  });
});

// ── Program-Fix 26: the ops-alert mirror (email + optional webhook) ─────────
describe('drainOnce — ops-alert mirror (Program-Fix 26)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  type Row = { id: number; kind: string; dedupe_key: string | null; payload: Record<string, unknown>; status: string; last_error: string | null };
  async function rows(kind: string): Promise<Row[]> {
    const r = (await db.execute(
      sql`SELECT id, kind, dedupe_key, payload, status, last_error FROM outbox WHERE kind = ${kind} ORDER BY id`,
    )) as unknown as { rows: Row[] };
    return r.rows;
  }
  const toBrink = (kind: string) =>
    db.execute(sql`UPDATE outbox SET attempts = ${MAX_ATTEMPTS - 1}, next_attempt_at = now() WHERE kind = ${kind}`);

  it('FIRST: a mirror row that dies does NOT enqueue another alert (no dead → alert → mail → dead loop)', async () => {
    const d: WorkerDeps = { ...deps(), sendEmail: async () => { throw new Error('smtp down'); } };
    await outbox.enqueue('email.send', { to: ['ops@example.test'], subject: 's', text: 't' }, { dedupeKey: 'opsmail:41' });
    await toBrink('email.send');
    const r = await drainOnce(d, 'w1');
    expect(r.dead).toBe(1);
    expect(await rows('ops.alert')).toEqual([]);
  });

  it('a dead opshook: webhook row does NOT enqueue another alert either', async () => {
    vi.stubEnv('OPS_ALERT_WEBHOOK_URL', 'https://hooks.example.test/T000/B000/xyz');
    fetchFn.mockResolvedValue({ ok: false, status: 500 });
    await outbox.enqueue('ops.webhook', { text: 't' }, { dedupeKey: 'opshook:42' });
    await toBrink('ops.webhook');
    const r = await drainOnce(deps(), 'w1');
    expect(r.dead).toBe(1);
    expect(await rows('ops.alert')).toEqual([]);
  });

  it('env unset → no child rows (today\'s behaviour byte-for-byte)', async () => {
    vi.stubEnv('OPS_ALERT_PHONE', '15550000001');
    vi.stubEnv('OPS_ALERT_EMAIL', '');
    vi.stubEnv('OPS_ALERT_WEBHOOK_URL', '');
    await outbox.enqueue('ops.alert', { message: 'hello ops' }, { dedupeKey: 'dead:1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]).toEqual(['15550000001', 'hello ops']);
    expect(await rows('email.send')).toEqual([]);
    expect(await rows('ops.webhook')).toEqual([]);
  });

  it('ops.alert retried 3× → exactly one opsmail row with the email.send payload shape', async () => {
    vi.stubEnv('OPS_ALERT_PHONE', '15550000001');
    vi.stubEnv('OPS_ALERT_EMAIL', 'ops@example.test');
    sendText.mockRejectedValue(new Error('graph down'));
    const id = (await outbox.enqueue('ops.alert', { message: 'stuck money' }, { dedupeKey: 'dead:7' })) as unknown;
    expect(id).toBeTruthy();
    for (let i = 0; i < 3; i++) {
      const r = await drainOnce(deps(), 'w1');
      expect(r.failed).toBe(1);
      await db.execute(sql`UPDATE outbox SET next_attempt_at = now() WHERE kind = 'ops.alert'`);
    }
    const alert = (await rows('ops.alert'))[0];
    const mails = await rows('email.send');
    expect(mails).toHaveLength(1);
    expect(mails[0].dedupe_key).toBe(`opsmail:${alert.id}`);
    expect(mails[0].payload).toEqual({ to: ['ops@example.test'], subject: 'SmartRemit ops alert', text: 'stuck money' });
  });

  it('a dead-row alert whose error holds a phone number and an email → the opsmail text is SCRUBBED', async () => {
    vi.stubEnv('OPS_ALERT_PHONE', '15550000001');
    vi.stubEnv('OPS_ALERT_EMAIL', 'ops@example.test');
    const failing: WorkerDeps = {
      ...deps(),
      sendEmail: async () => { throw new Error('rejected recipient 15559871234 jane.doe@example.org'); },
    };
    await outbox.enqueue('email.send', { to: ['x@example.test'], subject: 's', text: 't' }, { dedupeKey: 'preq:zz' });
    await toBrink('email.send');
    expect((await drainOnce(failing, 'w1')).dead).toBe(1);
    // The dead:<id> alert now runs; its mirror child must be scrubbed.
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    const mail = (await rows('email.send')).find((m) => m.dedupe_key?.startsWith('opsmail:'));
    expect(mail).toBeDefined();
    const text = String(mail!.payload.text);
    expect(text).toContain('…1234');
    expect(text).toContain('<email>');
    expect(text).not.toContain('15559871234');
    expect(text).not.toContain('jane.doe@example.org');
  });

  it('OPS_ALERT_PHONE empty + OPS_ALERT_EMAIL set → one opsmail row, no sendText', async () => {
    vi.stubEnv('OPS_ALERT_PHONE', '');
    vi.stubEnv('OPS_ALERT_EMAIL', 'ops@example.test');
    await outbox.enqueue('ops.alert', { message: 'm' }, { dedupeKey: 'dead:9' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(sendText).not.toHaveBeenCalled();
    expect((await rows('email.send')).map((m) => m.dedupe_key)).toEqual([expect.stringMatching(/^opsmail:\d+$/)]);
  });

  it('OPS_ALERT_WEBHOOK_URL (https) → one opshook row holding {text} only — never the URL', async () => {
    vi.stubEnv('OPS_ALERT_PHONE', '');
    vi.stubEnv('OPS_ALERT_WEBHOOK_URL', 'https://hooks.example.test/T000/B000/secretpart');
    await outbox.enqueue('ops.alert', { message: 'call 15559871234' }, { dedupeKey: 'dead:10' });
    await drainOnce(deps(), 'w1');
    const hooks = await rows('ops.webhook');
    expect(hooks).toHaveLength(1);
    expect(hooks[0].dedupe_key).toMatch(/^opshook:\d+$/);
    expect(hooks[0].payload).toEqual({ text: 'call …1234' });
    expect(JSON.stringify(hooks[0].payload)).not.toContain('secretpart');
  });

  it('an OPS_ALERT_WEBHOOK_URL that is not https → no opshook row and one warning', async () => {
    vi.stubEnv('OPS_ALERT_PHONE', '');
    vi.stubEnv('OPS_ALERT_WEBHOOK_URL', 'http://hooks.example.test/x');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await outbox.enqueue('ops.alert', { message: 'm' }, { dedupeKey: 'dead:11' });
    expect((await drainOnce(deps(), 'w1')).processed).toBe(1);
    expect(await rows('ops.webhook')).toEqual([]);
    const lines = warn.mock.calls.flat().join(' ');
    expect(lines).toContain('ops.webhook');
    expect(lines).not.toContain('hooks.example.test');
    warn.mockRestore();
  });

  it('ops.webhook POSTs {text} to the env URL with a deadline; a non-2xx fails the row without leaking the URL', async () => {
    vi.stubEnv('OPS_ALERT_WEBHOOK_URL', 'https://hooks.example.test/T000/B000/secretpart');
    fetchFn.mockResolvedValue({ ok: true, status: 200 });
    await outbox.enqueue('ops.webhook', { text: 'hello' }, { dedupeKey: 'opshook:1' });
    expect((await drainOnce(deps(), 'w1')).processed).toBe(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.example.test/T000/B000/secretpart');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ text: 'hello' });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    fetchFn.mockReset();
    fetchFn.mockRejectedValue(new TypeError('fetch failed https://hooks.example.test/T000/B000/secretpart'));
    await outbox.enqueue('ops.webhook', { text: 'again' }, { dedupeKey: 'opshook:2' });
    expect((await drainOnce(deps(), 'w1')).failed).toBe(1);
    const failed = (await rows('ops.webhook')).find((h) => h.dedupe_key === 'opshook:2')!;
    expect(failed.last_error).toBeTruthy();
    expect(failed.last_error).not.toContain('secretpart');
    expect(failed.last_error).not.toContain('hooks.example.test');
  });

  it('ops.webhook with the URL unset at send time → done, nothing fetched', async () => {
    vi.stubEnv('OPS_ALERT_WEBHOOK_URL', '');
    await outbox.enqueue('ops.webhook', { text: 'x' }, { dedupeKey: 'opshook:3' });
    expect((await drainOnce(deps(), 'w1')).processed).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ── Program-Fix 49A (whatsapp-10d): the worker honours STOP by category ──────
describe('whatsapp.* rows honour opt-out by category (Program-Fix 49A)', { retry: 0 }, () => {
  async function optOut(partnerId: string, phone: string) {
    const customers = createCustomerStore(db, store);
    await customers.ensureCustomer(partnerId, phone);
    await customers.setOptedOut(partnerId, phone);
  }
  const doneCount = async () =>
    ((await db.execute(sql`SELECT count(*)::int AS n FROM outbox WHERE status = 'done'`)).rows[0] as { n: number }).n;

  it('nonessential text to an opted-out customer completes WITHOUT sending', async () => {
    await optOut('acme', '15551230000');
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'ticket reply', partnerId: 'acme', category: 'nonessential' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    expect(sendText).not.toHaveBeenCalled();
    expect(await doneCount()).toBe(1);
    expect(warn.mock.calls.flat().join(' ')).toContain('opted out');
  });

  it('nonessential template to an opted-out customer is suppressed too', async () => {
    await optOut('acme', '919876543210');
    await outbox.enqueue('whatsapp.template', {
      to: '919876543210', template: 't', lang: 'en', params: [], partnerId: 'acme', category: 'nonessential',
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await drainOnce(deps(), 'w1');
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('essential text to an opted-out customer still sends', async () => {
    await optOut('acme', '15551230000');
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'stage 1', partnerId: 'acme', category: 'essential' });
    await drainOnce(deps(), 'w1');
    expect(sendText).toHaveBeenCalledWith('15551230000', 'stage 1', undefined);
  });

  it('a row with NO category (old build) to an opted-out customer still sends', async () => {
    await optOut('acme', '15551230000');
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'legacy', partnerId: 'acme' });
    await drainOnce(deps(), 'w1');
    expect(sendText).toHaveBeenCalledWith('15551230000', 'legacy', undefined);
  });

  it('opt-out is per tenant: opted out under acme, a nonessential row for the default tenant (no partnerId) still sends', async () => {
    await optOut('acme', '15551230000');
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'default tenant', category: 'nonessential' });
    await drainOnce(deps(), 'w1');
    expect(sendText).toHaveBeenCalledWith('15551230000', 'default tenant', undefined);
  });

  it('a nonessential row with no partnerId checks the DEFAULT tenant', async () => {
    await optOut('default', '15551230000');
    await outbox.enqueue('whatsapp.text', { to: '15551230000', body: 'x', category: 'nonessential' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await drainOnce(deps(), 'w1');
    expect(sendText).not.toHaveBeenCalled();
  });
});
