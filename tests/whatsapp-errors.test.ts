import { describe, it, expect } from 'vitest';
import {
  parseGraphError,
  classifyGraphCode,
  WhatsAppSendError,
  isInServiceWindow,
  permanentCodeInError,
  sendOutcomeFromError,
  PERMANENT_GRAPH_CODES,
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

// Program-Fix 25 PR B (b): ONE permanent-code list. ops-diagnosis derives its
// Retry-disable from this classifier instead of keeping its own copy.
describe('131031 (account restricted / locked) is permanent — PR B', () => {
  it('classifies 131031 as permanent (Meta: resolved through Policy Enforcement, not a retry)', () => {
    expect(classifyGraphCode(131031)).toBe('permanent');
    expect(PERMANENT_GRAPH_CODES).toEqual(expect.arrayContaining([131030, 131031, 131026, 132000, 132001, 133010]));
    expect(PERMANENT_GRAPH_CODES).not.toContain(131047); // window: a retry after the customer writes back can work
  });
});

describe('permanentCodeInError — reads a stored last_error / message string', () => {
  it('finds the (#code) marker, even in a truncated Graph body', () => {
    expect(
      permanentCodeInError('WhatsApp send failed (400): {"error":{"message":"(#131030) Recipient phone number not in allowed list"'),
    ).toBe(131030);
    expect(permanentCodeInError('Graph error (#131031) account restricted')).toBe(131031);
  });
  it('finds a JSON "code": field when there is no (#code) marker', () => {
    expect(permanentCodeInError('WhatsApp template send failed (404): {"error":{"code":132001}}')).toBe(132001);
  });
  it('a retryable / window / absent code → undefined', () => {
    expect(permanentCodeInError('WhatsApp send failed (400): (#131056) rate limited')).toBeUndefined();
    expect(permanentCodeInError('WhatsApp send failed (400): {"error":{"code":131047}}')).toBeUndefined();
    expect(permanentCodeInError('Settlement instruction rejected (503)')).toBeUndefined();
    expect(permanentCodeInError('')).toBeUndefined();
    expect(permanentCodeInError(null)).toBeUndefined();
    expect(permanentCodeInError(undefined)).toBeUndefined();
  });
});

describe('sendOutcomeFromError — PR B', () => {
  it('a WhatsAppSendError → ok:false carrying its Graph code', () => {
    const err = WhatsAppSendError.fromResponse('WhatsApp send failed', 400, graphBody(131030));
    expect(sendOutcomeFromError(err)).toEqual({ ok: false, code: 131030, reason: 'send_failed', error: err });
  });
  it('a plain Error → ok:false with no code', () => {
    const err = new Error('boom');
    expect(sendOutcomeFromError(err)).toEqual({ ok: false, reason: 'send_failed', error: err });
  });
});

// R2a: the partner-action (token) codes. Meta error-codes page: 190 = access
// token expired (also used for a revoked token); 0 = unable to authenticate the
// app user. They stay RETRYABLE (a re-saved token rescues rows still backing
// off); this only decides when the partner is told.
describe('isAuthErrorCode (R2a)', () => {
  it('190 and 0 are auth errors; others and undefined are not', async () => {
    const { isAuthErrorCode, classifyGraphCode } = await import('@/lib/whatsapp-errors');
    expect(isAuthErrorCode(190)).toBe(true);
    expect(isAuthErrorCode(0)).toBe(true);
    expect(isAuthErrorCode(131047)).toBe(false);
    expect(isAuthErrorCode(undefined)).toBe(false);
    expect(classifyGraphCode(190)).toBe('retryable');
  });
});
