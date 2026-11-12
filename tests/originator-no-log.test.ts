import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Fix pack 5 (D8, P18): the travel-rule originator values (the sender's address
// and date of birth) never reach a log line or an ops alert. src/lib/log.ts
// redacts them by key as a backstop; this static guard keeps the code from
// passing them in the first place. A call `logWarn(` / `logError(` /
// `console.<fn>(` / `enqueue('ops.alert'` whose argument text (up to its
// matching close paren) names one of the identifiers below fails the build.

const ROOT = join(__dirname, '..', 'src');
const ORIGINATOR_IDENT = /\b(?:senderAddress|senderDob|residentialAddress|dateOfBirth)\b/;
const CALL_START = /\blogWarn\s*\(|\blogError\s*\(|\bconsole\.[A-Za-z]+\s*\(|\benqueue\s*\(\s*['"]ops\.alert['"]/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/**
 * The argument text of the call whose opening paren is at or after `from`:
 * up to the matching close paren. Parens inside '...' and "..." strings are
 * not counted (a template literal is read as code, so `${dateOfBirth}` counts).
 */
function argumentText(text: string, from: number): string {
  const open = text.indexOf('(', from);
  if (open < 0) return '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** Offending `file:line` hits in one source text. */
function originatorLogCalls(file: string, text: string): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(CALL_START)) {
    const start = m.index ?? 0;
    if (ORIGINATOR_IDENT.test(argumentText(text, start))) {
      hits.push(`${file}:${text.slice(0, start).split('\n').length}`);
    }
  }
  return hits;
}

describe('originator values never reach a log or an ops alert (static guard, fix pack 5 P18)', () => {
  it('the guard catches every call shape and lets other calls through (positive and negative controls)', () => {
    expect(originatorLogCalls('x.ts', "logWarn('x', 'y', { senderDob })")).toEqual(['x.ts:1']);
    expect(originatorLogCalls('x.ts', "\nlogError('x', err, {\n  transferId,\n  senderAddress: v,\n})")).toEqual(['x.ts:2']);
    expect(originatorLogCalls('x.ts', 'console.log(c.residentialAddress)')).toEqual(['x.ts:1']);
    expect(originatorLogCalls('x.ts', "await outbox.enqueue('ops.alert', { message: `dob ${dateOfBirth}` })")).toEqual(['x.ts:1']);
    expect(originatorLogCalls('x.ts', "outbox.enqueue(\n  'ops.alert', { message: m(c.dateOfBirth) })")).toEqual(['x.ts:1']);
    expect(originatorLogCalls('x.ts', "logWarn('x', 'y', { transferId }); const dateOfBirth = 1;")).toEqual([]);
    expect(originatorLogCalls('x.ts', "logWarn('a)', fn(b), { id }); save({ senderDob })")).toEqual([]);
    expect(originatorLogCalls('x.ts', "outbox.enqueue('whatsapp.send', { senderDob })")).toEqual([]);
  });

  it('no file under src/ logs or alerts an originator value', () => {
    const hits = walk(ROOT).flatMap((f) => originatorLogCalls(relative(ROOT, f), readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
