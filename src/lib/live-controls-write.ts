import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { partners } from '@/db/schema';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { updateLiveControlsKey } from '@/db/repos/partner-repo';
import { DEFAULT_PARTNER_ID } from './defaults';
import type { KycDecider, LiveControlsKey, PostureRecord } from './live-controls';
import { sanctionsNoticeAddress } from './sanctions/notices';
import type { PartnerId, PartnerSupportConfig } from './types';

// live-controls-write — Fix pack 3 (R27, R15; contract 9): the TYPED writers of
// partners.live_controls. Each runs inside the CALLER's transaction and, on a
// write, does exactly this there:
//   1. updateLiveControlsKey (the one column writer: key read under the
//      partner row lock FOR NO KEY UPDATE, then jsonb_set of that key only;
//      every other key, including ones this code does not know, is kept);
//   2. one audit row (actorType 'staff', subjectId = the partner id; meta is
//      the action's own fields + actorScope);
//   3. one ops.alert (ids only: never a username, a reason or a reference);
//   4. one partner email (contract 13) when the partner is not 'default' and
//      has an alert address.
// A refusal writes nothing: no key write, no audit, no alert, no email.
// No 'use server': these are called by the gated server actions, which poke
// the worker after the commit (this file is in tests/outbox-poke-coverage
// HELPERS). T10 adds writeContract / writeCertification / writeOptIn on the
// same recordLiveChange helper.

export interface LiveActor {
  username: string;
  scope: 'platform' | 'partner';
}

export type LiveWriteResult =
  | { ok: true }
  | { ok: false; code: 'not_found' | 'kyc_decider_mismatch' | 'not_ready' | 'not_certified' | 'bad_input' };

/** The email's `<label>` per key (contract 9). */
const LABELS: Record<LiveControlsKey, string> = {
  posture: 'Your compliance posture',
  complianceUsers: 'Your compliance users',
  contract: 'Your live contract record',
  certification: 'Your live certification',
  optIns: 'A live feature approval',
};

/** The same username rule as the parser (live-controls.ts complianceUsers). */
const USERNAME = /^[a-z0-9._-]{1,64}$/;
const MAX_COMPLIANCE_USERS = 20;

const HOLD_DECIDERS: ReadonlySet<string> = new Set(['partner', 'smartremit_delegated']);
const KYC_DECIDERS: ReadonlySet<string> = new Set(['partner', 'smartremit_procedures']);

/** The audit row, the ops alert and the partner email of one live-controls change, in `tx`. */
async function recordLiveChange(
  tx: DbOrTx,
  partnerId: PartnerId,
  actor: LiveActor,
  c: { key: LiveControlsKey; action: string; meta: Record<string, unknown>; word: string },
  supportConfig?: PartnerSupportConfig | null,
): Promise<void> {
  await createAuditRepo(tx).record({
    partnerId,
    actor: actor.username,
    actorType: 'staff',
    action: c.action,
    subjectId: partnerId,
    meta: { ...c.meta, actorScope: actor.scope },
  });
  const outbox = createOutboxRepo(tx);
  await outbox.enqueue(
    'ops.alert',
    { message: `SmartRemit ops: ${c.action} on partner ${partnerId} by ${actor.scope} staff.` },
    { dedupeKey: `livectl:${c.key}:${partnerId}:${randomUUID()}` },
  );
  if (partnerId === DEFAULT_PARTNER_ID) return;
  const sc =
    supportConfig !== undefined
      ? supportConfig
      : ((await tx.select({ supportConfig: partners.supportConfig }).from(partners).where(eq(partners.id, partnerId)).limit(1))[0]?.supportConfig as
          | PartnerSupportConfig
          | null
          | undefined);
  const to = sanctionsNoticeAddress(sc ?? undefined);
  if (!to) return;
  const who = actor.scope === 'partner' ? 'your team' : 'SmartRemit';
  await outbox.enqueue(
    'email.send',
    {
      to: [to],
      subject: 'SmartRemit: a live control changed for your workspace',
      text: `${LABELS[c.key]} was changed by ${who} (${c.word}). Details are in your SmartRemit workspace.`,
    },
    { dedupeKey: `livectlmail:${c.key}:${partnerId}:${randomUUID()}` },
  );
}

/**
 * Sign (or re-sign: the record is replaced) the partner's compliance posture.
 * The KYC decider must match the platform's kycMode on the LOCKED row
 * ('delegated' -> 'partner', else 'smartremit_procedures'); a mismatch is
 * refused. A signed posture forces verify-before-send (resolveKycMode); the
 * requireKycBeforeSend column is never rewritten.
 */
export async function writePosture(
  tx: DbOrTx,
  partnerId: PartnerId,
  actor: LiveActor,
  i: { kycDecider: KycDecider; holdDecider: PostureRecord['holdDecider']; fourEyesNonSanctions: boolean },
): Promise<LiveWriteResult> {
  if (!KYC_DECIDERS.has(i.kycDecider) || !HOLD_DECIDERS.has(i.holdDecider) || typeof i.fourEyesNonSanctions !== 'boolean') {
    return { ok: false, code: 'bad_input' };
  }
  const locked = await tx
    .select({ kycMode: partners.kycMode, supportConfig: partners.supportConfig })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1)
    .for('no key update');
  const row = locked[0];
  if (!row) return { ok: false, code: 'not_found' };
  const expected: KycDecider = row.kycMode === 'delegated' ? 'partner' : 'smartremit_procedures';
  if (i.kycDecider !== expected) return { ok: false, code: 'kyc_decider_mismatch' };
  const record: PostureRecord = {
    version: 1,
    signedBy: actor.username,
    signedAt: new Date().toISOString(),
    kycDecider: i.kycDecider,
    holdDecider: i.holdDecider,
    requireKycBeforeSend: true,
    fourEyesNonSanctions: i.fourEyesNonSanctions,
  };
  const w = await updateLiveControlsKey(partnerId, 'posture', record, tx);
  if (!w.found) return { ok: false, code: 'not_found' };
  await recordLiveChange(
    tx,
    partnerId,
    actor,
    {
      key: 'posture',
      action: 'partner.live.posture.sign',
      meta: { version: 1, kycDecider: i.kycDecider, holdDecider: i.holdDecider, fourEyesNonSanctions: i.fourEyesNonSanctions },
      word: 'signed',
    },
    (row.supportConfig as PartnerSupportConfig | null) ?? null,
  );
  return { ok: true };
}

/**
 * Add (deduped) or remove one compliance user. The username must match the
 * parser's rule; the list is capped at 20 (adding past it is refused with no
 * audit, alert or email). A malformed stored value starts from []. The ROSTER
 * check (same tenant, active admin or agent) is the caller's (contract 12):
 * this writer only knows the list.
 */
export async function writeComplianceUser(
  tx: DbOrTx,
  partnerId: PartnerId,
  actor: LiveActor,
  i: { username: string; on: boolean },
): Promise<LiveWriteResult> {
  if (typeof i.username !== 'string' || !USERNAME.test(i.username) || typeof i.on !== 'boolean') return { ok: false, code: 'bad_input' };
  let overCap = false;
  const w = await updateLiveControlsKey(
    partnerId,
    'complianceUsers',
    (prev: unknown) => {
      const list = Array.isArray(prev) && prev.every((x) => typeof x === 'string') ? (prev as string[]) : [];
      if (!i.on) return list.filter((u) => u !== i.username);
      if (list.includes(i.username)) return list;
      if (list.length >= MAX_COMPLIANCE_USERS) {
        overCap = true;
        return prev; // the RAW value back unchanged (contract 9)
      }
      return [...list, i.username];
    },
    tx,
  );
  if (!w.found) return { ok: false, code: 'not_found' };
  if (overCap) return { ok: false, code: 'bad_input' };
  await recordLiveChange(tx, partnerId, actor, {
    key: 'complianceUsers',
    action: 'partner.live.compliance_user.set',
    meta: { target: i.username, on: i.on },
    word: i.on ? 'compliance user added' : 'compliance user removed',
  });
  return { ok: true };
}
