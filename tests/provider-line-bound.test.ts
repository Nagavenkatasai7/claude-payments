// Review R2-Q1 K1: one bound for the provider line (PROVIDER_LINE_MAX = 200). providerLineFor
// returns null for a longer line and the partner form refuses a block that would build one, so
// every surface shows the same exact line: the chat surfaces' bounding call can no longer cut it.
import { describe, expect, it } from 'vitest';
import { PROVIDER_LINE_MAX, providerLineFor } from '@/lib/legal/provider-line';
import type { ResolvedDisclosure } from '@/lib/partner-config';
import { parseDisclosureForm } from '@/lib/partner-support-settings';
import { fixedReply } from '@/lib/hold-replies';
import { buildApproveSummary } from '@/lib/tools';
import { buildSystemPrompt } from '@/lib/prompt';
import type { Quote } from '@/lib/types';

// 'Payments by ' (12) + entity + ', licensed by ' (14) + regulator
const FIXED = 'Payments by , licensed by '.length;

function d(entity: string, regulator: string): ResolvedDisclosure {
  return {
    demo: false, configured: true, licensedEntity: entity, licenseIds: [], phone: null, website: null,
    stateRegulator: { name: regulator, phone: null, website: null }, deliveryBusinessDays: 1,
    partnerApproved: true, hash: 'dh1:' + 'e'.repeat(64),
  } as unknown as ResolvedDisclosure;
}

const form = (over: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ licensedEntity: 'Acme Money Services LLC', regulatorName: 'State Department of Financial Services', ...over })) f.set(k, v);
  return f;
};

const ent = (n: number) => `Acme ${'e'.repeat(n - 5)}`;
const reg = (n: number) => `Dept ${'r'.repeat(n - 5)}`;

describe('provider line bound (R2-Q1 K1)', () => {
  it('PROVIDER_LINE_MAX is 200', () => {
    expect(PROVIDER_LINE_MAX).toBe(200);
  });

  it('a 120-character entity and a 120-character regulator -> null (never a cut line)', () => {
    expect(providerLineFor(d(ent(120), reg(120)))).toBeNull();
  });

  it('a line of exactly 200 characters is returned whole; 201 -> null', () => {
    const e = ent(100);
    const line = providerLineFor(d(e, reg(200 - FIXED - 100)));
    expect(line).not.toBeNull();
    expect([...line!].length).toBe(200);
    expect(providerLineFor(d(e, reg(201 - FIXED - 100)))).toBeNull();
  });

  it('parseDisclosureForm refuses entity + regulator that build a longer line (provider_line_too_long)', () => {
    expect(parseDisclosureForm(form({ licensedEntity: ent(120), regulatorName: reg(120) }))).toEqual({ ok: false, reason: 'provider_line_too_long' });
    expect(parseDisclosureForm(form({ licensedEntity: ent(100), regulatorName: reg(201 - FIXED - 100) }))).toEqual({ ok: false, reason: 'provider_line_too_long' });
    expect(parseDisclosureForm(form({ licensedEntity: ent(100), regulatorName: reg(200 - FIXED - 100) })).ok).toBe(true);
    // No regulator -> no line, so a long entity alone is not refused for this reason.
    expect(parseDisclosureForm(form({ licensedEntity: ent(120), regulatorName: '' })).ok).toBe(true);
  });

  it('a 200-character approved line passes fixedReply, the Approve card and the prompt unchanged (no ellipsis)', () => {
    const line = providerLineFor(d(ent(100), reg(200 - FIXED - 100)))!;
    expect(fixedReply('cannot_complete', { providerLine: line }).endsWith(`\n${line}`)).toBe(true);
    const q: Quote = {
      amountUsd: 500, feeUsd: 1.99, totalChargeUsd: 501.99, fxRate: 83, amountInr: 41500,
      deliveryEstimate: 'within 1 business day', sourceCurrency: 'USD', amountSource: 500,
      feeSource: 1.99, totalChargeSource: 501.99,
    } as Quote;
    const card = buildApproveSummary(q, 'Mom', 'bank', 'HDFC0001234 123456789', 'bank_transfer', 'INR', undefined, undefined, undefined, line);
    expect(card.split('\n').at(-1)).toBe(line);
    const p = buildSystemPrompt({ brand: 'SmartRemit', providerLine: line });
    expect(p).toContain(JSON.stringify(line));
    for (const s of [fixedReply('cannot_complete', { providerLine: line }), card]) expect(s).not.toContain('…');
  });
});
