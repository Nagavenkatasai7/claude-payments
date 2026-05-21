import { env } from './env';
import { hashPassword } from './password';
import { getAuthStore, type AuthStore } from './auth-store';
import type { Staff } from './types';

export async function ensureSeedAdmin(
  store: AuthStore = getAuthStore(),
): Promise<void> {
  const existing = await store.listStaff();
  if (existing.length > 0) return;
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
