import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql as rawSql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import type { Partner } from '@/lib/types';

// Program-Fix 15 PR B — partners.support_config holds TWO staff-edited blocks:
// the support knobs (enableSupportPortal, autoAssign) and the Reg E
// `disclosure` block (the licensed partner's identity for the pay page and the
// receipt). Each save MERGES its own keys into the stored jsonb under a row
// lock; neither save may erase the other's keys, and both are audited.

let currentStaff: { username: string; role: 'admin' | 'agent' | 'support'; partnerId?: string };
vi.mock('@/lib/auth', () => ({
  requireAdmin: async () => currentStaff,
  requireStaff: async () => currentStaff,
  requirePlatformAdmin: async () => currentStaff,
}));

let db: Db;
let ps: import('@/lib/partner-store').PartnerStore;
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => ps };
});
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { saveSupportConfigAction, saveDisclosureConfigAction } from '@/app/admin-dashboard/partners/actions';
import { createPartnerStore } from '@/lib/partner-store';

const DISCLOSURE = {
  licensedEntity: 'Acme Money Services LLC',
  licenseIds: ['NMLS 000000'],
  phone: '+1 800 555 0100',
  website: 'https://acme.example',
  stateRegulator: { name: 'State Department of Financial Services', phone: '+1 800 555 0199', website: 'https://regulator.example' },
  deliveryEstimate: { businessDays: 2 },
};

function basePartner(over: Partial<Partner> = {}): Partner {
  return {
    id: 'p1', name: 'Acme', countries: ['US'], status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set('id', 'p1');
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

function disclosureForm(over: Record<string, string> = {}): FormData {
  return form({
    licensedEntity: 'Acme Money Services LLC',
    licenseIds: 'NMLS 000000',
    phone: '+1 800 555 0100',
    website: 'https://acme.example',
    regulatorName: 'State Department of Financial Services',
    regulatorPhone: '+1 800 555 0199',
    regulatorWebsite: 'https://regulator.example',
    deliveryBusinessDays: '2',
    ...over,
  });
}

async function auditRows() {
  const r = await db.execute(rawSql`SELECT partner_id, actor, action, subject_id, meta FROM audit_events ORDER BY id`);
  return r.rows as Array<{ partner_id: string; actor: string; action: string; subject_id: string; meta: Record<string, unknown> }>;
}

beforeEach(async () => {
  currentStaff = { username: 'admin', role: 'admin' };
  db = await freshDb();
  ps = createPartnerStore(db);
});
afterEach(() => vi.clearAllMocks());

describe('saveSupportConfigAction keeps the disclosure block (the clobber fix)', () => {
  it('a support save merges into support_config and never erases disclosure', async () => {
    await ps.savePartner(basePartner({ supportConfig: { enableSupportPortal: true, disclosure: DISCLOSURE } }));
    await saveSupportConfigAction(form({ autoAssign: 'round_robin' }));
    const got = await ps.getPartner('p1');
    expect(got?.supportConfig).toEqual({ enableSupportPortal: false, autoAssign: 'round_robin', disclosure: DISCLOSURE });
    expect(got?.name).toBe('Acme');
  });

  it('records ONE audit row with the old and new support values (no disclosure detail)', async () => {
    await ps.savePartner(basePartner({ supportConfig: { enableSupportPortal: true, autoAssign: 'none', disclosure: DISCLOSURE } }));
    await saveSupportConfigAction(form({ autoAssign: 'round_robin' }));
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: 'p1', actor: 'admin', action: 'partner.support_config', subject_id: 'p1' });
    expect(rows[0].meta).toEqual({
      old: { enableSupportPortal: true, autoAssign: 'none' },
      new: { enableSupportPortal: false, autoAssign: 'round_robin' },
    });
  });

  it("an out-of-scope partner is 'not found': no write, no audit row", async () => {
    await ps.savePartner(basePartner());
    await ps.savePartner(basePartner({ id: 'rival', name: 'Rival' }));
    currentStaff = { username: 'p1admin', role: 'admin', partnerId: 'p1' };
    await expect(saveSupportConfigAction(form({ id: 'rival', enableSupportPortal: 'on' }))).rejects.toThrow(/not found/i);
    expect((await ps.getPartner('rival'))?.supportConfig).toBeUndefined();
    expect(await auditRows()).toEqual([]);
  });
});

describe('saveDisclosureConfigAction (Reg E provider identity, draft)', () => {
  it('saves the disclosure block and keeps the support knobs', async () => {
    await ps.savePartner(basePartner({ supportConfig: { enableSupportPortal: false, autoAssign: 'round_robin' } }));
    await saveDisclosureConfigAction(disclosureForm());
    const got = await ps.getPartner('p1');
    expect(got?.supportConfig).toEqual({ enableSupportPortal: false, autoAssign: 'round_robin', disclosure: DISCLOSURE });
  });

  it('records ONE audit row with the old and new disclosure values', async () => {
    await ps.savePartner(basePartner());
    await saveDisclosureConfigAction(disclosureForm());
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: 'p1', actor: 'admin', action: 'partner.disclosure_config', subject_id: 'p1' });
    expect(rows[0].meta).toEqual({ old: null, new: DISCLOSURE });
  });

  it('splits licence ids on commas and new lines, dropping blanks', async () => {
    await ps.savePartner(basePartner());
    await saveDisclosureConfigAction(disclosureForm({ licenseIds: 'NMLS 1, CA DFPI 2\n\n TX 3 ' }));
    expect((await ps.getPartner('p1'))?.supportConfig?.disclosure?.licenseIds).toEqual(['NMLS 1', 'CA DFPI 2', 'TX 3']);
  });

  it('optional fields may be blank: they are omitted, never stored as empty strings', async () => {
    await ps.savePartner(basePartner());
    await saveDisclosureConfigAction(
      disclosureForm({ licenseIds: '', regulatorName: '', regulatorPhone: '', regulatorWebsite: '', deliveryBusinessDays: '' }),
    );
    expect((await ps.getPartner('p1'))?.supportConfig?.disclosure).toEqual({
      licensedEntity: 'Acme Money Services LLC',
      phone: '+1 800 555 0100',
      website: 'https://acme.example',
    });
  });

  it('an all-blank form clears the block', async () => {
    await ps.savePartner(basePartner({ supportConfig: { enableSupportPortal: true, disclosure: DISCLOSURE } }));
    await saveDisclosureConfigAction(
      form({ licensedEntity: '', licenseIds: '', phone: '', website: '', regulatorName: '', regulatorPhone: '', regulatorWebsite: '', deliveryBusinessDays: '' }),
    );
    expect((await ps.getPartner('p1'))?.supportConfig).toEqual({ enableSupportPortal: true });
  });

  it.each([
    ['a non-https website', { website: 'http://acme.example' }, /website/i],
    ['a javascript: website', { website: 'javascript:alert(1)' }, /website/i],
    ['a malformed regulator website', { regulatorWebsite: 'not a url' }, /website/i],
    ['a phone with letters', { phone: 'call us' }, /phone/i],
    ['a too-short phone', { phone: '12' }, /phone/i],
    ['a bad regulator phone', { regulatorPhone: '555-CALL' }, /phone/i],
    ['a negative delivery estimate', { deliveryBusinessDays: '-1' }, /business days/i],
    ['a fractional delivery estimate', { deliveryBusinessDays: '1.5' }, /business days/i],
    ['a delivery estimate over 10', { deliveryBusinessDays: '11' }, /business days/i],
    ['a regulator phone without its name', { regulatorName: '' }, /regulator/i],
    ['details without the licensed entity', { licensedEntity: '' }, /licensed entity/i],
  ])('refuses %s before any write', async (_label, over, msg) => {
    await ps.savePartner(basePartner({ supportConfig: { enableSupportPortal: true } }));
    await expect(saveDisclosureConfigAction(disclosureForm(over as Record<string, string>))).rejects.toThrow(msg);
    expect((await ps.getPartner('p1'))?.supportConfig).toEqual({ enableSupportPortal: true });
    expect(await auditRows()).toEqual([]);
  });

  it('bounds partner-written text (no line breaks, clamped length)', async () => {
    await ps.savePartner(basePartner());
    await saveDisclosureConfigAction(disclosureForm({ licensedEntity: `Acme\nMoney ${'x'.repeat(300)}` }));
    const entity = (await ps.getPartner('p1'))?.supportConfig?.disclosure?.licensedEntity ?? '';
    expect(entity).not.toContain('\n');
    expect([...entity].length).toBeLessThanOrEqual(120);
  });

  it("scope gate: a partner admin saves their OWN block; another tenant's is 'not found'", async () => {
    await ps.savePartner(basePartner());
    await ps.savePartner(basePartner({ id: 'rival', name: 'Rival' }));
    currentStaff = { username: 'p1admin', role: 'admin', partnerId: 'p1' };
    await saveDisclosureConfigAction(disclosureForm());
    expect((await ps.getPartner('p1'))?.supportConfig?.disclosure?.licensedEntity).toBe('Acme Money Services LLC');
    await expect(saveDisclosureConfigAction(disclosureForm({ id: 'rival' }))).rejects.toThrow(/not found/i);
    expect((await ps.getPartner('rival'))?.supportConfig).toBeUndefined();
  });

  it('the route-bound id is authoritative: an unknown id writes nothing', async () => {
    await expect(saveDisclosureConfigAction(disclosureForm({ id: 'ghost' }))).rejects.toThrow(/not found/i);
    expect(await auditRows()).toEqual([]);
  });
});
