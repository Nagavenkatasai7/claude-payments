import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ApiKeyPublic } from '@/lib/partner-api-key';
import type { PartnerRate } from '@/lib/types';
import type { ChatMessage } from '@/lib/types';
import {
  scorePartnerHealth,
  HEALTH_BANDS,
  type HealthSummary,
  type PartnerHealthInput,
} from '@/lib/partner-health';

// partner-health — the deterministic struggling/stalled-partner scorer (U4) and
// its one-shot AI narrator. Two concerns:
//  1. The PURE scorer: inputs (transfers summary, API keys, pushed rates, now)
//     map to a band + signals with worst-band-wins precedence. Fully TDD'd —
//     never-activated, stalled, at_risk (quiet / high-attention / expired
//     rates), watch, and healthy cases.
//  2. The AI narrator (chat() stubbed): consumes only the band + signals,
//     throws on empty output, and carries the forbidden-content guardrails.

vi.mock('@/lib/ollama', () => ({ chat: vi.fn() }));

import { chat } from '@/lib/ollama';
import { narratePartnerHealth } from '@/lib/partner-health-ai';

const chatMock = vi.mocked(chat);
const NOW = Date.parse('2026-06-12T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function reply(content: string | null): ChatMessage {
  return { role: 'assistant', content };
}

function key(over: Partial<ApiKeyPublic> = {}): ApiKeyPublic {
  return { keyId: 'pk_1', createdAt: '2026-01-01T00:00:00.000Z', last4: 'ab12', ...over };
}

function rate(over: Partial<PartnerRate> = {}): PartnerRate {
  return {
    id: 'pr_1',
    partnerId: 'p1',
    sourceCurrency: 'USD',
    destinationCurrency: 'INR',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function summary(over: Partial<HealthSummary> = {}): HealthSummary {
  return {
    total: 10,
    countToday: 2,
    needsAttention: 0,
    latest: new Date(NOW - 1 * DAY).toISOString(), // active yesterday
    ...over,
  };
}

function input(over: Partial<PartnerHealthInput> = {}): PartnerHealthInput {
  return { summary: summary(), apiKeys: [], rates: [], now: NOW, ...over };
}

beforeEach(() => {
  chatMock.mockReset();
});

describe('scorePartnerHealth — band precedence (deterministic)', () => {
  it('healthy: recent activity, no flags, no expired rates', () => {
    const r = scorePartnerHealth(input());
    expect(r.band).toBe('healthy');
    expect(r.signals).toEqual([]);
  });

  it('never-activated: a live key but zero transfers ⇒ stalled', () => {
    const r = scorePartnerHealth(input({ apiKeys: [key()], summary: summary({ total: 0, latest: null }) }));
    expect(r.band).toBe('stalled');
    expect(r.signals[0]).toMatch(/never went live/i);
  });

  it('a REVOKED key with zero transfers is NOT "never activated"', () => {
    const r = scorePartnerHealth(
      input({
        apiKeys: [key({ revokedAt: '2026-02-01T00:00:00.000Z' })],
        summary: summary({ total: 0, latest: null, countToday: 0 }),
      }),
    );
    expect(r.band).not.toBe('stalled');
    expect(r.signals.some((s) => /never went live/i.test(s))).toBe(false);
  });

  it('stalled: previously active but silent for ≥30 days', () => {
    const r = scorePartnerHealth(
      input({ summary: summary({ latest: new Date(NOW - 45 * DAY).toISOString(), countToday: 0 }) }),
    );
    expect(r.band).toBe('stalled');
    expect(r.signals.some((s) => /no activity in 45 days/i.test(s))).toBe(true);
  });

  it('at_risk: gone quiet for ≥7 days (but <30)', () => {
    const r = scorePartnerHealth(
      input({ summary: summary({ latest: new Date(NOW - 10 * DAY).toISOString(), countToday: 0 }) }),
    );
    expect(r.band).toBe('at_risk');
    expect(r.signals.some((s) => /gone quiet.*10 days/i.test(s))).toBe(true);
  });

  it('at_risk: high needs-attention ratio (≥25% of lifetime)', () => {
    const r = scorePartnerHealth(input({ summary: summary({ total: 8, needsAttention: 3 }) }));
    expect(r.band).toBe('at_risk');
    expect(r.signals.some((s) => /need attention/i.test(s) && /38%/.test(s))).toBe(true);
  });

  it('at_risk: every pushed rate has expired (rate feed stopped)', () => {
    const r = scorePartnerHealth(
      input({
        rates: [
          rate({ effectiveRate: 83, expiresAt: new Date(NOW - 2 * DAY).toISOString() }),
          rate({ id: 'pr_2', effectiveRate: 84, expiresAt: new Date(NOW - 1 * DAY).toISOString() }),
        ],
      }),
    );
    expect(r.band).toBe('at_risk');
    expect(r.signals.some((s) => /2 pushed corridor rates expired/i.test(s))).toBe(true);
  });

  it('a FRESH pushed rate does not trigger the expired-rate signal', () => {
    const r = scorePartnerHealth(
      input({ rates: [rate({ effectiveRate: 83, expiresAt: new Date(NOW + 5 * DAY).toISOString() })] }),
    );
    expect(r.band).toBe('healthy');
    expect(r.signals.some((s) => /expired/i.test(s))).toBe(false);
  });

  it('a margin-only rate (never pushed) is ignored — no effectiveRate', () => {
    const r = scorePartnerHealth(input({ rates: [rate({ marginBps: 25 })] }));
    expect(r.band).toBe('healthy');
    expect(r.signals).toEqual([]);
  });

  it('stalled wins over at_risk tells (worst band wins) but still lists them', () => {
    const r = scorePartnerHealth(
      input({
        summary: summary({ latest: new Date(NOW - 40 * DAY).toISOString(), total: 8, needsAttention: 4, countToday: 0 }),
        rates: [rate({ effectiveRate: 83, expiresAt: new Date(NOW - 1 * DAY).toISOString() })],
      }),
    );
    expect(r.band).toBe('stalled');
    expect(r.signals.length).toBeGreaterThan(1);
  });
});

describe('scorePartnerHealth — softer "watch" signals', () => {
  it('watch: a short lull (3–7 days quiet)', () => {
    const r = scorePartnerHealth(
      input({ summary: summary({ latest: new Date(NOW - 4 * DAY).toISOString(), countToday: 0 }) }),
    );
    expect(r.band).toBe('watch');
    expect(r.signals.some((s) => /slowing down/i.test(s))).toBe(true);
  });

  it('watch: active but no transfers today', () => {
    const r = scorePartnerHealth(
      input({ summary: summary({ latest: new Date(NOW - 1 * DAY).toISOString(), countToday: 0 }) }),
    );
    expect(r.band).toBe('watch');
    expect(r.signals.some((s) => /no transfers today/i.test(s))).toBe(true);
  });

  it('watch: a fresh rate expiring within 24h', () => {
    const r = scorePartnerHealth(
      input({ rates: [rate({ effectiveRate: 83, expiresAt: new Date(NOW + 12 * 60 * 60 * 1000).toISOString() })] }),
    );
    expect(r.band).toBe('watch');
    expect(r.signals.some((s) => /expires within 24 hours/i.test(s))).toBe(true);
  });
});

describe('scorePartnerHealth — invariants', () => {
  it('band is always one of the closed set', () => {
    const cases = [
      input(),
      input({ apiKeys: [key()], summary: summary({ total: 0, latest: null }) }),
      input({ summary: summary({ latest: new Date(NOW - 90 * DAY).toISOString() }) }),
    ];
    for (const c of cases) expect(HEALTH_BANDS).toContain(scorePartnerHealth(c).band);
  });

  it('a brand-new partner with no key and no transfers is not flagged stalled', () => {
    const r = scorePartnerHealth(input({ apiKeys: [], summary: summary({ total: 0, latest: null, countToday: 0 }) }));
    expect(r.band).not.toBe('stalled');
  });
});

describe('narratePartnerHealth — AI narration (chat stubbed)', () => {
  it('passes the band + signals to the model and returns the trimmed note', async () => {
    chatMock.mockResolvedValue(reply('  Partner has gone quiet.\nReach out with a check-in.  '));
    const out = await narratePartnerHealth('at_risk', ['Gone quiet — no transfers in 10 days.']);
    expect(out).toBe('Partner has gone quiet.\nReach out with a check-in.');
    const [messages, tools] = chatMock.mock.calls[0];
    expect(tools).toEqual([]); // rung-1: never any tools
    const userMsg = messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('at_risk');
    expect(userMsg?.content).toContain('Gone quiet — no transfers in 10 days.');
  });

  it('throws on an empty model reply (caller degrades to "unavailable")', async () => {
    chatMock.mockResolvedValue(reply('   '));
    await expect(narratePartnerHealth('stalled', ['x'])).rejects.toThrow(/empty ai response/i);
  });

  it('throws on a null-content reply', async () => {
    chatMock.mockResolvedValue(reply(null));
    await expect(narratePartnerHealth('watch', [])).rejects.toThrow(/empty ai response/i);
  });
});

describe('prompt-content guard: the narrator system prompt forbids dangerous content', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/lib/partner-health-ai.ts'), 'utf-8');

  it('forbids promises and guarantees', () => {
    expect(src).toMatch(/never make promises or guarantees/i);
  });

  it('forbids refund commitments', () => {
    expect(src).toMatch(/never commit to a refund/i);
  });

  it('forbids revealing compliance/screening detail', () => {
    expect(src).toMatch(/never reveal compliance, screening, sanctions/i);
  });

  it('forbids financial advice', () => {
    expect(src).toMatch(/never give financial advice/i);
  });

  it('forbids inventing transaction facts', () => {
    expect(src).toMatch(/never invent transaction facts/i);
  });
});
