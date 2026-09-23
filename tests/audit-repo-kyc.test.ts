import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, seedPartner } from './helpers-db';
import { createAuditRepo } from '@/db/repos/aux-repos';
import type { Db } from '@/db/client';

// Program-Fix 28: the customer page's durable KYC trail. Tenant-keyed AND
// subject-keyed, KYC slugs only, newest first, bounded.
let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
});

const SUBJ = 'cust:' + 'a'.repeat(64);
const OTHER = 'cust:' + 'b'.repeat(64);

describe('createAuditRepo.listKycForSubject (Program-Fix 28)', () => {
  it('returns only this tenant + subject, only kyc.* rows, newest first', async () => {
    const repo = createAuditRepo(db);
    await repo.record({ partnerId: 'default', actor: 'plat', actorType: 'staff', action: 'kyc.review.approve', subjectId: SUBJ, meta: { reason: 'first' } });
    await repo.record({ partnerId: 'default', actor: 'plat', actorType: 'staff', action: 'pii.view', subjectId: SUBJ }); // not KYC
    await repo.record({ partnerId: 'default', actor: 'plat', actorType: 'staff', action: 'send_limits.set', subjectId: SUBJ }); // not KYC
    await repo.record({ partnerId: 'acme', actor: 'plat', actorType: 'staff', action: 'kyc.manual_override.approve', subjectId: SUBJ }); // other tenant
    await repo.record({ partnerId: 'default', actor: 'plat', actorType: 'staff', action: 'kyc.manual_override.reject', subjectId: OTHER }); // other subject
    await repo.record({ partnerId: 'default', actor: 'plat', actorType: 'staff', action: 'kyc.manual_override.reject', subjectId: SUBJ, meta: { reason: 'second' } });

    const rows = await repo.listKycForSubject('default', SUBJ);
    expect(rows.map((r) => r.action)).toEqual(['kyc.manual_override.reject', 'kyc.review.approve']);
    expect(rows[0]).toMatchObject({ actor: 'plat', meta: { reason: 'second' } });
    expect(typeof rows[0].at).toBe('string'); // ISO string, like the Redis trail
    expect(await repo.listKycForSubject('acme', SUBJ)).toHaveLength(1);
  });

  it('honours the limit', async () => {
    const repo = createAuditRepo(db);
    for (let i = 0; i < 5; i++) {
      await repo.record({ partnerId: 'default', actor: 'plat', actorType: 'staff', action: 'kyc.review.approve', subjectId: SUBJ });
    }
    expect(await repo.listKycForSubject('default', SUBJ, 3)).toHaveLength(3);
  });

  it("a LIKE wildcard in the slug prefix is literal: 'kycX…' is not a kyc.* row", async () => {
    const repo = createAuditRepo(db);
    await repo.record({ partnerId: 'default', actor: 'plat', actorType: 'staff', action: 'kycXreview', subjectId: SUBJ });
    expect(await repo.listKycForSubject('default', SUBJ)).toEqual([]);
  });
});
