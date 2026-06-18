import type { ApiKeyPublic } from './partner-api-key';
import type { PartnerRate } from './types';

// partner-health — a PURE, deterministic scorer that surfaces struggling or
// stalled partners before they churn (a Tier-1 "quick win" from
// docs/SMARTREMIT-AI-OPPORTUNITIES.md). It reads ONLY the snapshots the partner
// detail page already loads (transfers summary, audit events, API keys, pushed
// rates) and maps them to a health band + a list of human-readable signal
// strings. No I/O, no AI, no clock — `now` is injected so it is trivially
// TDD'd. The AI narration ("why + outreach") lives in partner-health-ai.ts and
// consumes this output; this module is the single source of the band.
//
// GOTCHA (do not regress): activity is measured from summary.total /
// summary.latest, NOT an audit 'transaction.create' event. That audit row is
// only written by pure-API integrators — WhatsApp and dashboard transfers write
// none — so keying activity off audit events false-positives every chat/dashboard
// partner as "never activated". The summary aggregate counts ALL channels.

export const HEALTH_BANDS = ['healthy', 'watch', 'at_risk', 'stalled'] as const;
export type HealthBand = (typeof HEALTH_BANDS)[number];

// The subset of transfersSummary() the scorer reads (kept narrow so callers can
// pass the full summary object unchanged).
export interface HealthSummary {
  total: number;
  countToday: number;
  needsAttention: number;
  latest: string | null;
}

export interface PartnerHealthInput {
  summary: HealthSummary;
  apiKeys: ApiKeyPublic[];
  rates: PartnerRate[];
  now: number; // injected for testability (ms epoch)
}

export interface PartnerHealth {
  band: HealthBand;
  signals: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Tunables (days) — a partner is "quiet" after 7 days of no activity and
// "stalled" after 30. A high needs-attention ratio is >25% of lifetime volume.
const QUIET_AFTER_DAYS = 7;
const STALLED_AFTER_DAYS = 30;
const ATTENTION_RATIO = 0.25;

function hasLiveKey(apiKeys: ApiKeyPublic[]): boolean {
  return apiKeys.some((k) => !k.revokedAt);
}

// A rate "competes" only when it carries a pushed effectiveRate with a future
// expiresAt (mirrors the page's freshnessBadge / effectiveRateFor). Rates that
// were pushed (have an effectiveRate) but are all stale are a strong churn tell:
// the partner wired up their rate API and then stopped feeding it.
function pushedRates(rates: PartnerRate[]): PartnerRate[] {
  return rates.filter((r) => r.effectiveRate !== undefined);
}

function isFresh(r: PartnerRate, now: number): boolean {
  return (
    r.effectiveRate !== undefined &&
    r.effectiveRate > 0 &&
    r.expiresAt !== undefined &&
    Date.parse(r.expiresAt) > now
  );
}

function daysSince(iso: string, now: number): number {
  return (now - Date.parse(iso)) / DAY_MS;
}

/**
 * Score one partner's integration health. Pure: inputs → { band, signals }.
 *
 * Band precedence (worst wins):
 *   stalled    — issued an API key but never sent a single transfer, OR was
 *                active and has now gone silent for ≥30 days.
 *   at_risk    — gone quiet for ≥7 days, a high needs-attention ratio, or every
 *                pushed rate has expired.
 *   watch      — a single softer signal (e.g. a short lull, low volume today).
 *   healthy    — recent activity, nothing flagged.
 */
export function scorePartnerHealth(input: PartnerHealthInput): PartnerHealth {
  const { summary, apiKeys, rates, now } = input;
  const signals: string[] = [];

  const keyed = hasLiveKey(apiKeys);
  const neverActivated = keyed && summary.total === 0;

  // ── Hard "stalled" tells ────────────────────────────────────────────────
  if (neverActivated) {
    signals.push('API key issued but no transfers ever sent — integration never went live.');
    return { band: 'stalled', signals };
  }

  // Activity recency from the summary (covers WhatsApp + dashboard + API).
  const quietDays = summary.latest !== null ? daysSince(summary.latest, now) : null;

  if (summary.total > 0 && quietDays !== null && quietDays >= STALLED_AFTER_DAYS) {
    signals.push(
      `No activity in ${Math.floor(quietDays)} days — last transfer was ${formatAge(quietDays)} ago.`,
    );
    // A stalled partner may also carry at_risk/watch tells; enumerate them so
    // the note is complete, but the band is already the worst.
    collectRiskSignals(input, signals);
    collectSoftSignals(input, signals, { quietDays });
    return { band: 'stalled', signals };
  }

  // ── "at_risk" tells ─────────────────────────────────────────────────────
  if (summary.total > 0 && quietDays !== null && quietDays >= QUIET_AFTER_DAYS) {
    signals.push(`Gone quiet — no transfers in ${Math.floor(quietDays)} days.`);
  }
  collectRiskSignals(input, signals);

  // Any hard tell so far (quiet ≥7d, high-attention ratio, or a dead rate feed)
  // makes the partner at_risk.
  if (signals.length > 0) {
    // Also append softer heads-ups (e.g. a rate expiring within 24h) for context.
    collectSoftSignals(input, signals, { quietDays });
    return { band: 'at_risk', signals };
  }

  // ── Softer "watch" tells ────────────────────────────────────────────────
  collectSoftSignals(input, signals, { quietDays });
  if (signals.length > 0) return { band: 'watch', signals };

  return { band: 'healthy', signals };
}

// The two hard "at_risk" tells beyond recency: a high needs-attention ratio and
// a fully-expired pushed-rate feed. Pulled out so a stalled or at_risk band can
// enumerate them regardless of which branch decided the band.
function collectRiskSignals(input: PartnerHealthInput, signals: string[]): void {
  const { summary, rates, now } = input;

  if (summary.total > 0 && summary.needsAttention / summary.total >= ATTENTION_RATIO) {
    const pct = Math.round((summary.needsAttention / summary.total) * 100);
    signals.push(
      `${pct}% of transfers need attention (${summary.needsAttention} of ${summary.total}) — friction in the flow.`,
    );
  }

  // The partner pushed rates at some point but none are fresh — their rate feed
  // went stale, so they no longer win quotes and customers drift away.
  const pushed = pushedRates(rates);
  if (pushed.length > 0 && !pushed.some((r) => isFresh(r, now))) {
    signals.push(
      `All ${pushed.length} pushed corridor rate${pushed.length === 1 ? '' : 's'} expired — rate feed has stopped.`,
    );
  }
}

// Softer, non-band-deciding observations layered onto an already-chosen band
// (or, when alone, enough to nudge a healthy partner to 'watch').
function collectSoftSignals(
  input: PartnerHealthInput,
  signals: string[],
  ctx: { quietDays: number | null },
): void {
  const { summary, rates, now } = input;

  // A short lull (between "quiet" thresholds) — early warning, not yet at_risk.
  if (
    summary.total > 0 &&
    ctx.quietDays !== null &&
    ctx.quietDays >= 3 &&
    ctx.quietDays < QUIET_AFTER_DAYS &&
    // don't double-report when an at_risk/stalled quiet signal already fired
    !signals.some((s) => s.startsWith('Gone quiet') || s.startsWith('No activity'))
  ) {
    signals.push(`Slowing down — no transfers in ${Math.floor(ctx.quietDays)} days.`);
  }

  // Active partner but zero volume today — worth a glance if they're usually busy.
  if (summary.total > 0 && summary.countToday === 0 && (ctx.quietDays ?? 0) < 3) {
    signals.push('No transfers today.');
  }

  // A pushed rate is fresh now but expires within 24h — a heads-up the feed may
  // be about to lapse.
  const pushed = pushedRates(rates);
  const anyFresh = pushed.some((r) => isFresh(r, now));
  const expiringSoon = pushed.some(
    (r) =>
      isFresh(r, now) &&
      r.expiresAt !== undefined &&
      Date.parse(r.expiresAt) - now < DAY_MS,
  );
  if (anyFresh && expiringSoon) {
    signals.push('A pushed corridor rate expires within 24 hours.');
  }
}

function formatAge(days: number): string {
  if (days < 1) return 'today';
  const whole = Math.floor(days);
  if (whole < 30) return `${whole} day${whole === 1 ? '' : 's'}`;
  const months = Math.floor(whole / 30);
  return `${months} month${months === 1 ? '' : 's'}`;
}
