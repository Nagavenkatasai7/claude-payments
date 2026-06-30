import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb } from './helpers-db';
import { createSellerRepo } from '@/db/repos/aux-repos';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';

let db: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => { db = await freshDb(); });

const base = {
  id: 's_hk1', partnerId: DEFAULT_PARTNER_ID, phone: '85291234567',
  businessName: 'Kowloon Design Co', country: 'HK' as const, currency: 'HKD' as const,
};

describe('createSellerRepo', () => {
  it('creates a pending seller and reads it back masked', async () => {
    const repo = createSellerRepo(db);
    const created = await repo.createSeller(base);
    expect(created.status).toBe('pending');
    expect(created.payoutLast4).toBeUndefined();

    const got = await repo.getSeller('85291234567', DEFAULT_PARTNER_ID);
    expect(got?.businessName).toBe('Kowloon Design Co');
    expect(got?.currency).toBe('HKD');
    expect((got as unknown as Record<string, unknown>).payoutDestination).toBeUndefined();
  });

  it('normalizes + validates the seller phone on write', async () => {
    const repo = createSellerRepo(db);
    await repo.createSeller({ ...base, phone: '+852 9123 4567' });
    const got = await repo.getSeller('85291234567', DEFAULT_PARTNER_ID);
    expect(got).not.toBeNull();
    await expect(repo.createSeller({ ...base, id: 's_bad', phone: '12' })).rejects.toThrow();
  });

  it('encrypts the payout destination; masked read shows only last4; decrypt round-trips', async () => {
    const repo = createSellerRepo(db);
    await repo.createSeller(base);
    const updated = await repo.setPayoutDestination('85291234567', DEFAULT_PARTNER_ID, 'HK|024|388|123456789');
    expect(updated?.payoutLast4).toBe('6789');

    const masked = await repo.getSeller('85291234567', DEFAULT_PARTNER_ID);
    expect(masked?.payoutLast4).toBe('6789');

    const decrypted = await repo.getSellerDecrypted('85291234567', DEFAULT_PARTNER_ID);
    expect(decrypted?.payoutDestination).toBe('HK|024|388|123456789');
  });

  it('is tenant-scoped: another partner cannot read the seller', async () => {
    const repo = createSellerRepo(db);
    await repo.createSeller(base);
    const cross = await repo.getSeller('85291234567', 'some_other_partner');
    expect(cross).toBeNull();
  });

  it('activates a seller via setStatus', async () => {
    const repo = createSellerRepo(db);
    await repo.createSeller(base);
    const active = await repo.setStatus('85291234567', DEFAULT_PARTNER_ID, 'active');
    expect(active?.status).toBe('active');
  });

  it('createSeller can land a row already flagged for review (atomic)', async () => {
    const repo = createSellerRepo(db);
    const created = await repo.createSeller({ ...base, kycReviewState: 'needs_review' });
    expect(created.status).toBe('pending');
    expect(created.kycReviewState).toBe('needs_review');
  });

  it('setReviewState transitions the review flag (partner-scoped)', async () => {
    const repo = createSellerRepo(db);
    await repo.createSeller(base);
    const flagged = await repo.setReviewState('85291234567', DEFAULT_PARTNER_ID, 'needs_review');
    expect(flagged?.kycReviewState).toBe('needs_review');
    // Cross-tenant write matches nothing.
    expect(await repo.setReviewState('85291234567', 'other', 'approved')).toBeNull();
  });

  describe('activateOnboarding (guarded atomic completion)', () => {
    it('activates a clean pending seller: encrypts payout + flips active in one write', async () => {
      const repo = createSellerRepo(db);
      await repo.createSeller(base);
      const done = await repo.activateOnboarding('85291234567', DEFAULT_PARTNER_ID, 'HK|024|388|123456789');
      expect(done?.status).toBe('active');
      expect(done?.payoutLast4).toBe('6789');
      const dec = await repo.getSellerDecrypted('85291234567', DEFAULT_PARTNER_ID);
      expect(dec?.payoutDestination).toBe('HK|024|388|123456789');
    });

    it('REFUSES (null, no write) a seller flagged needs_review — the hold holds at write time', async () => {
      const repo = createSellerRepo(db);
      await repo.createSeller({ ...base, kycReviewState: 'needs_review' });
      const done = await repo.activateOnboarding('85291234567', DEFAULT_PARTNER_ID, 'HK|024|388|123456789');
      expect(done).toBeNull();
      const still = await repo.getSeller('85291234567', DEFAULT_PARTNER_ID);
      expect(still?.status).toBe('pending');
      expect(still?.payoutLast4).toBeUndefined(); // no payout written
    });

    it('REFUSES (null) an already-active seller — never re-activates', async () => {
      const repo = createSellerRepo(db);
      await repo.createSeller(base);
      await repo.setStatus('85291234567', DEFAULT_PARTNER_ID, 'active');
      const done = await repo.activateOnboarding('85291234567', DEFAULT_PARTNER_ID, 'HK|024|388|123456789');
      expect(done).toBeNull();
    });

    it('is tenant-scoped: another partner cannot activate the seller', async () => {
      const repo = createSellerRepo(db);
      await repo.createSeller(base);
      expect(await repo.activateOnboarding('85291234567', 'other', 'HK|024|388|123456789')).toBeNull();
      expect((await repo.getSeller('85291234567', DEFAULT_PARTNER_ID))?.status).toBe('pending');
    });
  });
});
