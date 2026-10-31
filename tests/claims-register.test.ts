import { describe, it, expect } from 'vitest';
import {
  APPROVED_PUBLIC_PHRASINGS,
  BANNED_PUBLIC_CLAIMS,
  BANNED_REPLY_CLAIMS,
  findPublicClaims,
} from '@/lib/claims-register';

// R20: the public pages may say only what SmartRemit can stand behind. The
// register holds the banned public claims and the approved way to say each
// thing; findPublicClaims is the scanner tests/landing-claims.test.ts runs over
// the public page sources.

const ids = (text: string, scope?: 'site' | 'home') => findPublicClaims(text, scope).map((h) => h.id);

describe('BANNED_PUBLIC_CLAIMS', () => {
  it('has unique ids, a reason and a scope for every claim', () => {
    const all = BANNED_PUBLIC_CLAIMS.map((c) => c.id);
    expect(new Set(all).size).toBe(all.length);
    for (const c of BANNED_PUBLIC_CLAIMS) {
      expect(c.why.length).toBeGreaterThan(10);
      expect(['site', 'home']).toContain(c.scope);
    }
  });

  it('keeps the reply register separate (the reply guard reads only BANNED_REPLY_CLAIMS)', () => {
    expect(BANNED_REPLY_CLAIMS.map((c) => c.id)).toEqual(['instant', 'minutes', 'immediate', 'guaranteed']);
  });
});

describe('findPublicClaims: the old public wording is caught', () => {
  const OLD: Array<[string, string]> = [
    ['Mom · HDFC ••6210 · in minutes', 'delivery-minutes'],
    ['Many transfers are delivered within minutes.', 'delivery-minutes'],
    ['Your money arrives instantly.', 'instant'],
    ['Delivery is guaranteed.', 'guaranteed'],
    ['Staff watch money move in real time — live transfers.', 'money-real-time'],
    ['PII stays encrypted at rest, and every reveal is written to the audit log.', 'encryption-overclaim'],
    ['PII encrypted at rest — every staff reveal is audited.', 'encryption-overclaim'],
    ['Payout destinations, recipient legal names, customer data and integration secrets are AES-256-GCM encrypted at rest', 'encryption-overclaim'],
    ['All customer data is encrypted at rest.', 'encryption-overclaim'],
    ['a licensed partner settles — every step signed and audited.', 'audit-overclaim'],
    ['Full audit trail, end to end', 'audit-overclaim'],
    ["{ icon: <ShieldIcon />, label: 'Safe and secure' },", 'safety-overclaim'],
    ['Built so the money path is safe by construction.', 'safety-overclaim'],
    ['Quote, KYC, approval, receipt — the entire transfer is a conversation.', 'whole-transfer-in-chat'],
    ['SmartRemit makes the whole thing happen inside a WhatsApp conversation — no app to install.', 'whole-transfer-in-chat'],
    ['A real transfer moving through SmartRemit — conversation, quote, pay, settle, delivered.', 'illustration-as-real'],
    ['A live transfer flowing through SmartRemit: a WhatsApp message', 'illustration-as-real'],
    ['the chat, quoting, screening and pay-page software that licensed partners offer under their own brand.', 'own-brand'],
    ["id: 'telegram', title: 'Telegram', status: 'available', badge: 'Available now',", 'telegram-available-now'],
    ['SmartRemit is a licensed money transmitter.', 'smartremit-licensed'],
    ['Transfers licensed by SmartRemit.', 'smartremit-licensed'],
    ['SmartRemit sends your money to India.', 'smartremit-moves-money'],
    ['SmartRemit, a service that lets people send money between 18 countries.', 'smartremit-service'],
  ];

  for (const [text, id] of OLD) {
    it(`"${text.slice(0, 60)}" → ${id}`, () => {
      expect(ids(text)).toContain(id);
    });
  }

  it('the whitespace of wrapped JSX text does not hide a claim', () => {
    expect(ids('PII stays\n                    encrypted at rest')).toContain('encryption-overclaim');
    expect(ids('the entire\n   transfer is a\n conversation')).toContain('whole-transfer-in-chat');
  });

  it('names AI apps only on the home page (Q11: the AI apps are not named there)', () => {
    const text = 'AI assistants such as Claude, ChatGPT and Perplexity are in early access.';
    expect(ids(text, 'home')).toContain('named-ai-apps');
    // The AI-apps guide keeps each app's own connector steps.
    expect(ids(text, 'site')).not.toContain('named-ai-apps');
    expect(ids(text)).not.toContain('named-ai-apps');
  });

  it('reports each hit with a short excerpt, never the whole text', () => {
    const hits = findPublicClaims(`${'x '.repeat(400)}Many transfers are delivered within minutes.${' y'.repeat(400)}`);
    expect(hits).toHaveLength(1);
    expect(hits[0].excerpt).toContain('within minutes');
    expect(hits[0].excerpt.length).toBeLessThanOrEqual(120);
  });
});

describe('findPublicClaims: true statements pass', () => {
  const OK = [
    'You can cancel within 30 minutes of payment for a full refund.',
    'The exchange rate is locked for up to 30 minutes.',
    'It locks for <Fact name="rateLockMinutes" /> minutes only once the customer starts the send.',
    'Wait a minute, then try again.',
    'requests per minute per partner, shared by all of your keys',
    'Delivery is not instant: your receipt shows when the money is expected to arrive.',
    'A delivery date is an estimate and is never guaranteed.',
    'SmartRemit is non-custodial technology infrastructure — not a bank and not a money transmitter.',
    'SmartRemit never holds, receives or disburses customer money.',
    'Payout account details, identity data and integration secrets are encrypted at the field level.',
    'Phone numbers, support messages and the recent chat history are not encrypted yet.',
    'Every staff reveal of personal data is written to the audit log.',
    'Sanctions screening runs on every transfer (demo: reference list; production feed per partner).',
    "id: 'whatsapp', title: 'WhatsApp', status: 'available', badge: 'Available now', body: 'Chat with the SmartRemit AI.'",
    "id: 'telegram', title: 'Telegram', status: 'by-invitation', badge: 'By invitation',",
    'Start on WhatsApp. Telegram is open by invitation.',
  ];
  for (const text of OK) {
    it(`"${text.slice(0, 60)}" passes`, () => {
      expect(findPublicClaims(text, 'home')).toEqual([]);
    });
  }
});

describe('APPROVED_PUBLIC_PHRASINGS', () => {
  it('names a topic, the wording and the evidence for each approved phrasing', () => {
    const topics = APPROVED_PUBLIC_PHRASINGS.map((p) => p.topic);
    expect(new Set(topics).size).toBe(topics.length);
    for (const t of ['provider', 'custody', 'delivery', 'encryption', 'staff-access', 'sanctions', 'telegram', 'ai-apps', 'ai-chat']) {
      expect(topics).toContain(t);
    }
    for (const p of APPROVED_PUBLIC_PHRASINGS) {
      expect(p.say.length).toBeGreaterThan(10);
      expect(p.evidence.length).toBeGreaterThan(5);
    }
  });

  it('every approved phrasing passes the banned-claim scan, home scope included', () => {
    for (const p of APPROVED_PUBLIC_PHRASINGS) expect({ topic: p.topic, hits: findPublicClaims(p.say, 'home') }).toEqual({ topic: p.topic, hits: [] });
  });

  it('never uses the words the public site may not use', () => {
    for (const p of APPROVED_PUBLIC_PHRASINGS) expect(p.say).not.toMatch(/\b(test|tests|testing|testers?|beta|pilot)\b/i);
  });
});
