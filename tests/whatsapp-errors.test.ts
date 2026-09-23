import { describe, it, expect } from 'vitest';
import {
  parseGraphError,
  classifyGraphCode,
  WhatsAppSendError,
  isInServiceWindow,
} from '@/lib/whatsapp-errors';

// Program-Fix 25 PR A: the pure Graph error classifier. Meta: "Build your app's
// error handling around error codes instead of subcodes or HTTP response status
// codes" (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/).

const graphBody = (code: number, message = 'x') =>
  JSON.stringify({ error: { message: `(#${code}) ${message}`, type: 'OAuthException', code, fbtrace_id: 'A1' } });

describe('parseGraphError', () => {
  it('reads error.code and error.message from a Graph JSON body', () => {
    expect(parseGraphError(400, graphBody(131030, 'Recipient phone number not in allowed list'))).toEqual({
      code: 131030,
      title: '(#131030) Recipient phone number not in allowed list',
    });
  });

  it('an HTML / garbage / empty body → no code', () => {
    expect(parseGraphError(502, '<html>Bad Gateway</html>')).toEqual({});
    expect(parseGraphError(400, '')).toEqual({});
    expect(parseGraphError(400, '{"error":"nope"}')).toEqual({});
    expect(parseGraphError(400, '{"error":{"code":"131030"}}')).toEqual({}); // a string code is not trusted
    expect(parseGraphError(400, 'null')).toEqual({});
  });
});

describe('classifyGraphCode', () => {
  it('131047 (24h window passed) → window', () => {
    expect(classifyGraphCode(131047)).toBe('window');
  });

  it.each([131030, 131026, 132000, 132001, 133010])('%i → permanent', (code) => {
    expect(classifyGraphCode(code)).toBe('permanent');
  });

  it.each([190, 131049, 131056, 131000, 4, 80007])('%i → retryable', (code) => {
    expect(classifyGraphCode(code)).toBe('retryable');
  });

  it('no code → retryable (an unparseable reply is never terminal)', () => {
    expect(classifyGraphCode(undefined)).toBe('retryable');
  });
});

describe('WhatsAppSendError', () => {
  it('keeps the message string byte-for-byte and carries status / code / kind', () => {
    const body = graphBody(131030, 'Recipient phone number not in allowed list');
    const err = WhatsAppSendError.fromResponse('WhatsApp send failed', 400, body);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WhatsAppSendError);
    expect(err.name).toBe('WhatsAppSendError');
    expect(err.message).toBe(`WhatsApp send failed (400): ${body}`);
    expect(err.status).toBe(400);
    expect(err.code).toBe(131030);
    expect(err.kind).toBe('permanent');
  });

  it('a garbage body → retryable, no code', () => {
    const err = WhatsAppSendError.fromResponse('WhatsApp send failed', 502, '<html/>');
    expect(err.code).toBeUndefined();
    expect(err.kind).toBe('retryable');
  });
});

describe('isInServiceWindow (reads the existing lastmsg:{partner}:{phone} key)', () => {
  it('key present → true', async () => {
    const store = { getLastInboundAt: async () => '2026-09-23T00:00:00.000Z' };
    expect(await isInServiceWindow(store, 'default', '15550001111')).toBe(true);
  });

  it('key missing → false', async () => {
    const store = { getLastInboundAt: async () => null };
    expect(await isInServiceWindow(store, 'default', '15550001111')).toBe(false);
  });

  it('a Redis error counts as OUTSIDE the window', async () => {
    const store = {
      getLastInboundAt: async (): Promise<string | null> => {
        throw new Error('redis down');
      },
    };
    expect(await isInServiceWindow(store, 'default', '15550001111')).toBe(false);
  });

  it('passes the partner and phone through to the store read', async () => {
    const seen: string[] = [];
    const store = {
      getLastInboundAt: async (p: string, phone: string) => {
        seen.push(`${p}:${phone}`);
        return null;
      },
    };
    await isInServiceWindow(store, 'acme', '15550002222');
    expect(seen).toEqual(['acme:15550002222']);
  });
});
