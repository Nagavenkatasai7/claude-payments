import { describe, it, expect } from 'vitest';
import { waMessageRef, WA_MESSAGE_REF_PURPOSE } from '@/lib/wa-message-ref';
import { blindIndex } from '@/lib/blind-index';

// Program-Fix 26 (review): a WhatsApp message id is never stored or logged raw;
// audit rows and log lines carry a KEYED reference to it instead.

// Meta-style id (synthetic digits): `wamid.` + base64 of an opaque blob.
const META_STYLE_ID = 'wamid.HBgLMTU1NTk4NzEyMzQVAgARGBI5QzZBOEQ3RjA0QjE2NjJCMzcA';
const BASE64_PART = META_STYLE_ID.slice('wamid.'.length);

describe('waMessageRef', () => {
  it('is keyed (the blind-index HMAC under its own purpose), deterministic and letters-only', () => {
    const ref = waMessageRef(META_STYLE_ID);
    expect(ref).toBe(waMessageRef(META_STYLE_ID));
    expect(ref).toMatch(/^[a-p]{64}$/);
    const hex = blindIndex(WA_MESSAGE_REF_PURPOSE, META_STYLE_ID);
    expect(ref).toBe(hex.replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)]));
    expect(waMessageRef('wamid.OTHER')).not.toBe(ref);
  });

  it('never contains the id, its base64 body, or any digit run of 7+', () => {
    const ref = waMessageRef(META_STYLE_ID);
    expect(ref).not.toContain(BASE64_PART.slice(0, 8));
    expect(ref).not.toMatch(/\d{7,}/);
    expect(ref).not.toContain('wamid');
  });

  it('never throws: an empty id or a missing key yields a fixed marker', () => {
    expect(waMessageRef('')).toBe('none');
    expect(waMessageRef(META_STYLE_ID, () => { throw new Error('no key'); })).toBe('unavailable');
  });
});
