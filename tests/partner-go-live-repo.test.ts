import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import { partnerGoLive } from '@/db/schema';
import {
  approveGoLive,
  createPendingGoLive,
  getGoLive,
  getGoLiveForUpdate,
  isLiveApproved,
  requestGoLive,
  upsertApprovedGoLive,
  latestTemplateAttestation,
} from '@/db/repos/partner-go-live-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';

// UI redesign M3-14: the go-live gate for LIVE API keys. A partner is live-approved only when its
// partner_go_live row has approved_at set (migration 0028 backfills an approved row for every
// partner that existed when it was applied; a partner created later has no row until it asks).

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
});

describe('partner-go-live-repo', () => {
  it('a new partner (no row) is not live-approved and has no go-live record', async () => {
    expect(await isLiveApproved(db, 'pa')).toBe(false);
    expect(await getGoLive(db, 'pa')).toBeNull();
  });

  it('a backfilled partner (approved row, as migration 0028 writes it) is live-approved', async () => {
    await db.insert(partnerGoLive).values({ partnerId: 'pa', approvedAt: new Date(), approvedBy: 'system:0028-backfill' });
    expect(await isLiveApproved(db, 'pa')).toBe(true);
    expect((await getGoLive(db, 'pa'))?.approvedBy).toBe('system:0028-backfill');
  });

  it('requested but not approved is not live-approved', async () => {
    await requestGoLive(db, 'pa', 'pa-admin');
    expect(await isLiveApproved(db, 'pa')).toBe(false);
    const g = await getGoLive(db, 'pa');
    expect(g?.requestedBy).toBe('pa-admin');
    expect(g?.requestedAt).toBeInstanceOf(Date);
    expect(g?.approvedAt).toBeNull();
  });

  it('requestGoLive is idempotent: the first request time and requester are kept', async () => {
    await requestGoLive(db, 'pa', 'first', new Date('2026-09-01T00:00:00Z'));
    await requestGoLive(db, 'pa', 'second', new Date('2026-09-02T00:00:00Z'));
    const g = await getGoLive(db, 'pa');
    expect(g?.requestedBy).toBe('first');
    expect(g?.requestedAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(await db.select().from(partnerGoLive)).toHaveLength(1);
  });

  it('approveGoLive refuses (false) when nothing was requested, and writes nothing', async () => {
    expect(await approveGoLive(db, 'pa', 'platform-admin')).toBe(false);
    expect(await getGoLive(db, 'pa')).toBeNull();
    expect(await isLiveApproved(db, 'pa')).toBe(false);
  });

  it('approveGoLive after a request approves; a second approval keeps the first approver', async () => {
    await requestGoLive(db, 'pa', 'pa-admin');
    expect(await approveGoLive(db, 'pa', 'plat-1')).toBe(true);
    expect(await isLiveApproved(db, 'pa')).toBe(true);
    expect(await approveGoLive(db, 'pa', 'plat-2')).toBe(true);
    expect((await getGoLive(db, 'pa'))?.approvedBy).toBe('plat-1');
  });

  it('is tenant-keyed: approving A never approves B, and B’s request is not A’s', async () => {
    await requestGoLive(db, 'pb', 'pb-admin');
    expect(await approveGoLive(db, 'pa', 'plat')).toBe(false);
    await requestGoLive(db, 'pa', 'pa-admin');
    await approveGoLive(db, 'pa', 'plat');
    expect(await isLiveApproved(db, 'pa')).toBe(true);
    expect(await isLiveApproved(db, 'pb')).toBe(false);
    expect((await getGoLive(db, 'pb'))?.requestedBy).toBe('pb-admin');
  });

  // M3-21: the platform-side writers.
  it('createPendingGoLive writes ONE empty row (not requested, not approved) and never touches an existing one', async () => {
    await createPendingGoLive(db, 'pa');
    const g = await getGoLive(db, 'pa');
    expect(g).not.toBeNull();
    expect(g?.requestedAt).toBeNull();
    expect(g?.approvedAt).toBeNull();
    expect(await isLiveApproved(db, 'pa')).toBe(false);
    // A later request still records itself on the empty row, and approval then works.
    await requestGoLive(db, 'pa', 'pa-admin');
    expect(await approveGoLive(db, 'pa', 'root')).toBe(true);
    await createPendingGoLive(db, 'pa'); // a repeat never un-approves
    expect(await isLiveApproved(db, 'pa')).toBe(true);
    expect(await getGoLive(db, 'pb')).toBeNull();
  });

  it('upsertApprovedGoLive approves a partner with no row (the platform wizard) and records the approver', async () => {
    await upsertApprovedGoLive(db, 'pa', 'root', new Date('2026-09-29T00:00:00Z'));
    expect(await isLiveApproved(db, 'pa')).toBe(true);
    const g = await getGoLive(db, 'pa');
    expect(g?.approvedBy).toBe('root');
    expect(g?.approvedAt?.toISOString()).toBe('2026-09-29T00:00:00.000Z');
    expect(await isLiveApproved(db, 'pb')).toBe(false);
  });

  it('upsertApprovedGoLive approves an existing pending row, and keeps the first approval', async () => {
    await createPendingGoLive(db, 'pa');
    await upsertApprovedGoLive(db, 'pa', 'first', new Date('2026-09-01T00:00:00Z'));
    await upsertApprovedGoLive(db, 'pa', 'second', new Date('2026-09-02T00:00:00Z'));
    const g = await getGoLive(db, 'pa');
    expect(g?.approvedBy).toBe('first');
    expect(g?.approvedAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('getGoLiveForUpdate reads the row inside a transaction (null when there is none)', async () => {
    await requestGoLive(db, 'pa', 'pa-admin');
    const [a, b] = await db.transaction(async (tx) => [await getGoLiveForUpdate(tx, 'pa'), await getGoLiveForUpdate(tx, 'pb')]);
    expect(a?.requestedBy).toBe('pa-admin');
    expect(b).toBeNull();
  });

  it('latestTemplateAttestation: the newest partner.templates.attest row of THIS partner only', async () => {
    expect(await latestTemplateAttestation(db, 'pa')).toBeNull();
    const audit = createAuditRepo(db);
    const row = (partnerId: string, actor: string, action = 'partner.templates.attest') =>
      audit.record({ partnerId, actor, actorType: 'staff', action, subjectId: partnerId, meta: {} });
    await row('pb', 'pb-admin');
    await row('pa', 'pa-other', 'partner.theme.update');
    expect(await latestTemplateAttestation(db, 'pa')).toBeNull();
    await row('pa', 'pa-first');
    await row('pa', 'pa-second');
    const a = await latestTemplateAttestation(db, 'pa');
    expect(a?.actor).toBe('pa-second');
    expect(a?.at).toBeInstanceOf(Date);
  });
});
