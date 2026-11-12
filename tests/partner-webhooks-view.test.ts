import { describe, it, expect } from 'vitest';
import { RAIL_SECRET_GRACE_MS } from '@/lib/partner-integrations';
import { parseSecretKind, webhookConfigView } from '@/lib/partner-webhooks-view';

// UI redesign M3-15a: the pure view of the partner's settlement webhook config. It is the ONLY
// thing the page renders from the decrypted integrations row: never a secret value.

const now = new Date('2026-09-29T12:00:00Z');
const later = new Date(now.getTime() + RAIL_SECRET_GRACE_MS).toISOString();

describe('webhookConfigView', () => {
  it('an empty config → mock rail, not partner-operated, nothing set', () => {
    expect(webhookConfigView({ kyc: {}, payment: {}, whatsapp: {} }, now)).toEqual({
      railType: 'mock',
      partnerRail: false,
      endpoint: null,
      eventsUrl: null,
      signing: { set: false, previousUntil: null },
      webhook: { set: false, previousUntil: null },
    });
  });

  it('an http rail with both secrets and a signing rotation in grace', () => {
    const v = webhookConfigView(
      {
        kyc: {},
        payment: {
          providerType: 'http',
          credentials: { settlementUrl: 'https://rail.example.com/i', signingSecret: 'S-NEW', previousSigningSecret: 'S-OLD', previousSigningSecretUntil: later },
          webhookSecret: 'W-CUR',
        },
        whatsapp: {},
      },
      now,
    );
    expect(v).toEqual({
      railType: 'http',
      partnerRail: true,
      endpoint: 'https://rail.example.com/i',
      eventsUrl: null,
      signing: { set: true, previousUntil: later },
      webhook: { set: true, previousUntil: null },
    });
    expect(JSON.stringify(v)).not.toMatch(/S-NEW|S-OLD|W-CUR/);
  });

  it('an expired previous secret is not shown as in grace', () => {
    const past = new Date(now.getTime() - 1).toISOString();
    const v = webhookConfigView(
      { kyc: {}, payment: { providerType: 'http', credentials: { signingSecret: 'S', previousSigningSecret: 'O', previousSigningSecretUntil: past } }, whatsapp: {} },
      now,
    );
    expect(v.signing).toEqual({ set: true, previousUntil: null });
  });

  it('webhookConfigView exposes eventsUrl (null when absent or empty) (pack 7 T20, P19)', () => {
    const view = (credentials: Record<string, string>) => webhookConfigView({ kyc: {}, payment: { providerType: 'http', credentials }, whatsapp: {} }, now);
    expect(view({ settlementUrl: 'https://rail.example.com/i', eventsUrl: 'https://events.example.com/e' }).eventsUrl).toBe('https://events.example.com/e');
    expect(view({ settlementUrl: 'https://rail.example.com/i' }).eventsUrl).toBeNull();
    expect(view({ settlementUrl: 'https://rail.example.com/i', eventsUrl: '' }).eventsUrl).toBeNull();
    expect(webhookConfigView({ kyc: {}, payment: {}, whatsapp: {} }, now).eventsUrl).toBeNull();
  });

  it('a simulator rail is SmartRemit-managed', () => {
    expect(webhookConfigView({ kyc: {}, payment: { providerType: 'simulator' }, whatsapp: {} }, now).partnerRail).toBe(false);
  });
});

describe('parseSecretKind', () => {
  it('accepts only the two kinds', () => {
    expect(parseSecretKind('signing')).toBe('signing');
    expect(parseSecretKind('webhook')).toBe('webhook');
    for (const v of ['', 'Signing', 'kyc', null, 42, 'webhook ']) expect(parseSecretKind(v)).toBeNull();
  });
});
