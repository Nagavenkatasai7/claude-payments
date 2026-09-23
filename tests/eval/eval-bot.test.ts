import { describe, it, expect, vi, afterEach } from 'vitest';
import { EVAL_CASES, runEval, type ChatFn } from '../../scripts/eval-bot-cases';
import { main, makeEvalChat, EVAL_DEFAULT_BASE_URL } from '../../scripts/eval-bot';
import type { ChatMessage } from '@/lib/types';

// Program-Fix 49B (prompt-11). No real model is ever called here: every chat
// function is a stub, and fetch is a spy.

afterEach(() => vi.restoreAllMocks());

describe('eval-bot main()', () => {
  it('is a no-op without EVAL_OLLAMA_API_KEY: exit 0, a skip line, no network', async () => {
    const fetchSpy = vi.fn();
    const lines: string[] = [];
    const code = await main({}, fetchSpy as unknown as typeof fetch, (l) => lines.push(l));
    expect(code).toBe(0);
    expect(lines).toEqual(['eval-bot: skipped (EVAL_OLLAMA_API_KEY is not set)']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('with a key it runs all 15 cases against the endpoint and never prints the key', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: '' } }] }),
    }));
    const lines: string[] = [];
    const code = await main({ EVAL_OLLAMA_API_KEY: 'test-key-not-real' }, fetchSpy as unknown as typeof fetch, (l) => lines.push(l));
    expect(fetchSpy).toHaveBeenCalledTimes(15);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${EVAL_DEFAULT_BASE_URL}/chat/completions`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key-not-real');
    expect(lines.join('\n')).not.toContain('test-key-not-real');
    expect(lines.at(-1)).toMatch(/^eval-bot: \d+\/15 passed$/);
    expect(code).toBe(1); // an empty reply fails at least one case
  });

  it('a model HTTP error is a failed case, not a crash', async () => {
    const chat = makeEvalChat({ EVAL_OLLAMA_API_KEY: 'k' }, (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch);
    const results = await runEval(chat, EVAL_CASES.slice(0, 1));
    expect(results[0].failures).toEqual(['model call failed']);
  });
});

describe('the recorded cases prove their own checks', () => {
  it.each(EVAL_CASES.map((c) => [c.id, c.title, c] as const))('#%s %s', async (_id, _t, c) => {
    const replay = (m: ChatMessage): ChatFn => async () => m;
    const [pass] = await runEval(replay(c.recorded.pass), [c]);
    expect(pass.failures, 'recorded pass').toEqual([]);
    const [bad] = await runEval(replay(c.recorded.fail), [c]);
    expect(bad.failures.length, 'recorded fail').toBeGreaterThan(0);
  });

  it('the model sees the real system prompt first and only the WhatsApp tools', async () => {
    const seen: Array<{ first: ChatMessage; toolNames: string[] }> = [];
    await runEval(async (messages, tools) => {
      seen.push({ first: messages[0], toolNames: tools.map((t) => t.function.name) });
      return { role: 'assistant', content: 'ok' };
    }, EVAL_CASES.slice(0, 1));
    expect(seen[0].first.role).toBe('system');
    expect(seen[0].first.content).toContain('You are the assistant for SmartRemit');
    expect(seen[0].toolNames).not.toContain('create_transfer');
  });
});
