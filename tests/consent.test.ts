import { describe, it, expect } from 'vitest';
import {
  isOptOutKeyword,
  isResumeKeyword,
  OPT_OUT_REPLY,
  OPT_IN_REPLY,
} from '@/lib/consent';

describe('isOptOutKeyword', () => {
  it('matches exact STOP / UNSUBSCRIBE, case-insensitive and trimmed', () => {
    expect(isOptOutKeyword('STOP')).toBe(true);
    expect(isOptOutKeyword('stop')).toBe(true);
    expect(isOptOutKeyword('Stop')).toBe(true);
    expect(isOptOutKeyword('  stop  ')).toBe(true);
    expect(isOptOutKeyword('UNSUBSCRIBE')).toBe(true);
    expect(isOptOutKeyword('unsubscribe')).toBe(true);
    expect(isOptOutKeyword(' Unsubscribe ')).toBe(true);
  });

  it('does NOT match substrings or cancel (no collision with draft-cancel)', () => {
    expect(isOptOutKeyword('cancel')).toBe(false);
    expect(isOptOutKeyword('no')).toBe(false);
    expect(isOptOutKeyword('stop the transfer')).toBe(false);
    expect(isOptOutKeyword('please stop')).toBe(false);
    expect(isOptOutKeyword('stop sending')).toBe(false);
    expect(isOptOutKeyword('restart')).toBe(false);
    expect(isOptOutKeyword('')).toBe(false);
    expect(isOptOutKeyword('stopped')).toBe(false);
  });
});

describe('isResumeKeyword', () => {
  it('matches exact START / UNSTOP, case-insensitive and trimmed', () => {
    expect(isResumeKeyword('START')).toBe(true);
    expect(isResumeKeyword('start')).toBe(true);
    expect(isResumeKeyword('  Start  ')).toBe(true);
    expect(isResumeKeyword('UNSTOP')).toBe(true);
    expect(isResumeKeyword('unstop')).toBe(true);
  });

  it('does NOT match substrings or near-words', () => {
    expect(isResumeKeyword('started')).toBe(false);
    expect(isResumeKeyword('kickstart')).toBe(false);
    expect(isResumeKeyword('restart')).toBe(false);
    expect(isResumeKeyword('start sending')).toBe(false);
    expect(isResumeKeyword('')).toBe(false);
  });
});

describe('consent reply copy', () => {
  it('opt-out reply tells the user how to resume', () => {
    expect(OPT_OUT_REPLY).toMatch(/START/);
  });
  it('opt-in reply confirms resubscription', () => {
    expect(OPT_IN_REPLY.length).toBeGreaterThan(0);
  });
});
