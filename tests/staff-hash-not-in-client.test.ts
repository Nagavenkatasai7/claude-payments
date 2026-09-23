import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { toStaffOptions, type StaffOption } from '@/lib/staff-options';
import type { Staff } from '@/lib/types';

/**
 * Program-Fix 20 (F56): a full `Staff` record carries `passwordHash`. Anything a
 * client component receives is serialized into the RSC flight payload of every
 * browser that renders it, so no `'use client'` module may even TYPE a prop as
 * `Staff`: the transactions assign dropdown gets `StaffOption` ({ username, name }).
 * React's taint API needs an experimental Next flag, so this static scan is the guard.
 */

const SRC = join(__dirname, '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx?|jsx?)$/.test(name) ? [p] : [];
  });
}

const USE_CLIENT = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/;
// Any import (type or value, single- or multi-line) of `Staff` from a `…/types` module.
const STAFF_IMPORT = /import\s+(?:type\s+)?\{[^}]*\bStaff\b[^}]*\}\s*from\s*['"][^'"]*\/types['"]/;

describe('no client component can receive a Staff record (fix 20, F56)', () => {
  it('finds the client modules it is guarding (the scan is not vacuous)', () => {
    const clients = walk(SRC).filter((f) => USE_CLIENT.test(readFileSync(f, 'utf8')));
    expect(clients.map((f) => relative(SRC, f))).toContain('app/admin-dashboard/transactions-tabs.tsx');
  });

  it("no 'use client' file imports the Staff type", () => {
    const offenders = walk(SRC)
      .filter((f) => {
        const text = readFileSync(f, 'utf8');
        return USE_CLIENT.test(text) && STAFF_IMPORT.test(text);
      })
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('the pin regex catches the shapes it must (self-test)', () => {
    expect(STAFF_IMPORT.test("import type { Partner, Staff, Tier } from '@/lib/types';")).toBe(true);
    expect(STAFF_IMPORT.test('import {\n  Staff,\n  Tier,\n} from "../lib/types";')).toBe(true);
    expect(STAFF_IMPORT.test("import type { StaffOption } from '@/lib/staff-options';")).toBe(false);
    expect(STAFF_IMPORT.test("import type { StaffRole } from '@/lib/types';")).toBe(false);
  });
});

describe('toStaffOptions (fix 20, F56)', () => {
  it('projects to exactly { username, name } — no hash, role, permissions or partner', () => {
    const full: Staff = {
      username: 'priya',
      name: 'Priya',
      role: 'admin',
      permissions: { canCancel: true, canResend: true, canAssign: true },
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const out = toStaffOptions([full]);
    expect(out).toEqual([{ username: 'priya', name: 'Priya' }]);
    expect(Object.keys(out[0]).sort()).toEqual(['name', 'username']);
    expect(JSON.stringify(out)).not.toContain('argon2');
  });
});

describe('StaffOption rejects a full Staff at compile time (fix 20, review L1)', () => {
  it('a Staff (it carries passwordHash) is not assignable to StaffOption — tsc enforces the @ts-expect-error', () => {
    const full = {
      username: 'x',
      name: 'X',
      role: 'agent',
      permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: 'h',
      createdAt: '2026-01-01T00:00:00.000Z',
    } satisfies Staff;
    // @ts-expect-error — reverting the page to `staff={allStaff}` must not type-check.
    const leaked: StaffOption[] = [full as Staff];
    expect(leaked).toHaveLength(1);
  });
});
