import { describe, it, expect } from 'vitest';
import { verificationStatusParams, type VerificationState } from '@/lib/whatsapp-templates';

describe('verificationStatusParams', () => {
  it('builds [name, message] for each state', () => {
    const states: VerificationState[] = ['needed', 'in_progress', 'received', 'verified', 'failed'];
    for (const s of states) {
      const [name, msg] = verificationStatusParams('Jane', s);
      expect(name).toBe('Jane');
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it('verified message mentions being verified; failed message invites a retry', () => {
    expect(verificationStatusParams('Jane', 'verified')[1]).toMatch(/verified/i);
    expect(verificationStatusParams('there', 'failed')[1]).toMatch(/again|couldn|could not|not/i);
  });

  it('falls back to "there" when the name is empty', () => {
    expect(verificationStatusParams('', 'needed')[0]).toBe('there');
  });
});
