// partner-screening-view (fix pack 7, P8). SERVER ONLY.
//
// The masked evidence a qualified compliance user of a certified partner sees
// on /partner/transfers/[id], and the input of `hold_reviews.evidence` at
// decide time (toHoldReviewEvidence -> boundHoldEvidence).
//
//  • Never a hash (inputHash, listHash, listBaseHash, lists[] hashes), a name,
//    a phone or an amount: partnerScreeningView builds a NEW object field by
//    field and never spreads its input.
//  • ONE tenant-scoped audit read for the AML sub-kind (aml.hold, purpose.flag,
//    risk.signals, system rows of the OWNER only): never the customer's purpose
//    text, only the closed scam category.
//  • The scam category is shown on this one surface only (overrides PR6 P21;
//    an owner question in the pack 7 index). The AML explain copilot keeps it
//    platform-only for its model bundle.
//  • No decrypted read: evidence and audit meta are plaintext jsonb with no names.
//  • A failed read never throws: logWarn with the error NAME and the transfer
//    id only, and the empty part (the page shows the generic AML label).
//
// Imports evidence-read (drizzle) and purpose-detail (node:url via
// untrusted-text): no 'use client' file may import this module.

import type { DbOrTx } from '@/db/client';
import { createAuditRepo, type AuditRow } from '@/db/repos/aux-repos';
import type { HoldReviewEvidence } from '@/db/repos/hold-review-repo';
import { AML_HOLD_RULES, isAmlHoldRule, type AmlHoldRule } from './aml-rules';
import { boundHoldEvidence } from './hold-decision';
import type { HoldClass } from './hold-queue';
import { t, type MessageKey } from './i18n';
import { logWarn } from './log';
import { PURPOSE_RISK_CATEGORIES, PURPOSE_RISK_LABELS, type PurposeRiskCategory } from './purpose-detail';
import { isRiskSignal, RISK_SIGNALS, type RiskSignal } from './risk-signals';
import type { SanctionsDecision, ScreeningEvidence } from './sanctions/evidence';
import { listScreenEvidence } from './sanctions/evidence-read';
import type { PartnerId, Transfer } from './types';

export type { HoldReviewEvidence } from '@/db/repos/hold-review-repo';

export const AML_SUB_KINDS = Object.freeze(['aml_rule', 'aml_check_failed', 'scam_pattern', 'risk_signal'] as const);
export type AmlSubKind = (typeof AML_SUB_KINDS)[number];
// The two unions cannot drift (the reverse assignment is in the test file).
const _kinds: readonly NonNullable<HoldReviewEvidence['amlKinds']>[number][] = AML_SUB_KINDS;
void _kinds;

export interface ScreeningPartyView {
  role: 'sender' | 'recipient';
  matched: boolean;
  score: number | null;
  matchedEntryId: string | null;
  screened: boolean;
}

export interface ScreeningView {
  listSource: string;
  listVersion: string;
  screenedAt: string;
  decision: SanctionsDecision;
  parties: ScreeningPartyView[];
}

/** The masked view of one stored screen; null for none. Never a hash, name, phone or amount. */
export function partnerScreeningView(ev: ScreeningEvidence | null | undefined): ScreeningView | null {
  if (!ev) return null;
  return {
    listSource: ev.listSource,
    listVersion: ev.listVersion,
    screenedAt: ev.screenedAt,
    decision: ev.decision,
    parties: ev.parties.map((p) => ({
      role: p.role,
      matched: p.matched === true,
      score: p.unscreened === true || !Number.isFinite(p.matchScore) ? null : p.matchScore,
      matchedEntryId: typeof p.matchedEntryId === 'string' ? p.matchedEntryId : null,
      screened: p.unscreened !== true,
    })),
  };
}

export interface AmlEvidenceView {
  kinds: AmlSubKind[];
  rules: AmlHoldRule[];
  scamCategory: PurposeRiskCategory | null;
  riskSignals: RiskSignal[];
}

export const EMPTY_AML_EVIDENCE: AmlEvidenceView = Object.freeze({
  kinds: Object.freeze([]) as unknown as AmlSubKind[],
  rules: Object.freeze([]) as unknown as AmlHoldRule[],
  scamCategory: null,
  riskSignals: Object.freeze([]) as unknown as RiskSignal[],
});

export interface HoldEvidence {
  screening: ScreeningView | null;
  aml: AmlEvidenceView;
}

/** The mint writes its AML rows in the mint transaction; the read starts this far below createdAt. */
const BEFORE_CREATED_MS = 10 * 60_000;
/** A row written by a clock slightly ahead of ours is still read. */
const AFTER_NOW_MS = 60_000;

function inOrder<T extends string>(registry: readonly T[], picked: ReadonlySet<T>): T[] {
  return registry.filter((x) => picked.has(x));
}

/** The AML sub-kinds from the owner's system audit rows of the transfer. */
function amlFromRows(rows: readonly AuditRow[], ownerId: PartnerId): AmlEvidenceView {
  const kinds = new Set<AmlSubKind>();
  const rules = new Set<AmlHoldRule>();
  const signals = new Set<RiskSignal>();
  let scamCategory: PurposeRiskCategory | null = null;
  for (const r of rows) {
    if (r.partnerId !== ownerId || r.actorType !== 'system') continue;
    const meta = r.meta;
    if (r.action === 'aml.hold' && Array.isArray(meta.rules)) {
      const held = meta.rules as unknown[];
      const ids = held.filter(isAmlHoldRule);
      for (const id of ids) rules.add(id);
      if (ids.length > 0) kinds.add('aml_rule');
      if (held.includes('check_failed')) kinds.add('aml_check_failed');
    } else if (r.action === 'purpose.flag') {
      kinds.add('scam_pattern');
      // Only the closed category; any other stored value is dropped, never shown.
      if (scamCategory === null && (PURPOSE_RISK_CATEGORIES as readonly unknown[]).includes(meta.category)) {
        scamCategory = meta.category as PurposeRiskCategory;
      }
    } else if (r.action === 'risk.signals' && Array.isArray(meta.held)) {
      // Only `held` means the row was held for them; `shown` is never read.
      const held = (meta.held as unknown[]).filter(isRiskSignal);
      for (const s of held) signals.add(s);
      if (held.length > 0) kinds.add('risk_signal');
    }
  }
  return {
    kinds: inOrder(AML_SUB_KINDS, kinds),
    rules: inOrder(AML_HOLD_RULES, rules),
    scamCategory,
    riskSignals: inOrder(RISK_SIGNALS, signals),
  };
}

/**
 * The hold evidence of one transfer, OWNER tenant. Refuses (no read) an empty
 * ownerId or one that is not the row's owner: aux-repos tenantCond applies NO
 * tenant filter for a falsy partnerId, and callers pass the owner from
 * getOwnedTransfer.
 *
 * `listBySubject` caps at 200 rows (oldest first). The three mint rows
 * (aml.hold, risk.signals, purpose.flag) are written in the mint transaction,
 * so they are among the first rows of the subject.
 *
 * Never throws: a failed read gives that part empty (screening null, or the
 * empty sub-kinds) with one logWarn (error name, transfer id).
 */
export async function loadHoldEvidence(
  db: DbOrTx,
  ownerId: PartnerId,
  t: Pick<Transfer, 'id' | 'partnerId' | 'createdAt'>,
  now: Date = new Date(),
): Promise<HoldEvidence> {
  if (!ownerId || t.partnerId !== ownerId) return { screening: null, aml: EMPTY_AML_EVIDENCE };

  let screening: ScreeningView | null;
  try {
    screening = partnerScreeningView((await listScreenEvidence(db, t, now)).at(-1));
  } catch (err) {
    logWarn('hold.evidence.screening', err instanceof Error ? err.name : 'error', { transferId: t.id });
    screening = null;
  }

  let aml: AmlEvidenceView;
  try {
    const created = Date.parse(t.createdAt);
    const from = new Date((Number.isFinite(created) ? created : 0) - BEFORE_CREATED_MS);
    const rows = await createAuditRepo(db).listBySubject(ownerId, t.id, from, new Date(now.getTime() + AFTER_NOW_MS));
    aml = amlFromRows(rows, ownerId);
  } catch (err) {
    logWarn('hold.evidence.aml', err instanceof Error ? err.name : 'error', { transferId: t.id });
    aml = EMPTY_AML_EVIDENCE;
  }
  return { screening, aml };
}

/** The `hold_reviews.evidence` of a decision: ids, versions, scores and closed enums only (bounded, P7). */
export function toHoldReviewEvidence(e: HoldEvidence): HoldReviewEvidence {
  const out: HoldReviewEvidence = {};
  const s = e.screening;
  if (s) {
    out.listSource = s.listSource;
    out.listVersion = s.listVersion;
    out.screenedAt = s.screenedAt;
    const scores = s.parties.map((p) => p.score).filter((x): x is number => x !== null);
    if (scores.length > 0) out.maxScore = Math.max(...scores);
    const ids = s.parties.map((p) => p.matchedEntryId).filter((x): x is string => x !== null);
    if (ids.length > 0) out.matchedEntryIds = ids;
  }
  if (e.aml.kinds.length > 0) out.amlKinds = [...e.aml.kinds];
  if (e.aml.rules.length > 0) out.amlRules = [...e.aml.rules];
  if (e.aml.riskSignals.length > 0) out.riskSignals = [...e.aml.riskSignals];
  if (e.aml.scamCategory !== null) out.scamCategory = e.aml.scamCategory;
  return boundHoldEvidence(out);
}

/**
 * T12 (P8, P28): the `transfer.screening.view` row of ONE render of the
 * evidence panel on /partner/transfers/[id] (like `pii.view`): actor the
 * username, subject the transfer id, OWNER tenant, meta the row's hold classes
 * (closed enum) and the scope. True when written. A failed write never throws:
 * one logWarn (error NAME and transfer id only) and false, so the page shows
 * no evidence without its record.
 */
export async function recordScreeningView(
  db: DbOrTx,
  i: { partnerId: PartnerId; actor: string; transferId: string; holdClasses: readonly HoldClass[] },
): Promise<boolean> {
  try {
    await createAuditRepo(db).record({
      partnerId: i.partnerId,
      actor: i.actor,
      actorType: 'staff',
      action: 'transfer.screening.view',
      subjectId: i.transferId,
      meta: { holdClasses: [...i.holdClasses], actorScope: 'partner' },
    });
    return true;
  } catch (err) {
    logWarn('partner.screening-view', err instanceof Error ? err.name : 'error', { transferId: i.transferId });
    return false;
  }
}

/**
 * T12: the labelled detail rows of the AML evidence (the closed scam-pattern
 * label and the warning-signal labels), for the partner evidence panel. Closed
 * labels only, never the customer's text. Built here, not in the page, so no
 * file under src/app/partner names the signal field (tests/risk-signals-action
 * "partners have no risk-signal writer").
 */
export function amlEvidenceDetailRows(aml: AmlEvidenceView): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  if (aml.scamCategory) rows.push({ label: t('partner.evidence.scamCategory'), value: PURPOSE_RISK_LABELS[aml.scamCategory] });
  if (aml.riskSignals.length > 0) {
    rows.push({
      label: t('partner.evidence.riskSignals'),
      value: aml.riskSignals.map((s) => t(`partner.evidence.signal.${s}` as MessageKey)).join(', '),
    });
  }
  return rows;
}
