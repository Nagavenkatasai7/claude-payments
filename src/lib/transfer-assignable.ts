import { canSee, scopeOf } from './staff-scope';
import { isTestStaff } from './ticket-balancer';
import { toStaffOptions, type StaffOption } from './staff-options';
import type { PartnerId, Staff } from './types';

// transfer-assignable (lost-features restore p1 A2 + the dead-end fix): who may be given a
// transfer. Only admin and agent can open transfers on either dashboard (platform requireScope
// bounces support; /partner transfers is admin, agent and finance, and finance is not a worker), so
// any other assignee is a dead end. Mirrors ticket-assignable.ts.

/** Why a staff record cannot be given a transfer, in the order the checks run. */
export type TransferAssigneeRefusal = 'unknown' | 'inactive' | 'scope' | 'role';

const WORKS_TRANSFERS = (s: Pick<Staff, 'role'>): boolean => s.role === 'admin' || s.role === 'agent';

/**
 * The shared rule (the platform assign action uses it as is): the record exists, is active, its
 * scope can see the transfer's tenant, and its role works transfers. null = assignable.
 */
export function transferAssigneeRefusal(s: Staff | null, transferPartnerId: PartnerId): TransferAssigneeRefusal | null {
  if (!s) return 'unknown';
  if (s.status === 'suspended') return 'inactive';
  if (!canSee(scopeOf(s), transferPartnerId)) return 'scope';
  if (!WORKS_TRANSFERS(s)) return 'role';
  return null;
}

/**
 * The /partner rule: a MEMBER of the session tenant (never a SmartRemit account, which can see every
 * tenant), the shared rule above, and never an auto-provisioned test account. Fails closed on an
 * empty tenant.
 */
export function isTenantTransferAssignee(s: Staff | null, partnerId: PartnerId): boolean {
  if (!s || typeof partnerId !== 'string' || partnerId.length === 0) return false;
  if (s.partnerId !== partnerId) return false;
  return transferAssigneeRefusal(s, partnerId) === null && !isTestStaff(s);
}

/** The /partner assign dropdown: the tenant's eligible staff, sorted by username. */
export function tenantTransferAssignees(all: readonly Staff[], partnerId: PartnerId): Staff[] {
  return all.filter((s) => isTenantTransferAssignee(s, partnerId)).sort((a, b) => a.username.localeCompare(b.username));
}

export interface PlatformAssigneeOptions {
  /** SmartRemit staff (no tenant) who work transfers. */
  platform: StaffOption[];
  /** Each tenant's own eligible staff, keyed by tenant: a row offers only its own tenant's group. */
  byTenant: Record<PartnerId, StaffOption[]>;
}

/** The SmartRemit transactions picker, grouped so a row never offers another tenant's staff. */
export function platformAssigneeOptions(all: readonly Staff[]): PlatformAssigneeOptions {
  const sorted = [...all].sort((a, b) => a.username.localeCompare(b.username));
  const platform = sorted.filter((s) => !s.partnerId && s.status !== 'suspended' && WORKS_TRANSFERS(s) && !isTestStaff(s));
  const byTenant: Record<PartnerId, StaffOption[]> = {};
  for (const s of sorted) {
    if (!s.partnerId || !isTenantTransferAssignee(s, s.partnerId)) continue;
    (byTenant[s.partnerId] ??= []).push(...toStaffOptions([s]));
  }
  return { platform: toStaffOptions(platform), byTenant };
}
