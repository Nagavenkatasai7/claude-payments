// Fix pack 2 T5 (R04): sanctions block notices.
//
// Every sanctions block writes, in the SAME transaction as the block itself,
// one `sanctions.block` audit row and, unless the block is quiet, one ops.alert
// plus one email.send per distinct non-default partner in {owner, rail
// partner} that has a usable address (complianceAlertEmail ?? alertEmail). The
// licensed rail partner carries the blocking-report duty, so a routed block on
// the default (demo) owner still emails the rail partner.
//
// Quiet = no real money AND (a sandbox row OR a demo watchlist name): the demo
// and the sandbox keep blocking exactly as before, with an audit row only.
//
// Ids only, never PII: no name, phone, amount or list entry id reaches a
// payload or the audit meta. Payloads are inline literals
// (tests/outbox-payload-secrets.test.ts). The CALLER pokes the worker after
// its transaction commits (tests/outbox-poke-coverage.test.ts).

import { createAuditRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import type { DbOrTx } from '@/db/client';
import { normalizeAlertEmail } from '../channel-health';
import { WATCHLIST } from '../compliance-config';
import { DEFAULT_PARTNER_ID } from '../defaults';
import type { PartnerId, PartnerSupportConfig, TransferEnvironment } from '../types';
import { SANCTIONS_AUDIT_ACTOR, type ScreeningEvidence } from './evidence';

export type SanctionsBlockStage = 'card' | 'mint' | 'pay' | 'confirm' | 'resume' | 'hold_rescreen' | 'payee' | 'seller';

export interface SanctionsBlockNotice {
  /** The owner tenant (the audit row's partner). */
  partnerId: PartnerId;
  /** The settlement (rail) partner when it differs from the owner. */
  railPartnerId?: PartnerId;
  /** The blocked transfer, payee or seller id: never PII. */
  subjectId: string;
  stage: SanctionsBlockStage;
  environment: TransferEnvironment;
  /** live-gate.ts realMoneyRail for the subject. */
  realMoney: boolean;
  evidence?: ScreeningEvidence;
}

export const SANCTIONS_BLOCK_AUDIT_ACTION = 'sanctions.block';

const DEMO_ENTRY_RE = /^(mock|extra):(\d+)$/;

/**
 * A block whose every matched list entry is a demo WATCHLIST name. Both
 * screeners number the base list first: the mock as `mock:<i>` over
 * [...WATCHLIST, ...watchlistExtra] (compliance.ts), the OFAC screener as
 * `extra:<i>` over the same list (list-screener.ts). So an index below
 * WATCHLIST.length is a demo name; anything else (an SDN uid, a corridor
 * extra, a matched party without an id) is not. Pinned in
 * tests/sanctions-notices.test.ts.
 */
export function isDemoWatchlistBlock(e?: ScreeningEvidence): boolean {
  if (!e || !Array.isArray(e.parties)) return false;
  const matched = e.parties.filter((p) => p.matched);
  if (matched.length === 0) return false;
  return matched.every((p) => {
    const m = typeof p.matchedEntryId === 'string' ? DEMO_ENTRY_RE.exec(p.matchedEntryId) : null;
    return m !== null && Number(m[2]) < WATCHLIST.length;
  });
}

function checkedAddress(v: unknown): string | null {
  return typeof v === 'string' ? (normalizeAlertEmail(v) ?? null) : null;
}

/**
 * Where a partner's sanctions-block notice goes. supportConfig is cast, not
 * parsed (partner-repo.ts), so each stored value is re-checked here.
 */
export function sanctionsNoticeAddress(sc?: PartnerSupportConfig): string | null {
  return checkedAddress(sc?.complianceAlertEmail) ?? checkedAddress(sc?.alertEmail) ?? null;
}

/** The root-handle alert when a card-time block could not be recorded (ids only). */
export function sanctionsBlockUnrecordedKey(partnerId: PartnerId, hour: number): string {
  return `sanctions-block-unrecorded:${partnerId}:${hour}`;
}

/**
 * The audit row and (unless quiet) the ops alert and partner emails, all on
 * `tx`. Pass the block's own transaction so they commit or roll back with it.
 * Throws on a write error (the caller's transaction then rolls back).
 */
export async function enqueueSanctionsBlockNotices(
  tx: DbOrTx,
  n: SanctionsBlockNotice,
): Promise<{ alerted: boolean; partnerNotified: boolean }> {
  const quiet = !n.realMoney && (n.environment === 'test' || isDemoWatchlistBlock(n.evidence));
  const { subjectId, stage, environment, partnerId } = n;
  let alerted = false;
  let partnerNotified = false;
  if (!quiet) {
    const outbox = createOutboxRepo(tx);
    await outbox.enqueue(
      'ops.alert',
      {
        message: `⚠️ SmartRemit ops: sanctions block (${stage}) on ${subjectId}, partner ${partnerId}, ${environment}. Nothing paid out; evidence on the compliance page.`,
      },
      { dedupeKey: `sanctionsblock:${subjectId}` },
    );
    alerted = true;
    const targets = [...new Set([n.partnerId, n.railPartnerId].filter((id): id is PartnerId => Boolean(id)))];
    const partnersRepo = createPartnerRepo(tx);
    for (const toPartnerId of targets) {
      if (toPartnerId === DEFAULT_PARTNER_ID) continue;
      const addr = sanctionsNoticeAddress((await partnersRepo.getPartner(toPartnerId))?.supportConfig);
      if (!addr) continue;
      await outbox.enqueue(
        'email.send',
        {
          to: [addr],
          subject: 'SmartRemit: a transfer was stopped by sanctions screening',
          text: `Reference ${subjectId} (${stage}, ${environment}) was stopped by sanctions screening; nothing was paid out. Evidence is in your SmartRemit workspace. Do not share this notice with the customer.`,
        },
        { dedupeKey: `sanctionsblockmail:${subjectId}:${toPartnerId}` },
      );
      partnerNotified = true;
    }
  }
  await createAuditRepo(tx).record({
    partnerId,
    actor: SANCTIONS_AUDIT_ACTOR,
    actorType: 'system',
    action: SANCTIONS_BLOCK_AUDIT_ACTION,
    subjectId,
    meta: {
      stage,
      environment,
      realMoney: n.realMoney,
      quiet,
      alerted,
      partnerNotified,
      decision: n.evidence?.decision ?? null,
      listSource: n.evidence?.listSource ?? null,
      listVersion: n.evidence?.listVersion ?? null,
    },
  });
  return { alerted, partnerNotified };
}
