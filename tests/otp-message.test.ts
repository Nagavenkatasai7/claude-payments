import { describe, it, expect } from 'vitest';
import { otpMessage } from '@/lib/whatsapp-templates';

describe('otpMessage', () => {
  it('includes the code, an expiry note, and a do-not-share warning', () => {
    const msg = otpMessage('482913');
    expect(msg).toContain('482913');
    expect(msg).toMatch(/expir|minute/i);
    expect(msg).toMatch(/code/i);
    expect(msg).toMatch(/don.?t share|do not share|never share/i);
  });
});
