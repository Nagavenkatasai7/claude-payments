import { describe, it, expect, beforeEach } from 'vitest';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { capabilityOpen, isLiveCertified } from '@/lib/live-gate';
import { LIVE_CAPABILITIES, parseLiveControls, postureSigned } from '@/lib/live-controls';
import type { Db } from '@/db/client';
import type { PartnerId } from '@/lib/types';
import { freshDb, seedPartner } from './helpers-db';
import { certifiedLiveControls, certifyPartnerForTest } from './helpers-live';

// Fix pack 3 T1 (contract 16): the fixture helper every later gate's tests use.

const pid = (s: string) => s as PartnerId;

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
});

describe('certifyPartnerForTest', () => {
  it('certifyPartnerForTest -> isLiveCertified(getPartner) true', async () => {
    const before = await createPartnerRepo(db).getPartner(pid('acme'));
    expect(isLiveCertified(before)).toBe(false);
    await certifyPartnerForTest(db, pid('acme'));
    const p = await createPartnerRepo(db).getPartner(pid('acme'));
    expect(isLiveCertified(p)).toBe(true);
    expect(p?.liveControls?.contract).toBeDefined();
  });

  it('every capability open by default', async () => {
    await certifyPartnerForTest(db, pid('acme'));
    const p = await createPartnerRepo(db).getPartner(pid('acme'));
    for (const cap of LIVE_CAPABILITIES) expect(capabilityOpen(p, cap)).toBe(true);
  });

  it("optIns ['b2b'] opens only b2b", async () => {
    await certifyPartnerForTest(db, pid('acme'), { optIns: ['b2b'] });
    const p = await createPartnerRepo(db).getPartner(pid('acme'));
    for (const cap of LIVE_CAPABILITIES) expect(capabilityOpen(p, cap)).toBe(cap === 'b2b');
  });

  it('posture only with posture: true', async () => {
    await certifyPartnerForTest(db, pid('acme'));
    expect(postureSigned((await createPartnerRepo(db).getPartner(pid('acme')))?.liveControls)).toBe(false);
    await certifyPartnerForTest(db, pid('acme'), { posture: true, complianceUsers: ['acme-admin'] });
    const p = await createPartnerRepo(db).getPartner(pid('acme'));
    expect(postureSigned(p?.liveControls)).toBe(true);
    expect(p?.liveControls?.complianceUsers).toEqual(['acme-admin']);
  });

  it('throws on an unknown partner (seedPartner first)', async () => {
    await expect(certifyPartnerForTest(db, pid('ghost'))).rejects.toThrow();
  });

  it('certifiedLiveControls survives the parser unchanged (a valid record)', () => {
    const lc = certifiedLiveControls({ posture: true, complianceUsers: ['a', 'b'] });
    expect(parseLiveControls(JSON.parse(JSON.stringify(lc)))).toEqual(lc);
    expect(isLiveCertified({ id: pid('acme'), status: 'active', liveControls: lc })).toBe(true);
  });
});
