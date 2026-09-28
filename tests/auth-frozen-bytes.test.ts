import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// src/lib/auth.ts is shared with the compliance loop (UI redesign SPEC §6b: one file, one owner).
// UI redesign M3-1 may only ADD imports and ONE appended export; every pre-existing byte stays.
// Frozen @ 96c8933, computed with `git show 96c8933:src/lib/auth.ts | shasum -a 256`.
// A later PR that changes an existing gate on purpose (announced to the owner first) updates
// this pin, and the list below, in the same PR.
// UI redesign M3-6 (the finance role): ONE line inserted into requireStaff (INSERTED_LINES) and
// a second appended block (M3_6_MARKER) with exactly two exports. The 96c8933 pin still holds
// once those are stripped, so every other pre-existing byte is unchanged.
const AUTH_TS_ORIGINAL_SHA = 'c176d7c74b5526668745310f02effa39d123e9e6cad90bd51338f882a906095a'; // gitleaks:allow (SHA-256 digest, not a secret)
const ADDED_IMPORTS = [
  "import { decidePartnerAccess, type PartnerCtx, type PartnerPolicy } from './partner-access';",
  "import { partnerMfaEnrolmentPending } from './partner-mfa-gate';",
];
const APPENDED_MARKER = '// UI redesign M3 (SPEC §3): requirePartnerStaff.';
const M3_6_MARKER = '// UI redesign M3-6: the finance role.';
const INSERTED_LINES = [
  "  if (!isLegacyDashboardStaff(staff)) redirect(staff.role === 'finance' ? '/partner' : '/login');",
];

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const src = () => readFileSync('src/lib/auth.ts', 'utf8');

describe('src/lib/auth.ts: existing gates are byte-identical (M3-1 is additive only)', () => {
  it('removing the added imports and the appended block restores the 96c8933 bytes exactly', () => {
    const text = src();
    const at = text.indexOf(`\n${APPENDED_MARKER}`);
    expect(at).toBeGreaterThan(0);
    const head = text.slice(0, at);
    const lines = head.split('\n');
    for (const imp of ADDED_IMPORTS) expect(lines.filter((l) => l === imp)).toHaveLength(1);
    for (const ins of INSERTED_LINES) expect(lines.filter((l) => l === ins)).toHaveLength(1);
    const original = lines.filter((l) => !ADDED_IMPORTS.includes(l) && !INSERTED_LINES.includes(l)).join('\n');
    expect(sha(original)).toBe(AUTH_TS_ORIGINAL_SHA);
  });
  it('the added imports sit in the import block (after the original 10 import lines)', () => {
    const lines = src().split('\n');
    expect(lines.slice(10, 10 + ADDED_IMPORTS.length)).toEqual(ADDED_IMPORTS);
  });
  it('M3-6 inserts its one line directly after requireStaff\'s anonymous bounce', () => {
    const text = src();
    expect(text).toContain(
      "export async function requireStaff(): Promise<Staff> {\n  const staff = await getCurrentStaff();\n  if (!staff) redirect('/login');\n" +
        INSERTED_LINES[0] +
        '\n  return staff;\n}',
    );
  });
  it('the M3-6 block comes last and declares exactly two exports: isLegacyDashboardStaff, requireStaffSelf', () => {
    const text = src();
    const at = text.indexOf(`\n${M3_6_MARKER}`);
    expect(at).toBeGreaterThan(text.indexOf(APPENDED_MARKER));
    const exports = text.slice(at).match(/^export\s+[^\n]*/gm) ?? [];
    expect(exports).toHaveLength(2);
    expect(exports[0]).toMatch(/^export function isLegacyDashboardStaff\(/);
    expect(exports[1]).toMatch(/^export async function requireStaffSelf\(/);
  });
  it('the appended block declares exactly one export: requirePartnerStaff', () => {
    const text = src();
    const tail = text.slice(text.indexOf(APPENDED_MARKER), text.indexOf(`\n${M3_6_MARKER}`));
    const exports = tail.match(/^export\s+[^\n]*/gm) ?? [];
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatch(/^export async function requirePartnerStaff\(/);
  });
});
