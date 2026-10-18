import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Db } from '@/db/client';
import type { AgentAuth } from '@/lib/agent-auth';
import { createAgentOAuthRepo } from '@/db/repos/agent-oauth-repo';
import { createAgentTokenStore } from '@/lib/agent-auth/stores';
import { createAgentAuth } from '@/lib/agent-auth/service';
import { handleRegister, handleToken, type HostCtx } from '@/lib/agent-auth/server';
import { handleAuthorizeGet, handleAuthorizePost, type AuthorizeDeps } from '@/lib/agent-auth/authorize-flow';
import { handleMcpRequest } from '@/lib/mcp/http';
import { createStore, type Store } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createPartnerStore } from '@/lib/partner-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { resetRateCacheForTests } from '@/lib/rate';
import { fakeRedis, type FakeRedis } from './helpers';
import { freshDb, seedPartner, seedSender } from './helpers-db';

// Stage C1: both halves joined. A client registers, the customer allows it, the code becomes a
// real access token, and a real MCP SDK client uses that token on /api/mcp's handler, verified by
// the real agent auth (PGlite + fake Redis). Then: another host refuses the token, and a
// disconnect stops it at once.

const HOST = 'send.smartremit.ai';
const ISS = `https://${HOST}`;
const RESOURCE = `${ISS}/api/mcp`;
const CTX: HostCtx = { partnerId: 'pa', host: HOST };
const PHONE = '14155550101';
const PEPPER = 'test-pepper';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

let db: Db;
let redis: FakeRedis;
let store: Store;

function authDeps(): AuthorizeDeps {
  return {
    repo: createAgentOAuthRepo(db),
    store: createAgentTokenStore(redis, { now: Date.now, pepper: PEPPER }),
    now: Date.now,
    pepper: PEPPER,
    toolsOn: async () => true,
    gateOpen: async (_p, phone) => phone === PHONE,
    audit: async () => {},
    limited: async () => false,
    session: async () => ({ phone: PHONE, sid: 'sid-1', fresh: true }),
    isDev: false,
  };
}

function agentAuth(): AgentAuth {
  return createAgentAuth({
    repo: createAgentOAuthRepo(db),
    store: createAgentTokenStore(redis, { now: Date.now, pepper: PEPPER }),
    now: Date.now,
    redis,
    gateOpen: async (p, phone) => p === 'pa' && phone === PHONE,
    audit: async () => {},
  });
}

function toolDeps() {
  const customerStore = createCustomerStore(db, store);
  return {
    store,
    customerStore,
    scheduleStore: createScheduleStore(db),
    draftStore: createDraftStore(redis),
    dailyVolumeStore: createDailyVolumeStore(store),
    monthlyVolumeStore: createMonthlyVolumeStore(store),
    partnerStore: createPartnerStore(db),
    kycProvider: new MockKycProvider(customerStore, 'https://example.com'),
  };
}

/** Register → consent (Allow) → code → token, through the real handlers. */
async function signIn(): Promise<{ accessToken: string; grantId: string }> {
  const reg = await handleRegister(
    new Request(`${ISS}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Claude', token_endpoint_auth_method: 'none' }),
    }),
    CTX,
    authDeps(),
  );
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 's',
    resource: RESOURCE,
  });
  const consent = await handleAuthorizeGet(new Request(`${ISS}/oauth/authorize?${q}`), CTX, authDeps());
  const ticket = /name="ticket" value="([^"]+)"/.exec(await consent.text())![1];
  const allowed = await handleAuthorizePost(
    new Request(`${ISS}/oauth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ISS },
      body: new URLSearchParams({ ticket, decision: 'allow' }).toString(),
    }),
    CTX,
    authDeps(),
  );
  const code = new URL(allowed.headers.get('location')!).searchParams.get('code')!;
  const tok = await handleToken(
    new Request(`${ISS}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: RESOURCE }).toString(),
    }),
    CTX,
    authDeps(),
  );
  const accessToken = ((await tok.json()) as { access_token: string }).access_token;
  const grants = await createAgentOAuthRepo(db).listCustomerGrants('pa', PHONE, new Date());
  return { accessToken, grantId: grants[0].id };
}

const mcpDeps = (slug: string, partnerId: string) => ({
  site: async () => ({ partnerId, slug }),
  auth: agentAuth(),
  redis,
  toolDeps: toolDeps(),
  db,
});

async function connect(accessToken: string, slug = 'send', partnerId = 'pa') {
  const deps = mcpDeps(slug, partnerId);
  const c = new Client({ name: 'e2e', version: '0.0.1' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`https://${slug}.smartremit.ai/api/mcp`), {
      fetch: (url, init) => handleMcpRequest(new Request(url, init), deps),
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    }),
  );
  return c;
}

const post = (accessToken: string, slug: string, partnerId: string) =>
  handleMcpRequest(
    new Request(`https://${slug}.smartremit.ai/api/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
    mcpDeps(slug, partnerId),
  );

describe('sign-in + MCP endpoint, joined', () => {
  beforeEach(async () => {
    resetRateCacheForTests();
    db = await freshDb();
    redis = fakeRedis();
    store = createStore(redis, db);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '', json: async () => ({ rates: { INR: 85 } }) })));
    await seedPartner(db, 'pa', 'Partner A');
    await seedPartner(db, 'pb', 'Partner B');
    await seedSender(db, { partnerId: 'pa', phone: PHONE, firstSeenDaysAgo: 10, kycStatus: 'verified' });
    await store.upsertRecipient('pa', PHONE, {
      name: 'Asha Kumar',
      recipientPhone: '919812345678',
      payoutMethod: 'bank',
      payoutDestination: 'HDFC0000001 123456789012',
      lastUsedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a token from the real sign-in lists the five tools and reads the customer’s recipients', async () => {
    const { accessToken } = await signIn();
    expect(accessToken).toMatch(/^sra_/);
    const c = await connect(accessToken);
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['check_send_limit', 'get_quote', 'get_transfer_status', 'list_recent_transfers', 'list_recipients']);
    const r = await c.callTool({ name: 'list_recipients', arguments: {} });
    const text = (r.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text)).toMatchObject({ recipients: [{ name: 'Asha Kumar', payout_type: 'bank', account_last4: '9012' }] });
    expect(text).not.toContain('123456789012');
    expect(text).not.toContain('919812345678');
    await c.close();
  });

  it('the same token on another tenant’s host is a 401', async () => {
    const { accessToken } = await signIn();
    expect((await post(accessToken, 'send', 'pa')).status).toBe(200);
    const res = await post(accessToken, 'other', 'pb');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata="https://other.smartremit.ai/.well-known/oauth-protected-resource/api/mcp"');
  });

  it('a disconnect in the portal stops the live access token at once', async () => {
    const { accessToken, grantId } = await signIn();
    expect((await post(accessToken, 'send', 'pa')).status).toBe(200);
    expect(await createAgentOAuthRepo(db).revokeCustomerGrant('pa', PHONE, grantId, new Date())).not.toBeNull();
    expect((await post(accessToken, 'send', 'pa')).status).toBe(401);
  });
});
