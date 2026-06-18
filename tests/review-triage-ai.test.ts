import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChatMessage, Transfer } from '@/lib/types';

// U6 — the compliance-triage copilot AI module. Two concerns under test:
//  1. PROMPT-CONTENT GUARD (à la ticket-ai): the system prompt must carry the
//     forbidden-content rules — no promises/guarantees, no refund commitments,
//     no compliance/screening detail, no financial advice, no invented facts.
//  2. BEHAVIOR with chat() stubbed: ONE call with NO tools; urgency/path clamp
//     to the closed lists (off-list ⇒ normal / hold); only MASKED signals reach
//     the model; an empty rationale throws (callers degrade to "AI unavailable").

vi.mock('@/lib/ollama', () => ({ chat: vi.fn() }));

import { chat } from '@/lib/ollama';
import {
  suggestDisposition,
  URGENCIES,
  SUGGESTED_PATHS,
} from '@/lib/review-triage-ai';

const chatMock = vi.mocked(chat);

function reply(content: string | null): ChatMessage {
  return { role: 'assistant', content };
}

const NOW = Date.parse('2026-06-17T12:00:00.000Z');

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    id: 'tr_1',
    phone: '15551230000',
    amountUsd: 500,
    feeUsd: 5,
    totalChargeUsd: 505,
    fxRate: 85,
    amountInr: 42500,
    recipientName: 'R',
    recipientPhone: '91999',
    payoutMethod: 'upi',
    payoutDestination: '****1234',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'flagged',
    complianceReasons: ['Large transfer amount.'],
    status: 'in_review',
    createdAt: new Date(NOW - 5 * 3_600_000).toISOString(),
    paidAt: new Date(NOW - 3 * 3_600_000).toISOString(),
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: 'default',
    amountSource: 500,
    feeSource: 5,
    totalChargeSource: 505,
    ...overrides,
  };
}

beforeEach(() => {
  chatMock.mockReset();
});

describe('prompt-content guard: the system prompt forbids the dangerous content', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/lib/review-triage-ai.ts'), 'utf-8');

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
    expect(src).toMatch(/\$\{GUARDRAILS\}/);
    expect(src).toContain('TRIAGE_SYSTEM');
  });

  it('system message passed to chat() carries the rules, and tools are ALWAYS []', async () => {
    chatMock.mockResolvedValue(reply('{"urgency":"normal","suggested_path":"hold","rationale":"ok"}'));
    await suggestDisposition(makeTransfer(), { now: NOW });
    const call = chatMock.mock.calls[0];
    const system = call[0][0];
    expect(system.role).toBe('system');
    expect(system.content).toMatch(/never make promises or guarantees/i);
    expect(system.content).toMatch(/our team reviews refunds/i);
    // one-shot contract: NO tools, ever
    expect(call[1]).toEqual([]);
  });
});

describe('suggestDisposition — output clamped to the closed lists', () => {
  it('returns a valid suggestion verbatim', async () => {
    chatMock.mockResolvedValue(
      reply('{"urgency":"high","suggested_path":"escalate","rationale":"Watchlist near-match."}'),
    );
    expect(await suggestDisposition(makeTransfer(), { now: NOW })).toEqual({
      urgency: 'high',
      suggested_path: 'escalate',
      rationale: 'Watchlist near-match.',
    });
  });

  it('every allowed urgency round-trips', async () => {
    for (const u of URGENCIES) {
      chatMock.mockResolvedValue(reply(`{"urgency":"${u}","suggested_path":"hold","rationale":"r"}`));
      expect((await suggestDisposition(makeTransfer(), { now: NOW })).urgency).toBe(u);
    }
  });

  it('every allowed path round-trips', async () => {
    for (const p of SUGGESTED_PATHS) {
      chatMock.mockResolvedValue(reply(`{"urgency":"normal","suggested_path":"${p}","rationale":"r"}`));
      expect((await suggestDisposition(makeTransfer(), { now: NOW })).suggested_path).toBe(p);
    }
  });

  it('off-list urgency collapses to normal; off-list path to hold', async () => {
    chatMock.mockResolvedValue(
      reply('{"urgency":"nuclear","suggested_path":"wire-it-now","rationale":"r"}'),
    );
    expect(await suggestDisposition(makeTransfer(), { now: NOW })).toEqual({
      urgency: 'normal',
      suggested_path: 'hold',
      rationale: 'r',
    });
  });

  it('prose-wrapped JSON still parses', async () => {
    chatMock.mockResolvedValue(
      reply('Sure: {"urgency":"low","suggested_path":"release","rationale":"Clean."} hope that helps'),
    );
    expect(await suggestDisposition(makeTransfer(), { now: NOW })).toEqual({
      urgency: 'low',
      suggested_path: 'release',
      rationale: 'Clean.',
    });
  });

  it('trailing prose containing a brace does not break parsing (greedy-regex trap)', async () => {
    chatMock.mockResolvedValue(
      reply(
        '{"urgency":"high","suggested_path":"escalate","rationale":"Watchlist hit."}\n\n' +
          'Adjust the {urgency} field if you disagree.',
      ),
    );
    expect(await suggestDisposition(makeTransfer(), { now: NOW })).toEqual({
      urgency: 'high',
      suggested_path: 'escalate',
      rationale: 'Watchlist hit.',
    });
  });

  it('a rationale string that itself contains a brace still parses (lazy-regex trap)', async () => {
    chatMock.mockResolvedValue(
      reply('{"urgency":"normal","suggested_path":"hold","rationale":"See note {A1} on file."}'),
    );
    expect(await suggestDisposition(makeTransfer(), { now: NOW })).toEqual({
      urgency: 'normal',
      suggested_path: 'hold',
      rationale: 'See note {A1} on file.',
    });
  });
});

describe('suggestDisposition — throw-on-empty and masked input', () => {
  it('throws when the rationale is empty (caller degrades to "AI unavailable")', async () => {
    chatMock.mockResolvedValue(reply('{"urgency":"high","suggested_path":"hold","rationale":"   "}'));
    await expect(suggestDisposition(makeTransfer(), { now: NOW })).rejects.toThrow(/empty/i);
  });

  it('throws on non-JSON / null output (no rationale to ground on)', async () => {
    chatMock.mockResolvedValue(reply('I think we should hold this one'));
    await expect(suggestDisposition(makeTransfer(), { now: NOW })).rejects.toThrow(/empty/i);
    chatMock.mockResolvedValue(reply(null));
    await expect(suggestDisposition(makeTransfer(), { now: NOW })).rejects.toThrow(/empty/i);
  });

  it('sends only MASKED signals — reasons, a coarse amount band, EDD, hold age; never the exact figure or destination', async () => {
    chatMock.mockResolvedValue(reply('{"urgency":"normal","suggested_path":"hold","rationale":"r"}'));
    await suggestDisposition(
      makeTransfer({ amountUsd: 7500, eddRequired: true, complianceReasons: ['High transfer velocity.'] }),
      { now: NOW },
    );
    const sent = JSON.stringify(chatMock.mock.calls[0][0]);
    expect(sent).toContain('High transfer velocity.');
    expect(sent).toContain('large ($3k–$10k)'); // band, not the exact figure
    expect(sent).not.toContain('7500');
    expect(sent).not.toContain('****1234'); // masked destination never forwarded
    expect(sent).toMatch(/EDD required: yes/);
    expect(sent).toMatch(/3h since payment captured/); // paidAt → NOW = 3h
  });
});
