import { describe, it, expect, vi, afterEach } from 'vitest';
import { EVAL_CASES, runEval, type ChatFn } from '../../scripts/eval-bot-cases';
import { main, makeEvalChat, EVAL_DEFAULT_MODEL } from '../../scripts/eval-bot';
import type { ChatMessage } from '@/lib/types';

// Program-Fix 49B (prompt-11). No real model is ever called here: every chat
// function is a stub, and fetch is a spy that answers like the Claude API.

afterEach(() => vi.restoreAllMocks());

const claudeReply = (text: string) =>
  new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: EVAL_DEFAULT_MODEL,
      content: text ? [{ type: 'text', text }] : [],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers as HeadersInit | undefined).get(name);
}

describe('eval-bot main()', () => {
  it('is a no-op without EVAL_ANTHROPIC_API_KEY: exit 0, a skip line, no network', async () => {
    const fetchSpy = vi.fn();
    const lines: string[] = [];
    const code = await main({}, fetchSpy as unknown as typeof fetch, (l) => lines.push(l));
    expect(code).toBe(0);
    expect(lines).toEqual(['eval-bot: skipped (EVAL_ANTHROPIC_API_KEY is not set)']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('with a key it runs all 24 cases against the Claude API and never prints the key', async () => {
    const fetchSpy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => claudeReply(''));
    const lines: string[] = [];
    const code = await main({ EVAL_ANTHROPIC_API_KEY: 'test-key-not-real' }, fetchSpy as unknown as typeof fetch, (l) => lines.push(l));
    expect(fetchSpy).toHaveBeenCalledTimes(24);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    expect(headerOf(init, 'x-api-key')).toBe('test-key-not-real');
    const body = JSON.parse(String(init?.body)) as { model: string; inference_geo: string };
    expect(body.model).toBe(EVAL_DEFAULT_MODEL);
    expect(body.inference_geo).toBe('us');
    expect(lines.join('\n')).not.toContain('test-key-not-real');
    expect(lines.at(-1)).toMatch(/^eval-bot: \d+\/24 passed$/);
    expect(code).toBe(1); // an empty reply fails at least one case
  });

  it('EVAL_ANTHROPIC_MODEL picks the model', async () => {
    const fetchSpy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => claudeReply('ok'));
    const chat = makeEvalChat({ EVAL_ANTHROPIC_API_KEY: 'k', EVAL_ANTHROPIC_MODEL: 'claude-sonnet-5-5' }, fetchSpy as unknown as typeof fetch);
    await chat([{ role: 'user', content: 'hi' }], []);
    expect((JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as { model: string }).model).toBe('claude-sonnet-5-5');
  });

  it('a model HTTP error is a failed case, not a crash', async () => {
    const failing = (async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'x' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const chat = makeEvalChat({ EVAL_ANTHROPIC_API_KEY: 'k' }, failing);
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

  it('a required-purpose case sees the PURPOSE section and a picker that requires purpose; the others do not', async () => {
    const seen = new Map<number, { prompt: string; pickerRequired: string[] }>();
    const required = EVAL_CASES.find((c) => c.purposeRequired)!;
    const plain = EVAL_CASES.find((c) => !c.purposeRequired)!;
    for (const c of [required, plain]) {
      await runEval(async (messages, tools) => {
        const picker = tools.find((t) => t.function.name === 'send_approve_picker')!;
        seen.set(c.id, {
          prompt: String(messages[0].content),
          pickerRequired: (picker.function.parameters as { required?: string[] }).required ?? [],
        });
        return { role: 'assistant', content: 'ok' };
      }, [c]);
    }
    expect(seen.get(required.id)!.prompt).toContain('PURPOSE\n');
    expect(seen.get(required.id)!.pickerRequired).toContain('purpose');
    expect(seen.get(plain.id)!.prompt).not.toContain('PURPOSE\n');
    expect(seen.get(plain.id)!.pickerRequired).not.toContain('purpose');
  });
});
