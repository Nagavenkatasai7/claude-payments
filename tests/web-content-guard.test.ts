import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WEB_CHANNEL_NOTE } from '@/lib/agent';

// web-content-guard (B5) — à la bot-content-guard, for the customer dashboard
// chat surface. Nothing the web customer (or the model serving them) sees may
// carry tenant-internal or compliance-internal terminology.

const FORBIDDEN = [
  'partner',
  'settlementpartnerid',
  'compliance',
  'corridor',
  'watchlist',
  'sanctions',
];

// Stored-PII / internal field names that must never surface either.
const PII_TERMS = ['govidnumber', 'gov_id', 'residentialaddress', 'pepdeclared', 'eddcapturedat'];

describe('B5 hard rule: the web chat surface never leaks internal terminology', () => {
  // These files are pure web-surface code — they have no business importing or
  // naming tenant/compliance modules at all, so the FULL SOURCE is scanned.
  const fullSourceFiles = [
    'src/app/account/chat/page.tsx',
    'src/app/account/chat/chat-client.tsx',
    'src/app/api/account/chat/route.ts',
  ];

  for (const rel of fullSourceFiles) {
    it(`${rel} contains no forbidden internal term (full source)`, () => {
      const src = readFileSync(resolve(process.cwd(), rel), 'utf-8').toLowerCase();
      for (const term of [...FORBIDDEN, ...PII_TERMS]) {
        expect(src, `${rel} must not contain "${term}"`).not.toContain(term);
      }
    });
  }

  // web-chat.ts legitimately WIRES the partner store (the agent needs it), so
  // only strings destined for the model/customer are scanned — `content:`
  // literals, the same pattern bot-content-guard uses.
  it('src/lib/web-chat.ts has no chat content literal carrying a forbidden term', () => {
    const contents = readFileSync(resolve(process.cwd(), 'src/lib/web-chat.ts'), 'utf-8');
    const matches = [...contents.matchAll(/content:\s*['"`]([^'"`]*?)['"`]/g)];
    for (const m of matches) {
      const text = m[1].toLowerCase();
      for (const term of [...FORBIDDEN, ...PII_TERMS]) expect(text).not.toContain(term);
    }
  });

  it('the [WEB CHAT] channel note (shown to the model verbatim) is clean', () => {
    const note = WEB_CHANNEL_NOTE.toLowerCase();
    expect(note).toContain('[web chat]');
    for (const term of [...FORBIDDEN, ...PII_TERMS]) {
      expect(note, `WEB_CHANNEL_NOTE must not contain "${term}"`).not.toContain(term);
    }
    // The anti-URL-hallucination rule must be restated for the web surface too.
    expect(note).toContain('never write or guess urls');
  });

  it('the web tool strings (blocked-dispatch error, pay-link hint, EDD hand-off) are clean', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/tools.ts'), 'utf-8');
    // The blocked-dispatch contract is load-bearing: tests + the model both see it.
    expect(src).toContain("{ error: 'not available here' }");
    // Web-only literals: the reply_hint + the EDD WhatsApp hand-off.
    const webLiterals = [...src.matchAll(/(?:reply_hint|error):\s*\n?\s*['"`]([^'"`]*WhatsApp chat[^'"`]*|[^'"`]*payment link below[^'"`]*)['"`]/g)];
    for (const m of webLiterals) {
      const text = m[1].toLowerCase();
      for (const term of [...FORBIDDEN, ...PII_TERMS]) expect(text).not.toContain(term);
    }
  });

  it('the chat UI carries the persistent disclaimer banner', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/app/account/chat/chat-client.tsx'), 'utf-8');
    expect(src).toContain('AI assistant — answers can be wrong.');
    expect(src).toContain('Money only ever moves through your approved pay');
  });
});
