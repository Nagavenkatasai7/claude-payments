/**
 * partner-demo R5 fix round 1: the username format enforced on staff CREATE
 * (partner staff + Team page). Never on sign-in or lookup: an existing account
 * whose name predates the rule keeps working.
 */
import { describe, it, expect } from 'vitest';
import { assertNewStaffUsername, isValidNewStaffUsername } from '@/lib/staff-username';

describe('isValidNewStaffUsername', () => {
  it.each(['abc', 'acme-admin', 'e2e-smoke-partner', 'e2e-smoke-support', 'a.b_c-9', 'x'.repeat(64)])('accepts %s', (u) => {
    expect(isValidNewStaffUsername(u)).toBe(true);
  });
  it.each(['', 'ab', 'x'.repeat(65), 'Admin', 'has space', 'a:b', 'a/b', 'ünï', 'a@b.com', 'a\nb'])('rejects %j', (u) => {
    expect(isValidNewStaffUsername(u)).toBe(false);
  });
  it.each(['index', 'smartremit', 'system', 'null', 'undefined'])('rejects the reserved word %s', (u) => {
    expect(isValidNewStaffUsername(u)).toBe(false);
  });
});

describe('assertNewStaffUsername', () => {
  it('throws one generic message for any refusal', () => {
    expect(() => assertNewStaffUsername('index')).toThrow(/3.64 characters/);
    expect(() => assertNewStaffUsername('A B')).toThrow(/3.64 characters/);
    expect(() => assertNewStaffUsername('fine-name')).not.toThrow();
  });
});
