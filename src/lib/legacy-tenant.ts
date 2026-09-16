import type { Customer, PartnerId } from './types';

// legacy-tenant (fix 1, D9/D10/D12) — the ONE encoding of "which tenant may
// read a pre-fix, phone-only Redis key". Before fix 1 a phone had exactly one
// customers row, so the OLDEST row for a phone is its pre-fix owner and any
// later row is a post-fix sibling that must never inherit the other tenant's
// counters, KYC audit trail or conversation (D3: no cross-tenant oracle).
// Zero rows ⇒ no fallback (fail closed).
//
// INVARIANT THIS DEPENDS ON: customers.createdAt is NEVER backdated.
// customer-repo.freshCustomer stamps createdAt = now in BOTH branches (a
// grandfathered row backdates firstSeenAt only), so a row created after the
// fix always sorts after every pre-fix row. If any writer ever backdates
// createdAt, a post-fix sibling can become "the oldest row" and read the real
// owner's kyc_audit (no TTL — permanent), conv and counters.
//
// Lifetime: fix 10 removes the velocity/daily/monthly callers (the counters
// go away). The conv: (30-day TTL) and kyc_audit: (no TTL) fallbacks keep
// calling this helper after fix 10 — do not delete it with the counters.

export type LegacyTenantOf = (phone: string) => Promise<PartnerId | null>;

/** findByPhone is oldest-first (customer-repo orders by created_at, partner_id). */
export function legacyTenantResolver(customers: { findByPhone(phone: string): Promise<Customer[]> }): LegacyTenantOf {
  return async (phone) => (await customers.findByPhone(phone))[0]?.partnerId ?? null;
}

export async function legacyKeyAllowed(partnerId: PartnerId, phone: string, legacyTenantOf: LegacyTenantOf | undefined): Promise<boolean> {
  if (!legacyTenantOf) return false;
  return (await legacyTenantOf(phone)) === partnerId;
}
