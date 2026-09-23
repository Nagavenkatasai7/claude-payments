import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, seedLedgerSpend, seedPartner } from './helpers-db';
import { fakeRedis } from './helpers';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { sql } from 'drizzle-orm';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createApiKeyRepo } from '@/db/repos/api-key-repo';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { createScheduleRepo } from '@/db/repos/schedule-repo';
import {
  createRecipientRepo,
  createBeneficiaryRepo,
  createIdempotencyRepo,
  createAuditRepo,
} from '@/db/repos/aux-repos';
import { createOutboxRepo, MAX_ATTEMPTS, LEASE_MS } from '@/db/repos/outbox-repo';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { EMPTY_PARTNER_INTEGRATIONS } from '@/lib/partner-integrations';
import type { Db } from '@/db/client';
import type { Customer, Partner, Schedule } from '@/lib/types';

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

const now = '2026-06-09T12:00:00.000Z';

describe('partner-repo', () => {
  it('round-trips every white-label field; ensureDefaultPartner is idempotent', async () => {
    const repo = createPartnerRepo(db);
    const p: Partner = {
      id: 'acme', name: 'Acme', countries: ['US', 'AE'], status: 'active',
      displayName: 'Acme Pay', brandName: 'Acme', primaryColor: '#112233',
      logoUrl: 'https://cdn/x.png', supportContact: 'help@acme.com',
      botPersona: 'warm', kycMode: 'delegated', requireKycBeforeSend: false,
      createdAt: now, updatedAt: now,
    };
    await repo.savePartner(p);
    expect(await repo.getPartner('acme')).toEqual(p);
    const def = await repo.ensureDefaultPartner();
    expect(def.id).toBe('default');
    await repo.savePartner({ ...def, name: 'Renamed' });
    expect((await repo.ensureDefaultPartner()).name).toBe('Renamed'); // never clobbers
    expect((await repo.listPartners()).map((x) => x.id).sort()).toEqual(['acme', 'default']);
  });
});

describe('integrations-repo', () => {
  const FULL = {
    kyc: { providerType: 'persona' as const, apiKey: 'persona_secret', webhookSecret: 'whk_kyc' },
    payment: { providerType: 'simulator', credentials: { settlementUrl: 'https://rail', signingSecret: 'sgn' }, webhookSecret: 'whk_pay' },
    whatsapp: { phoneNumberId: '111222', token: 'EAAtok', verifyToken: 'vrfy', appSecret: 'meta_sec' },
  };

  it('no row ⇒ EMPTY (today’s behavior); full config round-trips', async () => {
    await seedPartner(db, 'acme');
    const repo = createIntegrationsRepo(db, provider);
    expect(await repo.getIntegrations('acme')).toEqual(EMPTY_PARTNER_INTEGRATIONS);
    await repo.saveIntegrations('acme', FULL);
    expect(await repo.getIntegrations('acme')).toEqual(FULL);
  });

  it('secrets are ciphertext AT REST; selectors plaintext; pnid reverse lookup works', async () => {
    await seedPartner(db, 'acme');
    const repo = createIntegrationsRepo(db, provider);
    await repo.saveIntegrations('acme', FULL);
    const raw = await db.execute(`SELECT * FROM partner_integrations WHERE partner_id = 'acme'`);
    const row = (raw as unknown as { rows: Record<string, string>[] }).rows[0];
    for (const secret of ['persona_secret', 'whk_kyc', 'sgn', 'whk_pay', 'EAAtok', 'vrfy', 'meta_sec']) {
      expect(JSON.stringify(row)).not.toContain(secret);
    }
    expect(row.wa_phone_number_id).toBe('111222');
    expect(row.payment_provider_type).toBe('simulator');
    expect(await repo.partnerForPhoneNumberId('111222')).toBe('acme');
    expect(await repo.partnerForPhoneNumberId('999')).toBeNull();
    await repo.deleteIntegrations('acme'); // crypto-shred
    expect(await repo.getIntegrations('acme')).toEqual(EMPTY_PARTNER_INTEGRATIONS);
  });
});

describe('api-key-repo', () => {
  function repo(n = { v: 0 }) {
    return createApiKeyRepo(db, {
      pepper: 'test-pepper',
      genSecret: () => `SECRET${n.v++}`,
      genKeyId: () => `pk_${n.v}`,
    });
  }

  it('issue → authenticate → revoke lifecycle; plaintext never at rest', async () => {
    await seedPartner(db, 'acme');
    const r = repo();
    const issued = await r.issue('acme');
    expect(issued.plaintext.startsWith('sr_live_')).toBe(true);
    const raw = await db.execute(`SELECT * FROM api_keys`);
    expect(JSON.stringify((raw as unknown as { rows: unknown[] }).rows)).not.toContain(issued.plaintext);
    expect(await r.authenticate(issued.plaintext)).toMatchObject({ partnerId: 'acme', keyId: issued.keyId, mode: 'live' });
    expect(await r.authenticate('sr_live_nope')).toBeNull();
    expect(await r.revoke(issued.keyId)).toBe(true);
    expect(await r.authenticate(issued.plaintext)).toBeNull();
    expect(await r.revoke(issued.keyId)).toBe(true); // idempotent
    expect(await r.revoke('pk_ghost')).toBe(false);
    const list = await r.list('acme');
    expect(list).toHaveLength(1);
    expect(list[0].revokedAt).toBeTruthy();
  });

  // Program-Fix 44 P1: last_used_at is written by authenticate — AWAITED (an
  // un-awaited write can be dropped once a Vercel response is sent), throttled
  // by a Redis SET NX EX 300 marker, and never able to fail the auth.
  function lastUsed(): Promise<string | null> {
    return db.execute(`SELECT last_used_at FROM api_keys`).then((raw) => {
      const v = (raw as unknown as { rows: Array<{ last_used_at: unknown }> }).rows[0]?.last_used_at;
      return v == null ? null : new Date(v as string).toISOString();
    });
  }

  it('last_used_at: written on auth, then at most once per 5-minute marker window', async () => {
    await seedPartner(db, 'acme');
    const redis = fakeRedis();
    let clock = new Date('2026-06-09T12:00:00.000Z');
    const n = { v: 0 };
    const r = createApiKeyRepo(db, {
      pepper: 'test-pepper',
      genSecret: () => `SECRET${n.v++}`,
      genKeyId: () => `pk_${n.v}`,
      now: () => clock,
      redis,
    });
    const issued = await r.issue('acme');
    expect(await lastUsed()).toBeNull();
    expect(await r.authenticate(issued.plaintext)).not.toBeNull();
    expect(await lastUsed()).toBe('2026-06-09T12:00:00.000Z');
    expect(await redis.get(`apikey_seen:${issued.keyId}`)).not.toBeNull();

    clock = new Date('2026-06-09T12:02:00.000Z'); // inside the marker window
    expect(await r.authenticate(issued.plaintext)).not.toBeNull();
    expect(await lastUsed()).toBe('2026-06-09T12:00:00.000Z'); // not rewritten

    await redis.del(`apikey_seen:${issued.keyId}`); // marker expired (EX 300)
    clock = new Date('2026-06-09T12:06:00.000Z');
    expect(await r.authenticate(issued.plaintext)).not.toBeNull();
    expect((await r.list('acme'))[0].lastUsedAt).toBe('2026-06-09T12:06:00.000Z');
  });

  it('last_used_at: a revoked key is never touched', async () => {
    await seedPartner(db, 'acme');
    const n = { v: 0 };
    const r = createApiKeyRepo(db, { pepper: 'p', genSecret: () => `S${n.v++}`, genKeyId: () => `pk_${n.v}`, redis: fakeRedis() });
    const issued = await r.issue('acme');
    await r.revoke(issued.keyId);
    expect(await r.authenticate(issued.plaintext)).toBeNull();
    expect(await lastUsed()).toBeNull();
  });

  it('last_used_at: a failing UPDATE or a failing Redis still returns the auth', async () => {
    await seedPartner(db, 'acme');
    const n = { v: 0 };
    const base = createApiKeyRepo(db, { pepper: 'p', genSecret: () => `S${n.v++}`, genKeyId: () => `pk_${n.v}` });
    const issued = await base.issue('acme');

    // Redis down: the marker SET throws — auth unaffected.
    const redisDown = { ...fakeRedis(), set: async () => { throw new Error('redis down'); } };
    const r1 = createApiKeyRepo(db, { pepper: 'p', redis: redisDown });
    expect(await r1.authenticate(issued.plaintext)).toMatchObject({ partnerId: 'acme', mode: 'live' });

    // DB UPDATE throws: auth unaffected. Proxy the db so only update() fails.
    const failingDb = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === 'update') return () => { throw new Error('update failed'); };
        return Reflect.get(target, prop, recv);
      },
    });
    const r2 = createApiKeyRepo(failingDb, { pepper: 'p', redis: fakeRedis() });
    expect(await r2.authenticate(issued.plaintext)).toMatchObject({ partnerId: 'acme', mode: 'live' });
  });
});

describe('customer-repo', () => {
  const firstAt: { value: string | null } = { value: null };
  const repo = () => createCustomerRepo(db, async () => firstAt.value, provider);

  it('PII is encrypted at rest and decrypted by default (sanctions needs fullName)', async () => {
    firstAt.value = null;
    const r = repo();
    const c: Customer = {
      senderPhone: '15551230000', firstSeenAt: now, kycStatus: 'verified',
      senderCountry: 'US', partnerId: 'default', fullName: 'Asha Patel',
      dateOfBirth: '1990-01-02', residentialAddress: '1 Main St', govIdNumber: 'P1234567',
      createdAt: now, updatedAt: now,
    };
    await r.saveCustomer(c);
    const raw = await db.execute(`SELECT full_name_enc, gov_id_number_enc FROM customers`);
    const row = (raw as unknown as { rows: Record<string, string>[] }).rows[0];
    expect(row.full_name_enc).not.toContain('Asha');
    expect(row.full_name_enc.startsWith('v1.')).toBe(true);
    expect(row.gov_id_number_enc).not.toContain('P1234567');
    const back = await r.getCustomer('default', '15551230000');
    expect(back!.fullName).toBe('Asha Patel');
    expect(back!.govIdNumber).toBe('P1234567');
  });

  it('upsertOnFirstInbound: create → grandfather via firstTransferAt → sibling row per tenant, never a re-home', async () => {
    await seedPartner(db, 'acme');
    const r = repo();
    // grandfathered path: prior transfer exists (under this tenant)
    firstAt.value = '2026-01-01T00:00:00.000Z';
    const g = await r.upsertOnFirstInbound('default', '15550001111');
    expect(g.wasCreated).toBe(false);
    expect(g.customer.kycStatus).toBe('grandfathered');
    expect(g.customer.firstSeenAt).toBe('2026-01-01T00:00:00.000Z');
    // brand-new path under a routed partner
    firstAt.value = null;
    const n = await r.upsertOnFirstInbound('acme', '15550002222');
    expect(n.wasCreated).toBe(true);
    expect(n.customer.partnerId).toBe('acme');
    // F44: a partner-signed inbound for a phone that already belongs to 'default'
    // creates acme's OWN row and leaves the default row exactly as it was.
    const sibling = await r.upsertOnFirstInbound('acme', '15550001111');
    expect(sibling.wasCreated).toBe(true);
    expect(sibling.customer.partnerId).toBe('acme');
    expect(sibling.customer.kycStatus).toBe('not_started');
    expect((await r.getCustomer('default', '15550001111'))!.partnerId).toBe('default');
    expect((await r.getCustomer('default', '15550001111'))!.kycStatus).toBe('grandfathered');
    expect((await r.findByPhone('15550001111')).map((c) => c.partnerId).sort()).toEqual(['acme', 'default']);
  });

  it('saveCustomer conflicts on (partner_id, phone), so two partners hold the same phone independently', async () => {
    await seedPartner(db, 'acme');
    const r = repo();
    const base: Customer = {
      senderPhone: '15550009999', firstSeenAt: now, kycStatus: 'verified', senderCountry: 'US',
      partnerId: 'default', fullName: 'Asha Patel', passwordHash: 'pw', createdAt: now, updatedAt: now,
    };
    await r.saveCustomer(base);
    await r.saveCustomer({ ...base, partnerId: 'acme', kycStatus: 'not_started', fullName: undefined, passwordHash: undefined });
    const d = (await r.getCustomer('default', '15550009999'))!;
    const a = (await r.getCustomer('acme', '15550009999'))!;
    expect([d.kycStatus, d.fullName, d.passwordHash]).toEqual(['verified', 'Asha Patel', 'pw']);
    expect([a.kycStatus, a.fullName, a.passwordHash]).toEqual(['not_started', undefined, undefined]);
    expect(await r.getCustomer('globex', '15550009999')).toBeNull();
    expect((await r.listCustomers('acme')).map((c) => c.partnerId)).toEqual(['acme']);
    expect((await r.listCustomers()).length).toBe(2);
  });

  it('ensureCustomer creates a row WITHOUT WhatsApp opt-in (API-minted senders never consent by side effect)', async () => {
    await seedPartner(db, 'acme');
    const r = repo();
    firstAt.value = null;
    const c = await r.ensureCustomer('acme', '15550004444');
    expect(c.partnerId).toBe('acme');
    expect(c.optInAt).toBeUndefined();
    expect((await r.ensureCustomer('acme', '15550004444')).createdAt).toBe(c.createdAt); // idempotent
  });

  it('consent + sticky funding + kyc inquiry mutations behave like the Redis store', async () => {
    firstAt.value = null;
    const r = repo();
    await r.upsertOnFirstInbound('default', '15550003333');
    await r.setOptedOut('default', '15550003333');
    expect((await r.getCustomer('default', '15550003333'))!.optedOutAt).toBeTruthy();
    await r.clearOptedOut('default', '15550003333');
    expect((await r.getCustomer('default', '15550003333'))!.optedOutAt).toBeUndefined();
    await r.recordFundingMethod('default', '15550003333', 'bank_transfer');
    expect((await r.getCustomer('default', '15550003333'))!.lastFundingMethod).toBe('bank_transfer');
    await r.recordKycInquiry('default', '15550003333', 'inq_1');
    await r.recordKycInquiry('default', '15550003333', 'inq_2');
    const c = await r.getCustomer('default', '15550003333');
    expect(c!.kycInquiryId).toBe('inq_2');
    expect(c!.kycSubmittedAt).toBeTruthy();
  });
});

describe('schedule-repo + aux repos', () => {
  it('schedule round-trips with encrypted payout destination', async () => {
    const r = createScheduleRepo(db, provider);
    const s: Schedule = {
      id: 'sch_1', phone: '15551230000', amountUsd: 100, recipientName: 'Mom',
      recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '999888777666',
      fundingMethod: 'bank_transfer', frequency: 'monthly', dayOfMonth: 5, status: 'active',
      createdAt: now, partnerId: 'default', sourceCurrency: 'USD', amountSource: 100,
    };
    await r.saveSchedule(s);
    expect(await r.getSchedule('sch_1')).toEqual(s);
    const raw = await db.execute(`SELECT payout_destination_enc FROM schedules`);
    expect((raw as unknown as { rows: Record<string, string>[] }).rows[0].payout_destination_enc).not.toContain('999888');
    expect((await r.listActiveSchedules()).map((x) => x.id)).toEqual(['sch_1']);
  });

  it('recipients: encrypted, sorted by lastUsedAt, limited, and TENANT-SCOPED', async () => {
    await seedPartner(db, 'acme');
    const r = createRecipientRepo(db, provider);
    await r.upsertRecipient('default', '15551230000', { name: 'A', recipientPhone: '91A', payoutMethod: 'bank', payoutDestination: '111122223333', lastUsedAt: '2026-06-01T00:00:00.000Z' });
    await r.upsertRecipient('default', '15551230000', { name: 'B', recipientPhone: '91B', payoutMethod: 'bank', payoutDestination: '444455556666', lastUsedAt: '2026-06-05T00:00:00.000Z' });
    const list = await r.listRecipients('default', '15551230000', 1);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('B');
    expect(list[0].payoutDestination).toBe('444455556666');
    // F45/F47: partner B cannot overwrite or read partner A's saved destination for the same sender + recipient.
    await r.upsertRecipient('acme', '15551230000', { name: 'B', recipientPhone: '91B', payoutMethod: 'bank', payoutDestination: '999999999999', lastUsedAt: '2026-06-06T00:00:00.000Z' });
    expect((await r.listRecipients('default', '15551230000', 5)).find((x) => x.recipientPhone === '91B')!.payoutDestination).toBe('444455556666');
    expect((await r.listRecipients('acme', '15551230000', 5)).map((x) => x.payoutDestination)).toEqual(['999999999999']);
    expect(await r.listRecipients('globex', '15551230000', 5)).toEqual([]);
  });

  it('beneficiaries are partner-scoped (404-never-403 contract at the repo)', async () => {
    await seedPartner(db, 'acme');
    const r = createBeneficiaryRepo(db, provider);
    await r.createBeneficiary({
      id: 'ben_1', partnerId: 'acme', name: 'Anita', country: 'IN',
      payoutMethod: 'bank', payoutDestination: '123456789012', createdAt: now,
    });
    expect((await r.getOwnedBeneficiary('acme', 'ben_1'))!.payoutDestination).toBe('123456789012');
    expect(await r.getOwnedBeneficiary('default', 'ben_1')).toBeNull();
  });

  it('idempotency claim: first writer wins, replay returns the ORIGINAL transfer id', async () => {
    const r = createIdempotencyRepo(db);
    expect(await r.claim('acme', 'idem-1', 'tr_first')).toBe('tr_first');
    expect(await r.claim('acme', 'idem-1', 'tr_second')).toBe('tr_first'); // replay
    expect(await r.claim('globex', 'idem-1', 'tr_other')).toBe('tr_other'); // per-tenant keyspace
  });

  it('audit events append and list', async () => {
    await seedPartner(db, 'acme');
    const r = createAuditRepo(db);
    await r.record({ partnerId: 'acme', actor: 'pk_1', actorType: 'api_key', action: 'transaction.create', subjectId: 'tr_1' });
    await r.record({ actor: 'system', actorType: 'system', action: 'reconcile.sweep' });
    expect(await r.listByPartner('acme')).toHaveLength(1);
    expect((await r.listRecent()).length).toBe(2);
  });
});

describe('outbox-repo (durability backbone)', () => {
  it('enqueue is dedupe-idempotent; claim moves to processing and increments attempts', async () => {
    const r = createOutboxRepo(db);
    expect(await r.enqueue('whatsapp.text', { to: 'x' }, { dedupeKey: 'stage1:tr_1' })).toBe(true);
    expect(await r.enqueue('whatsapp.text', { to: 'x' }, { dedupeKey: 'stage1:tr_1' })).toBe(false); // replay no-op
    const claimed = await r.claimBatch(10, 'w1');
    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe('processing');
    expect(claimed[0].attempts).toBe(1);
    // claimed rows are invisible to a second drain
    expect(await r.claimBatch(10, 'w2')).toHaveLength(0);
  });

  it('failure backoff schedules a retry in the future; success completes', async () => {
    const r = createOutboxRepo(db);
    await r.enqueue('settlement.instruct', { transferId: 'tr_1' });
    const [row] = await r.claimBatch(1, 'w1');
    expect(await r.markFailed(row.id, row.attempts, 'rail 503')).toBe('failed');
    expect(await r.claimBatch(1, 'w1')).toHaveLength(0); // backoff: not due yet
    expect(await r.countPending()).toBe(1);
    await r.markDone(row.id); // (simulating a later successful attempt)
    expect(await r.countPending()).toBe(0);
  });

  it('a row dies at MAX_ATTEMPTS and can be resurrected by ops retry', async () => {
    const r = createOutboxRepo(db);
    await r.enqueue('rail.callback', { reference: 'tr_1' });
    const [row] = await r.claimBatch(1, 'w1');
    expect(await r.markFailed(row.id, MAX_ATTEMPTS, 'still down')).toBe('dead');
    expect(await r.listDead()).toHaveLength(1);
    await r.retryDead(row.id);
    expect(await r.listDead()).toHaveLength(0);
    const reclaimed = await r.claimBatch(1, 'w1');
    expect(reclaimed).toHaveLength(1);
  });

  // Program-Fix 15 PR C relies on this: the sender cancel's "never claimed"
  // proof is locked_at IS NULL, which retryDead must NOT clear (a retried row
  // may have reached the rail on an earlier run).
  it('retryDead resets attempts to 0 but KEEPS locked_at (the row ran before)', { retry: 0 }, async () => {
    const r = createOutboxRepo(db);
    await r.enqueue('settlement.instruct', { transferId: 'tr_1' }, { dedupeKey: 'instruct:tr_1' });
    const [row] = await r.claimBatch(1, 'w1');
    await r.markFailed(row.id, MAX_ATTEMPTS, 'down');
    await r.retryDead(row.id);
    const [locked] = await r.lockRailRowsForTransfer('tr_1');
    expect(locked).toMatchObject({ status: 'pending', attempts: 0 });
    expect(locked.lockedAt).not.toBeNull();
    expect(await r.markDoneLocked([locked.id], 'sender_cancel')).toBe(0); // never provably unrun
  });

  it('delayed effects only become claimable after their delay', async () => {
    const r = createOutboxRepo(db);
    await r.enqueue('mock.settle', { transferId: 'tr_1' }, { delayMs: 60_000 });
    expect(await r.claimBatch(10, 'w1')).toHaveLength(0);
  });

  // ── Lease reclaim (Phase 1 fix 7: money-03 / neon-04 / vercel-04) ──────────
  // Fixture rule (CLAUDE.md): age leases with SQL-relative time, never a date.

  it('claimBatch RECLAIMS a processing row whose lease has expired and increments attempts', async () => {
    const r = createOutboxRepo(db);
    await r.enqueue('settlement.instruct', { transferId: 'tr_1' });
    const [claimed] = await r.claimBatch(1, 'w_dead');
    expect(claimed.attempts).toBe(1);
    expect(claimed.leaseOwner).toBe('w_dead');
    expect(claimed.leaseUntil!.getTime()).toBeGreaterThan(Date.now() + LEASE_MS - 60_000);
    // w_dead was killed by the 60s function ceiling and never comes back.
    await db.execute(sql`UPDATE outbox SET lease_until = now() - interval '10 minutes' WHERE id = ${claimed.id}`);
    const [reclaimed] = await r.claimBatch(1, 'w_new');
    expect(reclaimed.id).toBe(claimed.id);
    expect(reclaimed.status).toBe('processing');
    expect(reclaimed.attempts).toBe(2); // a reclaim IS a retry — attempts keeps climbing
    expect(reclaimed.leaseOwner).toBe('w_new');
  });

  it('claimBatch does NOT reclaim a processing row whose lease is still live', async () => {
    const r = createOutboxRepo(db);
    await r.enqueue('whatsapp.text', { to: 'x' });
    expect(await r.claimBatch(1, 'w_alive')).toHaveLength(1);
    expect(await r.claimBatch(1, 'w_other')).toHaveLength(0);
  });

  it('a reclaimed row still dies at MAX_ATTEMPTS — the lease never resets the death ceiling', async () => {
    const r = createOutboxRepo(db);
    await r.enqueue('rail.callback', { reference: 'tr_1' });
    const [row] = await r.claimBatch(1, 'w1');
    await db.execute(
      sql`UPDATE outbox SET attempts = ${MAX_ATTEMPTS - 1}, lease_until = now() - interval '1 minute' WHERE id = ${row.id}`,
    );
    const [reclaimed] = await r.claimBatch(1, 'w2');
    expect(reclaimed.attempts).toBe(MAX_ATTEMPTS);
    expect(await r.markFailed(reclaimed.id, reclaimed.attempts, 'still hung', 'w2')).toBe('dead');
    expect(await r.listDead()).toHaveLength(1);
  });

  it("markDone/markFailed from a worker that lost its lease cannot clobber the new owner's claim", async () => {
    const r = createOutboxRepo(db);
    await r.enqueue('settlement.instruct', { transferId: 'tr_1' });
    const [row] = await r.claimBatch(1, 'w_old');
    await db.execute(sql`UPDATE outbox SET lease_until = now() - interval '1 minute' WHERE id = ${row.id}`);
    const [stolen] = await r.claimBatch(1, 'w_new');
    expect(stolen.leaseOwner).toBe('w_new');
    // The resurrected old worker finishes late: both of its outcomes are refused.
    expect(await r.markDone(row.id, 'w_old')).toBe(false);
    expect(await r.markFailed(row.id, row.attempts, 'late failure', 'w_old')).toBe('lost');
    const res = await db.execute(sql`SELECT status, lease_owner FROM outbox WHERE id = ${row.id}`);
    const [{ status, lease_owner }] = (res as unknown as { rows: Array<{ status: string; lease_owner: string }> }).rows;
    expect(status).toBe('processing');
    expect(lease_owner).toBe('w_new');
    // The live owner's outcome lands and clears the lease.
    expect(await r.markDone(row.id, 'w_new')).toBe(true);
    // An owner-less markDone (staff "dismiss" on a dead row, ops/actions.ts:47) stays legal.
    await db.execute(sql`INSERT INTO outbox (kind, payload, status) VALUES ('whatsapp.text', '{}'::jsonb, 'dead')`);
    const [dead] = await r.listDead();
    expect(await r.markDone(dead.id)).toBe(true);
  });

  it('a processing row claimed by PRE-lease code (lease_until NULL) is reclaimed once locked_at + LEASE_MS has passed, and is visible to listStaleProcessing', async () => {
    const r = createOutboxRepo(db);
    // Old code: status/locked_at/locked_by only, never a lease.
    await db.execute(sql`INSERT INTO outbox (kind, payload, status, attempts, locked_at, locked_by)
      VALUES ('whatsapp.text', '{"to":"old"}'::jsonb, 'processing', 1, now() - interval '30 minutes', 'w_legacy')`);
    await db.execute(sql`INSERT INTO outbox (kind, payload, status, attempts, locked_at, locked_by)
      VALUES ('whatsapp.text', '{"to":"live"}'::jsonb, 'processing', 1, now() - interval '1 minute', 'w_legacy_live')`);
    const stale = await r.listStaleProcessing(15);
    expect(stale.map((o) => o.lockedBy)).toEqual(['w_legacy']); // 30m − 5m lease = 25m > 15m; the live one is not stale
    const reclaimed = await r.claimBatch(10, 'w_new');
    expect(reclaimed).toHaveLength(1); // the 1-minute-old legacy claim is still inside its implied lease
    expect(reclaimed[0].lockedBy).toBe('w_new');
    expect(reclaimed[0].attempts).toBe(2);
    expect(reclaimed[0].leaseOwner).toBe('w_new');
  });

  it('markFailed minBackoffSec parks the row at least that long (deadline failures: past any abandoned handler)', async () => {
    const r = createOutboxRepo(db);
    await r.enqueue('whatsapp.text', { to: 'x' });
    const [row] = await r.claimBatch(1, 'w1');
    expect(await r.markFailed(row.id, row.attempts, 'row deadline', 'w1', { minBackoffSec: LEASE_MS / 1000 })).toBe('failed');
    const res = await db.execute(
      sql`SELECT extract(epoch FROM (next_attempt_at - now()))::float AS wait_s FROM outbox WHERE id = ${row.id}`,
    );
    const [{ wait_s }] = (res as unknown as { rows: Array<{ wait_s: number }> }).rows;
    expect(wait_s).toBeGreaterThan(LEASE_MS / 1000 - 10);
  });

  it("releaseUnstarted hands back only the OWNER's untouched rows and refunds the claim's attempt", async () => {
    const r = createOutboxRepo(db);
    await r.enqueue('whatsapp.text', { to: 'a' });
    await r.enqueue('whatsapp.text', { to: 'b' });
    const [ra, rb] = await r.claimBatch(2, 'w1');
    expect(await r.releaseUnstarted([ra.id, rb.id], 'w_other')).toBe(0); // not the owner
    expect(await r.releaseUnstarted([ra.id], 'w1')).toBe(1);
    expect(await r.countPending()).toBe(1);
    const [again] = await r.claimBatch(1, 'w2');
    expect(again.id).toBe(ra.id);
    expect(again.attempts).toBe(1); // the release refunded the never-run attempt; this claim re-charges it
  });

  // ── dueSummary (Program-Fix 12 / Task 8): the drain-gap alarm's input ─────────
  it('dueSummary counts due pending/failed rows PLUS expired leases and returns the oldest due instant', async () => {
    const r = createOutboxRepo(db);
    expect(await r.dueSummary()).toEqual({ dueNow: 0, oldestDueAt: null });

    await r.enqueue('whatsapp.text', { to: 'a' }); // pending, due now
    await r.enqueue('whatsapp.text', { to: 'b' }, { delayMs: 60 * 60_000 }); // pending, NOT due
    await r.enqueue('rail.callback', { reference: 'c' });
    await r.enqueue('mock.settle', { transferId: 'd' });
    // Claim a, c, d (ORDER BY id; 'b' is not due). 'd' keeps a live lease.
    const [a] = await r.claimBatch(1, 'w1');
    const [c] = await r.claimBatch(1, 'w2');
    const [d] = await r.claimBatch(1, 'w3');
    expect([a.kind, c.kind, d.kind]).toEqual(['whatsapp.text', 'rail.callback', 'mock.settle']);
    // 'a' becomes a failed row due 20 minutes ago (SQL-relative time, never a date).
    await db.execute(sql`UPDATE outbox SET status = 'failed', next_attempt_at = now() - interval '20 minutes', lease_until = null, lease_owner = null WHERE id = ${a.id}`);
    // 'c' is stranded with a lease that expired 8 minutes ago.
    await db.execute(sql`UPDATE outbox SET lease_until = now() - interval '8 minutes' WHERE id = ${c.id}`);

    const s = await r.dueSummary();
    expect(s.dueNow).toBe(2); // 'a' (failed, due) + 'c' (expired lease); not 'b' (future), not 'd' (live lease)
    const ageMin = (Date.now() - s.oldestDueAt!.getTime()) / 60_000;
    expect(ageMin).toBeGreaterThan(19);
    expect(ageMin).toBeLessThan(21);
  });
});

// Program-Fix 32 (neon-09): the expiry sweep's read — unfunded awaiting_payment
// rows created before the cutoff, oldest first, bounded. A charged row
// (funding_ref set) belongs to the funding-resume sweep and is never listed.
describe('transfer-repo listStaleUnfunded (Program-Fix 32)', () => {
  it('lists only unfunded awaiting_payment rows older than the cutoff, oldest first, up to the limit', async () => {
    await seedPartner(db, 'acme');
    const day = 86_400_000;
    const ago = (days: number) => new Date(Date.now() - days * day);
    const old1 = await seedLedgerSpend(db, { partnerId: 'default', phone: '15550000001', amountUsd: 10, createdAt: ago(9) });
    const old2 = await seedLedgerSpend(db, { partnerId: 'acme', phone: '15550000002', amountUsd: 10, createdAt: ago(8) });
    await seedLedgerSpend(db, { partnerId: 'default', phone: '15550000003', amountUsd: 10, createdAt: ago(6) }); // too young
    const charged = await seedLedgerSpend(db, { partnerId: 'default', phone: '15550000004', amountUsd: 10, createdAt: ago(30) });
    await createTransferRepo(db).setFundingRef(charged, 'mockfund-x');
    for (const status of ['in_review', 'paid', 'delivered', 'cancelled', 'blocked'] as const) {
      await seedLedgerSpend(db, { partnerId: 'default', phone: '15550000005', amountUsd: 10, createdAt: ago(20), status });
    }
    // Review S1: a B2B invoice row is never expired (a crashed invoice mint
    // would otherwise be cancelled while b2b-pay-finalize replays it as ok).
    const b2b = await seedLedgerSpend(db, { partnerId: 'default', phone: '15550000006', amountUsd: 10, createdAt: ago(20) });
    await db.execute(sql`UPDATE transfers SET transfer_type = 'b2b', invoice_id = 'inv_1' WHERE id = ${b2b}`);
    const repo = createTransferRepo(db);
    expect((await repo.listStaleUnfunded(ago(7))).map((t) => t.id)).toEqual([old1, old2]);
    expect((await repo.listStaleUnfunded(ago(7), 1)).map((t) => t.id)).toEqual([old1]);
  });
});
