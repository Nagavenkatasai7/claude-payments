/**
 * M2-6: the pay-step OTP goes out through the partner's approved AUTHENTICATION
 * template on the partner's own number when one is recorded, so a customer
 * outside Meta's 24-h window still receives the code. The four plan cases are
 * pinned, plus "a partner template never reaches the shared number".
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { authenticationTemplateParams } from '@/lib/whatsapp-templates';
import { sendTransactionOtp } from '@/lib/whatsapp';

const ORIGINAL = {
  template: process.env.WHATSAPP_AUTH_TEMPLATE,
  phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  token: process.env.WHATSAPP_TOKEN,
  dev: process.env.OTP_DEV_MODE,
};
function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'pn_shared';
  process.env.WHATSAPP_TOKEN = 'tok_shared';
  delete process.env.OTP_DEV_MODE;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restore('WHATSAPP_AUTH_TEMPLATE', ORIGINAL.template);
  restore('WHATSAPP_PHONE_NUMBER_ID', ORIGINAL.phoneId);
  restore('WHATSAPP_TOKEN', ORIGINAL.token);
  restore('OTP_DEV_MODE', ORIGINAL.dev);
});

const PARTNER_CREDS = { phoneNumberId: 'pn_partner', token: 'tok_partner' };
const PARTNER_TEMPLATE = { name: 'partner_login_code', lang: 'en_US' };
const PHONE = '15551234567';
const CODE = '482913';

type Call = [string, RequestInit];
const callsOf = (m: { mock: { calls: unknown[][] } }) => m.mock.calls as unknown as Call[];
const bodyOf = (m: { mock: { calls: unknown[][] } }, i: number) => JSON.parse(callsOf(m)[i][1].body as string);
function expectAllOnPartnerNumber(m: { mock: { calls: unknown[][] } }) {
  for (const [url, init] of callsOf(m)) {
    expect(url).toContain('/pn_partner/messages');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok_partner');
  }
}
const okFetch = () => vi.fn(async () => ({ ok: true, text: async () => '' }));

describe('sendTransactionOtp with a partner auth template (M2-6)', () => {
  it('template + partner creds → the partner template carries the code, on the partner number', async () => {
    process.env.WHATSAPP_AUTH_TEMPLATE = 'otp_auth';
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await sendTransactionOtp(PHONE, CODE, PARTNER_CREDS, undefined, PARTNER_TEMPLATE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectAllOnPartnerNumber(fetchMock);
    const b = bodyOf(fetchMock, 0);
    expect(b.type).toBe('template');
    expect(b.to).toBe(PHONE);
    expect(b.template.name).toBe('partner_login_code');
    expect(b.template.language).toEqual({ code: 'en_US' });
    expect(b.template.components).toEqual(authenticationTemplateParams(CODE));
  });

  it('template send fails → free-form on the SAME partner creds (never the shared number); code never logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let n = 0;
    const fetchMock = vi.fn(async () =>
      n++ === 0
        ? { ok: false, status: 404, text: async (): Promise<string> => '{"error":{"code":132001}}' }
        : { ok: true, text: async (): Promise<string> => '' },
    );
    vi.stubGlobal('fetch', fetchMock);

    await sendTransactionOtp(PHONE, CODE, PARTNER_CREDS, undefined, PARTNER_TEMPLATE);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectAllOnPartnerNumber(fetchMock);
    expect(bodyOf(fetchMock, 0).type).toBe('template');
    expect(bodyOf(fetchMock, 1).type).toBe('text');
    expect(bodyOf(fetchMock, 1).text.body).toContain(CODE);
    const logged = [...warn.mock.calls, ...err.mock.calls, ...log.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join('\n');
    expect(logged).not.toContain(CODE);
    expect(logged).not.toContain(PHONE);
  });

  it('template and free-form both fail → throws (the route answers 502), no shared-number attempt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400, text: async () => '{"error":{"code":131047}}' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendTransactionOtp(PHONE, CODE, PARTNER_CREDS, undefined, PARTNER_TEMPLATE)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectAllOnPartnerNumber(fetchMock);
  });

  it('no template + partner creds → today\'s single free-form text on the partner number (unchanged)', async () => {
    process.env.WHATSAPP_AUTH_TEMPLATE = 'otp_auth';
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await sendTransactionOtp(PHONE, CODE, PARTNER_CREDS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectAllOnPartnerNumber(fetchMock);
    expect(bodyOf(fetchMock, 0).type).toBe('text');
  });

  it('no creds → today\'s env-template path on the shared number (unchanged)', async () => {
    process.env.WHATSAPP_AUTH_TEMPLATE = 'otp_auth';
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await sendTransactionOtp(PHONE, CODE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callsOf(fetchMock)[0][0]).toContain('/pn_shared/messages');
    const b = bodyOf(fetchMock, 0);
    expect(b.type).toBe('template');
    expect(b.template.name).toBe('otp_auth');
    expect(b.template.language).toEqual({ code: 'en' });
  });

  it('a partner template WITHOUT partner creds is ignored: the partner template name never goes out on the shared number', async () => {
    process.env.WHATSAPP_AUTH_TEMPLATE = 'otp_auth';
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await sendTransactionOtp(PHONE, CODE, undefined, undefined, PARTNER_TEMPLATE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const raw = callsOf(fetchMock).map(([, init]) => String(init.body)).join('\n');
    expect(raw).not.toContain('partner_login_code');
    expect(bodyOf(fetchMock, 0).template.name).toBe('otp_auth');
  });
});
