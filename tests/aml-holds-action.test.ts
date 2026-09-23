import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerStore } from '@/lib/partner-store';
import { resolveCorridorRules, GLOBAL_DEFAULTS } from '@/lib/compliance-config';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Program-Fix 43 PR B: the per-partner × corridor AML hold switch.
//  - setAmlHoldsAction is a PUBLIC POST endpoint: platform admins only
//    (requirePlatformAdmin), the partner must exist, the default (demo) tenant
//    is refused, the corridor must be one the partner serves (never IN), `on`
//    is parsed strictly, and the change + its audit row commit together.
//  - partners.corridor_compliance has ONE writer on an existing row
//    (updateCorridorCompliance, FOR UPDATE, single column). savePartner's
//    full-row upsert from an unlocked read must never roll a toggle back.

let currentStaff: Staff | null;
let db: Db;

vi.mock('@/lib/auth', () => ({
  requirePlatformAdmin: async () => {
    if (!currentStaff) throw new Error('REDIRECT:/login');
    if (currentStaff.role !== 'admin' || currentStaff.partnerId !== undefined) throw new Error('REDIRECT:/admin-dashboard');
    return currentStaff;
  },
  requireScope: async () => {
    throw new Error('requireScope must not gate the hold switch');
  },
}));
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { setAmlHoldsAction } from '@/app/admin-dashboard/compliance/actions';

function staff(over: Partial<Staff> = {}): Staff {
  return {
    username: 'root', name: 'Root', role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'x', createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

async function stored(id: string): Promise<unknown> {
  const r = await db.execute(sql`SELECT corridor_compliance FROM partners WHERE id = ${id}`);
  return (r.rows[0] as { corridor_compliance: unknown } | undefined)?.corridor_compliance;
}

async function audits() {
  const r = await db.execute(sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events ORDER BY id`);
  return r.rows as Array<{ partner_id: string; actor: string; actor_type: string; action: string; subject_id: string; meta: Record<string, unknown> }>;
}

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
  currentStaff = staff();
});

describe('setAmlHoldsAction — gating', { retry: 0 }, () => {
  it('unauthenticated is refused before any write', async () => {
    currentStaff = null;
    await expect(setAmlHoldsAction(form({ partnerId: 'acme', country: 'US', on: 'on' }))).rejects.toThrow('REDIRECT:/login');
    expect(await stored('acme')).toBeNull();
    expect(await audits()).toEqual([]);
  });

  it('partner-scoped admins and agents are refused (platform admins only)', async () => {
    currentStaff = staff({ partnerId: 'acme' });
    await expect(setAmlHoldsAction(form({ partnerId: 'acme', country: 'US', on: 'on' }))).rejects.toThrow('REDIRECT');
    currentStaff = staff({ role: 'agent' });
    await expect(setAmlHoldsAction(form({ partnerId: 'acme', country: 'US', on: 'on' }))).rejects.toThrow('REDIRECT');
    expect(await stored('acme')).toBeNull();
    expect(await audits()).toEqual([]);
  });

  it('the default (demo) tenant can never be switched on', async () => {
    await expect(setAmlHoldsAction(form({ partnerId: 'default', country: 'US', on: 'on' }))).rejects.toThrow(/demo/i);
    expect(await stored('default')).toBeNull();
    expect(await audits()).toEqual([]);
  });

  it('an unknown partner is not found', async () => {
    await expect(setAmlHoldsAction(form({ partnerId: 'ghost', country: 'US', on: 'on' }))).rejects.toThrow('Partner not found');
    expect(await audits()).toEqual([]);
  });

  it('a corridor the partner does not serve, IN, or junk is refused', async () => {
    for (const country of ['GB', 'IN', 'us', '', 'US;DROP']) {
      await expect(setAmlHoldsAction(form({ partnerId: 'acme', country, on: 'on' }))).rejects.toThrow('Invalid corridor');
    }
    expect(await stored('acme')).toBeNull();
    expect(await audits()).toEqual([]);
  });

  it('`on` is parsed strictly', async () => {
    for (const on of ['true', '1', 'yes', '']) {
      await expect(setAmlHoldsAction(form({ partnerId: 'acme', country: 'US', on }))).rejects.toThrow('Invalid setting');
    }
    expect(await audits()).toEqual([]);
  });
});

describe('setAmlHoldsAction — the write', { retry: 0 }, () => {
  it('ON writes amlHolds:true for that corridor and ONE audit row in the partner\'s tenant', async () => {
    await setAmlHoldsAction(form({ partnerId: 'acme', country: 'US', on: 'on' }));
    expect(await stored('acme')).toEqual({ US: { amlHolds: true } });
    const partner = await createPartnerStore(db).getPartner('acme');
    expect(resolveCorridorRules(partner, 'US').amlHolds).toBe(true);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      partner_id: 'acme', actor: 'root', actor_type: 'staff', action: 'aml.holds_set', subject_id: 'acme',
      meta: { country: 'US', from: false, to: true },
    });
  });

  it('OFF removes the key; an emptied corridor entry is dropped so the defaults fast path returns', async () => {
    await setAmlHoldsAction(form({ partnerId: 'acme', country: 'US', on: 'on' }));
    await setAmlHoldsAction(form({ partnerId: 'acme', country: 'US', on: 'off' }));
    expect(await stored('acme')).toEqual({});
    const partner = await createPartnerStore(db).getPartner('acme');
    expect(resolveCorridorRules(partner, 'US')).toBe(GLOBAL_DEFAULTS);
    expect((await audits()).map((r) => r.meta)).toEqual([
      { country: 'US', from: false, to: true },
      { country: 'US', from: true, to: false },
    ]);
  });

  it('other corridor settings are preserved across a toggle', async () => {
    await db.execute(sql`UPDATE partners SET corridor_compliance = '{"US":{"largeAmountUsd":5000,"watchlistExtra":["x y"]}}'::jsonb WHERE id = 'acme'`);
    await setAmlHoldsAction(form({ partnerId: 'acme', country: 'US', on: 'on' }));
    expect(await stored('acme')).toEqual({ US: { largeAmountUsd: 5000, watchlistExtra: ['x y'], amlHolds: true } });
    await setAmlHoldsAction(form({ partnerId: 'acme', country: 'US', on: 'off' }));
    expect(await stored('acme')).toEqual({ US: { largeAmountUsd: 5000, watchlistExtra: ['x y'] } });
  });
});

describe('partners.corridor_compliance single writer', { retry: 0 }, () => {
  it('savePartner from a stale read never rolls back a committed toggle', async () => {
    const ps = createPartnerStore(db);
    const stale = (await ps.getPartner('acme'))!;
    await setAmlHoldsAction(form({ partnerId: 'acme', country: 'US', on: 'on' }));
    await ps.savePartner({ ...stale, brandName: 'Acme Brand', updatedAt: new Date().toISOString() });
    expect(await stored('acme')).toEqual({ US: { amlHolds: true } });
    expect((await ps.getPartner('acme'))?.brandName).toBe('Acme Brand');
  });

  it('savePartner still writes corridor_compliance on INSERT (a new partner)', async () => {
    const ps = createPartnerStore(db);
    await ps.savePartner({
      id: 'newco', name: 'New Co', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      corridorCompliance: { US: { largeAmountUsd: 5000 } },
    });
    expect(await stored('newco')).toEqual({ US: { largeAmountUsd: 5000 } });
  });

  it('updateCorridorCompliance on an unknown id writes nothing', async () => {
    const r = await createPartnerStore(db).updateCorridorCompliance('ghost', (prev) => ({ ...prev, US: { amlHolds: true } }));
    expect(r.found).toBe(false);
  });
});
