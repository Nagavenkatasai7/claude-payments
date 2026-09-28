import { isLegacyDashboardStaff } from './legacy-dashboard-staff';
import type { Staff, StaffPermissions } from './types';

export function hasPermission(
  staff: Staff,
  permission: keyof StaffPermissions,
): boolean {
  // Legacy permissions belong to the legacy roles only: a finance (or unknown) record keeps whatever
  // it stores when read from Redis without a ledger row, so never trust it here (M3-6 review).
  if (!isLegacyDashboardStaff(staff)) return false;
  if (staff.role === 'admin') return true;
  return staff.permissions[permission] === true;
}
