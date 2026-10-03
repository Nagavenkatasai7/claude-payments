import type { Db } from '@/db/client';
import { createAuditRepo, createB2bInvoiceRepo } from '@/db/repos/aux-repos';
import { reissueIdFor } from './partner-invoices';
import type { B2bInvoice, PartnerId } from './types';

// b2b-invoice-ops (lost-features A6): the ONE void / reissue core behind /partner/invoices and the
// legacy /admin-dashboard/b2b actions. The caller resolves WHO may act and on WHICH tenant; this
// module re-reads the bill inside that tenant (the tenant is in every WHERE), makes the repo's
// guarded write and records the audit row in ONE transaction, so a lost audit insert leaves the
// bill unchanged. A bill outside the tenant reads exactly like a missing one.

export type InvoiceOpResult = { ok: true; invoice: B2bInvoice } | { ok: false; reason: 'not_found' | 'not_allowed' };

export interface InvoiceOpInput {
  partnerId: PartnerId;
  id: string;
  /** The staff username. */
  actor: string;
  actorScope: 'partner' | 'platform';
}

function requireTenant(partnerId: PartnerId): void {
  if (typeof partnerId !== 'string' || partnerId.length === 0) throw new Error('b2b-invoice-ops: a tenant is required');
}

/** Void an UNPAID bill (the repo guards unpaid → voided). Audited 'b2b.invoice.void'. */
export async function voidTenantInvoice(db: Db, i: InvoiceOpInput): Promise<InvoiceOpResult> {
  requireTenant(i.partnerId);
  return db.transaction(async (tx) => {
    const repo = createB2bInvoiceRepo(tx);
    if (!(await repo.getInvoiceByIdScoped(i.id, i.partnerId))) return { ok: false, reason: 'not_found' } as const;
    const voided = await repo.voidInvoice(i.id, i.partnerId);
    if (!voided) return { ok: false, reason: 'not_allowed' } as const;
    await createAuditRepo(tx).record({
      partnerId: i.partnerId,
      actor: i.actor,
      actorType: 'staff',
      action: 'b2b.invoice.void',
      subjectId: i.id,
      meta: { actorScope: i.actorScope },
    });
    return { ok: true, invoice: voided } as const;
  });
}

/**
 * Reissue a VOIDED or DISPUTED bill as a fresh unpaid clone under the derived id (reissueIdFor).
 * A repeat finds the clone already minted and returns it without a second write or audit row.
 * Audited 'b2b.invoice.reissue' with meta.reissuedAs.
 */
export async function reissueTenantInvoice(db: Db, i: InvoiceOpInput): Promise<InvoiceOpResult> {
  requireTenant(i.partnerId);
  const newId = reissueIdFor(i.id);
  return db.transaction(async (tx) => {
    const repo = createB2bInvoiceRepo(tx);
    const source = await repo.getInvoiceByIdScoped(i.id, i.partnerId);
    if (!source) return { ok: false, reason: 'not_found' } as const;
    if (source.status !== 'voided' && source.status !== 'disputed') return { ok: false, reason: 'not_allowed' } as const;
    const prior = await repo.getInvoiceByIdScoped(newId, i.partnerId);
    if (prior) return { ok: true, invoice: prior } as const;
    const clone = await repo.reissueInvoice(i.id, i.partnerId, newId);
    if (!clone) return { ok: false, reason: 'not_allowed' } as const;
    await createAuditRepo(tx).record({
      partnerId: i.partnerId,
      actor: i.actor,
      actorType: 'staff',
      action: 'b2b.invoice.reissue',
      subjectId: i.id,
      meta: { actorScope: i.actorScope, reissuedAs: clone.id },
    });
    return { ok: true, invoice: clone } as const;
  });
}
