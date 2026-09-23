import { describe, it, expect } from 'vitest';
import {
  isOptOutKeyword,
  isResumeKeyword,
  OPT_OUT_REPLY,
  OPT_IN_REPLY,
  OPT_OUT_REMINDER,
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

  it('opt-out STATE reminder tells an already-unsubscribed user to reply START to resume', () => {
    // Distinct from OPT_OUT_REPLY (which confirms a *fresh* STOP). This is the
    // brief nudge sent when an already-opted-out user sends a normal message.
    expect(OPT_OUT_REMINDER).toBe(
      "You're unsubscribed from SmartRemit. Reply START to resume.",
    );
    expect(OPT_OUT_REMINDER).toMatch(/START/);
    expect(OPT_OUT_REMINDER).not.toBe(OPT_OUT_REPLY);
  });
});

// Program-Fix 49A: the reminder carries the tenant's brand; media gets an honest reply.
describe('optOutReminder / MEDIA_REPLY (Program-Fix 49A)', () => {
  it('optOutReminder(brand) names the partner; OPT_OUT_REMINDER stays the SmartRemit default', async () => {
    const { optOutReminder } = await import('@/lib/consent');
    expect(optOutReminder('Acme Remit')).toBe("You're unsubscribed from Acme Remit. Reply START to resume.");
    expect(optOutReminder('')).toBe(OPT_OUT_REMINDER);
  });

  it('MEDIA_REPLY says only typed messages are read and warns against ID photos and bank details', async () => {
    const { MEDIA_REPLY } = await import('@/lib/consent');
    expect(MEDIA_REPLY).toBe(
      'I can only read typed messages here. Please type your question. Never send ID photos or bank details in chat.',
    );
  });
});
