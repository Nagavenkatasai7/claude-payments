import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

// UI redesign M4 PR-6: the /trust page content (src/content/trust/**) must stay honest. It states
// only what is true today: no certification or attestation that has not happened, no sanctions
// list that is not live, no encryption claim wider than the code, and unverified regions say so.
// The wording mirrors the internal compliance report; the reviewer checks it against that source.

const FORBIDDEN = [
  // "certified" only inside a negation ("We are not ISO 27001 certified."): variable-length lookbehind.
  /\bcompliant\b/i, /(?<!\bnot\b[^.]{0,40})\bcertified\b/i, /SOC 2 Type/i, /\bOFAC\b/i, /\bSDN\b/, /bank-grade|military-grade/i,
  /all (customer |personal )?data is encrypted|fully encrypted|end-to-end encrypted/i, /we sign (a )?(DPA|data-processing)/i,
  /recipient names? (are|is) encrypted/i, /MFA (is )?(required|enforced)/i, /24\/7/i, /security@/i,
  /logs? \(scrubbed\)/i,
];
// A response-time promise ("within 48 hours", "5 business days"): the owner chose none.
const TIME_PROMISE = /\b\d+\s*(business\s+|working\s+)?(hours?|days?)\b/i;

async function modules() {
  const c = await import('@/content/trust/compliance-status');
  const s = await import('@/content/trust/subprocessors');
  const o = await import('@/content/trust/security-overview');
  const d = await import('@/content/trust/disclosure');
  return { c, s, o, d };
}
async function allTrustText() {
  const { c, s, o, d } = await modules();
  return JSON.stringify([c, s, o, d]);
}

describe('the forbidden-phrase matcher', () => {
  it('lets a negated "certified" through and catches a bare one', () => {
    const certified = FORBIDDEN[1];
    expect(certified.test('We are not ISO 27001 certified.')).toBe(false);
    expect(certified.test('We are ISO certified.')).toBe(true);
  });
  it('catches a time promise and ignores a month stamp', () => {
    expect(TIME_PROMISE.test('We reply within 48 hours.')).toBe(true);
    expect(TIME_PROMISE.test('within 5 business days')).toBe(true);
    expect(TIME_PROMISE.test('As of 2026-09')).toBe(false);
  });
});

describe('Trust content is honest', () => {
  it('uses no over-claiming phrase and makes no time promise', async () => {
    const text = await allTrustText();
    for (const r of FORBIDDEN) expect({ r: String(r), hit: r.test(text) }).toEqual({ r: String(r), hit: false });
    expect(TIME_PROMISE.test(text)).toBe(false);
  });

  it('pins the SOC 2, ISO and GDPR rows to the honest wording', async () => {
    const { COMPLIANCE_STATUS, COMPLIANCE_AS_OF } = await import('@/content/trust/compliance-status');
    const byName = (f: string) => COMPLIANCE_STATUS.find((r) => r.framework === f)?.status;
    expect(byName('SOC 2')).toBe(
      'We have not undergone a SOC 2 examination. Our controls are being aligned to the AICPA Trust Services Criteria.',
    );
    expect(byName('ISO/IEC 27001:2022')).toBe('We are not ISO 27001 certified.');
    expect(byName('UK GDPR / EU GDPR')).toBe(
      'We act as our partners’ processor for customer data. A data-processing agreement is in preparation.',
    );
    expect(COMPLIANCE_AS_OF).toMatch(/^\d{4}-\d{2}$/);
  });

  it('the sanctions point says the list is a reference list, not a government list', async () => {
    const { SECURITY_POINTS } = await import('@/content/trust/security-overview');
    const sanctions = SECURITY_POINTS.find((p) => p.title === 'Sanctions screening');
    expect(sanctions?.body).toMatch(/reference list/);
    expect(sanctions?.body).toMatch(/cannot be switched off/);
    expect(sanctions?.body).not.toMatch(/per partner|production feed/i);
  });

  it('every sub-processor has purpose, data and a region; unconfirmed regions say so', async () => {
    const { SUBPROCESSORS } = await import('@/content/trust/subprocessors');
    expect(SUBPROCESSORS.length).toBeGreaterThan(0);
    for (const s of SUBPROCESSORS) {
      expect({ name: s.name, ok: Boolean(s.purpose && s.data && s.region) }).toEqual({ name: s.name, ok: true });
      if (s.regionStatus !== 'confirmed') expect({ name: s.name, region: s.region }).toEqual({ name: s.name, region: 'Being confirmed' });
      else expect(s.region).not.toBe('Being confirmed');
    }
  });

  it('lists the core stack and email host, and nothing switched off or unconfirmed', async () => {
    const { SUBPROCESSORS } = await import('@/content/trust/subprocessors');
    const names = SUBPROCESSORS.map((s) => s.name).join('|');
    for (const n of ['Vercel', 'Neon', 'Upstash', 'WhatsApp', 'Ollama', 'Persona', 'Hostinger']) expect(names).toContain(n);
    // Card funding is off; error reporting is unconfirmed; ops alerts go to WhatsApp only.
    expect(names).not.toMatch(/Stripe|Sentry|webhook/i);
  });

  it('the cache row names every category it holds, including payout details in short-lived drafts', async () => {
    const { SUBPROCESSORS } = await import('@/content/trust/subprocessors');
    const upstash = SUBPROCESSORS.find((s) => s.name === 'Upstash');
    expect(upstash?.data).toMatch(/phone numbers/i);
    expect(upstash?.data).toMatch(/chat text/i);
    expect(upstash?.data).toMatch(/payout account details/i);
    expect(upstash?.data).toMatch(/recipient name/i);
  });

  it('the encryption point does not hide the short-lived draft copy', async () => {
    const { SECURITY_POINTS } = await import('@/content/trust/security-overview');
    const fle = SECURITY_POINTS.find((p) => p.title === 'Field-level encryption');
    expect(fle?.body).toMatch(/in our database/);
    expect(fle?.body).toMatch(/up to 30 minutes/);
  });

  it('the disclosure policy does not tell outside researchers to use keys they cannot get', async () => {
    const src = (await import('node:fs')).readFileSync('SECURITY.md', 'utf8');
    expect(src).not.toMatch(/^- Test only with your own sandbox keys/m);
    expect(src).toMatch(/If you are a partner, use only your sandbox keys/);
  });

  it('file storage is its own row: the function region does not prove where stored documents live', async () => {
    const { SUBPROCESSORS } = await import('@/content/trust/subprocessors');
    const blob = SUBPROCESSORS.find((s) => /file storage/i.test(s.purpose));
    expect(blob?.data).toMatch(/partner documents/i);
    expect(blob?.regionStatus).toBe('being-confirmed');
    for (const s of SUBPROCESSORS.filter((x) => x.regionStatus === 'confirmed'))
      expect({ name: s.name, storage: /documents|file storage/i.test(s.purpose + s.data) }).toEqual({ name: s.name, storage: false });
  });

  it('the disclosure contact is an existing public mailbox, not an invented one', async () => {
    const { DISCLOSURE_CONTACT } = await import('@/content/trust/disclosure');
    expect(DISCLOSURE_CONTACT).toBe('support@smartremit.ai');
    expect(readFileSync('src/app/page.tsx', 'utf8')).toContain(`mailto:${DISCLOSURE_CONTACT}`);
  });

  it('the disclosure policy covers scope, rules, no bounty and a draft safe harbour', async () => {
    const { DISCLOSURE_POLICY } = await import('@/content/trust/disclosure');
    expect(DISCLOSURE_POLICY.scope.length).toBeGreaterThan(0);
    expect(DISCLOSURE_POLICY.please.length).toBeGreaterThan(0);
    expect(DISCLOSURE_POLICY.pleaseDont.length).toBeGreaterThan(0);
    expect(DISCLOSURE_POLICY.bounty).toMatch(/no bug bounty/i);
    expect(DISCLOSURE_POLICY.safeHarbor.draft).toBe(true);
  });
});

describe('SECURITY.md (repo root)', () => {
  it('exists, names the disclosure mailbox, and makes no time promise or over-claim', async () => {
    expect(existsSync('SECURITY.md')).toBe(true);
    const md = readFileSync('SECURITY.md', 'utf8');
    const { DISCLOSURE_CONTACT } = await import('@/content/trust/disclosure');
    expect(md).toContain(DISCLOSURE_CONTACT);
    expect(md).not.toMatch(/security@/i);
    expect(TIME_PROMISE.test(md)).toBe(false);
    for (const r of FORBIDDEN) expect({ r: String(r), hit: r.test(md) }).toEqual({ r: String(r), hit: false });
    expect(md).toMatch(/draft/i);
  });
  it('does not link the unlinked preview routes before the post-demo swap', () => {
    expect(readFileSync('SECURITY.md', 'utf8')).not.toMatch(/\/(trust|docs-next)\b/);
  });
});
