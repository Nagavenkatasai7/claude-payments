import { describe, it, expect } from 'vitest';
import { wizardDoneCopy } from '@/app/admin-dashboard/partners/new/wizard-copy';

// Pack 3 T13: the wizard's done screen says whether the first key is live or a sandbox key.
describe('wizardDoneCopy', () => {
  it('live: the strings the done screen showed before (byte for byte)', () => {
    const c = wizardDoneCopy('live');
    expect(c.title('Acme')).toBe('🎉 Acme is live');
    expect(c.keyLabel).toBe('API key (shown once — store it in your secret manager)');
    expect(c.keyLine('a1b2')).toBe('✅ API key issued (…a1b2)');
  });

  it('test: sandbox until go-live is approved', () => {
    const c = wizardDoneCopy('test');
    expect(c.title('Acme')).toBe('Acme is set up (sandbox until go-live is approved)');
    expect(c.keyLabel).toBe('Sandbox API key (shown once — store it in your secret manager)');
    expect(c.keyLine('a1b2')).toBe(
      '✅ Sandbox API key issued (…a1b2). Live keys come after SmartRemit approves go-live on the partner page.',
    );
  });
});
