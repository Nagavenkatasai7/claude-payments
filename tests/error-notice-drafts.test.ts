import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ERROR_NOTICE_TEXT_VERSION,
  CASE_ADD_INFO_HINT_CHAT,
  CASE_ADD_INFO_HINT_PAGE,
  CASE_REPLY_PROVIDER_MAX,
  CASE_SUBJECT_PREFIX,
  COMPLAINT_CASE_SUBJECT,
  formatCaseDate,
  caseOpenedReply,
  caseSubject,
  alsoReportedNote,
  caseNoticeLine,
  caseClassNote,
} from '@/lib/legal/error-notice-drafts';
import { REPORT_CODES, reportCodeOf } from '@/lib/error-notice';
import { PROVIDER_LINE_MAX } from '@/lib/legal/provider-line';

// Pack 8 (R44, P10): the fixed texts of a regulatory case. Drafts for counsel;
// never an outcome, a refund promise, a class word or a check word.

const DAY = 86_400_000;
const dueAt = new Date(Date.now() + 90 * DAY).toISOString();
const LINE = 'Payments by Acme Remit Inc, licensed by the State Banking Dept';
const SRC = readFileSync(resolve(process.cwd(), 'src/lib/legal/error-notice-drafts.ts'), 'utf-8');

const reply = (o: Partial<Parameters<typeof caseOpenedReply>[0]> = {}) =>
  caseOpenedReply({ caseId: 'tk_abc1', dueAt, providerLine: null, reused: false, surface: 'chat', ...o });

describe('error-notice-drafts', { retry: 0 }, () => {
  it('version is a counsel draft', () => {
    expect(ERROR_NOTICE_TEXT_VERSION).toMatch(/-draft$/);
  });

  it('the reply names the case and the date', () => {
    const chat = reply();
    expect(chat).toContain('tk_abc1');
    expect(chat).toContain(formatCaseDate(dueAt));
    expect(chat).toContain(CASE_ADD_INFO_HINT_CHAT);
    expect(chat.startsWith('We have recorded your report.')).toBe(true);
    expect(chat).toBe(
      `We have recorded your report. Your case reference is tk_abc1. We will tell you the result by ${formatCaseDate(dueAt)}. ${CASE_ADD_INFO_HINT_CHAT}`,
    );
    const page = reply({ surface: 'page' });
    expect(page).toContain(CASE_ADD_INFO_HINT_PAGE);
    expect(page).not.toMatch(/replying here/i);
    expect(CASE_ADD_INFO_HINT_CHAT).toBe('You can add information by replying here or in your case in your account.');
    expect(CASE_ADD_INFO_HINT_PAGE).toBe('You can add information in your case in your account.');
    expect(reply({ reused: true }).startsWith('We have added this to your open case.')).toBe(true);
  });

  it('formatCaseDate is the long en-US UTC date', () => {
    expect(formatCaseDate(dueAt)).toBe(
      new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(dueAt)),
    );
    const late = new Date(Date.now() + 10 * DAY);
    late.setUTCHours(23, 30, 0, 0);
    const utcDay = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(late);
    expect(formatCaseDate(late.toISOString())).toBe(utcDay);
    expect(formatCaseDate(late.toISOString())).toContain(String(late.getUTCDate()));
    expect(() => formatCaseDate('nope')).toThrow(RangeError);
  });

  it('provider line', () => {
    for (const p of [null, '', '   ']) {
      const r = reply({ providerLine: p });
      expect(r).not.toMatch(/licensed/i);
      expect(r).not.toMatch(/Payments by/);
      expect(r).toBe(reply());
    }
    const r = reply({ providerLine: LINE });
    expect(r.split(LINE).length - 1).toBe(1);
    expect(r).toContain(`${LINE}.`);
    expect(r).toContain(`by ${formatCaseDate(dueAt)}. ${LINE}. ${CASE_ADD_INFO_HINT_CHAT}`);
    expect(reply({ providerLine: `${LINE}.` })).not.toContain(`${LINE}..`);
    expect(reply({ providerLine: `${LINE}.` })).toContain(`${LINE}. `);
    const long = 'x'.repeat(300);
    const cut = reply({ providerLine: long });
    expect(cut).toContain(`${'x'.repeat(200)}.`);
    expect(cut).not.toContain('x'.repeat(201));
    const nl = reply({ providerLine: 'Payments by Acme\n  Remit,  licensed by X' });
    expect(nl).toContain('Payments by Acme Remit, licensed by X.');
    expect(nl).not.toContain('\n');
  });

  it('banned words (P10)', () => {
    const banned = [
      /refund/i, /guarantee/i, /returned/i, /recover/i, /fraud/i, /complaint/i, /error notice/i, /review/i,
      /compliance/i, /sanction/i, /screening/i, /\bflag/i, /investigat/i, /partner/i,
    ];
    const texts = [CASE_ADD_INFO_HINT_CHAT, CASE_ADD_INFO_HINT_PAGE];
    for (const reused of [false, true])
      for (const providerLine of [null, LINE])
        for (const surface of ['chat', 'page'] as const) texts.push(reply({ reused, providerLine, surface }));
    for (const t of texts) for (const b of banned) expect(t, `${b} in ${t}`).not.toMatch(b);
  });

  it('no outcome promise', () => {
    for (const reused of [false, true])
      for (const surface of ['chat', 'page'] as const)
        expect(reply({ reused, surface })).not.toMatch(
          /will (get|receive) (your )?money|money back|will be (fixed|reversed|cancelled)/i,
        );
  });

  it('no approval wording in the module', () => {
    expect(SRC).not.toMatch(/approv/i);
  });

  it('the module is pure', () => {
    const imports = SRC.match(/^\s*import\b.*$/gm) ?? [];
    for (const line of imports) expect(line, line).toMatch(/^\s*import type\b/);
    expect(SRC).not.toMatch(/\bfrom\s+['"]node:/);
    expect(SRC).not.toMatch(/Date\.now/);
  });

  it('staff strings are enum-only', () => {
    expect(caseSubject('wrong_amount')).toBe('Recall request: wrong_amount');
    expect(caseSubject('wrong_amount').startsWith(CASE_SUBJECT_PREFIX)).toBe(true);
    expect(COMPLAINT_CASE_SUBJECT).toBe('Complaint');
    const ALSO_REPORTED = /^Also reported: ([a-z_]+)\./;
    for (const c of REPORT_CODES) {
      // the subject round-trips through error-notice's reportCodeOf (the two prefixes stay equal)
      expect(reportCodeOf({ regClass: null, subject: caseSubject(c) })).toBe(c);
      expect(alsoReportedNote(c)).toBe(`Also reported: ${c}.`);
      expect(ALSO_REPORTED.exec(alsoReportedNote(c))?.[1]).toBe(c);
      const line = caseNoticeLine({ code: c, dueAt });
      const outside = line.replace(`(${c})`, '()');
      expect(outside).not.toMatch(/fraud|complaint|error notice|cancellation/i);
    }
    expect(caseNoticeLine({ code: 'not_received', dueAt })).toBe(
      `The customer reported a problem with this transfer (not_received). Due: ${formatCaseDate(dueAt)}.`,
    );
    expect(caseNoticeLine({ code: 'not_received', dueAt: null }).endsWith('Due: none.')).toBe(true);
    expect(caseClassNote('fraud_report')).toBe('Class: fraud_report.');
  });

  it('the provider cap equals pack 4\'s', () => {
    expect(CASE_REPLY_PROVIDER_MAX).toBe(PROVIDER_LINE_MAX);
  });
});
