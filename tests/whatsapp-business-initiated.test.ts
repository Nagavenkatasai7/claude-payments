import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendBusinessInitiated, rowTemplate, sendTextThenTemplate } from '@/lib/whatsapp-business-initiated';
import { WhatsAppSendError } from '@/lib/whatsapp-errors';

// Program-Fix 25 PR A: sendBusinessInitiated is for NEW call sites only (today:
// the ops.alert template path). With WHATSAPP_WINDOW_AWARE unset it is exactly
// today's template-then-free-form order; the zero-fetch short-circuit exists
// only once the owner turns the flag on.

const TO = '15550001111';
const TEMPLATE = { name: 'ops_alert', lang: 'en', params: ['hello'] };
const err = (code: number, status = 400) =>
  WhatsAppSendError.fromResponse('WhatsApp send failed', status, JSON.stringify({ error: { message: `(#${code}) x`, code } }));

const sendText = vi.fn(async (..._a: unknown[]) => {});
const sendTemplate = vi.fn(async (..._a: unknown[]) => {});
const getLastInboundAt = vi.fn(async (..._a: unknown[]): Promise<string | null> => null);
const opts = (partnerId = 'default') => ({
  partnerId,
  store: { getLastInboundAt },
  sendText: sendText as never,
  sendTemplate: sendTemplate as never,
});

beforeEach(() => {
  sendText.mockReset();
  sendTemplate.mockReset();
  getLastInboundAt.mockReset();
  getLastInboundAt.mockResolvedValue(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sendBusinessInitiated — flag OFF (default): today\'s order, no window read', () => {
  beforeEach(() => vi.stubEnv('WHATSAPP_WINDOW_AWARE', ''));

  it('template configured → template only; no window read', async () => {
    const out = await sendBusinessInitiated(TO, { template: TEMPLATE, fallbackText: 'hello' }, undefined, opts());
    expect(out).toEqual({ ok: true, via: 'template' });
    expect(sendTemplate).toHaveBeenCalledWith(TO, 'ops_alert', 'en', ['hello'], undefined);
    expect(sendText).not.toHaveBeenCalled();
    expect(getLastInboundAt).not.toHaveBeenCalled();
  });

  it('template fails → free-form fallback (same as sendTemplateOrText)', async () => {
    sendTemplate.mockRejectedValueOnce(err(132001));
    const out = await sendBusinessInitiated(TO, { template: TEMPLATE, fallbackText: 'hello' }, undefined, opts());
    expect(out).toEqual({ ok: true, via: 'text' });
    expect(sendText).toHaveBeenCalledWith(TO, 'hello', undefined);
  });

  it('no template → one free-form send', async () => {
    const out = await sendBusinessInitiated(TO, { fallbackText: 'hello' }, undefined, opts());
    expect(out).toEqual({ ok: true, via: 'text' });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('both fail → {ok:false} carrying the last error and its code; never throws', async () => {
    sendTemplate.mockRejectedValueOnce(err(132001));
    const last = err(131030);
    sendText.mockRejectedValueOnce(last);
    const out = await sendBusinessInitiated(TO, { template: TEMPLATE, fallbackText: 'hello' }, undefined, opts());
    expect(out).toMatchObject({ ok: false, code: 131030, reason: 'send_failed' });
    expect(out.ok === false && out.error).toBe(last);
  });
});

describe('sendBusinessInitiated — flag ON (WHATSAPP_WINDOW_AWARE=true)', () => {
  beforeEach(() => vi.stubEnv('WHATSAPP_WINDOW_AWARE', 'true'));

  it('out of window, no template → {ok:false, outside_window_no_template} and ZERO sends', async () => {
    const out = await sendBusinessInitiated(TO, { fallbackText: 'hello' }, undefined, opts('acme'));
    expect(out).toEqual({ ok: false, reason: 'outside_window_no_template' });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(getLastInboundAt).toHaveBeenCalledWith('acme', TO);
  });

  it('out of window, template configured → the template (no free-form attempt)', async () => {
    const out = await sendBusinessInitiated(TO, { template: TEMPLATE, fallbackText: 'hello' }, undefined, opts());
    expect(out).toEqual({ ok: true, via: 'template' });
    expect(sendText).not.toHaveBeenCalled();
  });

  it('in window → free-form first', async () => {
    getLastInboundAt.mockResolvedValue('2026-09-23T00:00:00.000Z');
    const out = await sendBusinessInitiated(TO, { template: TEMPLATE, fallbackText: 'hello' }, undefined, opts());
    expect(out).toEqual({ ok: true, via: 'text' });
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('in window, free-form hits 131047 → the template', async () => {
    getLastInboundAt.mockResolvedValue('2026-09-23T00:00:00.000Z');
    sendText.mockRejectedValueOnce(err(131047));
    const out = await sendBusinessInitiated(TO, { template: TEMPLATE, fallbackText: 'hello' }, undefined, opts());
    expect(out).toEqual({ ok: true, via: 'template' });
  });

  it('in window, free-form hits HTTP 470 with no code → the template', async () => {
    getLastInboundAt.mockResolvedValue('2026-09-23T00:00:00.000Z');
    sendText.mockRejectedValueOnce(WhatsAppSendError.fromResponse('WhatsApp send failed', 470, 'engagement'));
    const out = await sendBusinessInitiated(TO, { template: TEMPLATE, fallbackText: 'hello' }, undefined, opts());
    expect(out).toEqual({ ok: true, via: 'template' });
  });

  it('in window, a NON-window failure → {ok:false}, no template attempt', async () => {
    getLastInboundAt.mockResolvedValue('2026-09-23T00:00:00.000Z');
    sendText.mockRejectedValueOnce(err(131030));
    const out = await sendBusinessInitiated(TO, { template: TEMPLATE, fallbackText: 'hello' }, undefined, opts());
    expect(out).toMatchObject({ ok: false, code: 131030, reason: 'send_failed' });
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('a window-read error counts as outside the window', async () => {
    getLastInboundAt.mockRejectedValue(new Error('redis down'));
    const out = await sendBusinessInitiated(TO, { fallbackText: 'hello' }, undefined, opts());
    expect(out).toEqual({ ok: false, reason: 'outside_window_no_template' });
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe('rowTemplate — the optional template on a whatsapp.text outbox row (2026-10-03)', () => {
  it('accepts a well-formed template and flattens each param for Meta', () => {
    expect(rowTemplate({ name: 'transfer_in_review', lang: 'en', params: ['there', '$1,000.00', 'Priya\nSharma'] })).toEqual({
      name: 'transfer_in_review', lang: 'en', params: ['there', '$1,000.00', 'Priya Sharma'],
    });
  });

  it('absent or malformed ⇒ undefined (the row sends its plain text, exactly as before)', () => {
    expect(rowTemplate(undefined)).toBeUndefined();
    expect(rowTemplate(null)).toBeUndefined();
    expect(rowTemplate('transfer_in_review')).toBeUndefined();
    expect(rowTemplate({ name: 'Bad Name!', lang: 'en', params: [] })).toBeUndefined();
    expect(rowTemplate({ name: 'ok_name', lang: 'english please', params: [] })).toBeUndefined();
    expect(rowTemplate({ name: 'ok_name', lang: 'en', params: [1, 2] })).toBeUndefined();
    expect(rowTemplate({ name: 'ok_name', lang: 'en', params: 'x' })).toBeUndefined();
  });

  it('an empty param would be rejected by Meta, so the row falls back to text', () => {
    expect(rowTemplate({ name: 'ok_name', lang: 'en', params: ['a', '  '] })).toBeUndefined();
  });
});

describe('sendTextThenTemplate — the 24-hour window decides (2026-10-03)', () => {
  const T = { name: 'transfer_delivered_sender', lang: 'en', params: ['$50.00', 'Priya', 'tx_1'] };
  const win = () => WhatsAppSendError.fromResponse('WhatsApp send failed', 400, JSON.stringify({ error: { code: 131047 } }));
  const notApproved = () => WhatsAppSendError.fromResponse('WhatsApp template send failed', 404, JSON.stringify({ error: { code: 132001 } }));
  const inside = { getLastInboundAt: vi.fn(async () => '2026-10-03T10:00:00.000Z') };
  const outside = { getLastInboundAt: vi.fn(async () => null) };
  const opts = (store: typeof inside | typeof outside, sendText: ReturnType<typeof vi.fn>, sendTemplate: ReturnType<typeof vi.fn>) =>
    ({ partnerId: 'default', store, sendText, sendTemplate });

  it('no template ⇒ the plain text, the marker is never read', async () => {
    const store = { getLastInboundAt: vi.fn(async () => null) };
    const sendText = vi.fn().mockResolvedValue(undefined);
    await sendTextThenTemplate('1555', { text: 'hi' }, undefined, opts(store, sendText, vi.fn()));
    expect(sendText).toHaveBeenCalledWith('1555', 'hi', undefined);
    expect(store.getLastInboundAt).not.toHaveBeenCalled();
  });

  it('inside the window ⇒ exactly one text send, no template (today, byte-for-byte)', async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const sendTemplate = vi.fn();
    await sendTextThenTemplate('1555', { text: 'hi', template: T }, undefined, opts(inside, sendText, sendTemplate));
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith('1555', 'hi', undefined);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('the marker is read for THIS tenant and phone', async () => {
    const store = { getLastInboundAt: vi.fn(async () => null) };
    await sendTextThenTemplate('1555', { text: 'hi', template: T }, undefined, { partnerId: 'acme', store, sendText: vi.fn(), sendTemplate: vi.fn() });
    expect(store.getLastInboundAt).toHaveBeenCalledWith('acme', '1555');
  });

  it('a marker read that throws counts as inside: the plain text', async () => {
    const store = { getLastInboundAt: vi.fn(async () => { throw new Error('redis down'); }) };
    const sendText = vi.fn().mockResolvedValue(undefined);
    const sendTemplate = vi.fn();
    await sendTextThenTemplate('1555', { text: 'hi', template: T }, undefined, { partnerId: 'default', store, sendText, sendTemplate });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('outside the window ⇒ only the template, with the same creds', async () => {
    const creds = { phoneNumberId: 'p', token: 't' };
    const sendText = vi.fn();
    const sendTemplate = vi.fn().mockResolvedValue(undefined);
    await sendTextThenTemplate('1555', { text: 'hi', template: T }, creds, opts(outside, sendText, sendTemplate));
    expect(sendTemplate).toHaveBeenCalledWith('1555', T.name, T.lang, T.params, creds);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('outside the window and the template is not approved (132001) ⇒ the plain text, as today', async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    await sendTextThenTemplate('1555', { text: 'hi', template: T }, undefined, opts(outside, sendText, vi.fn().mockRejectedValue(notApproved())));
    expect(sendText).toHaveBeenCalledWith('1555', 'hi', undefined);
  });

  it('outside, template fails and the text fails ⇒ the TEXT error is thrown (as today)', async () => {
    const te = new Error('graph down');
    await expect(
      sendTextThenTemplate('1555', { text: 'hi', template: T }, undefined, opts(outside, vi.fn().mockRejectedValue(te), vi.fn().mockRejectedValue(notApproved()))),
    ).rejects.toBe(te);
  });

  it('inside, but Graph refuses the text with a window error ⇒ the template once', async () => {
    const sendTemplate = vi.fn().mockResolvedValue(undefined);
    await sendTextThenTemplate('1555', { text: 'hi', template: T }, undefined, opts(inside, vi.fn().mockRejectedValue(win()), sendTemplate));
    expect(sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('inside, window error, then the template fails ⇒ the ORIGINAL window error is thrown (retryable, not a permanent 132001)', async () => {
    const e = win();
    await expect(
      sendTextThenTemplate('1555', { text: 'hi', template: T }, undefined, opts(inside, vi.fn().mockRejectedValue(e), vi.fn().mockRejectedValue(notApproved()))),
    ).rejects.toBe(e);
  });

  it('inside, any other text error ⇒ thrown as-is, template never tried', async () => {
    const e = new Error('graph down');
    const sendTemplate = vi.fn();
    await expect(sendTextThenTemplate('1555', { text: 'hi', template: T }, undefined, opts(inside, vi.fn().mockRejectedValue(e), sendTemplate))).rejects.toBe(e);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('flattens template params for Meta (no new-lines, tabs or long space runs)', async () => {
    const sendTemplate = vi.fn().mockResolvedValue(undefined);
    const t = { name: 'transfer_delivered_sender', lang: 'en', params: ['$50.00', 'Priya\n   \tSharma', 'tx_1'] };
    await sendTextThenTemplate('1555', { text: 'hi', template: t }, undefined, opts(outside, vi.fn(), sendTemplate));
    expect(sendTemplate).toHaveBeenCalledWith('1555', t.name, t.lang, ['$50.00', 'Priya Sharma', 'tx_1'], undefined);
  });
});
