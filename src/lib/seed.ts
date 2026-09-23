import { env } from './env';
import { hashPassword } from './password';
import { getAuthStore, type AuthStore } from './auth-store';
import { getPartnerStore } from './partner-store';
import { logError } from './log';
import type { Staff } from './types';

/** The seed admin's credentials, or null when either variable is unset (env.ts `required()` throws). */
function seedAdminCredentials(): { username: string; password: string } | null {
  try {
    return { username: env.seedAdminUsername, password: env.seedAdminPassword };
  } catch {
    return null;
  }
}

export async function ensureSeedAdmin(
  store: AuthStore = getAuthStore(),
): Promise<void> {
  const existing = await store.listStaff();
  if (existing.length === 0) {
    const creds = seedAdminCredentials();
    if (creds) {
      const admin: Staff = {
        username: creds.username,
        name: 'Main Admin',
        role: 'admin',
        permissions: { canCancel: true, canResend: true, canAssign: true },
        passwordHash: await hashPassword(creds.password),
        createdAt: new Date().toISOString(),
      };
      // Program-Fix 45 P5: the seed must always land (owner rule: nothing locks
      // out the seed admin), so a staff-ledger failure is logged, not thrown.
      await store.saveStaff(admin, { ledgerBestEffort: true });
    } else {
      // Program-Fix 45 P1 (crypto-14): no staff at all AND no seed variables.
      // Log it for ops and carry on: the login then answers with its ordinary
      // generic error instead of crashing. (Deliberately NOT a boot-assert
      // requirement: the variables are needed only on an empty keyspace.)
      logError('seed', 'no staff exist and SEED_ADMIN_USERNAME / SEED_ADMIN_PASSWORD are not set; the seed admin was not created');
    }
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
        passwordHash: await hashPassword(env.seedPartnerPassword),
        createdAt: new Date().toISOString(),
        partnerId: env.seedPartnerId,
      };
      await store.saveStaff(seeded, { ledgerBestEffort: true });
    }
  }
}
