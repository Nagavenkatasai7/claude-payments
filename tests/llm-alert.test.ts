import { describe, it, expect, vi, beforeEach } from 'vitest';
import { llmDownAlertFor, raiseLlmDownAlert, __resetLlmAlertMemo } from '@/lib/llm-alert';
import { OllamaHttpError } from '@/lib/llm-provider-error';

// LLM provider outages reach ops: a permanent provider rejection (401/402/403)
// raises ONE deduped ops.alert per status per clock hour. The payload is
// {message} only: never the provider's response body, a phone or a tenant.
const HOUR_MS = 60 * 60 * 1000;
const T0 = 1_750_000_000_000;
const H = Math.floor(T0 / HOUR_MS);

beforeEach(() => __resetLlmAlertMemo());

describe('llmDownAlertFor', () => {
  it('a 402 gives llmdown:402:<hour> and a billing message without the body text', () => {
    const down = llmDownAlertFor(new OllamaHttpError(402, 'acct 123 out of credit'), H);
    expect(down?.dedupeKey).toBe(`llmdown:402:${H}`);
    expect(down?.message).toMatch(/402/);
    expect(down?.message).toMatch(/billing/i);
    expect(down?.message).not.toMatch(/acct 123/);
    expect(down?.message).not.toMatch(/\n/);
  });

  it('401 and 403 carry their own hint', () => {
    expect(llmDownAlertFor(new OllamaHttpError(401, ''), H)?.message).toMatch(/401/);
    expect(llmDownAlertFor(new OllamaHttpError(403, ''), H)?.dedupeKey).toBe(`llmdown:403:${H}`);
  });

  it('is null for transient or unknown errors', () => {
    expect(llmDownAlertFor(new OllamaHttpError(500, ''), H)).toBeNull();
    expect(llmDownAlertFor(new OllamaHttpError(429, ''), H)).toBeNull();
    expect(llmDownAlertFor(new Error('Ollama request timed out after 20000ms'), H)).toBeNull();
    expect(llmDownAlertFor(new Error('boom'), H)).toBeNull();
    expect(llmDownAlertFor(undefined, H)).toBeNull();
  });
});

describe('raiseLlmDownAlert', () => {
  it('enqueues one {message}-only ops.alert per status per hour (memo), again next hour', async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    const err = new OllamaHttpError(402, 'x');
    await raiseLlmDownAlert(err, { enqueue, now: () => T0 });
    await raiseLlmDownAlert(err, { enqueue, now: () => T0 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [kind, payload, opts] = enqueue.mock.calls[0];
    expect(kind).toBe('ops.alert');
    expect(Object.keys(payload)).toEqual(['message']);
    expect(opts).toEqual({ dedupeKey: `llmdown:402:${H}` });
    await raiseLlmDownAlert(err, { enqueue, now: () => T0 + HOUR_MS });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[1][2].dedupeKey).toBe(`llmdown:402:${H + 1}`);
  });

  it('is a no-op for a transient error', async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    await raiseLlmDownAlert(new OllamaHttpError(503, 'x'), { enqueue, now: () => T0 });
    await raiseLlmDownAlert(new Error('timeout'), { enqueue, now: () => T0 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('never throws when the enqueue fails, and retries on the next call', async () => {
    const enqueue = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(true);
    const err = new OllamaHttpError(401, 'x');
    await expect(raiseLlmDownAlert(err, { enqueue, now: () => T0 })).resolves.toBeUndefined();
    await raiseLlmDownAlert(err, { enqueue, now: () => T0 });
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('an enqueue that rejects after the deadline still clears the memo', async () => {
    let rejectLate: (e: Error) => void = () => {};
    const enqueue = vi
      .fn()
      .mockImplementationOnce(() => new Promise<boolean>((_, rej) => { rejectLate = rej; }))
      .mockResolvedValue(true);
    const err = new OllamaHttpError(402, 'x');
    await raiseLlmDownAlert(err, { enqueue, now: () => T0, timeoutMs: 5 });
    rejectLate(new Error('db down'));
    await new Promise((r) => setTimeout(r, 0));
    await raiseLlmDownAlert(err, { enqueue, now: () => T0 });
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('is bounded: a hanging enqueue resolves at the deadline', async () => {
    const enqueue = vi.fn(() => new Promise<boolean>(() => {}));
    const t = Date.now();
    await raiseLlmDownAlert(new OllamaHttpError(402, 'x'), { enqueue, now: () => T0, timeoutMs: 20 });
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
