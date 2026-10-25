import { describe, it, expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { createChat, LLM_TIMEOUT_MS, type MessagesClient } from '@/lib/llm';
import { ProviderHttpError, isPermanentProviderError } from '@/lib/llm-provider-error';
import { AGENT_MODEL_CHOICES, HAIKU, SONNET, llmTaskConfig } from '@/lib/llm-models';
import { ROW_DEADLINE_MS } from '@/lib/outbox-worker';
import { toolSchemas } from '@/lib/tools';
import type { ChatMessage } from '@/lib/types';

const USER: ChatMessage[] = [{ role: 'user', content: 'hi' }];

function reply(content: unknown[], extra: Record<string, unknown> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: HAIKU,
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, inference_geo: 'us' },
    ...extra,
  } as unknown as Anthropic.Message;
}

function fakeClient(impl: MessagesClient['messages']['create']) {
  const create = vi.fn(impl);
  const client: MessagesClient = { messages: { create } };
  return { create, client };
}

function apiError(status: number, type: string, errorCode?: string, message = 'x'): InstanceType<typeof Anthropic.APIError> {
  const body = { type: 'error', error: { type, message, ...(errorCode ? { details: { error_code: errorCode } } : {}) } };
  return Anthropic.APIError.generate(status, body, message, new Headers({ 'request-id': 'req_1' }));
}

describe('chat (Claude adapter)', () => {
  it('sends the bot request: Haiku 5.5, adaptive thinking at low effort, US-only, cached, our tools', async () => {
    const { create, client } = fakeClient(async () => reply([{ type: 'text', text: 'Hello!', citations: null }]));
    const chat = createChat({ client: () => client });
    const out = await chat([{ role: 'system', content: 'RULES' }, ...USER], toolSchemas);
    expect(out).toMatchObject({ role: 'assistant', content: 'Hello!' });
    const [body, options] = create.mock.calls[0];
    expect(body).toMatchObject({
      model: HAIKU,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      inference_geo: 'us',
      cache_control: { type: 'ephemeral' },
      system: [{ type: 'text', text: 'RULES', cache_control: { type: 'ephemeral' } }],
    });
    expect(body.tools).toHaveLength(toolSchemas.length);
    // No sampling params, no forced tool choice, no server tools.
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('tool_choice');
    expect(body.tools!.every((t) => 'input_schema' in t)).toBe(true);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('a helper task picks its own model and effort, and sends no tools key when there are none', async () => {
    const { create, client } = fakeClient(async () => reply([{ type: 'text', text: 'Explained.', citations: null }]));
    const chat = createChat({ client: () => client });
    await chat(USER, [], { task: 'aml_explain', timeoutMs: 45_000 });
    const [body, options] = create.mock.calls[0];
    expect(body.model).toBe(SONNET);
    expect(body.output_config).toEqual({ effort: 'medium' });
    expect(body).not.toHaveProperty('tools');
    expect(options?.timeout).toBe(46_000);
  });

  it('ANTHROPIC_AGENT_MODEL moves only the bot, and only to a listed model', async () => {
    const { create, client } = fakeClient(async () => reply([{ type: 'text', text: 'ok', citations: null }]));
    const chat = createChat({ client: () => client, agentModel: () => SONNET });
    await chat(USER, []);
    await chat(USER, [], { task: 'ticket_draft' });
    expect(create.mock.calls[0][0].model).toBe(SONNET);
    expect(create.mock.calls[1][0].model).toBe(HAIKU);
    expect(llmTaskConfig('agent', { agentModel: 'gpt-oops' }).model).toBe(HAIKU);
    expect(AGENT_MODEL_CHOICES).toEqual([HAIKU, SONNET]);
  });

  it('timeout budget: 2 calls (chatWithRetry) fit the worker row deadline', () => {
    expect(2 * LLM_TIMEOUT_MS).toBeLessThanOrEqual(ROW_DEADLINE_MS);
  });

  it.each([
    [401, 'authentication_error'],
    [402, 'billing_error'],
    [403, 'permission_error'],
  ])('HTTP %i is a permanent ProviderHttpError', async (status, type) => {
    const { client } = fakeClient(async () => {
      throw apiError(status, type);
    });
    const err = await createChat({ client: () => client })(USER, []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(status);
    expect(isPermanentProviderError(err)).toBe(true);
    expect((err as Error).message).toContain(type);
    expect((err as Error).message).toContain('request req_1');
  });

  it('the monthly spend cap (429 enforced_spend_limit_reached) is permanent; a plain 429 is not', async () => {
    const capped = await createChat({
      client: () => fakeClient(async () => { throw apiError(429, 'rate_limit_error', 'enforced_spend_limit_reached'); }).client,
    })(USER, []).catch((e: unknown) => e);
    expect(isPermanentProviderError(capped)).toBe(true);
    expect((capped as ProviderHttpError).spendCap).toBe(true);

    const limited = await createChat({
      client: () => fakeClient(async () => { throw apiError(429, 'rate_limit_error'); }).client,
    })(USER, []).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(ProviderHttpError);
    expect(isPermanentProviderError(limited)).toBe(false);
  });

  it('our own Console spend limit (400 "reached your specified API usage limits") is permanent', async () => {
    const err = await createChat({
      client: () =>
        fakeClient(async () => {
          throw apiError(400, 'invalid_request_error', undefined, 'You have reached your specified API usage limits. You will regain access on 2026-11-01');
        }).client,
    })(USER, []).catch((e: unknown) => e);
    expect(isPermanentProviderError(err)).toBe(true);
  });

  it('never puts the provider message body in the error', async () => {
    const err = await createChat({
      client: () => fakeClient(async () => { throw apiError(500, 'api_error', undefined, 'secret-ish echo +15551234567'); }).client,
    })(USER, []).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain('15551234567');
  });

  it('a 529 on the bot gets ONE call on Sonnet 5.5', async () => {
    let n = 0;
    const { create, client } = fakeClient(async () => {
      n += 1;
      if (n === 1) throw apiError(529, 'overloaded_error');
      return reply([{ type: 'text', text: 'from sonnet', citations: null }]);
    });
    const out = await createChat({ client: () => client })(USER, []);
    expect(out.content).toBe('from sonnet');
    expect(create.mock.calls.map((c) => c[0].model)).toEqual([HAIKU, SONNET]);
  });

  it('a 529 on a helper (no fallback model) and a 500 on the bot are thrown, one call each', async () => {
    const a = fakeClient(async () => { throw apiError(529, 'overloaded_error'); });
    await expect(createChat({ client: () => a.client })(USER, [], { task: 'ticket_draft' })).rejects.toBeInstanceOf(ProviderHttpError);
    expect(a.create).toHaveBeenCalledTimes(1);
    const b = fakeClient(async () => { throw apiError(500, 'api_error'); });
    await expect(createChat({ client: () => b.client })(USER, [])).rejects.toBeInstanceOf(ProviderHttpError);
    expect(b.create).toHaveBeenCalledTimes(1);
  });

  it('a refusal is a failed call', async () => {
    const { client } = fakeClient(async () =>
      reply([], { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms', explanation: null } }),
    );
    await expect(createChat({ client: () => client })(USER, [])).rejects.toThrow(/declined.*general_harms/);
  });

  it('our own timeout is a clear error', async () => {
    const { client } = fakeClient(
      (_body, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()));
        }),
    );
    await expect(createChat({ client: () => client })(USER, [], { timeoutMs: 20 })).rejects.toThrow(
      'Model request timed out after 20ms',
    );
  });

  it("the caller's abort (row deadline) is a clear error and gets no fallback call", async () => {
    const ctrl = new AbortController();
    const { create, client } = fakeClient(
      (_body, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()));
          ctrl.abort();
        }),
    );
    await expect(createChat({ client: () => client })(USER, [], { signal: ctrl.signal })).rejects.toThrow(
      'Model request aborted by the caller (row deadline)',
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a chat with no user message is refused before any call', async () => {
    const { create, client } = fakeClient(async () => reply([]));
    await expect(createChat({ client: () => client })([{ role: 'system', content: 'x' }], [])).rejects.toThrow(/no user message/);
    expect(create).not.toHaveBeenCalled();
  });

  it('logs token usage with numbers only, never the text', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { client } = fakeClient(async () => reply([{ type: 'text', text: 'PRIVATE REPLY', citations: null }]));
    await createChat({ client: () => client })([{ role: 'user', content: 'PRIVATE QUESTION' }], []);
    const line = info.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(line).toContain('llm.usage');
    expect(line).toContain('"task":"agent"');
    expect(line).not.toContain('PRIVATE');
    info.mockRestore();
  });
});
