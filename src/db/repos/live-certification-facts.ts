// live-certification-facts — Fix pack 3 (R15, contract 8): the facts the pure
// live readiness checklist (src/lib/live-certification.ts) needs.
//
// NEVER call this inside a transaction or with a tx handle. Callers pass the
// ROOT `getDb()` and load the facts BEFORE any `transaction` (contract 12,
// certify). Two reads here reach the root handle whatever `db` is given:
// `getAuthStore().getStaff` reads, and may copy-insert, the staff ledger
// through `getDb()` (auth-store.ts withLedger / getAuthStore), and
// `sanctionsListFitnessNow` may refresh the in-process OFAC list
// (sanctions-provider.ts). Inside a transaction that is a second Neon pool
// connection held under the row lock, and a deadlock on PGlite's single
// connection (the same rule as transfer-create.ts and store.ts).
//
// Never catches: any read error propagates, and callers fail closed. Returns
// booleans, enums and usernames only (no names, emails or phone numbers).

import type { DbOrTx } from '@/db/client';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { isLiveApproved } from '@/db/repos/partner-go-live-repo';
import { loadOnboardingFacts } from '@/db/repos/partner-onboarding-facts';
import { getAuthStore } from '@/lib/auth-store';
import type { LiveReadinessFacts } from '@/lib/live-certification';
import { sanctionsListFitnessNow } from '@/lib/sanctions/list-health';
import { staffMfaEnrolled } from '@/lib/staff-mfa-store';
import type { PartnerId } from '@/lib/types';

export async function loadLiveReadinessFacts(db: DbOrTx, partnerId: PartnerId, now: Date): Promise<LiveReadinessFacts> {
  const partner = await createPartnerRepo(db).getPartner(partnerId);
  const usernames = partner?.liveControls?.complianceUsers ?? [];

  const [goLiveApproved, listFitness, onboarding, staff] = await Promise.all([
    isLiveApproved(db, partnerId),
    sanctionsListFitnessNow(now),
    // The default Redis channel-test read is kept (no readChannelTest override).
    loadOnboardingFacts(db, partnerId, { now }),
    Promise.all(
      usernames.map(async (username) => {
        const [s, mfaEnrolled] = await Promise.all([getAuthStore().getStaff(username), staffMfaEnrolled(username)]);
        return { username, s, mfaEnrolled };
      }),
    ),
  ]);

  const complianceStaff: LiveReadinessFacts['complianceStaff'][number][] = [];
  for (const { username, s, mfaEnrolled } of staff) {
    if (!s) continue; // a listed username with no staff record is left out
    complianceStaff.push({
      username,
      partnerId: s.partnerId,
      role: s.role,
      active: (s.status ?? 'active') === 'active',
      mfaEnrolled,
    });
  }

  return { goLiveApproved, listFitness, ownWhatsapp: onboarding.whatsappOwnConfigured, complianceStaff };
}
