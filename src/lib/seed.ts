import { env } from './env';
import { hashPassword } from './password';
import { getAuthStore, type AuthStore } from './auth-store';
import { getPartnerStore } from './partner-store';
import type { Staff } from './types';

export async function ensureSeedAdmin(
  store: AuthStore = getAuthStore(),
): Promise<void> {
  const existing = await store.listStaff();
  if (existing.length === 0) {
    const admin: Staff = {
      username: env.seedAdminUsername,
      name: 'Main Admin',
      role: 'admin',
      permissions: { canCancel: true, canResend: true, canAssign: true },
      passwordHash: hashPassword(env.seedAdminPassword),
      createdAt: new Date().toISOString(),
    };
    await store.saveStaff(admin);
  }

  // P3: optional partner-staff seed.
  if (env.seedPartnerUsername && env.seedPartnerPassword && env.seedPartnerId) {
    const existingPartnerStaff = await store.getStaff(env.seedPartnerUsername);
    if (!existingPartnerStaff) {
      // Make sure the partner record exists before seeding the staff
      // (idempotent — does nothing if the partner is already there).
      const partnerStore = getPartnerStore();
      const partner = await partnerStore.getPartner(env.seedPartnerId);
      if (!partner) {
        const now = new Date().toISOString();
        await partnerStore.savePartner({
          id: env.seedPartnerId,
          name: `Seeded partner (${env.seedPartnerId})`,
          countries: ['US'],
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
      }
      const seeded: Staff = {
        username: env.seedPartnerUsername,
        name: 'Partner Staff (seed)',
        role: 'admin',
        permissions: { canCancel: false, canResend: false, canAssign: false },
        passwordHash: hashPassword(env.seedPartnerPassword),
        createdAt: new Date().toISOString(),
        partnerId: env.seedPartnerId,
      };
      await store.saveStaff(seeded);
    }
  }
}
