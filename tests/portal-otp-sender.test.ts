import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { outbox } from '@/db/schema';
import { freshDb, seedPartner } from './helpers-db';
import { EMPTY_PARTNER_INTEGRATIONS, type PartnerIntegrations } from '@/lib/partner-integrations';
import { WhatsAppSendError } from '@/lib/whatsapp-errors';

// UI redesign M2-5, Task 5.3: the portal sign-in code is sent ONLY as the partner's approved
// authentication template, from the partner's OWN number. Never free-form text, never the shared
// number (except the default tenant, whose own number IS the shared one: owner O2).

const w = vi.hoisted(() => ({ sendAuthTemplate: vi.fn(), sendText: vi.fn(), sendOtpCode: vi.fn(), recordChannelHealth: vi.fn() }));
vi.mock('@/lib/whatsapp', () => ({ sendAuthTemplate: w.sendAuthTemplate, sendText: w.sendText, sendOtpCode: w.sendOtpCode }));
vi.mock('@/lib/channel-health', async (orig) => ({
  ...(await orig<typeof import('@/lib/channel-health')>()),
  recordChannelHealth: w.recordChannelHealth,
}));
vi.mock('@/lib/outbox', () => ({ pokeWorker: () => {} }));

import { alertPortalOtpFailure, portalOtpChannelReady, sendPortalOtp } from '@/lib/portal-otp-sender';

const OWN: PartnerIntegrations = { ...EMPTY_PARTNER_INTEGRATIONS, whatsapp: { phoneNumberId: '555000', token: 'partner-token' } };
const SHARED = EMPTY_PARTNER_INTEGRATIONS;
const INCOMPLETE: PartnerIntegrations = { ...EMPTY_PARTNER_INTEGRATIONS, whatsapp: { phoneNumberId: '555000' } };
const TEMPLATE = { authTemplateName: 'acme_login', authTemplateLang: 'en_US', portalEnabledAt: new Date() };

function deps(o: { integrations?: PartnerIntegrations; settings?: typeof TEMPLATE | null; health?: string | null; throwOn?: 'integrations' | 'settings' | 'health' } = {}) {
  return {
    getIntegrations: async () => {
      if (o.throwOn === 'integrations') throw new Error('db down');
      return o.integrations ?? OWN;
    },
    getSettings: async () => {
      if (o.throwOn === 'settings') throw new Error('db down');
      return o.settings === null ? { authTemplateName: null, authTemplateLang: null, portalEnabledAt: null } : (o.settings ?? TEMPLATE);
    },
    readChannelHealth: async () => {
      if (o.throwOn === 'health') throw new Error('redis down');
      return o.health ?? null;
    },
    now: () => Date.now(),
  };
}

beforeEach(() => {
  for (const f of Object.values(w)) f.mockReset();
  w.recordChannelHealth.mockResolvedValue(false);
});
afterEach(() => vi.unstubAllEnvs());

describe('portalOtpChannelReady', () => {
  it('own channel + template → ready with THE PARTNER creds and template', async () => {
    expect(await portalOtpChannelReady('pa', deps())).toEqual({
      ready: true,
      creds: { phoneNumberId: '555000', token: 'partner-token' },
      template: { name: 'acme_login', lang: 'en_US' },
    });
  });
  it('a non-default partner on the shared number → not ready (channel_shared)', async () => {
    expect(await portalOtpChannelReady('pa', deps({ integrations: SHARED }))).toEqual({ ready: false, why: 'channel_shared' });
  });
  it('the default tenant on the shared number → ready with creds undefined (the env number is its own)', async () => {
    expect(await portalOtpChannelReady('default', deps({ integrations: SHARED }))).toEqual({
      ready: true,
      creds: undefined,
      template: { name: 'acme_login', lang: 'en_US' },
    });
  });
  it('incomplete → not ready', async () => {
    expect(await portalOtpChannelReady('pa', deps({ integrations: INCOMPLETE }))).toEqual({ ready: false, why: 'channel_incomplete' });
  });
  it('no template → not ready', async () => {
    expect(await portalOtpChannelReady('pa', deps({ settings: null }))).toEqual({ ready: false, why: 'no_template' });
  });
  it('an auth_error health mark within the hour → not ready; an older one is ignored', async () => {
    const recent = JSON.stringify({ auth_error: { at: new Date(Date.now() - 10 * 60_000).toISOString(), count: 1, code: 190 } });
    const old = JSON.stringify({ auth_error: { at: new Date(Date.now() - 2 * 3_600_000).toISOString(), count: 1, code: 190 } });
    expect(await portalOtpChannelReady('pa', deps({ health: recent }))).toEqual({ ready: false, why: 'health_auth_error' });
    expect((await portalOtpChannelReady('pa', deps({ health: old }))).ready).toBe(true);
  });
  it.each(['integrations', 'settings', 'health'] as const)('a %s read that throws → lookup_failed (fail CLOSED)', async (throwOn) => {
    expect(await portalOtpChannelReady('pa', deps({ throwOn }))).toEqual({ ready: false, why: 'lookup_failed' });
  });
});

describe('sendPortalOtp', () => {
  const ready = { ready: true as const, creds: { phoneNumberId: '555000', token: 'partner-token' }, template: { name: 'acme_login', lang: 'en_US' } };

  it('sends ONE authentication template with the partner creds and template name', async () => {
    w.sendAuthTemplate.mockResolvedValue(undefined);
    expect(await sendPortalOtp('pa', '14155550101', '123456', ready)).toEqual({ ok: true });
    expect(w.sendAuthTemplate).toHaveBeenCalledTimes(1);
    const [to, name, lang, components, creds] = w.sendAuthTemplate.mock.calls[0];
    expect([to, name, lang, creds]).toEqual(['14155550101', 'acme_login', 'en_US', ready.creds]);
    expect(JSON.stringify(components)).toContain('123456');
  });

  it('a template error → NO free-form text and NO second send on any number (the key invariant)', async () => {
    w.sendAuthTemplate.mockRejectedValue(new WhatsAppSendError('WhatsApp auth template send failed (400): x', { status: 400, code: 132001 }));
    expect(await sendPortalOtp('pa', '14155550101', '123456', ready)).toEqual({ ok: false, code: 132001 });
    expect(w.sendAuthTemplate).toHaveBeenCalledTimes(1);
    expect(w.sendText).not.toHaveBeenCalled();
    expect(w.sendOtpCode).not.toHaveBeenCalled();
    expect(w.recordChannelHealth).not.toHaveBeenCalled();
  });

  it('a Graph 190 (token revoked) → recordChannelHealth(partner, auth_error, {code:190})', async () => {
    w.sendAuthTemplate.mockRejectedValue(new WhatsAppSendError('x (401): y', { status: 401, code: 190 }));
    expect(await sendPortalOtp('pa', '14155550101', '123456', ready)).toEqual({ ok: false, code: 190 });
    expect(w.recordChannelHealth).toHaveBeenCalledWith('pa', 'auth_error', { code: 190 });
  });

  it('a non-Graph throw → ok:false without a code', async () => {
    w.sendAuthTemplate.mockRejectedValue(new Error('network'));
    expect(await sendPortalOtp('pa', '14155550101', '123456', ready)).toEqual({ ok: false });
  });

  it('OTP_DEV_MODE=true → ok without a send', async () => {
    vi.stubEnv('OTP_DEV_MODE', 'true');
    expect(await sendPortalOtp('pa', '14155550101', '123456', ready)).toEqual({ ok: true });
    expect(w.sendAuthTemplate).not.toHaveBeenCalled();
  });
});

describe('alertPortalOtpFailure', () => {
  it('twice in the same hour → ONE ops.alert row; the message has no phone and no code', async () => {
    const db = await freshDb();
    await seedPartner(db, 'pa');
    await alertPortalOtpFailure('pa', 'send_failed', { db });
    await alertPortalOtpFailure('pa', 'channel_shared', { db });
    const rows = await db.select().from(outbox).where(eq(outbox.kind, 'ops.alert'));
    expect(rows).toHaveLength(1);
    const msg = String((rows[0].payload as { message: string }).message);
    expect(msg).toContain('pa');
    expect(msg).not.toMatch(/\d{6}/);
    expect(rows[0].dedupeKey).toMatch(/^portalotp:pa:\d+$/);
  });
  it('never throws (a DB failure is swallowed)', async () => {
    const db = { insert: () => { throw new Error('db down'); } } as never;
    await expect(alertPortalOtpFailure('pa', 'send_failed', { db })).resolves.toBeUndefined();
  });
});
