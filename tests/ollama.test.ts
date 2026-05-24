import { describe, it, expect, vi, afterEach } from 'vitest';
import { chat } from '@/lib/ollama';
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
});
