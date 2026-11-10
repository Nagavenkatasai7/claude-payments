// Shared fixtures for the 2026-11-10 "customer data in database error text"
// tests (C6): a fake drizzle query failure that carries fake customer values in
// its params and in the Postgres detail, a console capture, and the assertion
// that nothing printed holds those values and that one logger line has the scope.
import { inspect } from 'node:util';
import { expect, vi } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';

export const FAKE_PHONE_DIGITS = '15551234567';
export const FAKE_PHONE = `+${FAKE_PHONE_DIGITS}`;
export const FAKE_NAME = 'Ravi Traders';

/** A query failure shaped like drizzle-orm 0.45.3's (node_modules/drizzle-orm/errors.js:10-20). */
export function fakeQueryError(code = '57P01', reason = 'terminating connection'): DrizzleQueryError {
  const cause = Object.assign(new Error(reason), { code, detail: `row (${FAKE_PHONE}, ${FAKE_NAME})` });
  return new DrizzleQueryError('select * from "t" where "phone" = $1 and "name" = $2', [FAKE_PHONE, FAKE_NAME], cause);
}

export type Captured = { warn: unknown[][]; error: unknown[][] };

/** Mute and record console.warn / console.error (vi.restoreAllMocks undoes it). */
export function captureConsole(): Captured {
  const c: Captured = { warn: [], error: [] };
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { c.warn.push(a); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { c.error.push(a); });
  return c;
}

/** Every captured console argument, as Node prints it (util.inspect for non-strings). */
export function printed(c: Captured): string[] {
  return [...c.warn, ...c.error].flat().map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 })));
}

/**
 * Nothing printed holds the fake phone, the fake name or a params list (the
 * only "params" allowed is queryErrorText's fixed `params: <redacted>`), and
 * exactly one JSON logger line has `scope` at `level`. Returns that line.
 */
export function expectSafeLog(
  c: Captured,
  scope: string,
  level: 'warn' | 'error' = 'warn',
  extraSecrets: string[] = [],
): Record<string, unknown> {
  const out = printed(c);
  for (const text of out) {
    for (const secret of [FAKE_PHONE_DIGITS, FAKE_NAME, ...extraSecrets]) expect(text).not.toContain(secret);
    expect(text.replace(/params: <redacted>/g, '')).not.toMatch(/params/);
  }
  const lines = out.flatMap((t) => {
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      return j && j.scope === scope ? [j] : [];
    } catch {
      return [];
    }
  });
  expect(lines).toHaveLength(1);
  expect(lines[0].level).toBe(level);
  return lines[0];
}
