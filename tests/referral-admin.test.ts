import { describe, it, expect, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditEvents } from '@/db/schema';
import { freshDb, seedLedgerSpend } from './helpers-db';
import { createReferralRepo } from '@/db/repos/referral-repo';
import {
  addReferralCode,
  buildReferralStatement,
  createReferralPartner,
  isReferralAdminError,
  REFERRAL_ADMIN_ERRORS,
  ReferralAdminError,
  setReferralCodeActive,
  setReferralPlumUrl,
  updateReferralPartner,
} from '@/lib/referral-admin';

// Batch B4: the admin service behind /admin-dashboard/referrals. Platform admins only; every
// write is validated and audited in the same transaction; error codes are a fixed allowlist.

const ADMIN = { username: 'raj', role: 'admin' as const, partnerId: undefined };
const PARTNER_ADMIN = { username: 'acme-admin', role: 'admin' as const, partnerId: 'acme' };
const AGENT = { username: 'ann', role: 'agent' as const, partnerId: undefined };

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

const audits = async (action: string) => db.select().from(auditEvents).where(eq(auditEvents.action, action));
const code = (e: unknown) => (e instanceof ReferralAdminError ? e.code : `not-a-referral-error: ${String(e)}`);
async function failsWith(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return code(e);
  }
  return 'resolved';
}

describe('createReferralPartner', () => {
  it('creates the partner with a generated code and one audit row', async () => {
    const r = await createReferralPartner(ADMIN, { name: ' TANA ', contact: 'events@tana.org', commissionUsd: '1.50' }, db);
    expect(r.id).toMatch(/^rp_[A-Za-z0-9_-]{12}$/);
    expect(r.code).toMatch(/^REF-[A-HJ-NP-Z2-9]{6}$/);
    const list = await createReferralRepo(db).listPartnersWithCodes();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: r.id, name: 'TANA', contact: 'events@tana.org', commissionCents: 150, status: 'active' });
    expect(list[0].codes.map((c) => c.code)).toEqual([r.code]);
    const rows = await audits('referral.partner_create');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'raj', actorType: 'staff', subjectId: r.id, partnerId: null });
    expect(rows[0].meta).toEqual({ commissionCents: 150, code: r.code });
  });

  it('commission defaults to 0; bad fields are refused with a fixed code and nothing is written', async () => {
    const r = await createReferralPartner(ADMIN, { name: 'Travel Desk', contact: '', commissionUsd: '' }, db);
    expect((await createReferralRepo(db).getPartner(r.id))?.commissionCents).toBe(0);
    expect(await failsWith(createReferralPartner(ADMIN, { name: '', contact: '', commissionUsd: '1' }, db))).toBe('name');
    expect(await failsWith(createReferralPartner(ADMIN, { name: 'A<b>', contact: '', commissionUsd: '1' }, db))).toBe('name');
    expect(await failsWith(createReferralPartner(ADMIN, { name: 'Ok', contact: 'x'.repeat(161), commissionUsd: '1' }, db))).toBe('contact');
    expect(await failsWith(createReferralPartner(ADMIN, { name: 'Ok', contact: '', commissionUsd: '-1' }, db))).toBe('commission');
    expect(await failsWith(createReferralPartner(ADMIN, { name: 'Ok', contact: '', commissionUsd: '1000.01' }, db))).toBe('commission');
    expect(await createReferralRepo(db).listPartnersWithCodes()).toHaveLength(1);
    expect(await audits('referral.partner_create')).toHaveLength(1);
  });

  it('only a platform admin: partner-scoped admins and agents are refused before any write', async () => {
    expect(await failsWith(createReferralPartner(PARTNER_ADMIN, { name: 'X', contact: '', commissionUsd: '1' }, db))).toBe('forbidden');
    expect(await failsWith(createReferralPartner(AGENT, { name: 'X', contact: '', commissionUsd: '1' }, db))).toBe('forbidden');
    expect(await createReferralRepo(db).listPartnersWithCodes()).toEqual([]);
  });
});

describe('updateReferralPartner', () => {
  it('changes name, contact, commission and status, audited with the previous values', async () => {
    const { id } = await createReferralPartner(ADMIN, { name: 'TANA', contact: '', commissionUsd: '1' }, db);
    await updateReferralPartner(ADMIN, id, { name: 'TANA DC', contact: 'dc@tana.org', commissionUsd: '2', status: 'inactive' }, db);
    expect(await createReferralRepo(db).getPartner(id)).toMatchObject({ name: 'TANA DC', contact: 'dc@tana.org', commissionCents: 200, status: 'inactive' });
    const rows = await audits('referral.partner_update');
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({ commissionCents: 200, previousCommissionCents: 100, status: 'inactive', previousStatus: 'active' });
  });

  it('unknown id → not_found; a bad status → status; a non-admin → forbidden', async () => {
    const { id } = await createReferralPartner(ADMIN, { name: 'TANA', contact: '', commissionUsd: '1' }, db);
    const ok = { name: 'TANA', contact: '', commissionUsd: '1', status: 'active' };
    expect(await failsWith(updateReferralPartner(ADMIN, 'rp_nope', ok, db))).toBe('not_found');
    expect(await failsWith(updateReferralPartner(ADMIN, id, { ...ok, status: 'deleted' }, db))).toBe('status');
    expect(await failsWith(updateReferralPartner(PARTNER_ADMIN, id, ok, db))).toBe('forbidden');
    expect(await audits('referral.partner_update')).toHaveLength(0);
  });
});

describe('referral codes', () => {
  it('adds a generated code, or a vanity code (normalized); a taken or malformed code is refused', async () => {
    const a = await createReferralPartner(ADMIN, { name: 'A', contact: '', commissionUsd: '1' }, db);
    const b = await createReferralPartner(ADMIN, { name: 'B', contact: '', commissionUsd: '1' }, db);
    const generated = await addReferralCode(ADMIN, a.id, '', db);
    expect(generated).toMatch(/^REF-[A-HJ-NP-Z2-9]{6}$/);
    expect(await addReferralCode(ADMIN, a.id, ' ref-tana01 ', db)).toBe('REF-TANA01');
    expect(await failsWith(addReferralCode(ADMIN, b.id, 'REF-TANA01', db))).toBe('code_taken');
    expect(await failsWith(addReferralCode(ADMIN, b.id, 'TANA01', db))).toBe('code_format');
    expect(await failsWith(addReferralCode(ADMIN, 'rp_nope', '', db))).toBe('not_found');
    const codes = (await createReferralRepo(db).listPartnersWithCodes()).find((p) => p.id === a.id)!.codes.map((c) => c.code);
    expect(codes).toEqual([a.code, generated, 'REF-TANA01']);
    expect((await audits('referral.code_add')).map((r) => r.subjectId)).toEqual([generated, 'REF-TANA01']);
  });

  it('a code can be turned off and on again, audited; an unknown code → not_found', async () => {
    const a = await createReferralPartner(ADMIN, { name: 'A', contact: '', commissionUsd: '1' }, db);
    await setReferralCodeActive(ADMIN, a.code, 'off', db);
    expect((await createReferralRepo(db).getCode(a.code))?.active).toBe(false);
    await setReferralCodeActive(ADMIN, a.code, 'on', db);
    expect((await createReferralRepo(db).getCode(a.code))?.active).toBe(true);
    expect(await failsWith(setReferralCodeActive(ADMIN, 'REF-NOPE00', 'off', db))).toBe('not_found');
    expect((await audits('referral.code_update')).map((r) => r.meta)).toEqual([{ active: false }, { active: true }]);
  });
});

describe('setReferralPlumUrl', () => {
  it('https only; empty clears; audited with the host, never the full address', async () => {
    await setReferralPlumUrl(ADMIN, 'https://rewards.example.com/smartremit?token=abc', db);
    expect(await createReferralRepo(db).getPlumPortalUrl()).toBe('https://rewards.example.com/smartremit?token=abc');
    expect(await failsWith(setReferralPlumUrl(ADMIN, 'http://rewards.example.com', db))).toBe('url');
    expect(await failsWith(setReferralPlumUrl(ADMIN, 'javascript:alert(1)', db))).toBe('url');
    await setReferralPlumUrl(ADMIN, '', db);
    expect(await createReferralRepo(db).getPlumPortalUrl()).toBeNull();
    const rows = await audits('referral.settings_update');
    expect(rows.map((r) => r.meta)).toEqual([{ plumPortalHost: 'rewards.example.com' }, { plumPortalHost: null }]);
    expect(await failsWith(setReferralPlumUrl(PARTNER_ADMIN, '', db))).toBe('forbidden');
  });
});

describe('buildReferralStatement', () => {
  it('the month, one line per referral partner and the total; defaults to the current UTC month', async () => {
    const a = await createReferralPartner(ADMIN, { name: 'A', contact: 'a@x.org', commissionUsd: '1.25' }, db);
    await createReferralPartner(ADMIN, { name: 'B', contact: '', commissionUsd: '0' }, db);
    await createReferralRepo(db).recordAttribution({ partnerId: 'default', phone: '15550001111', code: a.code, channel: 'whatsapp' });
    for (const id of ['t1', 't2']) {
      await seedLedgerSpend(db, { partnerId: 'default', phone: '15550001111', amountUsd: 50, status: 'delivered', id });
      await db.execute(sql`UPDATE transfers SET delivered_at = '2026-09-10T12:00:00Z' WHERE id = ${id}`);
    }
    const s = await buildReferralStatement(db, '2026-09', new Date('2026-10-08T00:00:00Z'));
    expect(s.month).toBe('2026-09');
    expect(s.lines.map((l) => [l.name, l.deliveredCount, l.commissionCents])).toEqual([['A', 2, 125], ['B', 0, 0]]);
    expect(s.totalCents).toBe(250);
    expect((await buildReferralStatement(db, 'garbage', new Date('2026-10-08T00:00:00Z'))).month).toBe('2026-10');
  });
});

describe('error codes', () => {
  it('every code has fixed text; anything else is not a referral error', () => {
    for (const c of Object.keys(REFERRAL_ADMIN_ERRORS)) expect(isReferralAdminError(c)).toBe(true);
    expect(isReferralAdminError('<script>')).toBe(false);
    expect(isReferralAdminError(undefined)).toBe(false);
  });
});

