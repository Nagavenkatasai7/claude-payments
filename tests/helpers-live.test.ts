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

// Fix pack 4 T6 (C24): an approved provider block for fixtures, written without certifying.
describe('approvedDisclosureConfig / approveDisclosureForTest (pack 4)', () => {
  it('approvedDisclosureConfig(): resolvePartnerDisclosure sees configured and partnerApproved', async () => {
    const { approvedDisclosureConfig } = await import('./helpers-live');
    const { resolvePartnerDisclosure } = await import('@/lib/partner-config');
    const cfg = approvedDisclosureConfig();
    const d = resolvePartnerDisclosure({ id: pid('acme'), supportConfig: { disclosure: cfg } });
    expect(d.configured).toBe(true);
    expect(d.partnerApproved).toBe(true);
    expect(d.licenseIds.length).toBeGreaterThanOrEqual(1);
    expect(d.phone).not.toBeNull();
    expect(d.website).not.toBeNull();
    expect(d.stateRegulator?.name).toBeTruthy();
    expect(d.deliveryBusinessDays).toBe(1);
    expect(cfg.approval?.by).toBe('test-partner-admin');
    const at = Date.parse(cfg.approval?.at ?? '');
    expect(Date.now() - at).toBeGreaterThan(0);
    expect(Date.now() - at).toBeLessThan(5 * 60_000);
  });

  it('entity / regulator overrides', async () => {
    const { approvedDisclosureConfig } = await import('./helpers-live');
    const { resolvePartnerDisclosure } = await import('@/lib/partner-config');
    const cfg = approvedDisclosureConfig({ entity: 'Other Remit LLC', regulator: 'Other Regulator' });
    const d = resolvePartnerDisclosure({ id: pid('acme'), supportConfig: { disclosure: cfg } });
    expect(d.licensedEntity).toBe('Other Remit LLC');
    expect(d.stateRegulator?.name).toBe('Other Regulator');
    expect(d.partnerApproved).toBe(true);
  });

  it('certifyPartnerForTest(db, id, { approvedDisclosure: true }) writes support_config.disclosure and keeps other support keys', async () => {
    const { resolvePartnerDisclosure } = await import('@/lib/partner-config');
    await createPartnerRepo(db).updateSupportConfig(pid('acme'), (prev) => ({ ...prev, alertEmail: 'ops@acme.example' }));
    await certifyPartnerForTest(db, pid('acme'), { approvedDisclosure: true });
    const p = await createPartnerRepo(db).getPartner(pid('acme'));
    expect(isLiveCertified(p)).toBe(true);
    expect(p?.supportConfig?.alertEmail).toBe('ops@acme.example');
    expect(resolvePartnerDisclosure(p).partnerApproved).toBe(true);
  });

  it('approveDisclosureForTest writes the block without certifying; throws on an unknown partner', async () => {
    const { approveDisclosureForTest } = await import('./helpers-live');
    const { resolvePartnerDisclosure } = await import('@/lib/partner-config');
    await approveDisclosureForTest(db, pid('acme'));
    const p = await createPartnerRepo(db).getPartner(pid('acme'));
    expect(isLiveCertified(p)).toBe(false);
    expect(resolvePartnerDisclosure(p).partnerApproved).toBe(true);
    await expect(approveDisclosureForTest(db, pid('ghost'))).rejects.toThrow();
  });

  it('without the option support_config is untouched', async () => {
    await certifyPartnerForTest(db, pid('acme'));
    const p = await createPartnerRepo(db).getPartner(pid('acme'));
    expect(p?.supportConfig).toBeUndefined();
  });
});
