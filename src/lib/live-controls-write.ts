import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { partners } from '@/db/schema';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createPartnerRepo, updateLiveControlsKey } from '@/db/repos/partner-repo';
import { DEFAULT_PARTNER_ID } from './defaults';
import type { LiveReadiness } from './live-certification';
import {
  LIVE_CAPABILITIES,
  type CertificationRecord,
  type ContractRecord,
  type KycDecider,
  type LiveCapability,
  type LiveControlsKey,
  type PostureRecord,
} from './live-controls';
import { isLiveCertified } from './live-gate';
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
//
// T10 refusals that depend on the stored state (revoke when not certified,
// an approval while uncertified or without counsel) are decided on a plain
// read of the row taken AFTER the row lock (lockPartner), and then write
// nothing at all (no key write, no updated_at move). A key that is absent
// reads back as `undefined`, which updateLiveControlsKey refuses to write,
// so "return the raw value unchanged" cannot be used for those.

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

const MAX_REF = 200;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD and a real calendar date ('2026-02-30' is not). */
export function isCalendarDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_ONLY.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** A trimmed reference of 1-200 characters, or null. */
function boundedRef(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const ref = raw.trim();
  return ref.length >= 1 && ref.length <= MAX_REF ? ref : null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Takes the partner row lock (FOR NO KEY UPDATE, the same lock updateLiveControlsKey takes); false when no row. */
async function lockPartner(tx: DbOrTx, partnerId: PartnerId): Promise<boolean> {
  const rows = await tx.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId)).limit(1).for('no key update');
  return rows.length === 1;
}

/** Record (or replace) the partner's signed live contract. The reference text is stored only here. */
export async function writeContract(
  tx: DbOrTx,
  partnerId: PartnerId,
  actor: LiveActor,
  i: { ref: string; signedOn: string },
): Promise<LiveWriteResult> {
  const ref = boundedRef(i.ref);
  if (ref === null || !isCalendarDate(i.signedOn)) return { ok: false, code: 'bad_input' };
  const record: ContractRecord = { ref, signedOn: i.signedOn, recordedBy: actor.username, recordedAt: new Date().toISOString() };
  const w = await updateLiveControlsKey(partnerId, 'contract', record, tx);
  if (!w.found) return { ok: false, code: 'not_found' };
  await recordLiveChange(tx, partnerId, actor, {
    key: 'contract',
    action: 'partner.live.contract.record',
    meta: { signedOn: i.signedOn, hadPrevious: w.previousRaw !== undefined },
    word: 'recorded',
  });
  return { ok: true };
}

/** Now, or 1 ms after `after` when that is a parseable timestamp at or past now (ISO string). */
function stampAfter(after: unknown): string {
  const floor = typeof after === 'string' ? Date.parse(after) + 1 : Number.NaN;
  return new Date(Number.isNaN(floor) ? Date.now() : Math.max(Date.now(), floor)).toISOString();
}

/**
 * Certify (a fresh record: any earlier revoke is gone) or revoke the partner for live money.
 * Certify needs `readiness.ok` (the caller recomputes it on the LOCKED row); in pack 3 that is
 * never true. Revoke needs a stored certification that is not already revoked; it keeps
 * certifiedAt / certifiedBy and adds revokedAt / revokedBy.
 */
export async function writeCertification(
  tx: DbOrTx,
  partnerId: PartnerId,
  actor: LiveActor,
  c: { kind: 'certify'; readiness: LiveReadiness } | { kind: 'revoke' },
  reason: string,
): Promise<LiveWriteResult> {
  if (c.kind === 'certify') {
    if (!c.readiness.ok) return { ok: false, code: 'not_ready' };
    // Pack 3 review C4: a fresh record, stamped after any earlier revoke (even one stamped by an
    // instance whose clock runs ahead), so isLiveCertified's revokedAt >= certifiedAt rule can
    // never read this certification as already revoked.
    const w = await updateLiveControlsKey(
      partnerId,
      'certification',
      (prev: unknown): CertificationRecord => ({
        certifiedAt: stampAfter(isPlainObject(prev) ? prev.revokedAt : undefined),
        certifiedBy: actor.username,
      }),
      tx,
    );
    if (!w.found) return { ok: false, code: 'not_found' };
    await recordLiveChange(tx, partnerId, actor, {
      key: 'certification',
      action: 'partner.live.certify',
      meta: { reason, linesPassed: c.readiness.lines.filter((l) => l.ok).map((l) => l.id) },
      word: 'certified',
    });
    return { ok: true };
  }
  if (!(await lockPartner(tx, partnerId))) return { ok: false, code: 'not_found' };
  const p = await createPartnerRepo(tx).getPartner(partnerId);
  if (!p) return { ok: false, code: 'not_found' };
  const cur = p.liveControls?.certification;
  const revoked =
    cur?.revokedAt !== undefined && !(Date.parse(cur.revokedAt) < Date.parse(cur.certifiedAt)); // as isLiveCertified
  if (!cur || revoked) return { ok: false, code: 'not_certified' };
  // Pack 3 review C4: never earlier than certifiedAt + 1 ms (clock skew, or a certifiedAt in the
  // future), or isLiveCertified would still read the partner as certified after a reported revoke.
  const revokedAt = stampAfter(cur.certifiedAt);
  await updateLiveControlsKey(
    partnerId,
    'certification',
    (prev: unknown) => ({ ...(isPlainObject(prev) ? prev : {}), revokedAt, revokedBy: actor.username }),
    tx,
  );
  await recordLiveChange(tx, partnerId, actor, {
    key: 'certification',
    action: 'partner.live.revoke',
    meta: { reason },
    word: 'revoked',
  });
  return { ok: true };
}

/**
 * One capability's opt-in record. counsel: a platform reference (trimmed, 1-200) is set, or
 * cleared (null), which also removes the partner's approval of that capability. approval: on needs
 * a certified partner and a counsel reference on record; off removes partnerApproved* (always
 * allowed: withdrawing is safer). Every other capability, and unknown fields, are kept raw.
 */
export async function writeOptIn(
  tx: DbOrTx,
  partnerId: PartnerId,
  actor: LiveActor,
  cap: LiveCapability,
  c: { kind: 'counsel'; counselRef: string | null } | { kind: 'approval'; on: boolean },
): Promise<LiveWriteResult> {
  if (!(LIVE_CAPABILITIES as readonly string[]).includes(cap)) return { ok: false, code: 'bad_input' };
  const ref = c.kind === 'counsel' && c.counselRef !== null ? boundedRef(c.counselRef) : null;
  if (c.kind === 'counsel' && c.counselRef !== null && ref === null) return { ok: false, code: 'bad_input' };
  if (c.kind === 'approval' && typeof c.on !== 'boolean') return { ok: false, code: 'bad_input' };

  if (!(await lockPartner(tx, partnerId))) return { ok: false, code: 'not_found' };
  if (c.kind === 'approval' && c.on) {
    const p = await createPartnerRepo(tx).getPartner(partnerId);
    if (!p) return { ok: false, code: 'not_found' };
    if (!isLiveCertified(p)) return { ok: false, code: 'not_certified' };
    if (!p.liveControls?.optIns[cap]?.counselRef) return { ok: false, code: 'not_ready' };
  }

  const now = new Date().toISOString();
  const w = await updateLiveControlsKey(
    partnerId,
    'optIns',
    (prev: unknown) => {
      const all: Record<string, unknown> = isPlainObject(prev) ? { ...prev } : {};
      const rec: Record<string, unknown> = isPlainObject(all[cap]) ? { ...(all[cap] as Record<string, unknown>) } : {};
      if (c.kind === 'counsel') {
        if (ref === null) {
          delete all[cap];
          return all;
        }
        all[cap] = { ...rec, counselRef: ref, counselBy: actor.username, counselAt: now };
        return all;
      }
      if (c.on) {
        all[cap] = { ...rec, partnerApprovedBy: actor.username, partnerApprovedAt: now };
      } else if (cap in all) {
        delete rec.partnerApprovedBy;
        delete rec.partnerApprovedAt;
        all[cap] = rec;
      }
      return all;
    },
    tx,
  );
  if (!w.found) return { ok: false, code: 'not_found' };
  await recordLiveChange(
    tx,
    partnerId,
    actor,
    c.kind === 'counsel'
      ? {
          key: 'optIns',
          action: 'partner.live.optin.counsel',
          meta: { capability: cap, set: ref !== null },
          word: ref !== null ? 'counsel review recorded' : 'counsel review cleared',
        }
      : {
          key: 'optIns',
          action: 'partner.live.optin.approve',
          meta: { capability: cap, on: c.on },
          word: c.on ? 'approved' : 'approval withdrawn',
        },
  );
  return { ok: true };
}
