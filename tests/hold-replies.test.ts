import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BLOCK_REPLY,
  capRefusalKind,
  capRefusalReply,
  EDD_ASK,
  FIXED_REPLIES,
  fixedReply,
  HELP_SUFFIX,
  HOLD_REPLIES_VERSION,
  HOLD_REPLY,
  type FixedReplyKind,
} from '@/lib/hold-replies';

// R30 (no tipping-off): hold-replies.ts is the ONLY source of the text a
// customer sees when a transfer is held, cannot go ahead, needs more details or
// is over a sending limit. No entry may hint at a reason (a review, a report, a
// screening result) or carry a figure (a threshold, a limit, what is left today).
// The list is the R30 plan's ("review, report, compliance, sanction, threshold,
// flag, investigation, a digit or '$'") plus the S1 task's "suspicious", "AML"
// and remaining-limit wording, and the near-synonyms that say the same thing.
const BANNED_WORDS = [
  'review',
  'report',
  'suspicious',
  'suspect',
  'compliance',
  'aml',
  'sanction',
  'screening',
  'watchlist',
  'threshold',
  'flag',
  'investigat',
  'monitor',
  'notified',
  'fraud',
  'remaining',
  'left today',
  'still send',
];
const FIGURE = /[\d$£€₹¥]/;

function offences(text: string): string[] {
  const lower = text.toLowerCase();
  const found = BANNED_WORDS.filter((w) => new RegExp(`\\b${w}`).test(lower));
  if (FIGURE.test(text)) found.push('a digit or currency sign');
  return found;
}

const KINDS = Object.keys(FIXED_REPLIES) as FixedReplyKind[];

describe('hold-replies: the fixed table never tips the customer off', () => {
  it('has a version for the MLRO sign-off and at least the hold, block, EDD and cap entries', () => {
    expect(HOLD_REPLIES_VERSION).toMatch(/\S/);
    for (const k of ['hold', 'block', 'edd_ask', 'cap_daily', 'cap_per_transfer', 'cap_verify', 'cap_unavailable', 'status_held', 'timeline_held'] as const) {
      expect(KINDS).toContain(k);
    }
  });

  it.each(KINDS)('%s has no banned word, digit or currency sign', (kind) => {
    const text = FIXED_REPLIES[kind];
    expect(text.trim().length).toBeGreaterThan(0);
    expect(offences(text), `${kind}: ${text}`).toEqual([]);
  });

  it.each(KINDS)('%s stays clean with the HELP suffix and an empty provider line', (kind) => {
    const text = fixedReply(kind, { help: true, providerLine: '' });
    expect(offences(text), `${kind}: ${text}`).toEqual([]);
  });

  it('the HELP suffix itself is clean', () => {
    expect(offences(HELP_SUFFIX)).toEqual([]);
  });

  it('the named exports are the table entries', () => {
    expect(HOLD_REPLY).toBe(FIXED_REPLIES.hold);
    expect(BLOCK_REPLY).toBe(FIXED_REPLIES.block);
    expect(EDD_ASK).toBe(FIXED_REPLIES.edd_ask);
  });

  it('the banned-word check catches the wording R30 removes (the test can fail)', () => {
    for (const old of [
      'This transfer is under a quick review; we will confirm as soon as it is released.',
      'Your daily limit right now is $2,999; you have $134 left today.',
      'For transfers totaling $3,000 or more this month we are required to ask.',
      "This transfer can't be completed, and our team has been notified.",
      'This transfer did not pass compliance and cannot be paid.',
      'This is more than you can send today. You can still send {remaining} today.',
    ]) {
      expect(offences(old), old).not.toEqual([]);
    }
  });
});

describe('fixedReply: the HELP suffix, the receipt link and the provider line are parameters', () => {
  it('returns the bare entry by default', () => {
    expect(fixedReply('hold')).toBe(HOLD_REPLY);
  });

  it('appends the HELP suffix only when asked', () => {
    expect(fixedReply('block', { help: true })).toBe(`${BLOCK_REPLY} ${HELP_SUFFIX}`);
    expect(fixedReply('block', { help: false })).toBe(BLOCK_REPLY);
  });

  it('adds the receipt link on its own line, after the HELP suffix', () => {
    const url = 'https://smartremit.ai/r/abc123';
    expect(fixedReply('hold', { help: true, receiptUrl: url })).toBe(`${HOLD_REPLY} ${HELP_SUFFIX}\nReceipt: ${url}`);
  });

  it('an empty or blank provider line adds nothing (PR4 fills it)', () => {
    expect(fixedReply('hold', { providerLine: '' })).toBe(HOLD_REPLY);
    expect(fixedReply('hold', { providerLine: '   ' })).toBe(HOLD_REPLY);
  });

  it('a provider line is added last, on its own line, flattened to one line', () => {
    const line = 'Payments by Example Bank, licensed by a regulator';
    expect(fixedReply('hold', { providerLine: line })).toBe(`${HOLD_REPLY}\n${line}`);
    expect(fixedReply('hold', { providerLine: 'a\nb' })).toBe(`${HOLD_REPLY}\na b`);
  });

  it('a blank receipt link adds nothing', () => {
    expect(fixedReply('hold', { receiptUrl: '' })).toBe(HOLD_REPLY);
  });
});

describe('capRefusalReply: one fixed refusal per cap reason, never a figure', () => {
  it.each([
    ['over_daily_cap', 'cap_daily'],
    ['over_per_transfer_cap', 'cap_per_transfer'],
    ['verification_required_after_window', 'cap_verify'],
    ['verification_rejected', 'cap_unavailable'],
  ] as const)('%s → %s', (reason, kind) => {
    expect(capRefusalKind(reason)).toBe(kind);
    expect(capRefusalReply(reason)).toBe(FIXED_REPLIES[kind]);
  });

  it('an unknown or missing reason gets the neutral cannot-complete text', () => {
    expect(capRefusalKind(undefined)).toBe('cannot_complete');
    expect(capRefusalKind('something_new')).toBe('cannot_complete');
    expect(capRefusalReply(42)).toBe(FIXED_REPLIES.cannot_complete);
  });

  it('passes the options through', () => {
    expect(capRefusalReply('over_daily_cap', { help: true })).toBe(`${FIXED_REPLIES.cap_daily} ${HELP_SUFFIX}`);
  });
});

describe('R30: the removed wording does not come back in the customer-facing modules', () => {
  // The bot (prompt + tools + recent transfers), the stage-1 message, the
  // portal send copy, the AI-app server and the account summary.
  const FILES = [
    'src/lib/prompt.ts',
    'src/lib/tools.ts',
    'src/lib/recent-transfers.ts',
    'src/lib/payment.ts',
    'src/lib/portal-send.ts',
    'src/lib/mcp/tools.ts',
    'src/lib/mcp/prepare.ts',
    'src/lib/customer-summary.ts',
    'src/lib/i18n/catalogues/en.ts',
  ];
  const GONE = [
    'left today',
    'quick review',
    '$3,000 or more',
    '$134',
    'our team has been notified',
    'did not pass compliance',
    'can still send',
    'today_remaining_usd',
    'remaining_today_usd',
    'edd_threshold_usd',
    'under review by our team',
    'currently under review',
  ];
  it.each(FILES)('%s', (rel) => {
    const src = readFileSync(resolve(process.cwd(), rel), 'utf-8');
    for (const phrase of GONE) expect(src.includes(phrase), `${rel} still has "${phrase}"`).toBe(false);
  });
});
