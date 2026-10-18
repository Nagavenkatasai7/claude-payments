import { describe, it, expect, vi } from 'vitest';
import type { AgentAuth, AgentPrincipal } from '@/lib/agent-auth';
import {
  MCP_GRANT_LIMITS,
  RATE_LIMITED_MESSAGE,
  TOOLS_OFF_MESSAGE,
  TOOL_FAILED_MESSAGE,
  runGuardedTool,
  underGrantLimits,
} from '@/lib/mcp/guard';
import { fakeRedis } from './helpers';

// Stage C1: the per-call guard of every MCP tool: per-grant limits (fail open), the gate (fail
// closed), the audit record (best effort) and JSON-only results.

const principal: AgentPrincipal = {
  grantId: 'agg_test1',
  partnerId: 'pa',
  phone: '14155550101',
  clientId: 'agc_test1',
  clientName: 'Test App',
  scopes: ['quotes:read', 'recipients:read', 'transfers:read'],
};

function fakeAuth(over: Partial<AgentAuth> = {}): AgentAuth & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    verifyAccessToken: async () => ({ ok: false, reason: 'invalid' }),
    toolsActive: async () => true,
    recordToolCall: async (_p, tool, outcome) => {
      calls.push([tool, outcome]);
    },
    ...over,
  };
}

const NOW = Date.UTC(2026, 9, 18, 12, 0, 30);

describe('underGrantLimits', () => {
  it('the windows are 60 a minute and 600 an hour', () => {
    expect(MCP_GRANT_LIMITS.map((w) => [w.limit, w.windowSec])).toEqual([
      [60, 60],
      [600, 3600],
    ]);
  });

  it('allows 60 calls in a minute and refuses the 61st', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < 60; i++) expect(await underGrantLimits(redis, 'agg_a', NOW)).toBe(true);
    expect(await underGrantLimits(redis, 'agg_a', NOW)).toBe(false);
  });

  it('is per grant: one grant spending its budget never throttles another', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < 61; i++) await underGrantLimits(redis, 'agg_a', NOW);
    expect(await underGrantLimits(redis, 'agg_b', NOW)).toBe(true);
  });

  it('the hour window refuses the 601st call even across fresh minutes', async () => {
    const redis = fakeRedis();
    // 10 minutes x 60 calls: inside every minute window, 600 in the hour.
    const hourStart = Math.floor(NOW / 3_600_000) * 3_600_000;
    for (let m = 0; m < 10; m++) {
      for (let i = 0; i < 60; i++) expect(await underGrantLimits(redis, 'agg_h', hourStart + m * 60_000)).toBe(true);
    }
    expect(await underGrantLimits(redis, 'agg_h', hourStart + 10 * 60_000)).toBe(false);
  });

  it('fails open when Redis throws', async () => {
    const redis = fakeRedis();
    redis.incr = async () => {
      throw new Error('redis down');
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await underGrantLimits(redis, 'agg_a', NOW)).toBe(true);
    vi.restoreAllMocks();
  });

  it('keys by the grant id, never by the phone', async () => {
    const redis = fakeRedis();
    await underGrantLimits(redis, 'agg_a', NOW);
    expect([...redis.dump.keys()].every((k) => k.includes('agg_a') && !k.includes(principal.phone))).toBe(true);
  });
});

describe('runGuardedTool', () => {
  it('runs the body and returns its data as JSON text; records ok', async () => {
    const auth = fakeAuth();
    const r = await runGuardedTool('get_quote', principal, { auth, redis: fakeRedis() }, async () => ({ ok: true, data: { a: 1 } }));
    expect(r.isError).toBeUndefined();
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ a: 1 });
    expect(auth.calls).toEqual([['get_quote', 'ok']]);
  });

  it('gate off → the switched-off tool error, the body never runs, recorded as refused', async () => {
    const auth = fakeAuth({ toolsActive: async () => false });
    const body = vi.fn(async () => ({ ok: true as const, data: {} }));
    const r = await runGuardedTool('list_recipients', principal, { auth, redis: fakeRedis() }, body);
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ error: TOOLS_OFF_MESSAGE });
    expect(TOOLS_OFF_MESSAGE).toBe('SmartRemit AI tools are switched off.');
    expect(body).not.toHaveBeenCalled();
    expect(auth.calls).toEqual([['list_recipients', 'refused']]);
  });

  it('a gate read that throws counts as off (fail closed)', async () => {
    const auth = fakeAuth({
      toolsActive: async () => {
        throw new Error('flag store down');
      },
    });
    const body = vi.fn(async () => ({ ok: true as const, data: {} }));
    const r = await runGuardedTool('get_quote', principal, { auth, redis: fakeRedis() }, body);
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ error: TOOLS_OFF_MESSAGE });
    expect(body).not.toHaveBeenCalled();
  });

  it('the gate is asked for the token principal (partner + phone)', async () => {
    const toolsActive = vi.fn(async () => true);
    await runGuardedTool('get_quote', principal, { auth: fakeAuth({ toolsActive }), redis: fakeRedis() }, async () => ({ ok: true, data: {} }));
    expect(toolsActive).toHaveBeenCalledWith('pa', '14155550101');
  });

  it('over the minute limit → the rate-limit tool error, recorded as refused', async () => {
    const auth = fakeAuth();
    const redis = fakeRedis();
    const deps = { auth, redis, now: () => NOW };
    const ok = async () => ({ ok: true as const, data: {} });
    for (let i = 0; i < 60; i++) expect((await runGuardedTool('get_quote', principal, deps, ok)).isError).toBeUndefined();
    const r = await runGuardedTool('get_quote', principal, deps, ok);
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ error: RATE_LIMITED_MESSAGE });
    expect(auth.calls.at(-1)).toEqual(['get_quote', 'refused']);
  });

  it('a body error message → a tool error, recorded as error', async () => {
    const auth = fakeAuth();
    const r = await runGuardedTool('get_transfer_status', principal, { auth, redis: fakeRedis() }, async () => ({ ok: false, message: 'Transfer not found.' }));
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ error: 'Transfer not found.' });
    expect(auth.calls).toEqual([['get_transfer_status', 'error']]);
  });

  it('a body that throws → a generic tool error (no internals), recorded as error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const auth = fakeAuth();
    const r = await runGuardedTool('get_quote', principal, { auth, redis: fakeRedis() }, async () => {
      throw new Error('relation "transfers" does not exist at 10.0.0.1');
    });
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(JSON.parse(text)).toEqual({ error: TOOL_FAILED_MESSAGE });
    expect(text).not.toContain('10.0.0.1');
    expect(auth.calls).toEqual([['get_quote', 'error']]);
    vi.restoreAllMocks();
  });

  it('a recordToolCall that throws never breaks the call', async () => {
    const auth = fakeAuth({
      recordToolCall: async () => {
        throw new Error('audit down');
      },
    });
    const r = await runGuardedTool('get_quote', principal, { auth, redis: fakeRedis() }, async () => ({ ok: true, data: { x: 1 } }));
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ x: 1 });
  });
});
