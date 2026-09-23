// Program-Fix 30 (F64): proof that a partner's access token actually controls
// the WhatsApp phone_number_id it is registering. Fail-closed on every error.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyPhoneNumberOwnership } from '@/lib/partner-integrations-verify';

const PNID = '1234567890123';
const WABA = '987654321';
const TOKEN = 'EAA-test-token';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('verifyPhoneNumberOwnership', () => {
  it('200 with the matching id → ok; exact URL and Bearer header', async () => {
    const f = vi.fn(async () => json(200, { id: PNID, display_phone_number: '+1 555', verified_name: 'Acme' }));
    vi.stubGlobal('fetch', f);
    expect(await verifyPhoneNumberOwnership({ pnid: PNID, token: TOKEN })).toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://graph.facebook.com/v21.0/${PNID}?fields=id,display_phone_number,verified_name`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(url).not.toContain(TOKEN); // the token never rides in the URL
  });

  it('200 with a DIFFERENT id → not ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { id: '5555555555' })));
    expect((await verifyPhoneNumberOwnership({ pnid: PNID, token: TOKEN })).ok).toBe(false);
  });

  it('401 → not ok, with the status for the caller to log', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: { message: 'bad token' } })));
    expect(await verifyPhoneNumberOwnership({ pnid: PNID, token: TOKEN })).toEqual({ ok: false, status: 401 });
  });

  it('a network throw or timeout → not ok (fail-closed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError'); }));
    expect((await verifyPhoneNumberOwnership({ pnid: PNID, token: TOKEN })).ok).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect((await verifyPhoneNumberOwnership({ pnid: PNID, token: TOKEN })).ok).toBe(false);
  });

  it('a malformed body → not ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })));
    expect((await verifyPhoneNumberOwnership({ pnid: PNID, token: TOKEN })).ok).toBe(false);
  });

  it('a non-digit pnid (path injection) or blank token → not ok with NO fetch made', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    for (const pnid of ['pn_acme', '123/../me', '1234', '12345?x=1', '1'.repeat(21), '']) {
      expect((await verifyPhoneNumberOwnership({ pnid, token: TOKEN })).ok).toBe(false);
    }
    expect((await verifyPhoneNumberOwnership({ pnid: PNID, token: '' })).ok).toBe(false);
    expect((await verifyPhoneNumberOwnership({ pnid: PNID, token: TOKEN, wabaId: 'abc/def' })).ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('with a WABA id: a phone_numbers list WITHOUT the pnid → not ok', async () => {
    const f = vi.fn(async (url: string) =>
      url.includes('/phone_numbers') ? json(200, { data: [{ id: '42424242' }] }) : json(200, { id: PNID }));
    vi.stubGlobal('fetch', f);
    expect((await verifyPhoneNumberOwnership({ pnid: PNID, token: TOKEN, wabaId: WABA })).ok).toBe(false);
  });

  it('with a WABA id: a phone_numbers list WITH the pnid → ok; both calls carry the Bearer token', async () => {
    const f = vi.fn(async (url: string) =>
      url.includes('/phone_numbers') ? json(200, { data: [{ id: '42424242' }, { id: PNID }] }) : json(200, { id: PNID }));
    vi.stubGlobal('fetch', f);
    expect(await verifyPhoneNumberOwnership({ pnid: PNID, token: TOKEN, wabaId: WABA })).toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(2);
    const urls = f.mock.calls.map((c) => c[0]);
    expect(urls).toContain(`https://graph.facebook.com/v21.0/${WABA}/phone_numbers`);
    for (const c of f.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect((c[1].headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('with a WABA id: a non-2xx on the list → not ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('/phone_numbers') ? json(403, {}) : json(200, { id: PNID })));
    expect(await verifyPhoneNumberOwnership({ pnid: PNID, token: TOKEN, wabaId: WABA })).toEqual({ ok: false, status: 403 });
  });

  it('uses an injected fetchFn when given', async () => {
    const fetchFn = vi.fn(async () => json(200, { id: PNID }));
    expect(await verifyPhoneNumberOwnership({ pnid: PNID, token: TOKEN, fetchFn, timeoutMs: 50 })).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
