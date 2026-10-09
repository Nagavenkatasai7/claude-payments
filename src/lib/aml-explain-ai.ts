import { chat } from '@/lib/ollama';
import { amlRuleReason, isAmlRule, type AmlHit, type AmlRule, type AmlRuleConfig } from '@/lib/aml-rules';
import { AML_HOLD_REASON } from '@/lib/aml-hold';
import {
  LARGE_AMOUNT_REASON,
  LIST_UNAVAILABLE_REASON,
  POSSIBLE_MATCH_REASON,
  RECIPIENT_WATCHLIST_REASON,
  SENDER_IDENTITY_MISSING_REASON,
  SENDER_WATCHLIST_REASON,
  VELOCITY_REASON,
} from '@/lib/compliance-config';
import { PURPOSE_RISK_LABELS, type PurposeRiskCategory } from '@/lib/purpose-detail';
import type { ChatMessage, CountryCode, Transfer } from '@/lib/types';

// aml-explain-ai — the AML "Explain" copilot (A4, Raj #6). Strictly rung-1 and
// READ-ONLY: it explains why a transfer raised a behavioural AML alert or sits
// on a compliance hold, so an analyst can decide faster. It never decides,
// never changes the transfer or the alert, and writes nothing but the caller's
// one audit row.
//
// What the model sees is ONLY numbers and closed strings (the FACTS bundle):
// rule codes and their fixed reasons, window, count, sum and thresholds, this
// transfer's USD amount, country codes, the payout method class, b2c/b2b, the
// hold age in hours, allow-listed hold-reason codes and the EDD flag. NEVER an
// id, a name, a phone (not even masked), a payout destination or its last4, KYC
// data, a staff note or screening evidence. The partner audience (owner
// decision D5) also drops count, sum, window and thresholds.
//
// ONE chat(messages, []) call: no tools, no loop, no retries. Any failure (or
// an empty answer) throws, and the caller serves amlExplainFallback instead.

export type AmlExplainAudience = 'platform' | 'partner';

export const AML_EXPLAIN_NEXT_STEPS = [
  'review_sender_history',
  'request_source_of_funds',
  'verify_recipient_relationship',
  'escalate',
  'keep_on_hold',
  'close_alert_no_action',
] as const;
export type AmlExplainNextStep = (typeof AML_EXPLAIN_NEXT_STEPS)[number];

/** Allow-listed hold reasons. Anything not in the list is 'other' (its text never leaves). */
export type HoldReasonCode =
  | 'screening'
  | 'sender_identity_missing'
  | 'large_amount'
  | 'velocity'
  | 'aml_hold'
  | 'purpose_hold'
  | 'edd_required'
  | 'other';

const HOLD_REASON_CODES: Readonly<Record<string, HoldReasonCode>> = Object.freeze({
  [POSSIBLE_MATCH_REASON]: 'screening',
  [LIST_UNAVAILABLE_REASON]: 'screening',
  [RECIPIENT_WATCHLIST_REASON]: 'screening',
  [SENDER_WATCHLIST_REASON]: 'screening',
  [SENDER_IDENTITY_MISSING_REASON]: 'sender_identity_missing',
  [LARGE_AMOUNT_REASON]: 'large_amount',
  [VELOCITY_REASON]: 'velocity',
  [AML_HOLD_REASON]: 'aml_hold',
  edd_required: 'edd_required',
});

const WINDOWS = ['7d', '30d', 'first', 'destination'] as const;
type AmlWindow = (typeof WINDOWS)[number];
const PAYOUT_CLASSES = ['bank', 'upi', 'usdc'] as const;
type PayoutClass = (typeof PAYOUT_CLASSES)[number] | 'other';

export interface AmlExplainRuleFact {
  rule: AmlRule;
  reason: string;
  /** 'alert' = an aml.alert audit row; 'recomputed' = the caller re-ran the in-mint rules. */
  source: 'alert' | 'recomputed';
  // Platform audience only (D5: never for a partner).
  window?: AmlWindow;
  count?: number;
  sumUsd?: number;
}

export interface AmlExplainThresholds {
  largeAmountUsd: number;
  bandLowerUsd: number;
  structuringCount: number;
  aggregateUsd: number;
  firstTransferUsd: number;
  clusterSenders: number;
}

/**
 * Security review L1: the purpose hold reuses AML_HOLD_REASON (no tipping off), so the caller says
 * when the transfer has a `purpose.flag` audit row. `category` is that row's category, or null when
 * the row carries none the code knows.
 */
export interface PurposeHoldFact {
  category: PurposeRiskCategory | null;
}

/** The FACTS bundle: the only thing the model (and the UI facts table) ever sees. */
export interface AmlExplainFacts {
  audience: AmlExplainAudience;
  rules: AmlExplainRuleFact[];
  thresholds?: AmlExplainThresholds; // platform only
  amountUsd: number;
  sourceCountry: CountryCode;
  destinationCountry: CountryCode;
  payoutMethodClass: PayoutClass;
  transferType: 'b2c' | 'b2b';
  onHold: boolean;
  holdAgeHours: number | null;
  holdReasons: HoldReasonCode[];
  eddRequired: boolean;
  /** Platform only: the scam pattern the customer's stated reason matched (a closed code and its staff label). */
  purposeRisk?: { category: PurposeRiskCategory; label: string };
}

export interface AmlExplanation {
  summary: string;
  checks: string[];
  next_step: AmlExplainNextStep;
}

/** An aml.alert audit row (only `meta` is read). */
export interface AmlAlertLike {
  meta: Record<string, unknown>;
}

const MAX_CHECKS = 5;
const MAX_SUMMARY = 1200;
const MAX_CHECK = 300;

const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const round2 = (n: number) => Math.round(n * 100) / 100;

function holdReasonCodes(reasons: readonly string[] | undefined, purposeHold: boolean): HoldReasonCode[] {
  const out: HoldReasonCode[] = [];
  for (const r of reasons ?? []) {
    let code = typeof r === 'string' && Object.hasOwn(HOLD_REASON_CODES, r) ? HOLD_REASON_CODES[r] : 'other';
    // The purpose hold adds the same generic reason as the AML hold (aml-hold.ts applyPurposeHold).
    if (code === 'aml_hold' && purposeHold) code = 'purpose_hold';
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

function ruleFact(
  rule: AmlRule,
  source: AmlExplainRuleFact['source'],
  audience: AmlExplainAudience,
  window: unknown,
  count: unknown,
  sumUsd: unknown,
): AmlExplainRuleFact {
  const fact: AmlExplainRuleFact = { rule, reason: amlRuleReason(rule), source };
  if (audience !== 'platform') return fact;
  const w = typeof window === 'string' && (WINDOWS as readonly string[]).includes(window) ? (window as AmlWindow) : undefined;
  const c = finite(count);
  const s = finite(sumUsd);
  // All three or none: a partial row is shown as the rule alone.
  if (w !== undefined && c !== undefined && s !== undefined) {
    fact.window = w;
    fact.count = c;
    fact.sumUsd = round2(s);
  }
  return fact;
}

/**
 * Build the facts bundle (PURE). `alerts` are the transfer's aml.alert rows
 * (malformed rows are dropped, one fact per rule). When there is none, the
 * caller may pass `recomputed` — the in-mint rules re-run on the sender's
 * ledger (senderAmlStats → amlHoldHit) — marked "recomputed". `purposeHold`
 * (the transfer has a purpose.flag row) turns the generic hold reason into
 * `purpose_hold`; its category reaches the PLATFORM audience only (the partner
 * transfer page never names it either).
 */
export function buildAmlExplainBundle(
  t: Transfer,
  alerts: readonly AmlAlertLike[],
  cfg: AmlRuleConfig,
  audience: AmlExplainAudience,
  now: number,
  recomputed?: AmlHit | null,
  purposeHold?: PurposeHoldFact | null,
): AmlExplainFacts {
  const rules: AmlExplainRuleFact[] = [];
  for (const a of alerts) {
    const m = a.meta ?? {};
    if (!isAmlRule(m.rule) || rules.some((r) => r.rule === m.rule)) continue;
    rules.push(ruleFact(m.rule, 'alert', audience, m.window, m.count, m.sumUsd));
  }
  if (rules.length === 0 && recomputed && isAmlRule(recomputed.rule)) {
    rules.push(ruleFact(recomputed.rule, 'recomputed', audience, recomputed.window, recomputed.count, recomputed.sumUsd));
  }
  const onHold = t.status === 'in_review';
  const since = Date.parse(t.paidAt ?? t.createdAt);
  const holdAgeHours = onHold && Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 3_600_000)) : null;
  const facts: AmlExplainFacts = {
    audience,
    rules,
    amountUsd: round2(t.amountUsd),
    sourceCountry: t.sourceCountry,
    destinationCountry: t.destinationCountry,
    payoutMethodClass: (PAYOUT_CLASSES as readonly string[]).includes(t.payoutMethod) ? (t.payoutMethod as PayoutClass) : 'other',
    transferType: t.transferType === 'b2b' ? 'b2b' : 'b2c',
    onHold,
    holdAgeHours,
    holdReasons: onHold || t.complianceStatus === 'flagged' ? holdReasonCodes(t.complianceReasons, !!purposeHold) : [],
    eddRequired: t.eddRequired === true,
  };
  const category = purposeHold?.category;
  if (audience === 'platform' && category) {
    facts.purposeRisk = { category, label: PURPOSE_RISK_LABELS[category] };
  }
  if (audience === 'platform') {
    facts.thresholds = {
      largeAmountUsd: cfg.largeAmountUsd,
      bandLowerUsd: round2(cfg.band * cfg.largeAmountUsd),
      structuringCount: cfg.count,
      aggregateUsd: cfg.aggUsd,
      firstTransferUsd: cfg.firstUsd,
      clusterSenders: cfg.senders,
    };
  }
  return facts;
}

// The staff guardrails — included verbatim in the system prompt (the test
// guards their presence).
const GUARDRAILS = `Hard rules — never break these:
- Never approve, release, reject or decide the case. You explain; a human analyst decides, and a separate audited action carries the decision out.
- Never state a legal conclusion: do not say money laundering, structuring or fraud happened, and do not say a report must or must not be filed.
- Never suggest contacting, warning or telling the customer about the alert, the review or its reasons (no tipping off).
- Use only the facts given. Never invent amounts, dates, people, history or documents; if something is unknown, say it is not in the facts.`;

export const AML_EXPLAIN_SYSTEM_PROMPT = `You are an AML-review copilot for the compliance staff of a money-transfer service. Given the facts of ONE transfer — the behavioural AML rules it raised (if any) and its hold state — explain in plain English why it was flagged, what an analyst should check, and the next review step. You only EXPLAIN. Respond with ONLY a JSON object: {"summary": two or three plain sentences, "checks": up to 5 short things to check, "next_step": one of ${AML_EXPLAIN_NEXT_STEPS.map((s) => `"${s}"`).join(' | ')}}. No other text.

${GUARDRAILS}`;

const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** The user message: a plain listing of the facts (numbers and closed strings only). */
function factsText(f: AmlExplainFacts): string {
  const lines: string[] = [];
  if (f.rules.length === 0) {
    lines.push('Behavioural AML rules raised: none recorded.');
  } else {
    lines.push('Behavioural AML rules raised:');
    for (const r of f.rules) {
      let line = `- rule ${r.rule} (${r.reason}); source: ${r.source}`;
      if (r.window !== undefined) line += `; window ${r.window}; count ${r.count}; sum ${usd(r.sumUsd ?? 0)}`;
      lines.push(line);
    }
  }
  if (f.thresholds) {
    const th = f.thresholds;
    lines.push(
      `Corridor thresholds: large amount ${usd(th.largeAmountUsd)}; structuring band from ${usd(th.bandLowerUsd)}; ` +
        `${th.structuringCount} in-band sends in 7 days; ${usd(th.aggregateUsd)} of sub-threshold sends in 30 days; ` +
        `first-send alert from ${usd(th.firstTransferUsd)}; ${th.clusterSenders} senders to one recipient in 30 days.`,
    );
  }
  lines.push(`This transfer: ${usd(f.amountUsd)} (USD equivalent), ${f.sourceCountry} → ${f.destinationCountry}, payout method ${f.payoutMethodClass}, ${f.transferType}.`);
  lines.push(
    f.onHold
      ? `On hold for review: yes, for ${f.holdAgeHours ?? 0}h since payment.`
      : 'On hold for review: no.',
  );
  lines.push(`Hold reasons: ${f.holdReasons.length ? f.holdReasons.join(', ') : 'none'}.`);
  if (f.purposeRisk) lines.push(`The reason the customer gave for the transfer matches a scam pattern: ${f.purposeRisk.label}.`);
  lines.push(`Enhanced due diligence required: ${f.eddRequired ? 'yes' : 'no'}.`);
  lines.push(f.audience === 'partner' ? 'The reader is the partner\'s compliance staff.' : 'The reader is SmartRemit compliance staff.');
  return lines.join('\n');
}

/** The exact messages sent to the model (exported for the PII guard test). */
export function amlExplainPrompt(f: AmlExplainFacts): ChatMessage[] {
  return [
    { role: 'system', content: AML_EXPLAIN_SYSTEM_PROMPT },
    { role: 'user', content: `${factsText(f)}\n\nExplain this for the analyst.` },
  ];
}

// The same defensive parse as review-triage-ai: the whole string, then the
// greedy slice, then the lazy slice; the first that parses to an object wins.
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const candidates = [trimmed, trimmed.match(/\{[\s\S]*\}/)?.[0], trimmed.match(/\{[\s\S]*?\}/)?.[0]];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const v = JSON.parse(c) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function clampNextStep(v: unknown): AmlExplainNextStep {
  return (AML_EXPLAIN_NEXT_STEPS as readonly unknown[]).includes(v) ? (v as AmlExplainNextStep) : 'review_sender_history';
}

function clampChecks(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((c): c is string => typeof c === 'string')
    .map((c) => c.trim().slice(0, MAX_CHECK))
    .filter((c) => c.length > 0)
    .slice(0, MAX_CHECKS);
}

/**
 * The model budget for one Explain click. Prod 2026-10-07: the agent's 20 s
 * budget (OLLAMA_TIMEOUT_MS) timed out and the analyst got the fixed text. The
 * route and the partner page allow 60 s (maxDuration), so this stays below it.
 */
export const AML_EXPLAIN_TIMEOUT_MS = 45_000;

/** ONE chat(messages, []) call. Throws on any failure or an empty summary. */
export async function explainAml(f: AmlExplainFacts): Promise<AmlExplanation> {
  const reply = await chat(amlExplainPrompt(f), [], { timeoutMs: AML_EXPLAIN_TIMEOUT_MS });
  const parsed = extractJsonObject(reply.content ?? '');
  const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim().slice(0, MAX_SUMMARY) : '';
  if (!summary) throw new Error('Empty AI response');
  return { summary, checks: clampChecks(parsed?.checks), next_step: clampNextStep(parsed?.next_step) };
}

// ── Deterministic fallback (AI down, timed out, or rate-limited) ───────────

const RULE_CHECKS: Readonly<Record<AmlRule, readonly string[]>> = Object.freeze({
  structuring: [
    "Review the sender's recent transfers for amounts kept just under the large-amount threshold.",
    'Check whether the stated purpose and source of funds explain how often they send.',
    'Look for other senders paying the same recipient.',
  ],
  first_transfer: [
    "Confirm the sender's identity verification is complete.",
    'Check the source of funds for a large first send.',
    'Check that the purpose fits the sender profile.',
  ],
  new_beneficiary: [
    "Check the sender's relationship to the new recipient.",
    'Compare the amount with what this sender usually sends.',
    'Check the purpose of the transfer.',
  ],
  cluster: [
    'Review the other senders paying this recipient.',
    'Check whether the senders are related (shared details, timing).',
    'Consider escalating to the compliance lead.',
  ],
});

const RULE_NEXT: Readonly<Record<AmlRule, AmlExplainNextStep>> = Object.freeze({
  structuring: 'review_sender_history',
  first_transfer: 'request_source_of_funds',
  new_beneficiary: 'verify_recipient_relationship',
  cluster: 'escalate',
});

const WINDOW_TEXT: Readonly<Record<AmlWindow, string>> = Object.freeze({
  '7d': 'within 7 days',
  '30d': 'within 30 days',
  first: 'as a first send',
  destination: 'to a new recipient',
});

const HOLD_TEXT: Readonly<Record<HoldReasonCode, string>> = Object.freeze({
  screening: 'name screening',
  sender_identity_missing: 'missing sender identity',
  large_amount: 'a large amount',
  velocity: 'high transfer velocity',
  aml_hold: 'an AML review hold',
  purpose_hold: 'a scam-pattern check of the reason the customer gave',
  edd_required: 'enhanced due diligence',
  other: 'another review reason',
});

const PURPOSE_CHECK = 'Read the reason the customer gave and check whether it fits a known scam pattern.';

const GENERIC_CHECKS = [
  "Review the sender's transfer history.",
  'Check the purpose and source of funds against the sender profile.',
  'Record your decision and reason in the review.',
] as const;

/** Deterministic explanation per rule plus a fixed checklist (no model, no PII). */
export function amlExplainFallback(f: AmlExplainFacts): AmlExplanation {
  const sentences: string[] = [];
  for (const r of f.rules) {
    let s = `This transfer raised the ${r.rule} rule: ${r.reason}`;
    if (r.window !== undefined && r.count !== undefined && r.sumUsd !== undefined && r.rule !== 'cluster') {
      s += ` (${r.count} sends ${WINDOW_TEXT[r.window]}, ${usd(r.sumUsd)} in total)`;
    } else if (r.window !== undefined && r.count !== undefined && r.rule === 'cluster') {
      s += ` (${r.count} senders ${WINDOW_TEXT[r.window]})`;
    }
    sentences.push(`${s}.`);
  }
  if (f.onHold) {
    const why = f.holdReasons.length ? f.holdReasons.map((c) => HOLD_TEXT[c]).join(', ') : 'review';
    sentences.push(`It is on hold for ${why}.`);
  }
  if (f.purposeRisk) sentences.push(`The reason the customer gave matches a scam pattern: ${f.purposeRisk.label}.`);
  if (sentences.length === 0) sentences.push('No behavioural AML rule is recorded for this transfer.');
  const checks: string[] = [];
  for (const r of f.rules) for (const c of RULE_CHECKS[r.rule]) if (!checks.includes(c)) checks.push(c);
  if (f.holdReasons.includes('purpose_hold')) checks.push(PURPOSE_CHECK);
  for (const c of GENERIC_CHECKS) if (!checks.includes(c)) checks.push(c);
  const first = f.rules[0];
  return {
    summary: sentences.join(' '),
    checks: checks.slice(0, MAX_CHECKS),
    next_step: first ? RULE_NEXT[first.rule] : 'keep_on_hold',
  };
}
