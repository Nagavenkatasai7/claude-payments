import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChatMessage } from '@/lib/types';
import type { CorridorDemand } from '@/lib/corridor-demand';

// corridor-brief-ai — the platform launch-recommender's AI narration. Same two
// concerns as ticket-ai: (1) the system prompt carries the forbidden-content
// GUARDRAILS verbatim, and (2) behavior with chat() stubbed — one tools-less
// call, the right numbers reach the model, no sender phones leak, empty output
// throws (the caller hides the brief).

vi.mock('@/lib/ollama', () => ({ chat: vi.fn() }));

import { chat } from '@/lib/ollama';
import { narrateCorridorBrief, getCorridorBrief, type BriefCache } from '@/lib/corridor-brief-ai';

const chatMock = vi.mocked(chat);

function reply(content: string | null): ChatMessage {
  return { role: 'assistant', content };
}

function demand(over: Partial<CorridorDemand> & { key: string; destination: string }): CorridorDemand {
  return {
    supported: false,
    total: { leads: 1, distinctSenders: 1, usdDemand: 0, pricedLeads: 0 },
    windows: {},
    growthLeads: null,
    growthPct: null,
    ...over,
  };
}

beforeEach(() => {
  chatMock.mockReset();
});

describe('prompt-content guard: the system prompt forbids the dangerous content', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/lib/corridor-brief-ai.ts'), 'utf-8');

  it('forbids promises and guarantees', () => {
    expect(src).toMatch(/never make promises or guarantees/i);
    expect(src).toMatch(/no delivery promises/i);
  });

  it('forbids refund commitments', () => {
    expect(src).toMatch(/never commit to a refund/i);
    expect(src).toMatch(/our team reviews refunds/i);
  });

  it('forbids compliance/screening/sanctions detail', () => {
    expect(src).toMatch(/never reveal compliance, screening, sanctions/i);
  });

  it('forbids financial advice', () => {
    expect(src).toMatch(/never give financial advice/i);
  });

  it('forbids inventing facts', () => {
    expect(src).toMatch(/never invent transaction facts/i);
  });

  it('the system prompt interpolates the shared guardrails block', () => {
    expect((src.match(/\$\{GUARDRAILS\}/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(src).toContain('BRIEF_SYSTEM');
  });
});

describe('narrateCorridorBrief — behavior with chat() stubbed', () => {
  it('makes ONE tools-less call whose system message carries the rules', async () => {
    chatMock.mockResolvedValue(reply('Pakistan looks worth prioritising.'));
    const out = await narrateCorridorBrief([
      demand({ key: 'pakistan', destination: 'Pakistan', total: { leads: 12, distinctSenders: 9, usdDemand: 5000, pricedLeads: 4 }, growthLeads: 3, growthPct: 50 }),
    ]);
    expect(out).toBe('Pakistan looks worth prioritising.');
    expect(chatMock).toHaveBeenCalledTimes(1);
    const [messages, tools] = chatMock.mock.calls[0];
    expect(tools).toEqual([]); // one-shot contract: never any tools
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toMatch(/never make promises or guarantees/i);
    expect(messages[0].content).toMatch(/our team reviews refunds/i);
  });

  it('passes counts/sums to the model but NEVER a sender phone number', async () => {
    chatMock.mockResolvedValue(reply('brief'));
    await narrateCorridorBrief([
      demand({ key: 'pakistan', destination: 'Pakistan', total: { leads: 12, distinctSenders: 9, usdDemand: 5000, pricedLeads: 4 }, growthLeads: 3, growthPct: 50 }),
    ]);
    const sent = JSON.stringify(chatMock.mock.calls[0][0]);
    expect(sent).toContain('Pakistan');
    expect(sent).toContain('12');
    expect(sent).toContain('9 distinct');
    // CorridorDemand has no phone field; assert the user message carries no raw number-like sender.
    expect(sent).not.toMatch(/\+?1555\d{4}/);
  });

  it('honors topN — only the first N rows are narrated', async () => {
    chatMock.mockResolvedValue(reply('brief'));
    const rows = ['Aland', 'Belgium', 'Chad', 'Denmark'].map((c, i) =>
      demand({ key: c.toLowerCase(), destination: c, total: { leads: 10 - i, distinctSenders: 1, usdDemand: 0, pricedLeads: 0 } }),
    );
    await narrateCorridorBrief(rows, 2);
    const sent = JSON.stringify(chatMock.mock.calls[0][0]);
    expect(sent).toContain('Aland');
    expect(sent).toContain('Belgium');
    expect(sent).not.toContain('Chad');
    expect(sent).not.toContain('Denmark');
  });

  it('marks an already-supported destination distinctly', async () => {
    chatMock.mockResolvedValue(reply('brief'));
    await narrateCorridorBrief([
      demand({ key: 'ae', destination: 'UAE', supported: true, total: { leads: 3, distinctSenders: 2, usdDemand: 0, pricedLeads: 0 } }),
    ]);
    expect(JSON.stringify(chatMock.mock.calls[0][0])).toMatch(/ALREADY SUPPORTED/);
  });

  it('throws on an empty model reply (caller hides the brief)', async () => {
    chatMock.mockResolvedValue(reply('   '));
    await expect(
      narrateCorridorBrief([demand({ key: 'x', destination: 'X' })]),
    ).rejects.toThrow(/empty/i);
    chatMock.mockResolvedValue(reply(null));
    await expect(
      narrateCorridorBrief([demand({ key: 'x', destination: 'X' })]),
    ).rejects.toThrow(/empty/i);
  });

  it('throws without calling the model when there is nothing to narrate', async () => {
    await expect(narrateCorridorBrief([])).rejects.toThrow(/no corridor demand/i);
    expect(chatMock).not.toHaveBeenCalled();
  });
});

// getCorridorBrief — the admin Corridors page's entry point. The model call is
// slow (up to OLLAMA_TIMEOUT_MS), so a brief for the same top-N numbers is
// reused from the shared cache for an hour, and concurrent page loads share one
// in-flight call. The cache is best-effort: a cache outage still narrates.
describe('getCorridorBrief — cached narration', () => {
  function mapCache(): BriefCache & { store: Map<string, string>; sets: Array<{ key: string; ex?: number }> } {
    const store = new Map<string, string>();
    const sets: Array<{ key: string; ex?: number }> = [];
    return {
      store,
      sets,
      async get(key) {
        return store.get(key) ?? null;
      },
      async set(key, value, opts) {
        store.set(key, value);
        sets.push({ key, ex: opts?.ex });
        return 'OK';
      },
    };
  }
  const rows = [
    demand({ key: 'pakistan', destination: 'Pakistan', total: { leads: 12, distinctSenders: 9, usdDemand: 5000, pricedLeads: 4 }, growthLeads: 3, growthPct: 50 }),
  ];

  it('calls the model once, stores the brief for an hour, then serves it from the cache', async () => {
    const cache = mapCache();
    chatMock.mockResolvedValue(reply('Pakistan looks worth prioritising.'));
    expect(await getCorridorBrief(rows, 5, cache)).toBe('Pakistan looks worth prioritising.');
    expect(await getCorridorBrief(rows, 5, cache)).toBe('Pakistan looks worth prioritising.');
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(cache.sets).toHaveLength(1);
    expect(cache.sets[0].ex).toBe(3600);
    expect(cache.sets[0].key).toMatch(/^corridor-brief:v1:[0-9a-f]{32}$/);
  });

  it('the cache key follows the numbers: changed demand gets a fresh brief', async () => {
    const cache = mapCache();
    chatMock.mockResolvedValueOnce(reply('first')).mockResolvedValueOnce(reply('second'));
    expect(await getCorridorBrief(rows, 5, cache)).toBe('first');
    const more = [{ ...rows[0], total: { ...rows[0].total, leads: 13 } }];
    expect(await getCorridorBrief(more, 5, cache)).toBe('second');
    expect(chatMock).toHaveBeenCalledTimes(2);
  });

  it('the cache key is an opaque hash: no destination, count or phone in it', async () => {
    const cache = mapCache();
    chatMock.mockResolvedValue(reply('brief'));
    await getCorridorBrief(rows, 5, cache);
    expect(JSON.stringify([...cache.store.keys()])).not.toMatch(/Pakistan|pakistan|1555/);
  });

  it('concurrent page loads share ONE model call', async () => {
    const cache = mapCache();
    let resolve!: (m: ChatMessage) => void;
    chatMock.mockReturnValue(new Promise<ChatMessage>((r) => { resolve = r; }));
    const a = getCorridorBrief(rows, 5, cache);
    const b = getCorridorBrief(rows, 5, cache);
    await new Promise((r) => setTimeout(r, 0));
    resolve(reply('shared'));
    expect(await Promise.all([a, b])).toEqual(['shared', 'shared']);
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it('a cache outage still narrates (fail-open on read and write)', async () => {
    const broken: BriefCache = {
      get: async () => { throw new Error('redis down'); },
      set: async () => { throw new Error('redis down'); },
    };
    chatMock.mockResolvedValue(reply('still here'));
    expect(await getCorridorBrief(rows, 5, broken)).toBe('still here');
  });

  it('a failed model call is not cached and the next load retries', async () => {
    const cache = mapCache();
    chatMock.mockResolvedValueOnce(reply('  ')).mockResolvedValueOnce(reply('recovered'));
    await expect(getCorridorBrief(rows, 5, cache)).rejects.toThrow(/empty/i);
    expect(cache.store.size).toBe(0);
    expect(await getCorridorBrief(rows, 5, cache)).toBe('recovered');
  });

  it('works with no cache at all', async () => {
    chatMock.mockResolvedValue(reply('uncached'));
    expect(await getCorridorBrief(rows, 5, null)).toBe('uncached');
  });
});
