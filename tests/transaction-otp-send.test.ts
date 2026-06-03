import { describe, it, expect } from 'vitest';
import { transactionOtpMessage } from '@/lib/whatsapp-templates';

describe('transactionOtpMessage', () => {
  it('includes the code and an expiry note, and reads as a payment-confirmation prompt', () => {
    const msg = transactionOtpMessage('123456');
    expect(msg).toContain('123456');
    expect(msg).toMatch(/expir|minute/i);
    expect(msg).toMatch(/confirm|send|pay/i);
  });
});
