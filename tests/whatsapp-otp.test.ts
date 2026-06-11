import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { authenticationTemplateParams } from '@/lib/whatsapp-templates';
import { sendOtpCode } from '@/lib/whatsapp';

// env is read through a getter (process.env.OTP_DEV_MODE === 'true'); we toggle
// the real env var per-test so we exercise the production getter, not a mock.
const ORIGINAL_DEV_MODE = process.env.OTP_DEV_MODE;
const ORIGINAL_AUTH_TEMPLATE = process.env.WHATSAPP_AUTH_TEMPLATE;
const ORIGINAL_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ORIGINAL_TOKEN = process.env.WHATSAPP_TOKEN;

beforeEach(() => {
  // Live-mode Graph send needs phone-number-id + token present.
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123456';
  process.env.WHATSAPP_TOKEN = 'test-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_DEV_MODE === undefined) delete process.env.OTP_DEV_MODE;
  else process.env.OTP_DEV_MODE = ORIGINAL_DEV_MODE;
  if (ORIGINAL_AUTH_TEMPLATE === undefined) delete process.env.WHATSAPP_AUTH_TEMPLATE;
  else process.env.WHATSAPP_AUTH_TEMPLATE = ORIGINAL_AUTH_TEMPLATE;
  if (ORIGINAL_PHONE_ID === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  else process.env.WHATSAPP_PHONE_NUMBER_ID = ORIGINAL_PHONE_ID;
  if (ORIGINAL_TOKEN === undefined) delete process.env.WHATSAPP_TOKEN;
  else process.env.WHATSAPP_TOKEN = ORIGINAL_TOKEN;
});

describe('authenticationTemplateParams', () => {
  it('emits a body component carrying the code as its single text param', () => {
    const components = authenticationTemplateParams('123456');
    const body = components.find((c) => c.type === 'body');
    expect(body).toBeDefined();
    expect(body!.parameters).toEqual([{ type: 'text', text: '123456' }]);
  });

  it('emits a url button component at index "0" carrying the SAME code (COPY_CODE)', () => {
    const components = authenticationTemplateParams('654321');
    const button = components.find((c) => c.type === 'button');
    expect(button).toBeDefined();
    expect(button!.sub_type).toBe('url');
    // Meta AUTHENTICATION copy-code button uses index '0'.
    expect(String(button!.index)).toBe('0');
    expect(button!.parameters).toEqual([{ type: 'text', text: '654321' }]);
  });

  it('the code appears in BOTH the body param and the button param (identical)', () => {
    const code = '098765';
    const components = authenticationTemplateParams(code);
    const body = components.find((c) => c.type === 'body');
    const button = components.find((c) => c.type === 'button');
    expect(body!.parameters[0].text).toBe(code);
    expect(button!.parameters[0].text).toBe(code);
  });

  it('preserves leading zeros in the code (string, not number)', () => {
    const components = authenticationTemplateParams('000123');
    const body = components.find((c) => c.type === 'body');
    expect(body!.parameters[0].text).toBe('000123');
  });
});

describe('sendOtpCode — dev mode', () => {
  it('does NOT perform a live send and logs a masked (last-4) dev line', async () => {
    process.env.OTP_DEV_MODE = 'true';
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await sendOtpCode('15551234567', '987654');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    const logged = log.mock.calls.map((c) => c.join(' ')).join('\n');
    // masked to last-4 (4567), not the full number
    expect(logged).toContain('4567');
    // full phone must NOT appear
    expect(logged).not.toContain('15551234567');
  });

  it('NEVER logs the OTP code in dev mode', async () => {
    process.env.OTP_DEV_MODE = 'true';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sendOtpCode('15551234567', '424242');

    const all = [...log.mock.calls, ...warn.mock.calls]
      .map((c) => c.join(' '))
      .join('\n');
    expect(all).not.toContain('424242');
  });
});

describe('sendOtpCode — live mode', () => {
  it('POSTs an AUTHENTICATION template send to the Graph API with the configured template name', async () => {
    process.env.OTP_DEV_MODE = 'false';
    process.env.WHATSAPP_AUTH_TEMPLATE = 'verification_code';
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);

    await sendOtpCode('15551234567', '135790');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/messages');
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe('template');
    expect(body.to).toBe('15551234567');
    expect(body.template.name).toBe('verification_code');
    expect(body.template.language.code).toBe('en');

    const components = body.template.components;
    const bodyComp = components.find((c: { type: string }) => c.type === 'body');
    const buttonComp = components.find((c: { type: string }) => c.type === 'button');
    expect(bodyComp.parameters).toEqual([{ type: 'text', text: '135790' }]);
    expect(buttonComp.sub_type).toBe('url');
    expect(buttonComp.parameters).toEqual([{ type: 'text', text: '135790' }]);
  });

  it('falls back to a free-form text carrying the code when the AUTHENTICATION template send fails', async () => {
    // The real-world case: the `verification_code` template isn't approved yet, so
    // the template send 400s. The customer must STILL receive the code in-session.
    process.env.OTP_DEV_MODE = 'false';
    process.env.WHATSAPP_AUTH_TEMPLATE = 'verification_code';
    // Key the mock on the request body so it's robust to any retry: template send
    // fails, free-form text send succeeds.
    const fetchMock = vi.fn(
      async (
        _url: string,
        init: RequestInit,
      ): Promise<{ ok: boolean; status?: number; text: () => Promise<string> }> => {
        const body = JSON.parse(init.body as string);
        if (body.type === 'template') {
          return { ok: false, status: 400, text: async () => 'template not approved' };
        }
        return { ok: true, text: async () => '' };
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(sendOtpCode('15551234567', '135790')).resolves.toBeUndefined();

    // A free-form text send happened, addressed to the phone, carrying the code.
    const textCall = fetchMock.mock.calls.find(([, init]) => {
      const b = JSON.parse((init as RequestInit).body as string);
      return b.type === 'text';
    });
    expect(textCall).toBeDefined();
    const textBody = JSON.parse((textCall![1] as RequestInit).body as string);
    expect(textBody.to).toBe('15551234567');
    expect(textBody.text.body).toContain('135790');
  });

  it('NEVER includes the code in the thrown error when BOTH the template AND the text send fail', async () => {
    process.env.OTP_DEV_MODE = 'false';
    process.env.WHATSAPP_AUTH_TEMPLATE = 'verification_code';
    // Every send fails (template 400, then the free-form fallback 400 too).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 400, text: async () => 'send rejected' })),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    let caught: unknown;
    try {
      await sendOtpCode('15551234567', '246802');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).not.toContain('246802');
  });
});

describe('sendOtpCode — templates are OPT-IN (testing-business mode)', () => {
  it('with NO template configured, sends the code as regular free-form text — never a template call', async () => {
    process.env.OTP_DEV_MODE = 'false';
    delete process.env.WHATSAPP_AUTH_TEMPLATE;
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);

    await sendOtpCode('15551234567', '246802');

    expect(fetchMock).toHaveBeenCalledTimes(1); // exactly one send, no doomed template attempt
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe('text');
    expect(body.to).toBe('15551234567');
    expect(body.text.body).toContain('246802'); // the inbuilt free-form message carries the code
  });
});
