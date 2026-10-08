import type { Catalog, CatalogEntry, FundedRewardKind, PartnerRewardSetting, PartnerRewardTerms } from './types';

// B3 rewards v1: the code defaults (a missing row reads as these) and the
// form rules for the two settings pages. Pure: every writer validates with
// these before it touches the database, and the engine re-checks a partner's
// saved values against the CURRENT catalog at every quote and mint, so a
// tightened admin limit applies at once without rewriting partner rows.

/** No catalog row ⇒ the reward is not available (all dark). */
export const DEFAULT_CATALOG: Catalog = {
  nth_transfer: {
    kind: 'nth_transfer', available: false, nthMin: 3, nthMax: 10, maxDays: 14,
    maxDiscountUsd: 2.99, customerMonthlyCap: 1, festivalNames: [],
  },
  festival: {
    kind: 'festival', available: false, nthMin: 3, nthMax: 10, maxDays: 14,
    maxDiscountUsd: 2.99, customerMonthlyCap: 1, festivalNames: [],
  },
};

/** Owner placeholders (question 5 and 6): $0.60 platform fee, 40% give-back, $0 budget. */
export const DEFAULT_TERMS: PartnerRewardTerms = { platformFeeUsd: 0.6, giveBackPct: 40, monthlyBudgetUsd: 0 };

export const FESTIVAL_NAME_MAX = 40;
export const FESTIVAL_NAMES_MAX = 30;
const MONEY_MAX = 100_000;

export type FormResult<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = <T>(error: string): FormResult<T> => ({ ok: false, error });

function str(v: FormDataEntryValue | null | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

function intIn(raw: string, min: number, max: number): number | null {
  if (!/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

function money(raw: string, max = MONEY_MAX): number | null {
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day 'YYYY-MM-DD' (rejects 2026-02-30). */
export function isCalendarDay(s: string): boolean {
  if (!DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Inclusive length of a day range in days (2026-10-01..2026-10-01 = 1). */
export function daySpan(startsOn: string, endsOn: string): number {
  return Math.round((Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Festival names: one per line or comma, trimmed, de-duplicated, letters/digits/space/'-& only. */
export function parseFestivalNames(raw: string): string[] | null {
  const names = [...new Set(raw.split(/[\n,]/).map((s) => s.trim()).filter((s) => s !== ''))];
  if (names.length > FESTIVAL_NAMES_MAX) return null;
  if (names.some((n) => n.length > FESTIVAL_NAME_MAX || !/^[\p{L}\p{N}][\p{L}\p{N} '&-]*$/u.test(n))) return null;
  return names;
}

/** The admin catalog form for one funded reward. */
export function parseCatalogForm(kind: FundedRewardKind, f: FormData): FormResult<CatalogEntry> {
  const available = str(f.get('available')) === 'on';
  const nthMin = intIn(str(f.get('nthMin')), 2, 50);
  const nthMax = intIn(str(f.get('nthMax')), 2, 50);
  const maxDays = intIn(str(f.get('maxDays')), 1, 31);
  const cap = intIn(str(f.get('customerMonthlyCap')), 1, 31);
  const maxDiscountUsd = money(str(f.get('maxDiscountUsd')), 100);
  const festivalNames = parseFestivalNames(str(f.get('festivalNames')));
  if (nthMin === null || nthMax === null || nthMax < nthMin) return fail('Every Nth transfer: the range must be 2 to 50, lowest first.');
  if (maxDays === null) return fail('Festival length must be 1 to 31 days.');
  if (cap === null) return fail('The customer monthly cap must be 1 to 31.');
  if (maxDiscountUsd === null) return fail('The largest discount must be an amount from $0 to $100.');
  if (festivalNames === null) return fail(`Festival names: at most ${FESTIVAL_NAMES_MAX}, each up to ${FESTIVAL_NAME_MAX} letters.`);
  return { ok: true, value: { kind, available, nthMin, nthMax, maxDays, maxDiscountUsd, customerMonthlyCap: cap, festivalNames } };
}

/** The admin terms form for one partner. */
export function parseTermsForm(f: FormData): FormResult<PartnerRewardTerms> {
  const platformFeeUsd = money(str(f.get('platformFeeUsd')), 100);
  const giveBackPct = money(str(f.get('giveBackPct')), 100);
  const monthlyBudgetUsd = money(str(f.get('monthlyBudgetUsd')));
  if (platformFeeUsd === null) return fail('The platform fee must be an amount from $0 to $100.');
  if (giveBackPct === null) return fail('The give-back must be a percentage from 0 to 100.');
  if (monthlyBudgetUsd === null) return fail('The monthly budget must be an amount from $0 to $100,000.');
  return { ok: true, value: { platformFeeUsd, giveBackPct, monthlyBudgetUsd } };
}

/**
 * Is a partner's saved choice inside the catalog's CURRENT limits? Used by the
 * partner form (before a write) and by the engine (at every quote and mint).
 * A turned-off choice is always valid (it gives nothing).
 */
export function settingWithinLimits(s: PartnerRewardSetting, c: CatalogEntry): boolean {
  if (!s.enabled) return true;
  if (s.kind === 'nth_transfer') {
    return typeof s.nth === 'number' && Number.isInteger(s.nth) && s.nth >= c.nthMin && s.nth <= c.nthMax;
  }
  if (!s.festivalName || !c.festivalNames.includes(s.festivalName)) return false;
  if (!s.startsOn || !s.endsOn || !isCalendarDay(s.startsOn) || !isCalendarDay(s.endsOn)) return false;
  const span = daySpan(s.startsOn, s.endsOn);
  if (span < 1 || span > c.maxDays) return false;
  return typeof s.minAmountUsd === 'number' && Number.isFinite(s.minAmountUsd) && s.minAmountUsd >= 0;
}

/** The partner form for one reward: values parsed, then checked against the catalog. */
export function parsePartnerRewardForm(kind: FundedRewardKind, f: FormData, c: CatalogEntry): FormResult<PartnerRewardSetting> {
  const enabled = str(f.get('enabled')) === 'on';
  if (enabled && !c.available) return fail('SmartRemit has not made this reward available yet.');
  let s: PartnerRewardSetting;
  if (kind === 'nth_transfer') {
    const nth = intIn(str(f.get('nth')), 2, 50);
    if (enabled && nth === null) return fail(`Choose N from ${c.nthMin} to ${c.nthMax}.`);
    s = { kind, enabled, nth };
    if (!settingWithinLimits(s, c)) return fail(`Choose N from ${c.nthMin} to ${c.nthMax}.`);
    return { ok: true, value: s };
  }
  const festivalName = str(f.get('festivalName')) || null;
  const startsOn = str(f.get('startsOn')) || null;
  const endsOn = str(f.get('endsOn')) || null;
  const minAmountUsd = money(str(f.get('minAmountUsd')) || '0');
  if (minAmountUsd === null) return fail('The minimum amount must be an amount from $0 to $100,000.');
  s = { kind, enabled, festivalName, startsOn, endsOn, minAmountUsd };
  if (!enabled) return { ok: true, value: s };
  if (!festivalName || !c.festivalNames.includes(festivalName)) return fail('Choose a festival from the SmartRemit list.');
  if (!startsOn || !endsOn || !isCalendarDay(startsOn) || !isCalendarDay(endsOn)) return fail('Give a start and an end date.');
  const span = daySpan(startsOn, endsOn);
  if (span < 1) return fail('The end date must be on or after the start date.');
  if (span > c.maxDays) return fail(`A festival offer can last at most ${c.maxDays} days.`);
  return { ok: true, value: s };
}
