import { describe, it, expect, vi, beforeEach } from 'vitest';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import type { B2bInvoice } from '@/lib/types';

// Lost-features A6: the ONE invoice lifecycle core behind both dashboards. Each op re-reads the
// bill inside the GIVEN tenant, makes the guarded repo write and records the audit row in ONE
// transaction: a failed audit insert leaves the bill unchanged.
const audit = vi.hoisted(() => ({ fail: false }));
vi.mock('@/db/repos/aux-repos', async () => {
  const actual = await vi.importActual<typeof import('@/db/repos/aux-repos')>('@/db/repos/aux-repos');
  return {
    ...actual,
    createAuditRepo: (db: Parameters<typeof actual.createAuditRepo>[0]) => {
      const repo = actual.createAuditRepo(db);
      return {
        ...repo,
        record: async (...args: Parameters<typeof repo.record>) => {
          if (audit.fail) throw new Error('audit insert failed');
          return repo.record(...args);
        },
      };
    },
  };
});

import { createAuditRepo, createB2bInvoiceRepo } from '@/db/repos/aux-repos';
import { reissueTenantInvoice, voidTenantInvoice } from '@/lib/b2b-invoice-ops';

let db: Db;
const inv = (o: Partial<B2bInvoice> & { id: string; partnerId: string }): B2bInvoice => ({
  businessName: 'Seller Co',
  buyerPhone: '15550001111',
  lineItems: [{ description: 'Widgets', qty: 1, unitAmountUsd: 100 }],
  amountUsd: 100,
  currency: 'USD',
  status: 'unpaid',
  createdAt: new Date().toISOString(),
  ...o,
});
const status = async (id: string) => (await createB2bInvoiceRepo(db).getInvoice(id))?.status ?? null;
const audits = async () => (await createAuditRepo(db).listRecent(100)).filter((r) => r.action.startsWith('b2b.invoice.'));
const actor = { actor: 'pa-admin', actorScope: 'partner' as const };

beforeEach(async () => {
  audit.fail = false;
  db = await freshDb();
  await seedPartner(db, 'pa');
  await seedPartner(db, 'pb');
  const repo = createB2bInvoiceRepo(db);
  await repo.saveInvoice(inv({ id: 'inv_a', partnerId: 'pa' }));
  await repo.saveInvoice(inv({ id: 'inv_paid', partnerId: 'pa', status: 'paid', paidAt: new Date().toISOString() }));
  await repo.saveInvoice(inv({ id: 'inv_dead', partnerId: 'pa', status: 'voided' }));
  await repo.saveInvoice(inv({ id: 'inv_b', partnerId: 'pb' }));
});

describe('voidTenantInvoice', () => {
  it('voids an unpaid bill and writes ONE audit row in the same transaction', async () => {
    const r = await voidTenantInvoice(db, { partnerId: 'pa', id: 'inv_a', ...actor });
    expect(r).toMatchObject({ ok: true, invoice: { id: 'inv_a', status: 'voided' } });
    expect(await status('inv_a')).toBe('voided');
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', actorType: 'staff', action: 'b2b.invoice.void', subjectId: 'inv_a' });
    expect(rows[0].meta).toEqual({ actorScope: 'partner' });
  });
  it('a failed audit insert rolls the void back', async () => {
    audit.fail = true;
    await expect(voidTenantInvoice(db, { partnerId: 'pa', id: 'inv_a', ...actor })).rejects.toThrow('audit insert failed');
    expect(await status('inv_a')).toBe('unpaid');
  });
  it('a paid or already-voided bill is not_allowed; nothing is written', async () => {
    expect(await voidTenantInvoice(db, { partnerId: 'pa', id: 'inv_paid', ...actor })).toEqual({ ok: false, reason: 'not_allowed' });
    expect(await voidTenantInvoice(db, { partnerId: 'pa', id: 'inv_dead', ...actor })).toEqual({ ok: false, reason: 'not_allowed' });
    expect(await status('inv_paid')).toBe('paid');
    expect(await audits()).toHaveLength(0);
  });
  it("another tenant's bill is not_found, exactly like a missing one; it stays unpaid", async () => {
    expect(await voidTenantInvoice(db, { partnerId: 'pa', id: 'inv_b', ...actor })).toEqual({ ok: false, reason: 'not_found' });
    expect(await voidTenantInvoice(db, { partnerId: 'pa', id: 'inv_missing', ...actor })).toEqual({ ok: false, reason: 'not_found' });
    expect(await status('inv_b')).toBe('unpaid');
    expect(await audits()).toHaveLength(0);
  });
  it('refuses an empty tenant', async () => {
    await expect(voidTenantInvoice(db, { partnerId: '', id: 'inv_a', ...actor })).rejects.toThrow();
    expect(await status('inv_a')).toBe('unpaid');
  });
});

describe('reissueTenantInvoice', () => {
  it('mints ONE unpaid clone under the derived id, audited with reissuedAs; a repeat writes nothing more', async () => {
    const first = await reissueTenantInvoice(db, { partnerId: 'pa', id: 'inv_dead', ...actor });
    expect(first).toMatchObject({ ok: true, invoice: { id: 'reissue-inv_dead', partnerId: 'pa', status: 'unpaid' } });
    const again = await reissueTenantInvoice(db, { partnerId: 'pa', id: 'inv_dead', ...actor });
    expect(again).toMatchObject({ ok: true, invoice: { id: 'reissue-inv_dead' } });
    expect((await createB2bInvoiceRepo(db).listInvoices('pa')).filter((i) => i.id.startsWith('reissue-'))).toHaveLength(1);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', action: 'b2b.invoice.reissue', subjectId: 'inv_dead' });
    expect(rows[0].meta).toEqual({ actorScope: 'partner', reissuedAs: 'reissue-inv_dead' });
  });
  it('a failed audit insert rolls the clone back', async () => {
    audit.fail = true;
    await expect(reissueTenantInvoice(db, { partnerId: 'pa', id: 'inv_dead', ...actor })).rejects.toThrow('audit insert failed');
    expect(await createB2bInvoiceRepo(db).getInvoice('reissue-inv_dead')).toBeNull();
  });
  it('an unpaid or paid source is not_allowed; a foreign or missing one not_found', async () => {
    expect(await reissueTenantInvoice(db, { partnerId: 'pa', id: 'inv_a', ...actor })).toEqual({ ok: false, reason: 'not_allowed' });
    expect(await reissueTenantInvoice(db, { partnerId: 'pa', id: 'inv_paid', ...actor })).toEqual({ ok: false, reason: 'not_allowed' });
    await createB2bInvoiceRepo(db).voidInvoice('inv_b', 'pb');
    expect(await reissueTenantInvoice(db, { partnerId: 'pa', id: 'inv_b', ...actor })).toEqual({ ok: false, reason: 'not_found' });
    expect(await reissueTenantInvoice(db, { partnerId: 'pa', id: 'inv_missing', ...actor })).toEqual({ ok: false, reason: 'not_found' });
    expect(await createB2bInvoiceRepo(db).getInvoice('reissue-inv_b')).toBeNull();
    expect(await audits()).toHaveLength(0);
  });
});
