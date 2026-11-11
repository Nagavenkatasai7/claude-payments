import { describe, it, expect } from 'vitest';
import { en } from '@/lib/i18n/catalogues/en';
import { PURPOSE_SCAM_WARNING } from '@/lib/purpose-detail';

// Fix pack 6 T14 (R47, P15) — the bot and the WhatsApp card read
// PURPOSE_SCAM_WARNING, the portal reads the catalogue key
// portal.send.scamWarning. The two must never drift.

describe('the scam warning copy (pack 6 P15)', () => {
  it('the portal catalogue string equals the constant the bot and the card use', () => {
    expect(en['portal.send.scamWarning']).toBe(PURPOSE_SCAM_WARNING);
  });

  it('is at most 300 characters (it prefixes the WhatsApp card body)', () => {
    expect(PURPOSE_SCAM_WARNING.length).toBeLessThanOrEqual(300);
  });

  it('has no line break', () => {
    expect(PURPOSE_SCAM_WARNING).not.toMatch(/[\r\n]/);
  });
});
