import type { Customer, PartnerId, Staff } from './types';
import type { Store } from './store';
import type { CustomerStore } from './customer-store';
import type { PartnerStore } from './partner-store';
import type { ScheduleStore } from './schedule-store';
import { scopeOf, canSee, type Scope } from './staff-scope';
import { getStore } from './store';
import { getCustomerStore } from './customer-store';
import { getPartnerStore } from './partner-store';
import { getScheduleStore } from './schedule-store';

export interface ScopedStoreDeps {
  store: Store;
  customerStore: CustomerStore;
  partnerStore: PartnerStore;
  scheduleStore: ScheduleStore;
}

export function createScopedStore(staff: Staff, deps?: ScopedStoreDeps) {
  const scope: Scope = scopeOf(staff);
  // In production, callers omit `deps` and we wire from the singletons.
  // In tests, callers inject deps backed by fakeRedis.
  const store = deps?.store ?? getStore();
  const customerStore = deps?.customerStore ?? getCustomerStore(store);
  const partnerStore = deps?.partnerStore ?? getPartnerStore();
  const scheduleStore = deps?.scheduleStore ?? getScheduleStore();

  return {
    scope,
    /** One-query SQL aggregates, partner-scoped at the WHERE (Stage 4). */
    async transfersSummary() {
      return store.transfersSummary(scope.kind === 'partner' ? scope.partnerId : undefined);
    },
    /** Newest-first keyset page, partner-scoped at the WHERE (Stage 4). */
    async recentTransfers(limit: number) {
      const page = await store.listTransfersPage({
        limit,
        partnerId: scope.kind === 'partner' ? scope.partnerId : undefined,
      });
      return page.items;
    },
    /**
     * Cursor-paged transfers for staff list views (Stage 5b). A platform
     * viewer may narrow to one partner; a partner-scoped viewer is ALWAYS
     * pinned to their own tenant regardless of the filter argument.
     */
    async transfersPage(req: { limit: number; cursor?: string; partnerFilter?: string }) {
      return store.listTransfersPage({
        limit: req.limit,
        cursor: req.cursor,
        partnerId:
          scope.kind === 'partner' ? scope.partnerId : (req.partnerFilter || undefined),
      });
    },
    /** Compliance views, partner-scoped at the WHERE (Stage 5e scan fixes). */
    async complianceViews(limit = 100) {
      const partnerId = scope.kind === 'partner' ? scope.partnerId : undefined;
      const [inReview, flagged, blocked, topVelocity] = await Promise.all([
        store.listTransfersPage({ limit, partnerId, status: 'in_review' }).then((p) => p.items),
        store.listTransfersByCompliance('flagged', { partnerId, limit }),
        store.listTransfersByCompliance('blocked', { partnerId, limit }),
        store.topVelocityToday(10, partnerId),
      ]);
      return { inReview, flagged, blocked, topVelocity };
    },
    async listTransfers() {
      const all = await store.listTransfers();
      return scope.kind === 'platform'
        ? all
        : all.filter((t) => t.partnerId === scope.partnerId);
    },
    async listCustomers() {
      // Tenant-scoped at the WHERE (fix 1); platform staff see every tenant.
      return customerStore.listCustomers(scope.kind === 'partner' ? scope.partnerId : undefined);
    },
    async listSchedules() {
      const all = await scheduleStore.listSchedules();
      return scope.kind === 'platform'
        ? all
        : all.filter((s) => s.partnerId === scope.partnerId);
    },
    async listPartners() {
      const all = await partnerStore.listPartners();
      return scope.kind === 'platform'
        ? all
        : all.filter((p) => p.id === scope.partnerId);
    },
    async getTransfer(id: string) {
      const t = await store.getTransfer(id);
      if (!t || !canSee(scope, t.partnerId)) return null;
      return t;
    },
    /**
     * A customer by phone under ONE tenant. Partner staff are PINNED to their
     * own tenant at the query — the hint is ignored. Platform staff pass the
     * tenant explicitly (`?partner=` on the detail page); without a hint a phone
     * that exists under several tenants resolves to the most recently updated
     * row (callers list the siblings via customerTenants). canSee stays as
     * defence-in-depth on the row that comes back.
     */
    async getCustomer(phone: string, opts: { partnerId?: PartnerId } = {}) {
      let c: Customer | null;
      if (scope.kind === 'partner') {
        c = await customerStore.getCustomer(scope.partnerId, phone);
      } else if (opts.partnerId) {
        c = await customerStore.getCustomer(opts.partnerId, phone);
      } else {
        const rows = await customerStore.findByPhone(phone);
        c = rows.length === 0 ? null : rows.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
      }
      if (!c || !canSee(scope, c.partnerId)) return null;
      return c;
    },
    /** The tenants a phone exists under, filtered to what this viewer may see. */
    async customerTenants(phone: string): Promise<PartnerId[]> {
      const rows = await customerStore.findByPhone(phone);
      return rows.map((c) => c.partnerId).filter((id) => canSee(scope, id));
    },
    async getPartner(id: string) {
      const p = await partnerStore.getPartner(id);
      if (!p || !canSee(scope, p.id)) return null;
      return p;
    },
  };
}

export type ScopedStore = ReturnType<typeof createScopedStore>;
