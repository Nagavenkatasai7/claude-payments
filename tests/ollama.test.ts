import { describe, it, expect, vi, afterEach } from 'vitest';
import { chat, OLLAMA_TIMEOUT_MS } from '@/lib/ollama';
import { OllamaHttpError, isPermanentProviderError } from '@/lib/llm-provider-error';
import { toolSchemas } from '@/lib/tools';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chat', () => {
  it('posts messages to the Ollama endpoint and returns the message', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'Hello!' } }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await chat(
      [{ role: 'user', content: 'hi' }],
      toolSchemas,
    );

    expect(result.content).toBe('Hello!');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ollama.test/v1/chat/completions');
    expect(JSON.parse(init.body as string).model).toBe('kimi-test');
  });

  it('throws when the response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => 'server error',
      })),
    );
    await expect(
      chat([{ role: 'user', content: 'hi' }], toolSchemas),
    ).rejects.toThrow(/500/);
  });

  it('a 402 rejects with a permanent OllamaHttpError (status kept, message prefix unchanged)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 402, text: async () => 'out of credit' })));
    const err = await chat([{ role: 'user', content: 'hi' }], toolSchemas).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OllamaHttpError);
    expect((err as OllamaHttpError).status).toBe(402);
    expect((err as OllamaHttpError).permanent).toBe(true);
    expect((err as Error).message).toMatch(/Ollama request failed \(402\)/);
  });

  it.each([401, 402, 403])('HTTP %i is a permanent provider error', (status) => {
    expect(new OllamaHttpError(status, '').permanent).toBe(true);
  });

  it.each([429, 500, 503])('HTTP %i stays transient', (status) => {
    expect(new OllamaHttpError(status, '').permanent).toBe(false);
  });

  it('isPermanentProviderError: only a permanent OllamaHttpError', () => {
    expect(isPermanentProviderError(new OllamaHttpError(402, 'x'))).toBe(true);
    expect(isPermanentProviderError(new OllamaHttpError(500, 'x'))).toBe(false);
    expect(isPermanentProviderError(new Error('Ollama request timed out after 20000ms'))).toBe(false);
    expect(isPermanentProviderError(new Error('Ollama request failed (402): x'))).toBe(false);
    expect(isPermanentProviderError(undefined)).toBe(false);
  });

  it('caps the response body in the error message at 500 chars', () => {
    const err = new OllamaHttpError(500, 'x'.repeat(10_000));
    expect(err.message.length).toBeLessThan(600);
  });

  it('passes AbortSignal.timeout to fetch, sized so chatWithRetry (2 calls) fits ROW_DEADLINE_MS', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: 'x' } }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await chat([{ role: 'user', content: 'hi' }], toolSchemas);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(OLLAMA_TIMEOUT_MS * 2).toBeLessThanOrEqual(40_000); // agent.ts chatWithRetry × ROW_DEADLINE_MS
  });

  it('an aborted chat throws a clear, catchable Error (agent.chatWithRetry retries once, then falls back)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      }),
    );
    await expect(chat([{ role: 'user', content: 'hi' }], toolSchemas)).rejects.toThrow(
      /Ollama request timed out after 20000ms/,
    );
  });

  it("a caller's AbortSignal (the worker's row deadline) aborts the call too, with a distinct message", async () => {
    let seen: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen = init.signal;
      await new Promise((res) => init.signal!.addEventListener('abort', res, { once: true }));
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    }));
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5);
    await expect(chat([{ role: 'user', content: 'hi' }], toolSchemas, { signal: ctrl.signal })).rejects.toThrow(/aborted by the caller/);
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen).not.toBe(ctrl.signal); // combined via AbortSignal.any — the 20s timeout still applies underneath
  });
});
