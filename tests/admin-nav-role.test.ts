import { describe, it, expect } from 'vitest';
import { staffRoleLabel } from '@/app/admin-dashboard/nav';

describe('staffRoleLabel (the role shown beside the name in the admin top bar)', () => {
  it('names every role in plain words', () => {
    expect(staffRoleLabel('admin')).toBe('Admin');
    expect(staffRoleLabel('agent')).toBe('Agent');
    expect(staffRoleLabel('support')).toBe('Support');
    expect(staffRoleLabel('finance')).toBe('Finance');
  });
});
