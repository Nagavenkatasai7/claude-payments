import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, seedPartner } from './helpers-db';
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
import { createOutboxRepo, MAX_ATTEMPTS } from '@/db/repos/outbox-repo';
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
    expect(await r.authenticate(issued.plaintext)).toEqual({ partnerId: 'acme', keyId: issued.keyId });
    expect(await r.authenticate('sr_live_nope')).toBeNull();
    expect(await r.revoke(issued.keyId)).toBe(true);
    expect(await r.authenticate(issued.plaintext)).toBeNull();
    expect(await r.revoke(issued.keyId)).toBe(true); // idempotent
    expect(await r.revoke('pk_ghost')).toBe(false);
    const list = await r.list('acme');
    expect(list).toHaveLength(1);
    expect(list[0].revokedAt).toBeTruthy();
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
    const back = await r.getCustomer('15551230000');
    expect(back!.fullName).toBe('Asha Patel');
    expect(back!.govIdNumber).toBe('P1234567');
  });

  it('upsertOnFirstInbound: create → grandfather via firstTransferAt → follow-the-number', async () => {
    await seedPartner(db, 'acme');
    const r = repo();
    // grandfathered path: prior transfer exists
    firstAt.value = '2026-01-01T00:00:00.000Z';
    const g = await r.upsertOnFirstInbound('15550001111');
    expect(g.wasCreated).toBe(false);
    expect(g.customer.kycStatus).toBe('grandfathered');
    expect(g.customer.firstSeenAt).toBe('2026-01-01T00:00:00.000Z');
    // brand-new path under a routed partner
    firstAt.value = null;
    const n = await r.upsertOnFirstInbound('15550002222', 'acme');
    expect(n.wasCreated).toBe(true);
    expect(n.customer.partnerId).toBe('acme');
    // follow-the-number: existing default customer moves to the channel owner
    const moved = await r.upsertOnFirstInbound('15550001111', 'acme');
    expect(moved.customer.partnerId).toBe('acme');
    expect((await r.getCustomer('15550001111'))!.partnerId).toBe('acme');
  });

  it('consent + sticky funding + kyc inquiry mutations behave like the Redis store', async () => {
    firstAt.value = null;
    const r = repo();
    await r.upsertOnFirstInbound('15550003333');
    await r.setOptedOut('15550003333');
    expect((await r.getCustomer('15550003333'))!.optedOutAt).toBeTruthy();
    await r.clearOptedOut('15550003333');
    expect((await r.getCustomer('15550003333'))!.optedOutAt).toBeUndefined();
    await r.recordFundingMethod('15550003333', 'bank_transfer');
    expect((await r.getCustomer('15550003333'))!.lastFundingMethod).toBe('bank_transfer');
    await r.recordKycInquiry('15550003333', 'inq_1');
    await r.recordKycInquiry('15550003333', 'inq_2');
    const c = await r.getCustomer('15550003333');
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

  it('recipients: encrypted, sorted by lastUsedAt, limited', async () => {
    const r = createRecipientRepo(db, provider);
    await r.upsertRecipient('15551230000', { name: 'A', recipientPhone: '91A', payoutMethod: 'bank', payoutDestination: '111122223333', lastUsedAt: '2026-06-01T00:00:00.000Z' });
    await r.upsertRecipient('15551230000', { name: 'B', recipientPhone: '91B', payoutMethod: 'bank', payoutDestination: '444455556666', lastUsedAt: '2026-06-05T00:00:00.000Z' });
    const list = await r.listRecipients('15551230000', 1);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('B');
    expect(list[0].payoutDestination).toBe('444455556666');
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

  it('delayed effects only become claimable after their delay', async () => {
    const r = createOutboxRepo(db);
    await r.enqueue('mock.settle', { transferId: 'tr_1' }, { delayMs: 60_000 });
    expect(await r.claimBatch(10, 'w1')).toHaveLength(0);
  });
});
