import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { createCustomerRepo, readEsignConsent, recordEsignConsent } from '@/db/repos/customer-repo';
import { auditSubjectId } from '@/lib/customer-ref';
import { esignConsentNeeded } from '@/lib/esign';
import { ESIGN_CONSENT_VERSION } from '@/lib/legal/esign-consent';
import { esignConsentView, recordStaffEsignWithdrawal } from '@/lib/esign-staff-withdraw';
import { freshDb, seedPartner } from './helpers-db';
import { seedEsignConsentForTest } from './helpers-esign';

// Fix pack 6 truth check TC-T1: the provider route of the E-SIGN consent text ("contact the
// provider named on your receipt") is recorded by staff. ONE transaction: the withdrawal and one
// `customer.consent.esign` audit row { version, on: false, via: 'staff', actorScope }. Phones are
// invented placeholders; dates are relative to now.

const PHONE = '15551230711';
const OTHER = 'esign-staff-other';
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

type AuditRow = { partner_id: string | null; actor: string; actor_type: string; action: string; subject_id: string | null; meta: Record<string, unknown> };
async function esignAudits(db: Db): Promise<AuditRow[]> {
  const r = await db.execute(
    sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events WHERE action = 'customer.consent.esign' ORDER BY id`,
  );
  return (r as unknown as { rows: AuditRow[] }).rows;
}

describe('recordStaffEsignWithdrawal (TC-T1)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, OTHER);
  });

  it('withdraws the consent and writes ONE audit row with exactly version, on, via and actorScope (no phone, no name)', async () => {
    await seedEsignConsentForTest(db, 'default', PHONE);
    const r = await recordStaffEsignWithdrawal(db, { partnerId: 'default', phone: PHONE, actor: 'ops-1', actorScope: 'platform' });
    expect(r).toEqual({ withdrawn: true, version: ESIGN_CONSENT_VERSION });
    const state = await readEsignConsent(db, 'default', PHONE);
    expect(state?.withdrawnAt).not.toBeNull();
    expect(esignConsentNeeded(state)).toBe(true);
    const rows = await esignAudits(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      partner_id: 'default',
      actor: 'ops-1',
      actor_type: 'staff',
      action: 'customer.consent.esign',
      subject_id: auditSubjectId('default', PHONE),
      meta: { version: ESIGN_CONSENT_VERSION, on: false, via: 'staff', actorScope: 'platform' },
    });
    expect(JSON.stringify(rows[0])).not.toContain(PHONE);
  });

  it('a partner actor records actorScope partner', async () => {
    await seedEsignConsentForTest(db, OTHER, PHONE);
    await recordStaffEsignWithdrawal(db, { partnerId: OTHER, phone: PHONE, actor: 'pa-agent', actorScope: 'partner' });
    expect((await esignAudits(db))[0].meta).toEqual({ version: ESIGN_CONSENT_VERSION, on: false, via: 'staff', actorScope: 'partner' });
  });

  it('a second call writes nothing (no audit row) and returns withdrawn false', async () => {
    await seedEsignConsentForTest(db, 'default', PHONE);
    await recordStaffEsignWithdrawal(db, { partnerId: 'default', phone: PHONE, actor: 'ops-1', actorScope: 'platform' });
    const before = await readEsignConsent(db, 'default', PHONE);
    expect(await recordStaffEsignWithdrawal(db, { partnerId: 'default', phone: PHONE, actor: 'ops-1', actorScope: 'platform' })).toEqual({ withdrawn: false });
    expect(await readEsignConsent(db, 'default', PHONE)).toEqual(before);
    expect(await esignAudits(db)).toHaveLength(1);
  });

  it('nothing on file (no row, or a row never consented): no write, no audit row', async () => {
    expect(await recordStaffEsignWithdrawal(db, { partnerId: 'default', phone: PHONE, actor: 'ops-1', actorScope: 'platform' })).toEqual({ withdrawn: false });
    await createCustomerRepo(db, async () => null).ensureCustomer('default', PHONE);
    expect(await recordStaffEsignWithdrawal(db, { partnerId: 'default', phone: PHONE, actor: 'ops-1', actorScope: 'platform' })).toEqual({ withdrawn: false });
    expect(await readEsignConsent(db, 'default', PHONE)).toEqual({ version: null, consentedAt: null, withdrawnAt: null });
    expect(await esignAudits(db)).toHaveLength(0);
  });

  it('a customer of ANOTHER tenant with the same phone is untouched', async () => {
    await seedEsignConsentForTest(db, 'default', PHONE);
    await seedEsignConsentForTest(db, OTHER, PHONE);
    const otherBefore = await readEsignConsent(db, OTHER, PHONE);
    await recordStaffEsignWithdrawal(db, { partnerId: 'default', phone: PHONE, actor: 'ops-1', actorScope: 'platform' });
    expect(await readEsignConsent(db, OTHER, PHONE)).toEqual(otherBefore);
    expect(esignConsentNeeded(await readEsignConsent(db, OTHER, PHONE))).toBe(false);
    const rows = await esignAudits(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].partner_id).toBe('default');
  });

  it('the withdrawal and the audit row commit together: an audit failure rolls the withdrawal back', async () => {
    await seedEsignConsentForTest(db, 'default', PHONE);
    // freshDb() shares one PGlite instance: the constraint is dropped again before the test ends.
    await db.execute(sql`ALTER TABLE audit_events ADD CONSTRAINT esign_staff_block CHECK (action <> 'customer.consent.esign')`);
    try {
      await expect(
        recordStaffEsignWithdrawal(db, { partnerId: 'default', phone: PHONE, actor: 'ops-1', actorScope: 'platform' }),
      ).rejects.toThrow();
    } finally {
      await db.execute(sql`ALTER TABLE audit_events DROP CONSTRAINT esign_staff_block`);
    }
    const state = await readEsignConsent(db, 'default', PHONE);
    expect(state?.withdrawnAt).toBeNull();
    expect(esignConsentNeeded(state)).toBe(false);
  });

  it('a later consent clears the withdrawal, so the customer is asked exactly once', async () => {
    await seedEsignConsentForTest(db, 'default', PHONE);
    await recordStaffEsignWithdrawal(db, { partnerId: 'default', phone: PHONE, actor: 'ops-1', actorScope: 'platform' });
    expect(esignConsentNeeded(await readEsignConsent(db, 'default', PHONE))).toBe(true);
    expect(await recordEsignConsent(db, 'default', PHONE, ESIGN_CONSENT_VERSION, new Date(Date.now() + 1_000))).toBe(true);
    expect(esignConsentNeeded(await readEsignConsent(db, 'default', PHONE))).toBe(false);
  });
});

describe('esignConsentView (TC-T1)', () => {
  const V = ESIGN_CONSENT_VERSION;
  it('none: no row, or nothing consented', () => {
    expect(esignConsentView(null, V)).toEqual({ state: 'none' });
    expect(esignConsentView({ version: null, consentedAt: null, withdrawnAt: null }, V)).toEqual({ state: 'none' });
  });
  it('on: the current version, not withdrawn', () => {
    const at = minutesAgo(5);
    expect(esignConsentView({ version: V, consentedAt: at, withdrawnAt: null }, V)).toEqual({ state: 'on', version: V, consentedAt: at, current: true });
  });
  it('on: a withdrawal OLDER than the consent (a re-consent) is not a withdrawal', () => {
    const at = minutesAgo(5);
    const v = esignConsentView({ version: V, consentedAt: at, withdrawnAt: minutesAgo(10) }, V);
    expect(v.state).toBe('on');
  });
  it('withdrawn: a withdrawal after the consent', () => {
    const at = minutesAgo(5);
    const w = minutesAgo(1);
    expect(esignConsentView({ version: V, consentedAt: at, withdrawnAt: w }, V)).toEqual({
      state: 'withdrawn',
      version: V,
      consentedAt: at,
      withdrawnAt: w,
      current: true,
    });
  });
  it('withdrawn: a withdrawal at the same instant as the consent (the esignConsentNeeded rule)', () => {
    const at = minutesAgo(5);
    expect(esignConsentView({ version: V, consentedAt: at, withdrawnAt: new Date(at.getTime()) }, V).state).toBe('withdrawn');
    expect(esignConsentNeeded({ version: V, consentedAt: at, withdrawnAt: new Date(at.getTime()) })).toBe(true);
  });
  it('an older text version is still shown as on file, with its version', () => {
    const at = minutesAgo(5);
    expect(esignConsentView({ version: 'esign-older', consentedAt: at, withdrawnAt: null }, V)).toEqual({
      state: 'on',
      version: 'esign-older',
      consentedAt: at,
      current: false,
    });
  });
});
