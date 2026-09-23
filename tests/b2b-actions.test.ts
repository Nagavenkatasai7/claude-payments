import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createStore } from '@/lib/store';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { scopeOf } from '@/lib/staff-scope';
import type { Db } from '@/db/client';
import type { B2bInvoice, Staff } from '@/lib/types';

/**
 * Program-Fix 44 (P3, b2b-04): void and reissue resolve the invoice's OWNING
 * partner instead of a hardcoded default tenant. Platform staff act on any
 * tenant's bill; a partner-scoped ADMIN acts on its own tenant's bill only; a
 * cross-tenant id reads exactly like a missing one (404-never-403) and changes
 * nothing.
 */

const redis = fakeRedis();
let db: Db;
let store: ReturnType<typeof createStore>;
let currentStaff: Staff;

vi.mock('@/lib/auth', () => ({
  requireScope: async () => ({ staff: currentStaff, scope: scopeOf(currentStaff) }),
}));
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => store };
});
vi.mock('@/db/client', async () => {
  const actual = await vi.importActual<typeof import('@/db/client')>('@/db/client');
  return { ...actual, getDb: () => db };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { voidB2bInvoiceAction, reissueB2bInvoiceAction } from '@/app/admin-dashboard/b2b/actions';

function staff(over: Partial<Staff> = {}): Staff {
  return {
    username: 'plat',
    name: 'Plat',
    role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'x',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function invoice(over: Partial<B2bInvoice> & { id: string; partnerId: string }): B2bInvoice {
  return {
    businessName: 'Seller Co',
    buyerPhone: '15550001111',
    lineItems: [{ description: 'Widgets', qty: 1, unitAmountUsd: 100 }],
    amountUsd: 100,
    currency: 'USD',
    status: 'unpaid',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

async function auditRows(action: string, subjectId: string) {
  const rows = await createAuditRepo(db).listRecent(100);
  return rows.filter((r) => r.action === action && r.subjectId === subjectId);
}

beforeEach(async () => {
  redis.dump.clear();
  db = await freshDb();
  store = createStore(redis, db);
  await seedPartner(db, 'tenant_a');
  await seedPartner(db, 'tenant_b');
  currentStaff = staff();
});

describe('voidB2bInvoiceAction: tenant resolved from the invoice (Program-Fix 44)', () => {
  it('platform staff voids a NON-default tenant bill; the audit row names that tenant', async () => {
    await store.saveB2bInvoice(invoice({ id: 'inv_a', partnerId: 'tenant_a' }));
    await voidB2bInvoiceAction(form({ id: 'inv_a' }));
    expect((await store.getB2bInvoice('inv_a'))?.status).toBe('voided');
    const audit = await auditRows('b2b.invoice.void', 'inv_a');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ partnerId: 'tenant_a', actor: 'plat' });
  });

  it("a tenant's scoped admin voids its OWN tenant's bill", async () => {
    currentStaff = staff({ username: 'a_admin', partnerId: 'tenant_a' });
    await store.saveB2bInvoice(invoice({ id: 'inv_a', partnerId: 'tenant_a' }));
    await voidB2bInvoiceAction(form({ id: 'inv_a' }));
    expect((await store.getB2bInvoice('inv_a'))?.status).toBe('voided');
    expect(await auditRows('b2b.invoice.void', 'inv_a')).toHaveLength(1);
  });

  it('a cross-tenant attempt reads "Invoice not found." — the bill is unchanged and nothing is audited', async () => {
    currentStaff = staff({ username: 'b_admin', partnerId: 'tenant_b' });
    await store.saveB2bInvoice(invoice({ id: 'inv_a', partnerId: 'tenant_a' }));
    await expect(voidB2bInvoiceAction(form({ id: 'inv_a' }))).rejects.toThrow('Invoice not found.');
    expect((await store.getB2bInvoice('inv_a'))?.status).toBe('unpaid');
    expect(await auditRows('b2b.invoice.void', 'inv_a')).toHaveLength(0);
  });

  it('a cross-tenant attempt on a PAID bill never leaks its status (same message as missing)', async () => {
    currentStaff = staff({ username: 'b_admin', partnerId: 'tenant_b' });
    await store.saveB2bInvoice(invoice({ id: 'inv_paid', partnerId: 'tenant_a', status: 'paid' }));
    await expect(voidB2bInvoiceAction(form({ id: 'inv_paid' }))).rejects.toThrow('Invoice not found.');
    await expect(voidB2bInvoiceAction(form({ id: 'inv_missing' }))).rejects.toThrow('Invoice not found.');
  });

  it('a partner-scoped AGENT (not admin) is refused, even on its own tenant', async () => {
    currentStaff = staff({ username: 'a_agent', role: 'agent', partnerId: 'tenant_a' });
    await store.saveB2bInvoice(invoice({ id: 'inv_a', partnerId: 'tenant_a' }));
    await expect(voidB2bInvoiceAction(form({ id: 'inv_a' }))).rejects.toThrow(/Forbidden/);
    expect((await store.getB2bInvoice('inv_a'))?.status).toBe('unpaid');
  });

  it('control: an ineligible own-tenant bill still names its status', async () => {
    await store.saveB2bInvoice(invoice({ id: 'inv_a', partnerId: 'tenant_a', status: 'paid' }));
    await expect(voidB2bInvoiceAction(form({ id: 'inv_a' }))).rejects.toThrow(/Cannot void a paid invoice/);
  });
});

describe('reissueB2bInvoiceAction: tenant resolved from the invoice (Program-Fix 44)', () => {
  it('platform staff reissues a NON-default tenant voided bill; the clone stays on that tenant', async () => {
    await store.saveB2bInvoice(invoice({ id: 'inv_a', partnerId: 'tenant_a', status: 'voided' }));
    await reissueB2bInvoiceAction(form({ id: 'inv_a' }));
    const clone = await store.getB2bInvoice('reissue-inv_a');
    expect(clone).toMatchObject({ partnerId: 'tenant_a', status: 'unpaid' });
    const audit = await auditRows('b2b.invoice.reissue', 'inv_a');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ partnerId: 'tenant_a' });
  });

  it("a tenant's scoped admin reissues its OWN tenant's disputed bill", async () => {
    currentStaff = staff({ username: 'a_admin', partnerId: 'tenant_a' });
    await store.saveB2bInvoice(invoice({ id: 'inv_a', partnerId: 'tenant_a', status: 'disputed' }));
    await reissueB2bInvoiceAction(form({ id: 'inv_a' }));
    expect((await store.getB2bInvoice('reissue-inv_a'))?.partnerId).toBe('tenant_a');
  });

  it('a cross-tenant attempt reads "Invoice not found." and mints no clone', async () => {
    currentStaff = staff({ username: 'b_admin', partnerId: 'tenant_b' });
    await store.saveB2bInvoice(invoice({ id: 'inv_a', partnerId: 'tenant_a', status: 'voided' }));
    await expect(reissueB2bInvoiceAction(form({ id: 'inv_a' }))).rejects.toThrow('Invoice not found.');
    expect(await store.getB2bInvoice('reissue-inv_a')).toBeNull();
    expect(await auditRows('b2b.invoice.reissue', 'inv_a')).toHaveLength(0);
  });

  it('a partner-scoped AGENT is refused', async () => {
    currentStaff = staff({ username: 'a_agent', role: 'agent', partnerId: 'tenant_a' });
    await store.saveB2bInvoice(invoice({ id: 'inv_a', partnerId: 'tenant_a', status: 'voided' }));
    await expect(reissueB2bInvoiceAction(form({ id: 'inv_a' }))).rejects.toThrow(/Forbidden/);
    expect(await store.getB2bInvoice('reissue-inv_a')).toBeNull();
  });
});
