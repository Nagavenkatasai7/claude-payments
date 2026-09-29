import { describe, it, expect } from 'vitest';
import { INVITE_ROLES, parseInviteEmail, parseInviteName, parseInviteRole } from '@/lib/staff-invite-input';

// UI redesign M3-8: the invite form's input rules (pure).
describe('parseInviteEmail', () => {
  it('accepts one plain address, trimmed', () => {
    expect(parseInviteEmail('  new.person+ops@example.co.uk ')).toBe('new.person+ops@example.co.uk');
    expect(parseInviteEmail('A.B@Example.test')).toBe('A.B@Example.test');
  });
  it('refuses non-strings, blanks, no domain dot, spaces, lists, CR/LF, quotes, angle brackets and > 254 chars', () => {
    for (const v of [null, undefined, 42, '', '   ', 'nope', 'a@b', 'a b@example.test', 'a@example.test,b@example.test',
      'a@example.test;b@example.test', 'a@example.test\r\nBcc: x@evil.test', 'a@exam\nple.test', '"q"@example.test',
      '<a@example.test>', 'a@-bad.test', 'a@bad-.test', 'a@@example.test', `${'a'.repeat(250)}@example.test`, 'a@example.test ' + 'b']) {
      expect(parseInviteEmail(v as never), String(v)).toBeNull();
    }
  });
});

describe('parseInviteName', () => {
  it('1 to 80 characters after trim, internal whitespace collapsed', () => {
    expect(parseInviteName('  Ada   Lovelace ')).toBe('Ada Lovelace');
    expect(parseInviteName('n'.repeat(80))).toBe('n'.repeat(80));
  });
  it('refuses blanks, > 80 characters, control characters and non-strings', () => {
    for (const v of ['', '   ', 'n'.repeat(81), 'a\u0000b', 'a\u007fb', null, 7]) expect(parseInviteName(v as never)).toBeNull();
  });
});

describe('parseInviteRole', () => {
  it('exactly the four partner roles', () => {
    expect([...INVITE_ROLES]).toEqual(['admin', 'agent', 'support', 'finance']);
    for (const r of INVITE_ROLES) expect(parseInviteRole(r)).toBe(r);
  });
  it('refuses anything else', () => {
    for (const v of ['', 'platform', 'owner', 'Admin', ' admin', 'root', null, undefined, 1]) expect(parseInviteRole(v as never)).toBeNull();
  });
});
