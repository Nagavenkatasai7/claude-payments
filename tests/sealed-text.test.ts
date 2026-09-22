import { describe, it, expect } from 'vitest';
import { renderSealedText } from '@/lib/sealed-text';
import { encryptField, decryptField, EnvKeyProvider } from '@/lib/field-crypto';

// sealed-text — the ONE way an outbox payload may carry a capability (fix 11 /
// F66): the value is sealed with field-crypto at enqueue and opened at SEND time.
// tests/setup.ts pins FIELD_ENCRYPTION_KEY to 32×0x07, so the default provider
// matches this one — injected explicitly to keep the test env-independent.
const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const open = (blob: string) => decryptField(blob, provider);

describe('renderSealedText', () => {
  it('replaces each {{key}} with the DECRYPTED sealed value', () => {
    const sealed = { apply_link: encryptField('https://smartremit.test/partners/apply/abc', provider) };
    expect(renderSealedText('Hi,\n\n{{apply_link}}\n\nBye', sealed, open)).toBe(
      'Hi,\n\nhttps://smartremit.test/partners/apply/abc\n\nBye',
    );
  });

  it('returns the text untouched when nothing is sealed (legacy rows, plain emails)', () => {
    expect(renderSealedText('plain text', undefined, open)).toBe('plain text');
    expect(renderSealedText('plain text', null, open)).toBe('plain text');
    expect(renderSealedText('no placeholders', {}, open)).toBe('no placeholders');
  });

  it('throws naming ONLY the placeholder (never a value) when a key has no sealed blob', () => {
    expect(() => renderSealedText('x {{apply_link}} y', {}, open)).toThrow(
      'sealed-text: no sealed value for {{apply_link}}',
    );
  });

  it('a tampered blob fails closed (the field-crypto auth error propagates)', () => {
    const blob = encryptField('https://x', provider);
    const tampered = blob.slice(0, -4) + (blob.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => renderSealedText('{{apply_link}}', { apply_link: tampered }, open)).toThrow();
  });

  it('defaults to the env key provider (the worker calls it without an opener)', () => {
    const sealed = { apply_link: encryptField('https://smartremit.test/partners/apply/def') };
    expect(renderSealedText('{{apply_link}}', sealed)).toBe('https://smartremit.test/partners/apply/def');
  });
});
