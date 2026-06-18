import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChatMessage, Customer } from '@/lib/types';
import type { AuditEntry } from '@/lib/kyc-case-store';

// Tier-1 KYC review-decision copilot — the suggest-only AI module. Two concerns:
//  1. PROMPT-CONTENT GUARD (à la ticket-ai): the system prompt must carry the
//     forbidden-content rules — no promises/guarantees, no refund commitments,
//     no compliance/screening/sanctions detail, no financial advice, no invented
//     facts — and interpolate the shared GUARDRAILS block.
//  2. BEHAVIOR with chat() stubbed: the structured output clamps to the closed
//     lists (off-list decision → need_more, off-list confidence → low,
//     non-array reasons → []); valid output round-trips; an empty model reply
//     throws (callers degrade to "AI unavailable"); the one-shot contract passes
//     NO tools, ever.

vi.mock('@/lib/ollama', () => ({ chat: vi.fn() }));

import { chat } from '@/lib/ollama';
import {
  suggestKycReview,
  KYC_DECISIONS,
  KYC_CONFIDENCES,
} from '@/lib/kyc-review-ai';

const chatMock = vi.mocked(chat);

function reply(content: string | null): ChatMessage {
  return { role: 'assistant', content };
}

const customer: Customer = {
  senderPhone: '15551230000',
  firstSeenAt: '2026-06-01T00:00:00.000Z',
  kycStatus: 'pending',
  kycReviewState: 'pending_review',
  kycInquiryId: 'inq_abc',
  fullName: 'Jane Q. Sender',
  dateOfBirth: '1990-01-01',
  occupation: 'salaried',
  idLast4: '4242',
  watchlistHit: false,
  pepHit: false,
  senderCountry: 'US',
  partnerId: 'default',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

const audit: AuditEntry[] = [
  { at: '2026-06-01T00:00:00.000Z', actor: 'persona', action: 'inquiry.completed' },
  { at: '2026-06-02T00:00:00.000Z', actor: 'system', action: 'review.queued', reason: 'clean pass' },
];

const GOOD =
  '{"summary":"l1\\nl2\\nl3\\nl4\\nl5","suggested_decision":"approve","confidence":"high","top_reasons":["clean pass","id verified"]}';

beforeEach(() => {
  chatMock.mockReset();
});

describe('prompt-content guard: the system prompt forbids the dangerous content', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/lib/kyc-review-ai.ts'), 'utf-8');

  it('forbids promises and guarantees', () => {
    expect(src).toMatch(/never make promises or guarantees/i);
    expect(src).toMatch(/no delivery promises/i);
  });

  it('forbids refund commitments — "our team reviews refunds" is the only allowed framing', () => {
    expect(src).toMatch(/never commit to a refund/i);
    expect(src).toMatch(/our team reviews refunds/i);
  });

  it('forbids compliance/screening/sanctions detail', () => {
    expect(src).toMatch(/never reveal compliance, screening, sanctions/i);
  });

  it('forbids financial advice', () => {
    expect(src).toMatch(/never give financial advice/i);
  });

  it('forbids inventing transaction facts', () => {
    expect(src).toMatch(/never invent transaction facts/i);
  });

  it('the system prompt interpolates the shared GUARDRAILS block', () => {
    const refs = src.match(/\$\{GUARDRAILS\}/g) ?? [];
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(src).toContain('REVIEW_SYSTEM');
  });

  it('system message passed to chat() actually carries the rules — and NO tools', async () => {
    chatMock.mockResolvedValue(reply(GOOD));
    await suggestKycReview(customer, audit);
    const system = chatMock.mock.calls[0][0][0];
    expect(system.role).toBe('system');
    expect(system.content).toMatch(/never make promises or guarantees/i);
    expect(system.content).toMatch(/our team reviews refunds/i);
    expect(system.content).toMatch(/never reveal compliance, screening, sanctions/i);
    // one-shot contract: NO tools, ever
    expect(chatMock.mock.calls[0][1]).toEqual([]);
  });

  it('is suggest-only — the prompt states the human makes the final decision', () => {
    expect(src).toMatch(/human .* (final|decision)/i);
  });
});

describe('suggestKycReview — output clamped to the closed lists', () => {
  it('returns a valid suggestion verbatim', async () => {
    chatMock.mockResolvedValue(reply(GOOD));
    expect(await suggestKycReview(customer, audit)).toEqual({
      summary: 'l1\nl2\nl3\nl4\nl5',
      suggested_decision: 'approve',
      confidence: 'high',
      top_reasons: ['clean pass', 'id verified'],
    });
  });

  it('every allowed decision round-trips', async () => {
    for (const d of KYC_DECISIONS) {
      chatMock.mockResolvedValue(reply(`{"summary":"s","suggested_decision":"${d}","confidence":"low","top_reasons":[]}`));
      expect((await suggestKycReview(customer, audit)).suggested_decision).toBe(d);
    }
  });

  it('every allowed confidence round-trips', async () => {
    for (const c of KYC_CONFIDENCES) {
      chatMock.mockResolvedValue(reply(`{"summary":"s","suggested_decision":"approve","confidence":"${c}","top_reasons":[]}`));
      expect((await suggestKycReview(customer, audit)).confidence).toBe(c);
    }
  });

  it('off-list decision collapses to need_more; off-list confidence to low', async () => {
    chatMock.mockResolvedValue(
      reply('{"summary":"s","suggested_decision":"auto_clear","confidence":"certain","top_reasons":["x"]}'),
    );
    const out = await suggestKycReview(customer, audit);
    expect(out.suggested_decision).toBe('need_more');
    expect(out.confidence).toBe('low');
  });

  it('prose-wrapped JSON still parses', async () => {
    chatMock.mockResolvedValue(
      reply('Sure! Here you go: {"summary":"s","suggested_decision":"reject","confidence":"medium","top_reasons":["dob mismatch"]} hope that helps'),
    );
    const out = await suggestKycReview(customer, audit);
    expect(out.suggested_decision).toBe('reject');
    expect(out.confidence).toBe('medium');
    expect(out.top_reasons).toEqual(['dob mismatch']);
  });

  it('garbage / non-JSON output falls back to safe defaults (need_more, low, [])', async () => {
    chatMock.mockResolvedValue(reply('I think it is probably fine'));
    expect(await suggestKycReview(customer, audit)).toMatchObject({
      suggested_decision: 'need_more',
      confidence: 'low',
      top_reasons: [],
    });
    chatMock.mockResolvedValue(reply('{broken json'));
    expect(await suggestKycReview(customer, audit)).toMatchObject({
      suggested_decision: 'need_more',
      confidence: 'low',
      top_reasons: [],
    });
  });

  it('non-array / dirty top_reasons clamp to a clean string[] capped at 3', async () => {
    chatMock.mockResolvedValue(
      reply('{"summary":"s","suggested_decision":"approve","confidence":"high","top_reasons":"not an array"}'),
    );
    expect((await suggestKycReview(customer, audit)).top_reasons).toEqual([]);

    chatMock.mockResolvedValue(
      reply('{"summary":"s","suggested_decision":"approve","confidence":"high","top_reasons":["a","",123,"  b  ","c","d"]}'),
    );
    expect((await suggestKycReview(customer, audit)).top_reasons).toEqual(['a', 'b', 'c']);
  });

  it('a missing summary falls back to a placeholder line (never empty)', async () => {
    chatMock.mockResolvedValue(reply('{"suggested_decision":"approve","confidence":"high","top_reasons":[]}'));
    const out = await suggestKycReview(customer, audit);
    expect(out.summary.length).toBeGreaterThan(0);
  });

  it('throws on an empty model reply (caller degrades to "AI unavailable")', async () => {
    chatMock.mockResolvedValue(reply('   '));
    await expect(suggestKycReview(customer, audit)).rejects.toThrow(/empty/i);
    chatMock.mockResolvedValue(reply(null));
    await expect(suggestKycReview(customer, audit)).rejects.toThrow(/empty/i);
  });
});

describe('suggestKycReview — what the model sees', () => {
  it('includes the screening result, declared name, and audit trail in the user message', async () => {
    chatMock.mockResolvedValue(reply(GOOD));
    await suggestKycReview(
      { ...customer, watchlistHit: true },
      audit,
    );
    const sent = JSON.stringify(chatMock.mock.calls[0][0]);
    expect(sent).toContain('WATCHLIST HIT');
    expect(sent).toContain('Jane Q. Sender');
    expect(sent).toContain('inquiry.completed');
  });
});
