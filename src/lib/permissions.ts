import type { Staff, StaffPermissions } from './types';

export function hasPermission(
  staff: Staff,
  permission: keyof StaffPermissions,
): boolean {
  if (staff.role === 'admin') return true;
  return staff.permissions[permission] === true;
}
