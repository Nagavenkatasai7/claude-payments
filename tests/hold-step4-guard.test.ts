/**
 * Fix pack 7 F4 (early review EB2): P9 step 4, the partner-scope reject sender stance, in
 * routeLockedReview (src/lib/hold-review-tx.ts) and its mirror in planHoldDecision
 * (src/lib/hold-decision.ts). Today decisionRoute rule 8 refuses every case step 4 guards first
 * (classifyHold adds a platform sender_watchlist class for them), so no end-to-end fixture reaches
 * it. This file forces decisionRoute to answer the reject route (the real classifyHold, nextStep
 * and senderPepOnly stay) and proves the last guard: unreadable flags, a watchlist hit, or an
 * active stamp that is not PEP-only -> changed 'waits_platform'; a PEP-only sender passes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore, type Store } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { certifiedQueuePartner, heldRowFor } from './helpers-hold';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import { HoldReviewChangedError, lockAndRouteReview, type HoldReviewInput } from '@/lib/hold-review-tx';
import { planHoldDecision } from '@/lib/hold-decision';
import { rowReasonsFp } from '@/lib/hold-queue';

// decisionRoute forced to the reject route (the switch); every other hold-queue export is real.
const route = vi.hoisted(() => ({ forceReject: false, calls: 0 }));
vi.mock('@/lib/hold-queue', async (orig) => {
  const real = await orig<typeof import('@/lib/hold-queue')>();
  return {
    ...real,
    decisionRoute: (...a: Parameters<typeof real.decisionRoute>) => {
      route.calls += 1;
      return route.forceReject ? ({ kind: 'reject' } as const) : real.decisionRoute(...a);
    },
  };
});

const REASON = 'The customer could not verify the documents on file.';

let db: Db;
let store: Store;

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  route.forceReject = false;
  route.calls = 0;
});

function partnerReject(t: Transfer): HoldReviewInput {
  return {
    ownerId: t.partnerId, holdClass: 'kyc', rowFp: rowReasonsFp(t.complianceReasons), disposition: 'customer_not_verified',
    reason: REASON, actor: 'co-a', actorScope: 'partner', evidence: {}, expectFinal: true,
  };
}

/** The locked route's answer, in a transaction that then rolls back (nothing is written). */
async function locked(t: Transfer): Promise<string> {
  const ROLLBACK = new Error('rollback');
  let kind = '';
  await db
    .transaction(async (tx) => {
      const r = await lockAndRouteReview(tx, t.id, partnerReject(t), 'reject');
      kind = r.kind === 'changed' ? `changed:${r.why}` : r.kind;
      throw ROLLBACK;
    })
    .catch((e: unknown) => {
      if (e !== ROLLBACK) throw e;
    });
  return kind;
}

/** The unlocked plan's answer. */
async function planned(t: Transfer): Promise<string> {
  const { expectFinal: _e, ...i } = partnerReject(t);
  void _e;
  try {
    const plan = await planHoldDecision(db, store, { ...i, transferId: t.id });
    return plan.route.kind;
  } catch (e) {
    if (e instanceof HoldReviewChangedError) return `changed:${e.why}`;
    throw e;
  }
}

type Sender = 'none' | 'watchlist' | 'stamp_not_pep_only' | 'pep_only';
/** A queue owner's kyc row whose sender is set AFTER heldRowFor (it re-saves the fixture sender, O3). */
async function rowWith(sender: Sender): Promise<Transfer> {
  const t = await heldRowFor(db, 'acme', 'kyc', { id: `s4_${sender}` });
  if (sender === 'none') {
    await db.execute(sql`DELETE FROM customers WHERE partner_id = 'acme' AND phone = ${t.phone}`);
  } else if (sender === 'watchlist') {
    await db.execute(sql`UPDATE customers SET watchlist_hit = true WHERE partner_id = 'acme' AND phone = ${t.phone}`);
  } else if (sender === 'stamp_not_pep_only') {
    // An unattributable stamp (no boolean hit): active, and not PEP-only.
    await db.execute(sql`UPDATE customers SET watchlist_hit = false, pep_hit = NULL, screening_flagged_at = now()
      WHERE partner_id = 'acme' AND phone = ${t.phone}`);
  } else {
    await db.execute(sql`UPDATE customers SET watchlist_hit = false, pep_hit = true, screening_flagged_at = now()
      WHERE partner_id = 'acme' AND phone = ${t.phone}`);
  }
  return t;
}

describe('P9 step 4: the partner reject sender stance behind a forced reject route (F4, EB2)', { retry: 0 }, () => {
  it('without the forced route, rule 8 of decisionRoute refuses the flagged senders first (today)', async () => {
    await certifiedQueuePartner(db);
    for (const s of ['none', 'watchlist', 'stamp_not_pep_only'] as const) {
      const t = await rowWith(s);
      expect(await locked(t)).toBe('changed:waits_platform');
      expect(await planned(t)).toBe('changed:waits_platform');
    }
    expect(route.calls).toBeGreaterThan(0);
  });

  it('routeLockedReview: flags null, a watchlist hit, or an active stamp that is not PEP-only -> changed waits_platform', async () => {
    await certifiedQueuePartner(db);
    route.forceReject = true;
    for (const s of ['none', 'watchlist', 'stamp_not_pep_only'] as const) {
      const t = await rowWith(s);
      expect(await locked(t)).toBe('changed:waits_platform');
    }
  });

  it('routeLockedReview: a PEP-only sender passes step 4 (ok)', async () => {
    await certifiedQueuePartner(db);
    route.forceReject = true;
    const t = await rowWith('pep_only');
    expect(await locked(t)).toBe('ok');
  });

  it('planHoldDecision (the mirror): the same three refuse with waits_platform; a PEP-only sender plans the reject', async () => {
    await certifiedQueuePartner(db);
    route.forceReject = true;
    for (const s of ['none', 'watchlist', 'stamp_not_pep_only'] as const) {
      const t = await rowWith(s);
      expect(await planned(t)).toBe('changed:waits_platform');
    }
    expect(await planned(await rowWith('pep_only'))).toBe('reject');
  });

  it('nothing is written by any of the refused routes', async () => {
    await certifiedQueuePartner(db);
    route.forceReject = true;
    const t = await rowWith('watchlist');
    await locked(t);
    await planned(t);
    const r = (await db.execute(sql`SELECT count(*)::int AS n FROM hold_reviews WHERE transfer_id = ${t.id}`)) as unknown as {
      rows: Array<{ n: number }>;
    };
    expect(r.rows[0].n).toBe(0);
    expect((await store.getTransfer(t.id))?.status).toBe('in_review');
  });
});
