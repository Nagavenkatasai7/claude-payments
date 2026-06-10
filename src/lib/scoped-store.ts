import type { Staff } from './types';
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
    async listTransfers() {
      const all = await store.listTransfers();
      return scope.kind === 'platform'
        ? all
        : all.filter((t) => t.partnerId === scope.partnerId);
    },
    async listCustomers() {
      const all = await customerStore.listCustomers();
      return scope.kind === 'platform'
        ? all
        : all.filter((c) => c.partnerId === scope.partnerId);
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
    async getCustomer(phone: string) {
      const c = await customerStore.getCustomer(phone);
      if (!c || !canSee(scope, c.partnerId)) return null;
      return c;
    },
    async getPartner(id: string) {
      const p = await partnerStore.getPartner(id);
      if (!p || !canSee(scope, p.id)) return null;
      return p;
    },
  };
}

export type ScopedStore = ReturnType<typeof createScopedStore>;
