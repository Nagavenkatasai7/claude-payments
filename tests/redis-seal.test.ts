import { describe, it, expect } from 'vitest';
import { encryptField } from '@/lib/field-crypto';
import { threadKeyFor } from '@/lib/customer-ref';
import {
  conversationSealCtx,
  draftSealCtx,
  isSealed,
  openJson,
  sealedConversationKey,
  sealedDraftPointerKey,
} from '@/lib/redis-seal';

// R49 part 1 (readers only): the sealed Redis format PR9's writers will use.
// A value is the field-crypto v2 envelope over the JSON text, bound to its
// tenant + thread (chat history) or its draft id (pay-link draft); a key holds
// the keyed thread HMAC (customer-ref threadKeyFor), never the phone.

const PHONE = '15551234567';
const hex = (pid: string, phone: string) => threadKeyFor(pid, phone).toString('hex');

describe('key shapes hold no phone', () => {
  it('conversation keys: conv:<pid>:h:<thread hmac>, per tenant and per thread', () => {
    const k = sealedConversationKey('acme', PHONE);
    expect(k).toBe(`conv:acme:h:${hex('acme', PHONE)}`);
    expect(k).not.toContain(PHONE);
    expect(k).toMatch(/^conv:acme:h:[0-9a-f]{64}$/);
    expect(sealedConversationKey('beta', PHONE)).not.toBe(k);
    // The web thread (web-chat.ts threadPhone 'web:<phone>') has its own HMAC.
    const web = sealedConversationKey('acme', `web:${PHONE}`);
    expect(web).not.toBe(k);
    expect(web).not.toContain(PHONE);
  });

  it('draft pointer keys: active_draft:<pid>:h:<hmac> and the web namespace', () => {
    expect(sealedDraftPointerKey('acme', PHONE, 'bot')).toBe(`active_draft:acme:h:${hex('acme', PHONE)}`);
    expect(sealedDraftPointerKey('acme', PHONE, 'web')).toBe(`active_draft:web:acme:h:${hex('acme', PHONE)}`);
    for (const p of ['bot', 'web'] as const) expect(sealedDraftPointerKey('acme', PHONE, p)).not.toContain(PHONE);
  });
});

describe('isSealed', () => {
  it('a v2 envelope is sealed; JSON is not', () => {
    expect(isSealed(encryptField('[]', undefined, draftSealCtx('d1')))).toBe(true);
    expect(isSealed('[{"role":"user","content":"hi"}]')).toBe(false);
    expect(isSealed('{"senderPhone":"1"}')).toBe(false);
    expect(isSealed('')).toBe(false);
  });
});

describe('openJson reads both formats', () => {
  const history = [{ role: 'user', content: 'send 100 to mom' }];

  it('plaintext JSON (what this build still writes) passes through', () => {
    expect(openJson(JSON.stringify(history), conversationSealCtx('acme', PHONE))).toEqual(history);
  });

  it('a sealed conversation opens under its own tenant and thread only', () => {
    const blob = encryptField(JSON.stringify(history), undefined, conversationSealCtx('acme', PHONE));
    expect(blob).not.toContain('mom');
    expect(openJson(blob, conversationSealCtx('acme', PHONE))).toEqual(history);
    expect(() => openJson(blob, conversationSealCtx('beta', PHONE))).toThrow();
    expect(() => openJson(blob, conversationSealCtx('acme', '15550000000'))).toThrow();
    expect(() => openJson(blob, conversationSealCtx('acme', `web:${PHONE}`))).toThrow();
  });

  it('a sealed draft opens under its own draft id only (a blob copied to another id does not open)', () => {
    const draft = { senderPhone: PHONE, partnerId: 'acme', recipientName: 'Mom' };
    const blob = encryptField(JSON.stringify(draft), undefined, draftSealCtx('draftA'));
    expect(openJson(blob, draftSealCtx('draftA'))).toEqual(draft);
    expect(() => openJson(blob, draftSealCtx('draftB'))).toThrow();
  });

  it('a corrupt sealed value throws (the caller decides what to do)', () => {
    expect(() => openJson('v2.k0.garbage', draftSealCtx('d1'))).toThrow();
    expect(() => openJson('not json', draftSealCtx('d1'))).toThrow();
  });

  it('error text never carries the key parts', () => {
    const blob = encryptField('{}', undefined, conversationSealCtx('acme', PHONE));
    try {
      openJson(blob, conversationSealCtx('beta', PHONE));
    } catch (err) {
      expect(String(err)).not.toContain(PHONE);
      expect(String(err)).not.toContain(hex('beta', PHONE));
    }
  });
});
