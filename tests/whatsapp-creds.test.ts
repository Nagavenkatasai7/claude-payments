import { describe, it, expect, vi } from 'vitest';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import { EMPTY_PARTNER_INTEGRATIONS } from '@/lib/partner-integrations';

describe('waCredsFrom (WL2 outbound credential resolution)', () => {
  it('returns creds only when BOTH phoneNumberId and token are configured', () => {
    expect(
      waCredsFrom({ kyc: {}, payment: {}, whatsapp: { phoneNumberId: '111', token: 'tok' } }),
    ).toEqual({ phoneNumberId: '111', token: 'tok' });
  });

  it('half-configured / empty / null ⇒ undefined (fall back to the shared env number)', () => {
    expect(waCredsFrom({ kyc: {}, payment: {}, whatsapp: { phoneNumberId: '111' } })).toBeUndefined();
    expect(waCredsFrom({ kyc: {}, payment: {}, whatsapp: { token: 'tok' } })).toBeUndefined();
    expect(waCredsFrom(EMPTY_PARTNER_INTEGRATIONS)).toBeUndefined();
    expect(waCredsFrom(null)).toBeUndefined();
    expect(waCredsFrom(undefined)).toBeUndefined();
  });
});

// Program-Fix 49A (whatsapp-11): the ONE shared resolver the direct senders
// (portal OTP, Persona nudge, KYC decision) use. FAIL-SOFT on purpose: an OTP
// must still arrive when a partner read hiccups, so any error ⇒ the shared
// number and the SmartRemit brand. (The outbox worker keeps its own
// fail-closed, memoized resolver.)
describe('partnerWaContext (Program-Fix 49A)', () => {
  it('a BYO partner ⇒ its brand + its creds', async () => {
    const { partnerWaContext } = await import('@/lib/whatsapp-creds');
    const ctx = await partnerWaContext('acme', {
      getPartner: async () => ({ id: 'acme', displayName: 'Acme Remit' }) as never,
      getIntegrations: async () => ({ kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn', token: 't' } }) as never,
    });
    expect(ctx).toEqual({ brand: 'Acme Remit', waCreds: { phoneNumberId: 'pn', token: 't' } });
  });

  it('no partner row / no integrations ⇒ SmartRemit + the shared number', async () => {
    const { partnerWaContext } = await import('@/lib/whatsapp-creds');
    const ctx = await partnerWaContext('ghost', { getPartner: async () => null, getIntegrations: async () => null as never });
    expect(ctx).toEqual({ brand: 'SmartRemit', waCreds: undefined });
  });

  it('a read error ⇒ SmartRemit + the shared number, never a throw', async () => {
    const { partnerWaContext } = await import('@/lib/whatsapp-creds');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = await partnerWaContext('acme', {
      getPartner: async () => { throw new Error('db down'); },
      getIntegrations: async () => ({}) as never,
    });
    expect(ctx).toEqual({ brand: 'SmartRemit', waCreds: undefined });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// R2a: the SEND-time channel rule. own = pnid AND token (warnings for a missing
// appSecret / verifyToken, never blocking); shared = the default partner or NO
// field set; incomplete = some field set but not pnid+token (fails closed in
// the worker's whatsapp.text/template send, never falls back to the shared number).
describe('resolveWaChannel (R2a)', () => {
  const w = (whatsapp: Record<string, string>) => ({ kyc: {}, payment: {}, whatsapp });

  it('{pnid, token} ⇒ own + both warnings', async () => {
    const { resolveWaChannel } = await import('@/lib/whatsapp-creds');
    expect(resolveWaChannel('acme', w({ phoneNumberId: 'pn', token: 't' }))).toEqual({
      kind: 'own',
      creds: { phoneNumberId: 'pn', token: 't' },
      warnings: ['appSecret', 'verifyToken'],
    });
  });

  it('{pnid, token, appSecret} (no verifyToken) ⇒ own, one warning', async () => {
    const { resolveWaChannel } = await import('@/lib/whatsapp-creds');
    expect(resolveWaChannel('acme', w({ phoneNumberId: 'pn', token: 't', appSecret: 's' }))).toEqual({
      kind: 'own',
      creds: { phoneNumberId: 'pn', token: 't' },
      warnings: ['verifyToken'],
    });
  });

  it('all four ⇒ own, no warnings', async () => {
    const { resolveWaChannel } = await import('@/lib/whatsapp-creds');
    const r = resolveWaChannel('acme', w({ phoneNumberId: 'pn', token: 't', appSecret: 's', verifyToken: 'v' }));
    expect(r).toEqual({ kind: 'own', creds: { phoneNumberId: 'pn', token: 't' }, warnings: [] });
  });

  it('appSecret only ⇒ incomplete (missing pnid + token)', async () => {
    const { resolveWaChannel } = await import('@/lib/whatsapp-creds');
    expect(resolveWaChannel('acme', w({ appSecret: 's' }))).toEqual({ kind: 'incomplete', missing: ['phoneNumberId', 'token'] });
  });

  it('{token, appSecret} with the pnid cleared ⇒ incomplete (missing pnid)', async () => {
    const { resolveWaChannel } = await import('@/lib/whatsapp-creds');
    expect(resolveWaChannel('acme', w({ token: 't', appSecret: 's' }))).toEqual({ kind: 'incomplete', missing: ['phoneNumberId'] });
  });

  it('verifyToken only ⇒ incomplete', async () => {
    const { resolveWaChannel } = await import('@/lib/whatsapp-creds');
    expect(resolveWaChannel('acme', w({ verifyToken: 'v' })).kind).toBe('incomplete');
  });

  it('no field set / null / undefined ⇒ shared (API-only partners keep the shared number)', async () => {
    const { resolveWaChannel } = await import('@/lib/whatsapp-creds');
    expect(resolveWaChannel('acme', EMPTY_PARTNER_INTEGRATIONS)).toEqual({ kind: 'shared' });
    expect(resolveWaChannel('acme', null)).toEqual({ kind: 'shared' });
    expect(resolveWaChannel('acme', undefined)).toEqual({ kind: 'shared' });
    expect(resolveWaChannel('acme', w({ phoneNumberId: '', token: '' }))).toEqual({ kind: 'shared' });
  });

  it('the default partner is never incomplete: a partial row still means the shared number', async () => {
    const { resolveWaChannel } = await import('@/lib/whatsapp-creds');
    expect(resolveWaChannel('default', w({ appSecret: 's' }))).toEqual({ kind: 'shared' });
    // …but a full default row keeps waCredsFrom's behaviour (own creds).
    expect(resolveWaChannel('default', w({ phoneNumberId: 'pn', token: 't' })).kind).toBe('own');
  });

  it('agrees with waCredsFrom on the creds it returns', async () => {
    const { resolveWaChannel } = await import('@/lib/whatsapp-creds');
    const i = w({ phoneNumberId: 'pn', token: 't' });
    const r = resolveWaChannel('acme', i);
    expect(r.kind === 'own' ? r.creds : undefined).toEqual(waCredsFrom(i));
  });
});

// R2a: the SAVE-time rule, run on the MERGED state (blank form fields keep the
// stored secret). Accept exactly: nothing set, or pnid + token + appSecret
// (verifyToken is a warning). Anything else would save and then fail closed.
describe('checkWhatsappConfig (R2a save rule on the merged state)', () => {
  it('empty ⇒ ok (shared number)', async () => {
    const { checkWhatsappConfig } = await import('@/lib/whatsapp-creds');
    expect(checkWhatsappConfig({})).toEqual({ ok: true, warnings: [] });
    expect(checkWhatsappConfig({ phoneNumberId: undefined, token: undefined })).toEqual({ ok: true, warnings: [] });
  });

  it('pnid + token + appSecret ⇒ ok, verifyToken missing is a warning', async () => {
    const { checkWhatsappConfig } = await import('@/lib/whatsapp-creds');
    expect(checkWhatsappConfig({ phoneNumberId: 'pn', token: 't', appSecret: 's' })).toEqual({ ok: true, warnings: ['verifyToken'] });
    expect(checkWhatsappConfig({ phoneNumberId: 'pn', token: 't', appSecret: 's', verifyToken: 'v' })).toEqual({ ok: true, warnings: [] });
  });

  it('partial states are refused, naming the missing fields', async () => {
    const { checkWhatsappConfig } = await import('@/lib/whatsapp-creds');
    expect(checkWhatsappConfig({ appSecret: 's' })).toEqual({ ok: false, missing: ['phoneNumberId', 'token'] });
    expect(checkWhatsappConfig({ token: 't', appSecret: 's' })).toEqual({ ok: false, missing: ['phoneNumberId'] });
    expect(checkWhatsappConfig({ phoneNumberId: 'pn', token: 't' })).toEqual({ ok: false, missing: ['appSecret'] });
    expect(checkWhatsappConfig({ verifyToken: 'v' })).toEqual({ ok: false, missing: ['phoneNumberId', 'token', 'appSecret'] });
  });
});
