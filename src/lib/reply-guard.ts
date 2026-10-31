import { BANNED_REPLY_CLAIMS, CLAIM_NEGATION } from './claims-register';
import { mentionsRemittance } from './scope-guard';

/**
 * reply-guard (R32, bot part) — checks the RAW model text of a turn against
 * the facts the code produced, before anything is added to it.
 *
 * Facts are what the model had in front of it: the tool results (this turn's,
 * the round-0 customer context and the earlier results in the conversation),
 * the customer's own messages and the limits the prompt states. A reply that
 * names a money figure, an exchange rate, a delivery day count or a delivery
 * date that no fact backs, or makes a banned delivery claim (claims-register.ts),
 * gets an issue.
 *
 * The customer's figures are kept apart (review fix): they back an echoed
 * amount only ("$350 to Mom"), never a rate, a fee or a delivery day count, so
 * nobody can make a false rate pass by stating it first. Free-text tool fields
 * (names, nicknames, descriptions) are data and back nothing.
 *
 * R56 backstop: a reply with a code block or code lines, or a long reply that
 * never mentions money, a transfer or the account, gets an off_topic issue.
 *
 * Shadow mode (the agent.reply_guard switch off, the default) only alerts;
 * with the switch on, the agent replaces the reply with the fixed fallback.
 *
 * What is checked:
 *  - money: a number with a currency mark ($, ₹, Rs, £, €, MX$, …, an ISO code,
 *    or a word such as "dollars" or "rupees"). It must equal a fact, rounded to
 *    the decimals the reply shows, in a compatible currency ("$" is any dollar
 *    currency). A hedged figure ("about $603") is an estimate and is skipped:
 *    the SEND AMOUNT LOCK question may estimate.
 *  - rates: "1 USD = ₹85.20", "$1 = ₹85.2", "rate of 85.20".
 *  - delivery: "N business/working days" (each number of a range), "arrives in
 *    N days", "the same day", and today/tomorrow after a delivery verb.
 *  - dates: an explicit day and month ("5 Nov", "November 5th").
 *
 * Pure. Never throws: a bad input is treated as empty.
 */

export type ReplyIssueKind = 'amount' | 'rate' | 'delivery' | 'claim' | 'off_topic';

export interface ReplyIssue {
  kind: ReplyIssueKind;
  /** The figure or claim id as found (for tests and logs; alerts carry only the kind). */
  found: string;
}

export interface ReplyCheck {
  ok: boolean;
  issues: ReplyIssue[];
}

/** A money fact. `currency` is an ISO code, DOLLAR for a bare "$", or absent when the code did not say. */
export interface MoneyFact {
  value: number;
  currency?: string;
}

export interface ReplyFacts {
  amounts: MoneyFact[];
  /** Figures the customer typed: they back an echoed amount only, never a fee, a rate or a day count. */
  customerAmounts: MoneyFact[];
  rates: number[];
  /** Day counts (business days; 0 is the same day). */
  days: number[];
  /** Calendar dates as 'MM-DD'. */
  dates: string[];
}

/** What the agent reports when a reply fails the check (agent.ts onReplyGuard). */
export interface ReplyGuardReport {
  issues: ReplyIssue[];
  /** shadow: the reply was sent unchanged. on: it was replaced with the fixed fallback. */
  mode: 'shadow' | 'on';
}

export function emptyReplyFacts(): ReplyFacts {
  return { amounts: [], customerAmounts: [], rates: [], days: [], dates: [] };
}

// ── Lexicon ──────────────────────────────────────────────────────────────────

/** A bare "$": any of the dollar currencies. */
export const DOLLAR = '$';
const DOLLAR_LIKE: ReadonlySet<string> = new Set(['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'MXN']);
const ISO = ['USD', 'CAD', 'GBP', 'AED', 'SGD', 'AUD', 'NZD', 'INR', 'HKD', 'MXN', 'EUR'];

/** Marks written before the number, longest first (so "MX$" wins over "$"). */
const PREFIXES: ReadonlyArray<[string, string]> = [
  ['US$', 'USD'], ['CA$', 'CAD'], ['AU$', 'AUD'], ['NZ$', 'NZD'], ['HK$', 'HKD'], ['MX$', 'MXN'], ['SG$', 'SGD'],
  ['C$', 'CAD'], ['A$', 'AUD'], ['S$', 'SGD'], ['$', DOLLAR], ['₹', 'INR'], ['Rs.', 'INR'], ['Rs', 'INR'], ['£', 'GBP'], ['€', 'EUR'],
  ...ISO.map((c): [string, string] => [c, c]),
];
/** Words and codes written after the number. */
const SUFFIXES: ReadonlyArray<[RegExp, string]> = [
  [/^(?:dollars?|d[oó]lares?|bucks)$/iu, DOLLAR],
  [/^(?:rupees?|rupaye|rupay|rupiya)$/iu, 'INR'],
  [/^(?:pounds?)$/iu, 'GBP'],
  [/^(?:euros?)$/iu, 'EUR'],
  [/^(?:pesos?)$/iu, 'MXN'],
  [/^(?:dirhams?)$/iu, 'AED'],
  ...ISO.map((c): [RegExp, string] => [new RegExp(`^${c}$`, 'iu'), c]),
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PREFIX_ALT = PREFIXES.map(([p]) => esc(p)).join('|');
const ISO_ALT = ISO.join('|');
const SUFFIX_ALT = `${ISO_ALT}|dollars?|d[oó]lares?|bucks|rupees?|rupaye|rupay|rupiya|pounds?|euros?|pesos?|dirhams?`;
/** 1,234.56 · 1,00,000 · 41500 · 85.2 */
const NUM = String.raw`(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d+)?`;
const NOT_WORD_BEFORE = String.raw`(?<![\p{L}\p{N}])`;
const NOT_WORD_AFTER = String.raw`(?![\p{L}\p{N}])`;
/** Masked spans (rates already read) are replaced by this, so nothing reads them twice. */
const MASK = '\u0000';

const MONEY_PREFIX_RE = new RegExp(
  `${NOT_WORD_BEFORE}(${PREFIX_ALT})\\s?(${NUM})(?:\\s?(${ISO_ALT})${NOT_WORD_AFTER})?(?![\\d.,]*\\d)`,
  'giu',
);
const MONEY_SUFFIX_RE = new RegExp(`${NOT_WORD_BEFORE}(?<![.,])(${NUM})\\s?(${SUFFIX_ALT})${NOT_WORD_AFTER}`, 'giu');
const BARE_NUMBER_RE = new RegExp(`${NOT_WORD_BEFORE}(?<![.,])(${NUM})${NOT_WORD_AFTER}`, 'gu');

const RATE_LEFT = `(?:${NOT_WORD_BEFORE}1\\s?(?:${SUFFIX_ALT})|(?:${PREFIX_ALT})\\s?1(?:\\.0+)?)(?![\\d.,]*\\d)`;
const RATE_EXPR_RE = new RegExp(
  `${RATE_LEFT}\\s*(?:=|≈|is|equals|→|->|gets(?: you)?|buys)\\s*(?:(?:${PREFIX_ALT})\\s?)?(${NUM})(?![\\d.,]*\\d)(?:\\s?(?:${SUFFIX_ALT})${NOT_WORD_AFTER})?`,
  'giu',
);
const RATE_WORD_RE = new RegExp(
  `\\brates?\\b[^\\d\\n${MASK}]{0,30}?(?:(?:${PREFIX_ALT})\\s?)?(${NUM})(?![\\d.,]*\\d)(?!\\s?(?:%|min|mins|minutes?|hours?|days?|business))`,
  'giu',
);

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const DAY_NUM = String.raw`\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten`;
const RANGE = String.raw`(?:\s?(?:-|–|—|to|or)\s?(${DAY_NUM}))?`;
const BUSINESS_DAYS_RE = new RegExp(
  `${NOT_WORD_BEFORE}(${DAY_NUM})${RANGE}\\s?(?:business|working|bank)[\\s-]days?\\b`,
  'giu',
);
// A promise of delivery, never a past one: "arrived today" is a status.
const DELIVERY_VERB = String.raw`(?:arrives?|arriving|deliver(?:s|ing)?|be (?:delivered|credited|paid out)|receives?|receiving|gets? (?:it|the money|their money|the funds))`;
const DELIVERY_DAYS_RE = new RegExp(
  `\\b${DELIVERY_VERB}\\b[^.!?\\n${MASK}]{0,30}?\\b(?:in|within|by|after|over)\\s+(${DAY_NUM})${RANGE}\\s+days?\\b`,
  'giu',
);
const SAME_DAY_RE = /\bsame[\s-](?:business[\s-])?day\b/giu;
const DELIVERY_WHEN_RE = new RegExp(`\\b${DELIVERY_VERB}\\b[^.!?\\n${MASK}]{0,30}?\\b(today|tomorrow)\\b`, 'giu');

const MONTH = String.raw`jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?`;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DATE_DAY_MONTH_RE = new RegExp(`(?<!\\p{N})(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})\\.?(?!\\p{L})`, 'giu');
const DATE_MONTH_DAY_RE = new RegExp(`(?<!\\p{L})(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\p{N})`, 'giu');
const ISO_DATE_RE = /(?<!\d)\d{4}-(\d{2})-(\d{2})(?!\d)/gu;

const HEDGE_BEFORE =
  /(?:\b(?:about|around|approx(?:\.|imately)?|roughly|nearly|almost|estimated|some|lagbhag|takriban|aprox(?:\.|imadamente)?|alrededor de|unos|cerca de)|[~≈])\s*$/iu;

// ── Small helpers ────────────────────────────────────────────────────────────

function norm(text: unknown): string {
  return typeof text === 'string' ? text.normalize('NFKC') : '';
}

function parseNum(raw: string): { value: number; decimals: number } {
  const clean = raw.replace(/,/g, '');
  const dot = clean.indexOf('.');
  return { value: Number(clean), decimals: dot === -1 ? 0 : clean.length - dot - 1 };
}

function dayNum(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const w = WORD_NUMBERS[raw.toLowerCase()];
  return w ?? Number(raw);
}

function prefixCurrency(mark: string): string {
  const hit = PREFIXES.find(([p]) => p.toLowerCase() === mark.toLowerCase());
  return hit ? hit[1] : DOLLAR;
}

function suffixCurrency(word: string): string | undefined {
  return SUFFIXES.find(([re]) => re.test(word))?.[1];
}

function compatible(fact: string | undefined, shown: string | undefined): boolean {
  if (!fact || !shown || fact === shown) return true;
  if (fact === DOLLAR) return DOLLAR_LIKE.has(shown);
  if (shown === DOLLAR) return DOLLAR_LIKE.has(fact);
  return false;
}

/** The fact, rounded to the decimals the reply shows, is the figure shown. */
function sameFigure(fact: number, shown: number, decimals: number): boolean {
  if (!Number.isFinite(fact) || !Number.isFinite(shown)) return false;
  if (Math.abs(fact - shown) < 0.005) return true;
  const p = 10 ** Math.min(decimals, 6);
  return Math.abs(Math.round(fact * p) / p - shown) < 1e-9;
}

function mask(text: string, start: number, length: number): string {
  return text.slice(0, start) + MASK.repeat(length) + text.slice(start + length);
}

function monthDay(month: string, day: number): string | undefined {
  const m = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
  if (m === -1 || !Number.isInteger(day) || day < 1 || day > 31) return undefined;
  return `${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

interface Found<T> {
  value: T;
  text: string;
  start: number;
}

function* moneyIn(text: string): Generator<Found<{ value: number; decimals: number; currency: string }>> {
  let t = text;
  const found: Array<Found<{ value: number; decimals: number; currency: string }>> = [];
  for (const m of t.matchAll(MONEY_PREFIX_RE)) {
    const n = parseNum(m[2]);
    const currency = m[3] ? m[3].toUpperCase() : prefixCurrency(m[1]);
    found.push({ value: { ...n, currency }, text: m[0].trim(), start: m.index ?? 0 });
  }
  for (const f of found) t = mask(t, f.start, f.text.length);
  for (const m of t.matchAll(MONEY_SUFFIX_RE)) {
    const currency = suffixCurrency(m[2]);
    if (!currency) continue;
    found.push({ value: { ...parseNum(m[1]), currency }, text: m[0].trim(), start: m.index ?? 0 });
  }
  yield* found;
}

function* ratesIn(text: string): Generator<Found<{ value: number; decimals: number }>> {
  // "1 USD = ₹85.20" first, masked, so "rate is 1 USD = …" never reads the 1 as a rate.
  let rest = text;
  for (const m of text.matchAll(RATE_EXPR_RE)) {
    rest = mask(rest, m.index ?? 0, m[0].length);
    yield { value: parseNum(m[1]), text: m[0].trim(), start: m.index ?? 0 };
  }
  for (const m of rest.matchAll(RATE_WORD_RE)) yield { value: parseNum(m[1]), text: m[0].trim(), start: m.index ?? 0 };
}

function* daysIn(text: string): Generator<Found<number[]>> {
  for (const re of [BUSINESS_DAYS_RE, DELIVERY_DAYS_RE]) {
    for (const m of text.matchAll(re)) {
      const nums = [dayNum(m[1]), dayNum(m[2])].filter((n): n is number => n !== undefined && Number.isFinite(n));
      const at = re === BUSINESS_DAYS_RE ? m[0] : m[0].slice(m[0].search(/\b(?:in|within|by|after|over)\s/iu));
      yield { value: nums, text: at.trim(), start: m.index ?? 0 };
    }
  }
  for (const m of text.matchAll(SAME_DAY_RE)) yield { value: [0], text: m[0], start: m.index ?? 0 };
  for (const m of text.matchAll(DELIVERY_WHEN_RE)) {
    yield { value: [m[1].toLowerCase() === 'today' ? 0 : 1], text: m[1], start: m.index ?? 0 };
  }
}

function* datesIn(text: string): Generator<Found<string>> {
  for (const m of text.matchAll(DATE_DAY_MONTH_RE)) {
    const md = monthDay(m[2], Number(m[1]));
    if (md) yield { value: md, text: m[0].trim(), start: m.index ?? 0 };
  }
  for (const m of text.matchAll(DATE_MONTH_DAY_RE)) {
    const md = monthDay(m[1], Number(m[2]));
    if (md) yield { value: md, text: m[0].trim(), start: m.index ?? 0 };
  }
}

/** The text with every rate expression masked, plus the rates read. */
function splitRates(text: string): { rest: string; rates: Array<Found<{ value: number; decimals: number }>> } {
  const rates = [...ratesIn(text)];
  let rest = text;
  for (const r of rates) rest = mask(rest, r.start, r.text.length);
  return { rest, rates };
}

// ── Facts ────────────────────────────────────────────────────────────────────

/**
 * Add the figures in free text. `tool`: text a tool returned (money, rates,
 * day phrases, dates; any other number counts as a figure of unknown
 * currency). `customer`: the customer's own words. Their money and bare
 * numbers go to `customerAmounts` (an echoed send amount is not drift) and
 * their dates count; a rate or a day count they typed backs nothing.
 */
export function addTextFacts(facts: ReplyFacts, text: unknown, source: 'tool' | 'customer' = 'tool'): ReplyFacts {
  const t = norm(text);
  if (!t) return facts;
  const customer = source === 'customer';
  const amounts = customer ? (facts.customerAmounts ??= []) : facts.amounts;
  const { rest, rates } = splitRates(t);
  if (!customer) for (const r of rates) facts.rates.push(r.value.value);
  let bare = rest;
  for (const m of moneyIn(rest)) {
    amounts.push({ value: m.value.value, currency: m.value.currency });
    bare = mask(bare, m.start, m.text.length);
  }
  if (!customer) for (const d of daysIn(t)) facts.days.push(...d.value);
  for (const d of datesIn(t)) facts.dates.push(d.value);
  for (const m of t.matchAll(ISO_DATE_RE)) facts.dates.push(`${m[1]}-${m[2]}`);
  for (const m of bare.matchAll(BARE_NUMBER_RE)) amounts.push({ value: parseNum(m[1]).value });
  return facts;
}

/** prompt.ts: refunds, and a reverse of a paid bill, arrive in 3-5 business days once approved. */
export const REFUND_BUSINESS_DAYS: readonly number[] = [3, 5];

/**
 * Add what the system prompt itself lets the bot state: the send minimum, the
 * per-transfer maximum and the daily caps (all USD, from the resolved limits),
 * the refund timing and the tenant's disclosed delivery days.
 */
export function addPolicyFacts(
  facts: ReplyFacts,
  p: { minUsd: number; limits: { t0DailyCapCents: number; t1DailyCapCents: number; perTransferCapCents: number; maxUsd: number }; deliveryBusinessDays: number },
): ReplyFacts {
  for (const value of [p.minUsd, p.limits.maxUsd, p.limits.t0DailyCapCents / 100, p.limits.t1DailyCapCents / 100, p.limits.perTransferCapCents / 100]) {
    if (Number.isFinite(value)) facts.amounts.push({ value, currency: 'USD' });
  }
  facts.days.push(...REFUND_BUSINESS_DAYS);
  if (Number.isFinite(p.deliveryBusinessDays)) facts.days.push(p.deliveryBusinessDays);
  return facts;
}

interface CurrencyContext {
  source?: string;
  dest?: string;
  plain?: string;
}

function iso(v: unknown): string | undefined {
  return typeof v === 'string' && /^[A-Za-z]{3}$/.test(v) ? v.toUpperCase() : undefined;
}

function addNumberFact(facts: ReplyFacts, key: string, value: number, ctx: CurrencyContext): void {
  if (!Number.isFinite(value)) return;
  const k = key.toLowerCase();
  if (/_cents$/.test(k)) {
    facts.amounts.push({ value: value / 100 });
    return;
  }
  if (/(?:^|_)rate$/.test(k)) {
    facts.rates.push(value);
    facts.amounts.push({ value, currency: ctx.dest });
    return;
  }
  if (/days?$/.test(k)) facts.days.push(value);
  if (/_usd$/.test(k)) facts.amounts.push({ value, currency: 'USD' });
  else if (/_source$/.test(k) && ctx.source) facts.amounts.push({ value, currency: ctx.source });
  else if (/^amount_(?:dest|inr|destination)$/.test(k)) facts.amounts.push({ value, currency: ctx.dest ?? (k === 'amount_inr' ? 'INR' : undefined) });
  else facts.amounts.push({ value, currency: ctx.plain });
}

/**
 * Free-text fields a tool result carries as DATA: a recipient's name or
 * nickname, a bill's description. Text in them may come from an outsider, so
 * a figure inside one never backs the reply (review fix).
 */
const FREE_TEXT_KEY =
  /(?:^|_)(?:name|names|nickname|nicknames|memo|description|label|comment|comments|address|email|bill_text|invoice_text|biller|payee|merchant|seller|buyer)$/iu;

function walk(facts: ReplyFacts, value: unknown, key: string, ctx: CurrencyContext, seen: WeakSet<object>, depth: number): void {
  if (depth > 8) return;
  if (typeof value === 'number') return addNumberFact(facts, key, value, ctx);
  if (typeof value === 'string') {
    if (!FREE_TEXT_KEY.test(key)) addTextFacts(facts, value);
    return;
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const v of value) walk(facts, v, key, ctx, seen, depth + 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  const next: CurrencyContext = {
    source: iso(obj.source_currency) ?? ctx.source,
    dest: iso(obj.destination_currency) ?? ctx.dest,
    plain: iso(obj.currency) ?? ctx.plain,
  };
  for (const [k, v] of Object.entries(obj)) walk(facts, v, k, next, seen, depth + 1);
}

/** Add every figure in a tool result (any depth). Currency comes from the record's own fields. */
export function addToolResultFacts(facts: ReplyFacts, result: unknown): ReplyFacts {
  try {
    walk(facts, result, '', {}, new WeakSet(), 0);
  } catch {
    // a hostile shape adds what it can, never throws
  }
  return facts;
}

// ── The check ────────────────────────────────────────────────────────────────

function hedged(text: string, start: number): boolean {
  return HEDGE_BEFORE.test(text.slice(Math.max(0, start - 24), start));
}

function negated(text: string, start: number): boolean {
  return CLAIM_NEGATION.test(text.slice(Math.max(0, start - 30), start));
}

function asFacts(f: unknown): ReplyFacts {
  const x = (f ?? {}) as Partial<ReplyFacts>;
  return {
    amounts: Array.isArray(x.amounts) ? x.amounts : [],
    customerAmounts: Array.isArray(x.customerAmounts) ? x.customerAmounts : [],
    rates: Array.isArray(x.rates) ? x.rates : [],
    days: Array.isArray(x.days) ? x.days : [],
    dates: Array.isArray(x.dates) ? x.dates : [],
  };
}

/** Check the raw model text of one turn against that turn's facts. */
export function checkReply(reply: string, factsIn: ReplyFacts): ReplyCheck {
  const facts = asFacts(factsIn);
  const text = norm(reply);
  const issues: ReplyIssue[] = [];
  const seen = new Set<string>();
  const add = (kind: ReplyIssueKind, found: string) => {
    const k = `${kind}:${found}`;
    if (seen.has(k)) return;
    seen.add(k);
    issues.push({ kind, found });
  };
  if (!text) return { ok: true, issues };

  for (const claim of BANNED_REPLY_CLAIMS) {
    const re = new RegExp(claim.pattern.source, claim.pattern.flags.includes('g') ? claim.pattern.flags : `${claim.pattern.flags}g`);
    for (const m of text.matchAll(re)) {
      if (!negated(text, m.index ?? 0)) add('claim', claim.id);
    }
  }

  const { rest, rates } = splitRates(text);
  for (const r of rates) {
    const ok = facts.rates.some((f) => sameFigure(f, r.value.value, r.value.decimals));
    if (!ok) add('rate', r.text);
  }

  for (const d of daysIn(rest)) {
    if (d.value.some((n) => !facts.days.includes(n))) add('delivery', d.text);
  }
  for (const d of datesIn(rest)) {
    if (!facts.dates.includes(d.value)) add('delivery', d.text);
  }

  for (const m of moneyIn(rest)) {
    if (hedged(rest, m.start)) continue;
    const { value, decimals, currency } = m.value;
    const backs = (f: MoneyFact) => compatible(f.currency, currency) && sameFigure(f.value, value, decimals);
    const ok = facts.amounts.some(backs) || (!priceContext(rest, m.start, m.text.length) && facts.customerAmounts.some(backs));
    if (!ok) add('amount', m.text);
  }

  if (offTopic(text)) add('off_topic', 'reply');

  return { ok: issues.length === 0, issues };
}

// A fee, a charge or a rate around a figure: the customer's own numbers never back it.
const PRICE_BEFORE = /\b(?:fees?|charges?|charged|commission|costs?|markup|spread|rate)\b[^.!?\n]{0,24}$/iu;
const PRICE_AFTER = /^\s*(?:fees?|charges?|commission|per\b|for each\b|for every\b|a dollar\b|\/)/iu;

function priceContext(text: string, start: number, length: number): boolean {
  return PRICE_BEFORE.test(text.slice(Math.max(0, start - 40), start)) || PRICE_AFTER.test(text.slice(start + length, start + length + 16));
}

// R56 backstop: code, or a long answer about something else.
const CODE_FENCE = /```/u;
const CODE_LINE = /^\s*(?:def |class |import |from \S+ import |function |const |let |var |public |private |#include|SELECT |INSERT |console\.log|print\(|<\/?[a-z][a-z0-9]*[ >])/gimu;
const LONG_REPLY_CHARS = 400;

function offTopic(text: string): boolean {
  if (CODE_FENCE.test(text)) return true;
  if ((text.match(CODE_LINE) ?? []).length >= 2) return true;
  return text.length > LONG_REPLY_CHARS && !mentionsRemittance(text);
}

// ── The ops alert ────────────────────────────────────────────────────────────

/**
 * The deduped ops alert for a failed check: one per tenant and hour, with the
 * kinds of issue and the mode. Never the reply text or a figure (the sealed
 * conversation log holds what the customer saw).
 */
export function replyGuardAlertFor(input: {
  tenant: string;
  /** Where the reply went, e.g. 'WhatsApp, outbox #42' or 'web chat'. */
  where: string;
  report: ReplyGuardReport;
  hour: number;
}): { message: string; dedupeKey: string } {
  const kinds = [...new Set(input.report.issues.map((i) => i.kind))].join(', ') || 'unknown';
  const outcome =
    input.report.mode === 'on'
      ? 'The reply was replaced with the fixed fallback (agent.reply_guard is on).'
      : 'Shadow mode: the reply was sent unchanged (agent.reply_guard is off).';
  return {
    message:
      `⚠️ SmartRemit ops: the bot reply guard found figures or claims that no tool result backs, or an answer outside sending money (tenant ${input.tenant}, ${input.where}; ` +
      `checks: ${kinds}). ${outcome} Read the conversation log to see what the customer was told.`,
    dedupeKey: `replyguard:${input.tenant}:${input.hour}`,
  };
}
