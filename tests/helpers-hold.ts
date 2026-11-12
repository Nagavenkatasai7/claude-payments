import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import {
  AML_HOLD_REASON, LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON, ORIGINATOR_INFO_MISSING_REASON,
  POSSIBLE_MATCH_REASON, RECIPIENT_WATCHLIST_REASON, SENDER_SCREENING_REASON,
} from '@/lib/compliance-config';
import type { HoldClass } from '@/lib/hold-queue';
import type { PartnerId, Staff, Transfer } from '@/lib/types';
import { seedPartner } from './helpers-db';
import { certifyPartnerForTest, paidRealMoneyTransfer, seedRealMoneyRail } from './helpers-live';

// helpers-hold — Fix pack 7 (P32): fixtures for the hold queue and the hold
// decisions. Later tasks extend this file (platformReviewFor T8a, eventRail T21,
// strandedRefundRow T30). Relative times only (never a hardcoded date). Stores
// and repos are loaded lazily (dynamic `await import`), as paidRealMoneyTransfer
// does, because the files that use these helpers vi.mock them.
// Never hand-write live_controls or posture JSON in a test: use these.

// T5: the hold class names come from '@/lib/hold-queue' (kept as an alias).
export type HoldClassName = HoldClass;

/**
 * A partner certified for live money on an http rail with a signed posture whose
 * deciders are the requested ones (kycDecider 'partner' for kycMode 'delegated',
 * 'smartremit_procedures' for 'ours': the pack 3 match), and the compliance users
 * listed. Defaults: 'acme', holdDecider 'partner', kycMode 'delegated',
 * fourEyes false, users ['co-a','co-b']. The staff rows are seedComplianceUsers.
 */
export async function certifiedQueuePartner(
  db: Db,
  o: {
    partnerId?: string;
    holdDecider?: 'partner' | 'smartremit_delegated';
    kycMode?: 'delegated' | 'ours';
    fourEyes?: boolean;
    users?: string[];
  } = {},
): Promise<PartnerId> {
  const id = o.partnerId ?? 'acme';
  const holdDecider = o.holdDecider ?? 'partner';
  const kycMode = o.kycMode ?? 'delegated';
  const fourEyes = o.fourEyes ?? false;
  const users = o.users ?? ['co-a', 'co-b'];
  await seedPartner(db, id);
  await seedRealMoneyRail(db, id);
  await certifyPartnerForTest(db, id, { posture: true, complianceUsers: users });
  const kycDecider = kycMode === 'delegated' ? 'partner' : 'smartremit_procedures';
  const patch = JSON.stringify({ holdDecider, kycDecider, fourEyesNonSanctions: fourEyes });
  const r = await db.execute(sql`UPDATE partners
    SET kyc_mode = ${kycMode},
        live_controls = jsonb_set(live_controls, '{posture}', (live_controls->'posture') || ${patch}::jsonb)
    WHERE id = ${id} RETURNING id`);
  if ((r as unknown as { rows: unknown[] }).rows.length !== 1) throw new Error(`certifiedQueuePartner: no partner row '${id}'`);
  return id;
}

/**
 * Active staff of this tenant (role default 'agent'), saved through
 * getAuthStore().saveStaff (the ledger row and Redis), MFA-enrolled unless
 * `mfa: false` (the staffMfaKeys.secret marker in the given Redis fake).
 * `redis` is REQUIRED: getStaff reads Redis first, so the calling file mocks
 * '@/lib/redis' to the same fake. `db` is kept for symmetry (the auth store
 * reads getDb(), which the calling file mocks to it).
 */
export async function seedComplianceUsers(
  db: Db,
  partnerId: PartnerId,
  names: readonly string[],
  o: { redis: { set(k: string, v: string): Promise<unknown> }; mfa?: boolean; role?: 'admin' | 'agent' },
): Promise<void> {
  void db;
  const { getAuthStore } = await import('@/lib/auth-store');
  const { staffMfaKeys } = await import('@/lib/staff-mfa-store');
  for (const username of names) {
    const s: Staff = {
      username,
      name: `Compliance ${username}`,
      role: o.role ?? 'agent',
      permissions: { canCancel: false, canResend: false, canAssign: false, canRevealPii: false },
      passwordHash: 'HASH',
      createdAt: new Date().toISOString(),
      partnerId,
      status: 'active',
    };
    await getAuthStore().saveStaff(s);
    if (o.mfa !== false) await o.redis.set(staffMfaKeys.secret(username), 'sealed');
  }
}

const CLASS_REASONS: Record<HoldClass, string[]> = {
  kyc: [LARGE_AMOUNT_REASON],
  aml: [AML_HOLD_REASON],
  sender_pep: [SENDER_SCREENING_REASON],
  sender_watchlist: [SENDER_SCREENING_REASON],
  sanctions_review: [POSSIBLE_MATCH_REASON],
  list_wait: [LIST_UNAVAILABLE_REASON],
  data_missing: [ORIGINATOR_INFO_MISSING_REASON],
  blocked: [RECIPIENT_WATCHLIST_REASON],
  unknown: ['Legacy reason not in the registry.'],
};

/**
 * A held live row of one class: paidRealMoneyTransfer (fresh live clear
 * screening evidence; address and dob on file unless 'data_missing'), then
 * in_review with the class's reasons (compliance 'blocked' for 'blocked', else
 * 'flagged'). sender_pep / sender_watchlist set pep_hit / watchlist_hit and
 * screening_flagged_at an hour ago on the sender; sanctions_review adds a newer
 * possible_match evidence row. The caller seeds the partner (certifiedQueuePartner).
 * `phone` is reserved for a later task that needs two rows of one sender
 * (paidRealMoneyTransfer has one fixed test phone today).
 */
export async function heldRowFor(
  db: Db,
  partnerId: PartnerId,
  holdClass: HoldClassName,
  o: { id?: string; phone?: string; routed?: PartnerId; fundingProvider?: 'mock' | 'stripe' | null; fundingRef?: string } = {},
): Promise<Transfer> {
  if (o.phone !== undefined) throw new Error('heldRowFor: `phone` is not supported yet (paidRealMoneyTransfer has a fixed phone)');
  const id = o.id ?? `held_${holdClass}_${Date.now().toString(36)}`;
  const t = await paidRealMoneyTransfer(db, {
    id,
    partnerId,
    ...(o.routed ? { routedVia: o.routed } : {}),
    ...(o.fundingProvider !== undefined ? { fundingProvider: o.fundingProvider } : {}),
    ...(o.fundingRef ? { fundingRef: o.fundingRef } : {}),
    ...(holdClass === 'data_missing' ? {} : { originator: { address: true, dob: true } }),
  });
  const compliance = holdClass === 'blocked' ? 'blocked' : 'flagged';
  await db.execute(sql`UPDATE transfers
    SET status = 'in_review', compliance_status = ${compliance}, compliance_reasons = ${JSON.stringify(CLASS_REASONS[holdClass])}::jsonb
    WHERE id = ${id} AND partner_id = ${partnerId}`);
  if (holdClass === 'sender_pep') {
    await db.execute(sql`UPDATE customers SET pep_hit = true, screening_flagged_at = now() - interval '1 hour'
      WHERE partner_id = ${partnerId} AND phone = ${t.phone}`);
  } else if (holdClass === 'sender_watchlist') {
    await db.execute(sql`UPDATE customers SET watchlist_hit = true, screening_flagged_at = now() - interval '1 hour'
      WHERE partner_id = ${partnerId} AND phone = ${t.phone}`);
  }
  if (holdClass === 'sanctions_review') {
    const { seedLiveEvidence } = await import('./helpers-sanctions');
    // One ms later than the clear row paidRealMoneyTransfer wrote, so it is the newest.
    await seedLiveEvidence(db, { id, partnerId, recipientName: t.recipientName }, { decision: 'possible_match', at: new Date(Date.now() + 1) });
  }
  const { createStore } = await import('@/lib/store');
  const { fakeRedis } = await import('./helpers');
  const row = await createStore(fakeRedis(), db).getTransfer(id);
  if (!row) throw new Error(`heldRowFor: transfer '${id}' not found`);
  return row;
}
