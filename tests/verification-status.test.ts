import { describe, it, expect } from 'vitest';
import {
  verificationStatusParams,
  verificationStatusFallbackText,
  type VerificationState,
} from '@/lib/whatsapp-templates';

const STATES: VerificationState[] = ['needed', 'in_progress', 'received', 'verified', 'failed'];

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

describe('verificationStatusFallbackText (free-form, no template configured)', () => {
  it('greets by name for every state', () => {
    for (const s of STATES) {
      const msg = verificationStatusParams('Anand', s)[1];
      expect(verificationStatusFallbackText('Anand', s)).toBe(`Hi Anand — ${msg}`);
    }
  });

  it('omits the greeting entirely when the name is missing — never "there,"', () => {
    for (const s of STATES) {
      const msg = verificationStatusParams('x', s)[1];
      for (const name of [undefined, '', '   ']) {
        const text = verificationStatusFallbackText(name, s);
        expect(text).toBe(msg);
        expect(text.startsWith('there')).toBe(false);
      }
    }
  });

  it('regression: the in_progress text reads naturally in both forms', () => {
    expect(verificationStatusFallbackText('Anand', 'in_progress')).toBe(
      'Hi Anand — Your identity verification is in progress.',
    );
    expect(verificationStatusFallbackText(undefined, 'in_progress')).toBe(
      'Your identity verification is in progress.',
    );
  });
});
