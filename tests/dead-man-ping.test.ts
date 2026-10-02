import { describe, it, expect, vi, beforeEach } from 'vitest';

// The dead-man ping: one fail-open GET to WORKER_HEARTBEAT_URL after a
// completed cron-sourced full worker run. It never throws and never logs the
// URL (anyone holding it can fake liveness).

const logWarnSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn: logWarnSpy }));

import { pingDeadMan, DEAD_MAN_PING_TIMEOUT_MS, DEAD_MAN_PING_MIN_BUDGET_MS } from '@/lib/dead-man-ping';

const URL_ = 'https://hc-ping.example/5f1c-secret-uuid';

beforeEach(() => {
  logWarnSpy.mockReset();
});

function okFetch(status = 200) {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
}

function loggedText(): string {
  return JSON.stringify(logWarnSpy.mock.calls);
}

describe('pingDeadMan', () => {
  it("an empty or whitespace URL is 'unset' and never fetches", async () => {
    const f = okFetch();
    expect(await pingDeadMan({ rawUrl: '', fetchFn: f, budgetMs: 10_000 })).toBe('unset');
    expect(await pingDeadMan({ rawUrl: '   ', fetchFn: f, budgetMs: 10_000 })).toBe('unset');
    expect(f).not.toHaveBeenCalled();
  });

  it("a 2xx is 'sent': one GET to the exact URL with an AbortSignal", async () => {
    const f = okFetch(200);
    expect(await pingDeadMan({ rawUrl: ` ${URL_} `, fetchFn: f, budgetMs: 10_000 })).toBe('sent');
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(URL_);
    expect(init?.method).toBe('GET');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('the timeout is min(3 s, budget)', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await pingDeadMan({ rawUrl: URL_, fetchFn: okFetch(), budgetMs: 10_000 });
    expect(spy).toHaveBeenLastCalledWith(DEAD_MAN_PING_TIMEOUT_MS);
    expect(DEAD_MAN_PING_TIMEOUT_MS).toBe(3_000);
    await pingDeadMan({ rawUrl: URL_, fetchFn: okFetch(), budgetMs: 1_200 });
    expect(spy).toHaveBeenLastCalledWith(1_200);
    spy.mockRestore();
  });

  it("a budget under 500 ms is 'skipped' with no fetch", async () => {
    const f = okFetch();
    expect(DEAD_MAN_PING_MIN_BUDGET_MS).toBe(500);
    expect(await pingDeadMan({ rawUrl: URL_, fetchFn: f, budgetMs: 499 })).toBe('skipped');
    expect(await pingDeadMan({ rawUrl: URL_, fetchFn: f, budgetMs: -5_000 })).toBe('skipped');
    expect(f).not.toHaveBeenCalled();
  });

  it("a non-2xx is 'failed', logged with the status only (never the URL)", async () => {
    expect(await pingDeadMan({ rawUrl: URL_, fetchFn: okFetch(404), budgetMs: 10_000 })).toBe('failed');
    expect(logWarnSpy).toHaveBeenCalledTimes(1);
    expect(logWarnSpy.mock.calls[0][2]).toEqual({ status: 404 });
    expect(loggedText()).not.toContain('hc-ping');
    expect(loggedText()).not.toContain('secret-uuid');
  });

  it("a safeFetch refusal is 'failed' with its fixed code, never throws", async () => {
    const f = vi.fn<typeof fetch>().mockRejectedValue(new Error('settlement_url_refused:scheme'));
    expect(await pingDeadMan({ rawUrl: 'http://hc-ping.example/x', fetchFn: f, budgetMs: 10_000 })).toBe('failed');
    expect(logWarnSpy.mock.calls[0][2]).toEqual({ error: 'settlement_url_refused:scheme' });
  });

  it("an abort (timeout) is 'failed', logged by error name only", async () => {
    const f = vi.fn<typeof fetch>().mockRejectedValue(new DOMException(`aborted ${URL_}`, 'TimeoutError'));
    expect(await pingDeadMan({ rawUrl: URL_, fetchFn: f, budgetMs: 10_000 })).toBe('failed');
    expect(logWarnSpy.mock.calls[0][2]).toEqual({ error: 'TimeoutError' });
    expect(loggedText()).not.toContain('hc-ping');
  });

  it('a non-Error rejection or a synchronous throw is still contained', async () => {
    const f1 = vi.fn<typeof fetch>().mockRejectedValue(URL_);
    expect(await pingDeadMan({ rawUrl: URL_, fetchFn: f1, budgetMs: 10_000 })).toBe('failed');
    const f2 = vi.fn<typeof fetch>().mockImplementation(() => {
      throw new Error(`bad ${URL_}`);
    });
    expect(await pingDeadMan({ rawUrl: URL_, fetchFn: f2, budgetMs: 10_000 })).toBe('failed');
    expect(loggedText()).not.toContain('hc-ping');
  });
});
