import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// Fix pack 7 T4 (P32): the hold fixtures later tasks build on.

const redis = fakeRedis();
let db: Db;
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));

import { certifiedQueuePartner, heldRowFor, seedComplianceUsers, type HoldClassName } from './helpers-hold';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { holdQueueApplies, isQualifiedComplianceUser, partnerDecidesKyc, platformDelegated, reviewRecordApplies } from '@/lib/partner-decision-scope';
import { getAuthStore } from '@/lib/auth-store';
import { staffMfaEnrolled } from '@/lib/staff-mfa-store';
import { listScreenEvidence } from '@/lib/sanctions/evidence-read';
import {
  AML_HOLD_REASON, LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON, ORIGINATOR_INFO_MISSING_REASON,
  POSSIBLE_MATCH_REASON, RECIPIENT_WATCHLIST_REASON, SENDER_SCREENING_REASON,
} from '@/lib/compliance-config';

beforeEach(async () => {
  redis.dump.clear();
  db = await freshDb();
});

type CustomerFlags = { pep_hit: boolean | null; watchlist_hit: boolean | null; screening_flagged_at: unknown; address: boolean; dob: boolean };
async function customer(partnerId: string, phone: string): Promise<CustomerFlags> {
  const r = (await db.execute(sql`SELECT pep_hit, watchlist_hit, screening_flagged_at,
    residential_address_enc IS NOT NULL AS address, date_of_birth_enc IS NOT NULL AS dob
    FROM customers WHERE partner_id = ${partnerId} AND phone = ${phone}`)) as unknown as { rows: CustomerFlags[] };
  return r.rows[0];
}

async function qualified(partnerId: string, username: string): Promise<boolean> {
  const p = await createPartnerRepo(db).getPartner(partnerId);
  const s = await getAuthStore().getStaff(username);
  const fact = s ? { username: s.username, partnerId: s.partnerId, role: s.role, active: (s.status ?? 'active') === 'active' } : null;
  return isQualifiedComplianceUser(p, fact, await staffMfaEnrolled(username));
}

describe('certifiedQueuePartner', () => {
  it('defaults: acme certified, holdDecider partner, kycMode delegated, kycDecider partner, two users, an http rail', async () => {
    const id = await certifiedQueuePartner(db);
    expect(id).toBe('acme');
    const p = (await createPartnerRepo(db).getPartner('acme'))!;
    expect(p.kycMode).toBe('delegated');
    expect(p.liveControls?.posture).toMatchObject({ holdDecider: 'partner', kycDecider: 'partner', fourEyesNonSanctions: false });
    expect(p.liveControls?.complianceUsers).toEqual(['co-a', 'co-b']);
    expect(reviewRecordApplies(p)).toBe(true);
    expect(holdQueueApplies(p)).toBe(true);
    expect(partnerDecidesKyc(p)).toBe(true);
    expect(platformDelegated(p)).toBe(false);
    const rail = (await db.execute(sql`SELECT payment_provider_type FROM partner_integrations WHERE partner_id = 'acme'`)) as unknown as { rows: Array<{ payment_provider_type: string }> };
    expect(rail.rows[0].payment_provider_type).toBe('http');
  });

  it('smartremit_delegated with kycMode ours: platformDelegated, not partnerDecidesKyc, kycDecider smartremit_procedures', async () => {
    await certifiedQueuePartner(db, { partnerId: 'pz', holdDecider: 'smartremit_delegated', kycMode: 'ours', fourEyes: true, users: ['u1'] });
    const p = (await createPartnerRepo(db).getPartner('pz'))!;
    expect(platformDelegated(p)).toBe(true);
    expect(holdQueueApplies(p)).toBe(false);
    expect(partnerDecidesKyc(p)).toBe(false);
    expect(p.kycMode).toBe('ours');
    expect(p.liveControls?.posture).toMatchObject({ kycDecider: 'smartremit_procedures', fourEyesNonSanctions: true });
    expect(p.liveControls?.complianceUsers).toEqual(['u1']);
  });
});

describe('seedComplianceUsers', () => {
  it('makes isQualifiedComplianceUser true for each name; mfa:false makes staffMfaEnrolled false', async () => {
    await certifiedQueuePartner(db);
    await seedComplianceUsers(db, 'acme', ['co-a', 'co-b'], { redis });
    expect(await qualified('acme', 'co-a')).toBe(true);
    expect(await qualified('acme', 'co-b')).toBe(true);
    await seedComplianceUsers(db, 'acme', ['co-c'], { redis, mfa: false, role: 'admin' });
    expect(await staffMfaEnrolled('co-c')).toBe(false);
    expect((await getAuthStore().getStaff('co-c'))?.role).toBe('admin');
    expect((await getAuthStore().getStaff('co-a'))?.partnerId).toBe('acme');
  });
});

describe('heldRowFor', () => {
  beforeEach(async () => {
    await certifiedQueuePartner(db);
  });

  it("'kyc' is in_review/flagged with [LARGE_AMOUNT_REASON]", async () => {
    const t = await heldRowFor(db, 'acme', 'kyc');
    expect(t.status).toBe('in_review');
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toEqual([LARGE_AMOUNT_REASON]);
    expect(t.partnerId).toBe('acme');
    expect(t.environment).toBe('live');
  });

  it('each class carries its reasons', async () => {
    const want: Array<[HoldClassName, string[]]> = [
      ['aml', [AML_HOLD_REASON]],
      ['sender_pep', [SENDER_SCREENING_REASON]],
      ['sender_watchlist', [SENDER_SCREENING_REASON]],
      ['sanctions_review', [POSSIBLE_MATCH_REASON]],
      ['list_wait', [LIST_UNAVAILABLE_REASON]],
      ['data_missing', [ORIGINATOR_INFO_MISSING_REASON]],
      ['blocked', [RECIPIENT_WATCHLIST_REASON]],
      ['unknown', ['Legacy reason not in the registry.']],
    ];
    for (const [cls, reasons] of want) {
      await db.execute(sql`DELETE FROM customers`);
      const t = await heldRowFor(db, 'acme', cls, { id: `h_${cls}` });
      expect(t.id, cls).toBe(`h_${cls}`);
      expect(t.complianceReasons, cls).toEqual(reasons);
      expect(t.status, cls).toBe('in_review');
    }
  });

  it("'sender_pep' sets pep_hit and screening_flagged_at; 'sender_watchlist' sets watchlist_hit", async () => {
    const a = await heldRowFor(db, 'acme', 'sender_pep', { id: 'h_pep' });
    const c = await customer('acme', a.phone);
    expect(c.pep_hit).toBe(true);
    expect(c.watchlist_hit).not.toBe(true);
    expect(c.screening_flagged_at).not.toBeNull();
    await db.execute(sql`DELETE FROM customers`);
    const b = await heldRowFor(db, 'acme', 'sender_watchlist', { id: 'h_wl' });
    const d = await customer('acme', b.phone);
    expect(d.watchlist_hit).toBe(true);
    expect(d.pep_hit).not.toBe(true);
    expect(d.screening_flagged_at).not.toBeNull();
  });

  it("'kyc' leaves the sender flags unset", async () => {
    const t = await heldRowFor(db, 'acme', 'kyc');
    const c = await customer('acme', t.phone);
    expect(c.pep_hit).not.toBe(true);
    expect(c.watchlist_hit).not.toBe(true);
    expect(c.screening_flagged_at).toBeNull();
  });

  it("'sanctions_review' has a newest evidence row with decision possible_match; others a clear one", async () => {
    const t = await heldRowFor(db, 'acme', 'sanctions_review', { id: 'h_sr' });
    const ev = await listScreenEvidence(db, t, new Date());
    expect(ev.at(-1)?.decision).toBe('possible_match');
    expect(ev.at(-1)?.listFitness).toBe('live');
    const k = await heldRowFor(db, 'acme', 'kyc', { id: 'h_k' });
    expect((await listScreenEvidence(db, k, new Date())).at(-1)?.decision).toBe('clear');
  });

  it("'data_missing' has no originator data; every other class has address and dob on file", async () => {
    const t = await heldRowFor(db, 'acme', 'data_missing', { id: 'h_dm' });
    const c = await customer('acme', t.phone);
    expect([c.address, c.dob]).toEqual([false, false]);
    await db.execute(sql`DELETE FROM customers`);
    const k = await heldRowFor(db, 'acme', 'aml', { id: 'h_aml' });
    const d = await customer('acme', k.phone);
    expect([d.address, d.dob]).toEqual([true, true]);
  });

  it("'blocked' has complianceStatus blocked with RECIPIENT_WATCHLIST_REASON", async () => {
    const t = await heldRowFor(db, 'acme', 'blocked');
    expect(t.complianceStatus).toBe('blocked');
    expect(t.complianceReasons).toEqual([RECIPIENT_WATCHLIST_REASON]);
    expect(t.status).toBe('in_review');
  });

  it("{ routed: 'rail2' } sets settlementPartnerId; funding options pass through", async () => {
    await seedPartner(db, 'rail2');
    const t = await heldRowFor(db, 'acme', 'kyc', { routed: 'rail2', fundingProvider: 'stripe', fundingRef: 'pi_test_1' });
    expect(t.settlementPartnerId).toBe('rail2');
    expect(t.partnerId).toBe('acme');
    expect(t.fundingRef).toBe('pi_test_1');
    const r = (await db.execute(sql`SELECT funding_provider FROM transfers WHERE id = ${t.id}`)) as unknown as { rows: Array<{ funding_provider: string }> };
    expect(r.rows[0].funding_provider).toBe('stripe');
  });
});
