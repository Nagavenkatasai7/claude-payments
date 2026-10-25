import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Client, StreamableHTTPClientTransport, extractWWWAuthenticateParams } from '@modelcontextprotocol/client';
import type { AgentAuth, AgentPrincipal, AgentScope } from '@/lib/agent-auth';
import { TOOLS_OFF_MESSAGE } from '@/lib/mcp/guard';
import { fakeRedis, type FakeRedis } from './helpers';

// Stage C1: /api/mcp through the REAL route module (src/app/api/mcp/route.ts), with the host site,
// the agent-auth implementation, Redis and the per-IP limiter replaced by fakes. A real MCP client
// from the SDK drives initialize → tools/list → tools/call in both protocol eras, and a raw
// 2025-06-18 initialize proves legacy clients are served.

const HOST = 'send.smartremit.ai';
const RESOURCE = `https://${HOST}/api/mcp`;
const METADATA = `https://${HOST}/.well-known/oauth-protected-resource/api/mcp`;
const CHALLENGE = `Bearer resource_metadata="${METADATA}", scope="quotes:read recipients:read transfers:read transfers:prepare schedules:manage"`;
const ALL: AgentScope[] = ['quotes:read', 'recipients:read', 'transfers:read', 'transfers:prepare', 'schedules:manage'];

const state: {
  site: { partnerId: string; slug: string } | null;
  auth: AgentAuth;
  redis: FakeRedis;
  ipLimited: boolean;
} = { site: null, auth: null as unknown as AgentAuth, redis: fakeRedis(), ipLimited: false };

vi.mock('@/lib/portal-site', () => ({ getPortalSite: async () => state.site }));
vi.mock('@/lib/redis', () => ({ getRedis: () => state.redis }));
vi.mock('@/lib/agent-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-auth')>()),
  getAgentAuth: () => state.auth,
}));
vi.mock('@/lib/ip-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ip-rate-limit')>()),
  enforceIpRateLimit: async () => (state.ipLimited ? Response.json({ ok: false }, { status: 429 }) : null),
}));

const route = await import('@/app/api/mcp/route');

function principal(over: Partial<AgentPrincipal> = {}): AgentPrincipal {
  return { grantId: 'agg_1', partnerId: 'pa', phone: '14155550101', clientId: 'agc_1', clientName: 'Test App', scopes: ALL, ...over };
}

interface FakeAuth extends AgentAuth {
  seen: Array<{ token: string | null; resource: string }>;
  recorded: Array<[string, string]>;
}

function fakeAuth(tokens: Record<string, AgentPrincipal>, toolsOn = false): FakeAuth {
  const seen: FakeAuth['seen'] = [];
  const recorded: FakeAuth['recorded'] = [];
  return {
    seen,
    recorded,
    async verifyAccessToken(token, resource) {
      seen.push({ token, resource });
      if (!token) return { ok: false, reason: 'missing' };
      const p = tokens[token];
      return p && resource === RESOURCE ? { ok: true, principal: p } : { ok: false, reason: 'invalid' };
    },
    async toolsActive() {
      return toolsOn;
    },
    async recordToolCall(_p, tool, outcome) {
      recorded.push([tool, outcome]);
    },
  };
}

type NextInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;
const req = (init: NextInit & { url?: string } = {}) => new NextRequest(init.url ?? RESOURCE, init);

const jsonRpc = (body: unknown, headers: Record<string, string> = {}) =>
  req({
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });

/** A JSON-RPC response from either a JSON body or an SSE stream (the 2025 stateless transport streams). */
async function rpcBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    return JSON.parse(data[data.length - 1]);
  }
  return JSON.parse(text);
}

const initialize = (protocolVersion: string) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion, capabilities: {}, clientInfo: { name: 'legacy-test', version: '0.0.1' } },
});

/** A real SDK client whose fetch calls the route's handlers in-process. */
function clientFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const r = new NextRequest(new Request(url, init));
  const m = r.method.toUpperCase();
  if (m === 'POST') return route.POST(r);
  if (m === 'GET') return route.GET(r);
  if (m === 'DELETE') return route.DELETE(r);
  return route.OPTIONS(r);
}

async function connect(token: string, opts: { modern?: boolean; versions?: string[] } = {}) {
  const client = new Client(
    { name: 'smartremit-test-client', version: '0.0.1' },
    {
      ...(opts.versions ? { supportedProtocolVersions: opts.versions } : {}),
      ...(opts.modern ? { versionNegotiation: { mode: 'auto' as const } } : {}),
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    fetch: clientFetch,
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

beforeEach(() => {
  state.site = { partnerId: 'pa', slug: 'send' };
  state.auth = fakeAuth({ sra_good: principal() });
  state.redis = fakeRedis();
  state.ipLimited = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/api/mcp: host = tenant', () => {
  it('the route module exports POST, GET, DELETE and OPTIONS', () => {
    for (const m of ['POST', 'GET', 'DELETE', 'OPTIONS'] as const) expect(typeof route[m]).toBe('function');
  });

  it('not a portal host (apex, portal off, unknown) → bare 404 for every method, token never checked', async () => {
    state.site = null;
    const auth = fakeAuth({ sra_good: principal() });
    state.auth = auth;
    for (const m of ['POST', 'GET', 'DELETE', 'OPTIONS'] as const) {
      const res = await route[m](req({ method: m, headers: { authorization: 'Bearer sra_good' } }));
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('');
    }
    expect(auth.seen).toEqual([]);
  });

  it('verifies the token for THIS host canonical resource', async () => {
    const auth = fakeAuth({ sra_good: principal() });
    state.auth = auth;
    await route.POST(jsonRpc(initialize('2025-06-18'), { authorization: 'Bearer sra_good' }));
    expect(auth.seen).toEqual([{ token: 'sra_good', resource: RESOURCE }]);
  });
});

describe('/api/mcp: 401 and CORS', () => {
  it('no token → 401 with the exact challenge of spec item 13, and CORS headers', async () => {
    const res = await route.POST(jsonRpc(initialize('2025-06-18')));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate');
  });

  it('a real MCP client reads resource_metadata and scope from the challenge', async () => {
    const res = await route.POST(jsonRpc(initialize('2025-06-18')));
    const params = extractWWWAuthenticateParams(res);
    expect(params.resourceMetadataUrl?.href).toBe(METADATA);
    expect(params.scope).toBe('quotes:read recipients:read transfers:read transfers:prepare schedules:manage');
  });

  it('an unknown token → 401, the challenge plus error="invalid_token"', async () => {
    const res = await route.POST(jsonRpc(initialize('2025-06-18'), { authorization: 'Bearer sra_nope' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(`${CHALLENGE}, error="invalid_token"`);
  });

  it('a malformed Authorization header → 401 without calling the verifier', async () => {
    const auth = fakeAuth({ sra_good: principal() });
    state.auth = auth;
    for (const h of ['Basic abc', 'Bearer', 'Bearer a b', 'sra_good']) {
      const res = await route.POST(jsonRpc(initialize('2025-06-18'), { authorization: h }));
      expect(res.status).toBe(401);
    }
    expect(auth.seen).toEqual([]);
  });

  it('a token in the query string is ignored (401: tokens are header-only)', async () => {
    const res = await route.POST(
      new NextRequest(`${RESOURCE}?access_token=sra_good`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(initialize('2025-06-18')),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("the token principal's tenant is not the host's → 401 (same as invalid)", async () => {
    state.auth = fakeAuth({ sra_other: principal({ partnerId: 'pb' }) });
    const res = await route.POST(jsonRpc(initialize('2025-06-18'), { authorization: 'Bearer sra_other' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(`${CHALLENGE}, error="invalid_token"`);
  });

  it('a verifier that throws → 401 (fail closed)', async () => {
    state.auth = {
      ...fakeAuth({}),
      verifyAccessToken: async () => {
        throw new Error('redis down');
      },
    };
    const res = await route.POST(jsonRpc(initialize('2025-06-18'), { authorization: 'Bearer sra_good' }));
    expect(res.status).toBe(401);
  });

  it('OPTIONS is the CORS preflight: 204, any origin, no credentials, the MCP headers allowed', async () => {
    const res = await route.OPTIONS(req({ method: 'OPTIONS', headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST' } }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    const allowed = res.headers.get('access-control-allow-headers') ?? '';
    for (const h of ['authorization', 'content-type', 'mcp-protocol-version', 'mcp-session-id']) expect(allowed).toContain(h);
    const exposed = res.headers.get('access-control-expose-headers') ?? '';
    for (const h of ['WWW-Authenticate', 'Mcp-Session-Id', 'Mcp-Protocol-Version']) expect(exposed).toContain(h);
  });

  it('the per-IP limiter answers 429 before the token is checked', async () => {
    state.ipLimited = true;
    const auth = fakeAuth({ sra_good: principal() });
    state.auth = auth;
    const res = await route.POST(jsonRpc(initialize('2025-06-18'), { authorization: 'Bearer sra_good' }));
    expect(res.status).toBe(429);
    expect(auth.seen).toEqual([]);
  });
});

describe('/api/mcp: legacy (2025-era) clients, stateless', () => {
  it('a raw 2025-06-18 initialize is answered at 2025-06-18 by SmartRemit', async () => {
    const res = await route.POST(jsonRpc(initialize('2025-06-18'), { authorization: 'Bearer sra_good' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('mcp-session-id')).toBeNull(); // stateless: no session
    const body = await rpcBody(res);
    const result = body.result as { protocolVersion: string; serverInfo: { name: string }; capabilities: Record<string, unknown>; instructions?: string };
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.serverInfo.name).toBe('SmartRemit');
    expect(result.capabilities.tools).toBeDefined();
    expect(result.instructions).toContain('cannot pay or move money');
  });

  it('a raw 2025-11-25 and 2025-03-26 initialize are answered at their own versions', async () => {
    for (const v of ['2025-11-25', '2025-03-26']) {
      const body = await rpcBody(await route.POST(jsonRpc(initialize(v), { authorization: 'Bearer sra_good' })));
      expect((body.result as { protocolVersion: string }).protocolVersion).toBe(v);
    }
  });

  it('GET and DELETE (2025 session operations) with a valid token → 405 (stateless)', async () => {
    for (const m of ['GET', 'DELETE'] as const) {
      const res = await route[m](req({ method: m, headers: { authorization: 'Bearer sra_good', accept: 'text/event-stream' } }));
      expect(res.status).toBe(405);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    }
  });

  it('a real SDK client pinned to 2025-06-18: initialize → tools/list → tools/call', async () => {
    const client = await connect('sra_good', { versions: ['2025-06-18'] });
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-06-18');
    expect(client.getProtocolEra()).toBe('legacy');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'cancel_prepared_transfer',
      'change_schedule',
      'check_send_limit',
      'create_schedule',
      'get_quote',
      'get_transfer_status',
      'list_recent_transfers',
      'list_recipients',
      'list_schedules',
      'prepare_transfer',
    ]);
    for (const t of tools) {
      expect(t.description).toContain('cannot pay or move money');
      // Only the two C2 tools (a draft) and the two schedule changers change anything; every other tool only reads.
      expect(t.annotations?.readOnlyHint).toBe(!['prepare_transfer', 'cancel_prepared_transfer', 'create_schedule', 'change_schedule'].includes(t.name));
    }
    expect(tools.find((t) => t.name === 'cancel_prepared_transfer')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'prepare_transfer')?.annotations?.destructiveHint).toBe(false);
    expect(tools.find((t) => t.name === 'create_schedule')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'change_schedule')?.annotations?.destructiveHint).toBe(true);
    // The gate is off for this customer: every call is the switched-off tool error.
    const r = await client.callTool({ name: 'check_send_limit', arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content as Array<{ text: string }>)[0].text)).toEqual({ error: TOOLS_OFF_MESSAGE });
    await client.close();
  });

  it('the default SDK client (2025-11-25) works the same', async () => {
    const client = await connect('sra_good');
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect((await client.listTools()).tools).toHaveLength(10);
    await client.close();
  });
});

describe('/api/mcp: modern (2026-07-28) clients', () => {
  it('a real SDK client with version negotiation: discover → tools/list → tools/call', async () => {
    const auth = fakeAuth({ sra_good: principal() });
    state.auth = auth;
    const client = await connect('sra_good', { modern: true });
    expect(client.getProtocolEra()).toBe('modern');
    expect((await client.listTools()).tools).toHaveLength(10);
    const r = await client.callTool({ name: 'get_transfer_status', arguments: { transfer_id: 'tx_123456' } });
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content as Array<{ text: string }>)[0].text)).toEqual({ error: TOOLS_OFF_MESSAGE });
    expect(auth.recorded).toEqual([['get_transfer_status', 'refused']]);
    await client.close();
  });
});

describe('/api/mcp: tool input size (GHSA-46jr-4wx8-v453)', () => {
  const call = (name: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } });

  it('refuses tools/call arguments with more elements than MCP_MAX_TOOL_INPUT_ELEMENTS before the tool runs', async () => {
    const { MCP_MAX_TOOL_INPUT_ELEMENTS } = await import('@/lib/mcp/server');
    expect(MCP_MAX_TOOL_INPUT_ELEMENTS).toBe(64);
    const auth = fakeAuth({ sra_good: principal() }, true);
    state.auth = auth;
    const junk = Array.from({ length: MCP_MAX_TOOL_INPUT_ELEMENTS + 1 }, (_, i) => i);
    const res = await route.POST(jsonRpc(call('get_quote', { amount: 100, junk }), { authorization: 'Bearer sra_good', 'mcp-protocol-version': '2025-06-18' }));
    const text = JSON.stringify(await rpcBody(res));
    expect(text).toContain(`more than the maximum of ${MCP_MAX_TOOL_INPUT_ELEMENTS} elements`);
    expect(auth.recorded).toEqual([]);
  });

  it('the largest real tool input (prepare_transfer, every field) stays well under the cap', async () => {
    const { MCP_MAX_TOOL_INPUT_ELEMENTS } = await import('@/lib/mcp/server');
    const { prepareTransferInput } = await import('@/lib/mcp/prepare');
    expect(Object.keys(prepareTransferInput.shape).length).toBeLessThan(MCP_MAX_TOOL_INPUT_ELEMENTS / 4);
  });
});

describe('/api/mcp: scopes', () => {
  const call = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });

  it('a tool outside the token scopes → HTTP 403 insufficient_scope naming the missing scope, nothing runs', async () => {
    const auth = fakeAuth({ sra_quotes: principal({ scopes: ['quotes:read'] }) }, true);
    state.auth = auth;
    const res = await route.POST(jsonRpc(call('list_recipients'), { authorization: 'Bearer sra_quotes', 'mcp-protocol-version': '2025-06-18' }));
    expect(res.status).toBe(403);
    const www = res.headers.get('www-authenticate') ?? '';
    expect(www).toContain('error="insufficient_scope"');
    expect(www).toContain('scope="recipients:read"');
    expect(www).toContain(`resource_metadata="${METADATA}"`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(auth.recorded).toEqual([]);
  });

  it('a tool inside the token scopes is dispatched (here: the gate answers)', async () => {
    state.auth = fakeAuth({ sra_quotes: principal({ scopes: ['quotes:read'] }) });
    const res = await route.POST(jsonRpc(call('check_send_limit'), { authorization: 'Bearer sra_quotes', 'mcp-protocol-version': '2025-06-18' }));
    expect(res.status).toBe(200);
    const body = await rpcBody(res);
    const result = body.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: TOOLS_OFF_MESSAGE });
  });

  it('each tool requires its own scope', async () => {
    const want: Record<string, string> = {
      get_quote: 'quotes:read',
      check_send_limit: 'quotes:read',
      list_recipients: 'recipients:read',
      list_recent_transfers: 'transfers:read',
      get_transfer_status: 'transfers:read',
      prepare_transfer: 'transfers:prepare',
      cancel_prepared_transfer: 'transfers:prepare',
      list_schedules: 'schedules:manage',
      create_schedule: 'schedules:manage',
      change_schedule: 'schedules:manage',
    };
    state.auth = fakeAuth({ sra_none: principal({ scopes: [] }) });
    for (const [name, scope] of Object.entries(want)) {
      const args: Record<string, unknown> =
        name === 'get_quote'
          ? { amount: 100 }
          : name === 'get_transfer_status'
            ? { transfer_id: 'tx_123456' }
            : name === 'prepare_transfer'
              ? { recipient_id: 'r_123', amount: 100, purpose: 'gift' }
              : name === 'cancel_prepared_transfer'
                ? { prepared_transfer_id: 'dr_123456' }
                : name === 'create_schedule'
                  ? { recipient_id: 'r_123', amount: 100, frequency: 'monthly', day_of_month: 5, purpose: 'gift' }
                  : name === 'change_schedule'
                    ? { schedule_id: 's_123456', action: 'pause' }
                    : {};
      const res = await route.POST(jsonRpc(call(name, args), { authorization: 'Bearer sra_none', 'mcp-protocol-version': '2025-06-18' }));
      expect(res.status, name).toBe(403);
      expect(res.headers.get('www-authenticate'), name).toContain(`scope="${scope}"`);
    }
  });
});
