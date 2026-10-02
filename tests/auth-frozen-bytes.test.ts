import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// src/lib/auth.ts is shared with the compliance loop (UI redesign SPEC §6b: one file, one owner).
// UI redesign M3-1 may only ADD imports and ONE appended export; every pre-existing byte stays.
// Frozen @ 96c8933, computed with `git show 96c8933:src/lib/auth.ts | shasum -a 256`.
// A later PR that changes an existing gate on purpose (announced to the owner first) updates
// this pin, and the list below, in the same PR.
// UI redesign M3-6 (the finance role): ONE line inserted into requireStaff (INSERTED_LINES) and
// one added import and a second appended block (M3_6_MARKER) with exactly one export. The 96c8933 pin still holds
// once those are stripped, so every other pre-existing byte is unchanged.
// UI redesign M3-9 (owner answer O10 = yes, 2026-09-28): ONE more line in requireStaff, directly after
// the M3-6 line (the legacy gates honour the invite MFA marker), and its one added import.
// UI M5 (owner approved the one-partner-dashboard plan, 2026-10-02): ONE more line in requireStaff,
// directly after the M3-9 line: partner-scoped staff are sent to /partner, so /admin-dashboard is
// SmartRemit-only. No import.
const AUTH_TS_ORIGINAL_SHA = 'c176d7c74b5526668745310f02effa39d123e9e6cad90bd51338f882a906095a'; // gitleaks:allow (SHA-256 digest, not a secret)
const ADDED_IMPORTS = [
  "import { decidePartnerAccess, type PartnerCtx, type PartnerPolicy } from './partner-access';",
  "import { partnerMfaEnrolmentPending } from './partner-mfa-gate';",
  "import { isLegacyDashboardStaff } from './legacy-dashboard-staff';", // M3-6
  "import { inviteMfaPending } from './partner-mfa-gate';", // M3-9 (O10)
];
const APPENDED_MARKER = '// UI redesign M3 (SPEC §3): requirePartnerStaff.';
const M3_6_MARKER = '// UI redesign M3-6: the finance role.';
const INSERTED_LINES = [
  "  if (!isLegacyDashboardStaff(staff)) redirect(staff.role === 'finance' ? '/partner' : '/login');",
  "  if (await inviteMfaPending(staff)) redirect('/partner/security?enroll=1'); // M3-9 (O10): invite marker",
  "  if (staff.partnerId !== undefined) redirect('/partner'); // UI M5: partner staff use /partner only",
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
  it('M3-6, M3-9 then UI M5 insert their lines directly after requireStaff\'s anonymous bounce', () => {
    const text = src();
    expect(text).toContain(
      "export async function requireStaff(): Promise<Staff> {\n  const staff = await getCurrentStaff();\n  if (!staff) redirect('/login');\n" +
        INSERTED_LINES[0] +
        '\n' +
        INSERTED_LINES[1] +
        '\n' +
        INSERTED_LINES[2] +
        '\n  return staff;\n}',
    );
  });
  it('the M3-6 block comes last and declares exactly one export: requireStaffSelf', () => {
    const text = src();
    const at = text.indexOf(`\n${M3_6_MARKER}`);
    expect(at).toBeGreaterThan(text.indexOf(APPENDED_MARKER));
    const exports = text.slice(at).match(/^export\s+[^\n]*/gm) ?? [];
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatch(/^export async function requireStaffSelf\(/);
  });
  it('the appended block declares exactly one export: requirePartnerStaff', () => {
    const text = src();
    const tail = text.slice(text.indexOf(APPENDED_MARKER), text.indexOf(`\n${M3_6_MARKER}`));
    const exports = tail.match(/^export\s+[^\n]*/gm) ?? [];
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatch(/^export async function requirePartnerStaff\(/);
  });
});
