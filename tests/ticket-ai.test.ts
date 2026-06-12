import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fakeRedis } from './helpers';
import type { ChatMessage, Ticket, TicketMessage } from '@/lib/types';

// B3 — the support copilot AI module. Two concerns under test:
//  1. PROMPT-CONTENT GUARD (à la bot-content-guard): the system prompts must
//     carry the forbidden-content rules — no promises/guarantees, no refund
//     commitments, no compliance/screening detail, no financial advice, no
//     invented transaction facts — and every prompt must include them.
//  2. BEHAVIOR with chat() stubbed: triage clamps to the closed lists; drafts
//     never see internal notes; empty model output throws (callers degrade to
//     "AI unavailable").

vi.mock('@/lib/ollama', () => ({ chat: vi.fn() }));

import { chat } from '@/lib/ollama';
import {
  draftReply,
  summarizeCase,
  triageSuggest,
  checkCopilotRateLimit,
  TICKET_CATEGORIES,
  COPILOT_RATE_LIMIT_PER_HOUR,
} from '@/lib/ticket-ai';

const chatMock = vi.mocked(chat);

function reply(content: string | null): ChatMessage {
  return { role: 'assistant', content };
}

const ticket: Ticket = {
  id: 'tk_1',
  partnerId: 'default',
  kind: 'customer',
  customerPhone: '15551230000',
  subject: 'Where is my money?',
  status: 'open',
  priority: 'normal',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

function msg(over: Partial<TicketMessage> & { id: number; body: string }): TicketMessage {
  return {
    ticketId: 'tk_1',
    actorType: 'customer',
    actorId: '15551230000',
    internal: false,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  chatMock.mockReset();
});

describe('prompt-content guard: the system prompts forbid the dangerous content', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/lib/ticket-ai.ts'), 'utf-8');

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

  it('EVERY system prompt includes the shared guardrails block', () => {
    // The three *_SYSTEM prompts each interpolate ${GUARDRAILS}.
    const refs = src.match(/\$\{GUARDRAILS\}/g) ?? [];
    expect(refs.length).toBeGreaterThanOrEqual(3);
    for (const name of ['DRAFT_SYSTEM', 'SUMMARY_SYSTEM', 'TRIAGE_SYSTEM']) {
      expect(src).toContain(name);
    }
  });

  it('system messages passed to chat() actually carry the rules', async () => {
    chatMock.mockResolvedValue(reply('ok'));
    await draftReply(ticket, [], '');
    await summarizeCase(ticket, []);
    await triageSuggest('s', 'm');
    for (const call of chatMock.mock.calls) {
      const system = call[0][0];
      expect(system.role).toBe('system');
      expect(system.content).toMatch(/never make promises or guarantees/i);
      expect(system.content).toMatch(/our team reviews refunds/i);
      // one-shot contract: NO tools, ever
      expect(call[1]).toEqual([]);
    }
  });
});

describe('triageSuggest — output clamped to the closed lists', () => {
  it('returns valid suggestions verbatim', async () => {
    chatMock.mockResolvedValue(reply('{"category":"refund","priority":"urgent"}'));
    expect(await triageSuggest('s', 'm')).toEqual({ category: 'refund', priority: 'urgent' });
  });

  it('every allowed category round-trips', async () => {
    for (const c of TICKET_CATEGORIES) {
      chatMock.mockResolvedValue(reply(`{"category":"${c}","priority":"low"}`));
      expect((await triageSuggest('s', 'm')).category).toBe(c);
    }
  });

  it('off-list category collapses to other; off-list priority to normal', async () => {
    chatMock.mockResolvedValue(reply('{"category":"hacking","priority":"mega-urgent"}'));
    expect(await triageSuggest('s', 'm')).toEqual({ category: 'other', priority: 'normal' });
  });

  it('prose-wrapped JSON still parses', async () => {
    chatMock.mockResolvedValue(reply('Sure! Here you go: {"category":"kyc","priority":"low"} hope that helps'));
    expect(await triageSuggest('s', 'm')).toEqual({ category: 'kyc', priority: 'low' });
  });

  it('garbage / non-JSON output falls back to {other, normal}', async () => {
    chatMock.mockResolvedValue(reply('I think it is probably a delay issue'));
    expect(await triageSuggest('s', 'm')).toEqual({ category: 'other', priority: 'normal' });
    chatMock.mockResolvedValue(reply('{broken json'));
    expect(await triageSuggest('s', 'm')).toEqual({ category: 'other', priority: 'normal' });
    chatMock.mockResolvedValue(reply(null));
    expect(await triageSuggest('s', 'm')).toEqual({ category: 'other', priority: 'normal' });
  });
});

describe('draftReply — customer-facing safety', () => {
  it('never shows internal notes to the model', async () => {
    chatMock.mockResolvedValue(reply('Here is a draft.'));
    const messages = [
      msg({ id: 1, body: 'Where is my transfer?' }),
      msg({ id: 2, actorType: 'staff', actorId: 'sup1', body: 'SECRET-INTERNAL-DETAIL', internal: true }),
      msg({ id: 3, actorType: 'staff', actorId: 'sup1', body: 'We are looking into it.' }),
    ];
    await draftReply(ticket, messages, 'linked transfer ctx');
    const sent = JSON.stringify(chatMock.mock.calls[0][0]);
    expect(sent).not.toContain('SECRET-INTERNAL-DETAIL');
    expect(sent).toContain('We are looking into it.');
    expect(sent).toContain('linked transfer ctx');
  });

  it('throws on an empty model reply (caller degrades to "AI unavailable")', async () => {
    chatMock.mockResolvedValue(reply('   '));
    await expect(draftReply(ticket, [], '')).rejects.toThrow(/empty/i);
    chatMock.mockResolvedValue(reply(null));
    await expect(summarizeCase(ticket, [])).rejects.toThrow(/empty/i);
  });

  it('summarizeCase DOES see internal notes (staff-facing)', async () => {
    chatMock.mockResolvedValue(reply('1\n2\n3\n4\n5'));
    await summarizeCase(ticket, [
      msg({ id: 1, body: 'q' }),
      msg({ id: 2, actorType: 'staff', actorId: 's', body: 'INTERNAL-CTX', internal: true }),
    ]);
    expect(JSON.stringify(chatMock.mock.calls[0][0])).toContain('INTERNAL-CTX');
  });
});

describe('checkCopilotRateLimit — 60/h per staff, fixed window', () => {
  it('allows up to the limit and refuses the 61st call in the same hour', async () => {
    const redis = fakeRedis();
    const now = Date.now();
    for (let i = 0; i < COPILOT_RATE_LIMIT_PER_HOUR; i++) {
      expect(await checkCopilotRateLimit(redis, 'sup1', { now })).toBe(true);
    }
    expect(await checkCopilotRateLimit(redis, 'sup1', { now })).toBe(false);
  });

  it('windows are per-staff and reset on the next hour', async () => {
    const redis = fakeRedis();
    const now = Date.now();
    for (let i = 0; i < COPILOT_RATE_LIMIT_PER_HOUR + 1; i++) {
      await checkCopilotRateLimit(redis, 'sup1', { now });
    }
    expect(await checkCopilotRateLimit(redis, 'sup1', { now })).toBe(false);
    expect(await checkCopilotRateLimit(redis, 'sup2', { now })).toBe(true); // other staff unaffected
    expect(await checkCopilotRateLimit(redis, 'sup1', { now: now + 3_600_000 })).toBe(true); // next hour
  });
});
