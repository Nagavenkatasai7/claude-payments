import { describe, it, expect } from 'vitest';
import { inviteRedeemable, type RedeemDeps } from '@/lib/staff-invite-accept';
import type { StaffInvite } from '@/lib/staff-invite-store';
import type { Staff } from '@/lib/types';

// UI redesign M3-9: the re-checks an invite must pass at the moment it is opened (peek) and again
// when it is accepted (after consume). Every "no" is the same false: the caller renders ONE dead
// sheet, so nothing here may distinguish the reasons to the invitee.

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
const member = (o: Partial<Staff>): Staff => ({
  username: 'pa-owner',
  name: 'Owner',
  role: 'admin',
  permissions: perms,
  passwordHash: 'x',
  createdAt: '2026-01-01T00:00:00Z',
  partnerId: 'pa',
  ...o,
});
const invite = (o: Partial<StaffInvite> = {}): StaffInvite => ({
  partnerId: 'pa',
  username: 'pa-new',
  name: 'New Person',
  role: 'agent',
  invitedBy: 'pa-owner',
  createdAt: '2026-09-29T00:00:00Z',
  expiresAt: '2026-10-02T00:00:00Z',
  ...o,
});

function deps(o: { partners?: Record<string, string>; staff?: Staff[]; seedName?: string } = {}): RedeemDeps {
  const partners = o.partners ?? { pa: 'active', pb: 'active' };
  const staff = o.staff ?? [member({})];
  return {
    getPartner: async (id) => (id in partners ? { status: partners[id] } : null),
    getStaff: async (u) => staff.find((s) => s.username === u) ?? null,
    seedName: o.seedName ?? 'admin',
  };
}

describe('inviteRedeemable', () => {
  it('a live invite from an active admin of an active tenant, for a free name → true', async () => {
    expect(await inviteRedeemable(invite(), deps())).toBe(true);
  });
  it('the tenant is suspended or missing → false', async () => {
    expect(await inviteRedeemable(invite(), deps({ partners: { pa: 'suspended' } }))).toBe(false);
    expect(await inviteRedeemable(invite(), deps({ partners: {} }))).toBe(false);
  });
  it('the inviting admin was removed → false (a removed admin’s invites are not redeemable)', async () => {
    expect(await inviteRedeemable(invite(), deps({ staff: [] }))).toBe(false);
  });
  it('the inviter is suspended, no longer an admin, or an admin of ANOTHER tenant → false', async () => {
    expect(await inviteRedeemable(invite(), deps({ staff: [member({ status: 'suspended' })] }))).toBe(false);
    expect(await inviteRedeemable(invite(), deps({ staff: [member({ role: 'agent' })] }))).toBe(false);
    expect(await inviteRedeemable(invite(), deps({ staff: [member({ partnerId: 'pb' })] }))).toBe(false);
  });
  it('a platform account as the inviter of a NON-admin role → false (teammates are tenant-issued only)', async () => {
    expect(await inviteRedeemable(invite(), deps({ staff: [member({ partnerId: undefined })] }))).toBe(false);
    for (const role of ['agent', 'support', 'finance'] as const) {
      expect(await inviteRedeemable(invite({ role }), deps({ staff: [member({ partnerId: undefined })] }))).toBe(false);
      expect(await inviteRedeemable(invite({ role, inviterScope: 'platform' }), deps({ staff: [member({ partnerId: undefined })] }))).toBe(false);
    }
  });
  // M3-21: a new partner's FIRST admin is invited by a SmartRemit platform admin (create-from-request).
  it('an active platform admin inviting a tenant ADMIN (a platform-issued record) → true', async () => {
    expect(await inviteRedeemable(invite({ role: 'admin', inviterScope: 'platform' }), deps({ staff: [member({ partnerId: undefined })] }))).toBe(true);
  });
  it('a TENANT-issued admin invite whose inviter name now belongs to a platform admin → false (no revival)', async () => {
    expect(await inviteRedeemable(invite({ role: 'admin' }), deps({ staff: [member({ partnerId: undefined })] }))).toBe(false);
  });
  it('a platform-issued record whose inviter is now a tenant admin (even of this tenant) → false', async () => {
    expect(await inviteRedeemable(invite({ role: 'admin', inviterScope: 'platform' }), deps({ staff: [member({})] }))).toBe(false);
  });
  it('a platform inviter who is suspended, removed, not an admin, or an empty-string tenant → false', async () => {
    const adminInvite = invite({ role: 'admin', inviterScope: 'platform' });
    expect(await inviteRedeemable(adminInvite, deps({ staff: [member({ partnerId: undefined, status: 'suspended' })] }))).toBe(false);
    expect(await inviteRedeemable(adminInvite, deps({ staff: [] }))).toBe(false);
    expect(await inviteRedeemable(adminInvite, deps({ staff: [member({ partnerId: undefined, role: 'agent' })] }))).toBe(false);
    expect(await inviteRedeemable(adminInvite, deps({ staff: [member({ partnerId: undefined, role: 'support' })] }))).toBe(false);
    expect(await inviteRedeemable(adminInvite, deps({ staff: [member({ partnerId: '' })] }))).toBe(false);
  });
  it('a platform admin invite into a suspended tenant → false', async () => {
    expect(await inviteRedeemable(invite({ role: 'admin', inviterScope: 'platform' }), deps({ partners: { pa: 'suspended' }, staff: [member({ partnerId: undefined })] }))).toBe(false);
  });
  it('a role outside INVITE_ROLES → false', async () => {
    expect(await inviteRedeemable(invite({ role: 'root' as never }), deps())).toBe(false);
  });
  it('the seed admin’s name, or a name outside the new-username rule → false', async () => {
    expect(await inviteRedeemable(invite({ username: 'admin' }), deps())).toBe(false);
    expect(await inviteRedeemable(invite({ username: 'Bad Name' }), deps())).toBe(false);
  });
  it('the username is already taken (anywhere) → false', async () => {
    expect(await inviteRedeemable(invite(), deps({ staff: [member({}), member({ username: 'pa-new', partnerId: 'pb' })] }))).toBe(false);
  });
  it('a lookup that throws propagates (the caller maps it; it is never read as "redeemable")', async () => {
    const d = deps();
    await expect(inviteRedeemable(invite(), { ...d, getPartner: async () => { throw new Error('db down'); } })).rejects.toThrow('db down');
  });
});
