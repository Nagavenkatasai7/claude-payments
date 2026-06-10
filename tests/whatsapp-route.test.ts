import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';

// after() runs the agent callback inline (we don't assert on it here, but keep
// it from being a no-op scheduled task that leaks across tests).
vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: (cb: () => Promise<void> | void) => { void cb(); } };
});

// markMessageSeen is the first side-effect after the signature gate; asserting on
// it tells us whether a request got PAST the gate or was rejected before it.
const markMessageSeen = vi.fn(async (_id: string) => true);
const getLastInboundAt = vi.fn(async (_from: string) => null);
const recordInboundNow = vi.fn(async (_from: string) => {});
vi.mock('@/lib/store', () => ({
  getStore: () => ({ markMessageSeen, getLastInboundAt, recordInboundNow }),
}));

// Keep the downstream turn-building dependencies inert so the POST handler can
// run to completion once it's past the gate, without real Redis / Postgres.
// vi.hoisted: these mock fns are referenced inside the hoisted vi.mock factories.
// Stage 2c: the agent turn is ENQUEUED to the outbox, not run inline — so the
// "agent ran / didn't run" assertions become "agent.turn enqueued / not".
const {
  sendText,
  setOptedOut,
  clearOptedOut,
  setOptedIn,
  getCustomer,
  upsertOnFirstInbound,
  enqueue,
} = vi.hoisted(() => ({
  sendText: vi.fn(async () => {}),
  setOptedOut: vi.fn(async (_phone: string) => {}),
  clearOptedOut: vi.fn(async (_phone: string) => {}),
  setOptedIn: vi.fn(async (_phone: string) => {}),
  // Default: an opted-IN customer (optInAt set, no optedOutAt). Tests override.
  // Typed loosely so per-test overrides can add optedOutAt / drop optInAt.
  getCustomer: vi.fn(
    async (_phone: string): Promise<Record<string, unknown> | null> => ({
      senderPhone: '15551230000',
      optInAt: new Date().toISOString(),
    }),
  ),
  upsertOnFirstInbound: vi.fn(
    async (): Promise<{ customer: Record<string, unknown>; wasCreated: boolean }> => ({
      customer: { firstSeenAt: new Date().toISOString(), optInAt: new Date().toISOString() },
      wasCreated: true,
    }),
  ),
  enqueue: vi.fn(async () => true),
}));
vi.mock('@/lib/whatsapp', async (orig) => {
  const real = await orig<typeof import('@/lib/whatsapp')>();
  return { ...real, sendText };
});
vi.mock('@/lib/customer-store', () => ({
  getCustomerStore: () => ({
    upsertOnFirstInbound,
    getCustomer,
    setOptedOut,
    clearOptedOut,
    setOptedIn,
  }),
}));
vi.mock('@/lib/tier-rules', () => ({ deriveTier: () => 'T1' }));
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));
vi.mock('@/db/repos/outbox-repo', () => ({ createOutboxRepo: () => ({ enqueue }) }));
vi.mock('@/lib/outbox', () => ({ pokeWorker: vi.fn() }));

import { GET, POST } from '@/app/api/whatsapp/route';
import { OPT_OUT_REPLY, OPT_IN_REPLY, OPT_OUT_REMINDER } from '@/lib/consent';

const SECRET = 'meta-app-secret';
const inboundBody = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            messages: [
              { from: '15551230000', id: 'wamid.TEST1', type: 'text', text: { body: 'hi' } },
            ],
          },
        },
      ],
    },
  ],
});
const sign = (body: string, secret = SECRET) =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

function post(raw: string, signature?: string) {
  const req = new NextRequest('http://localhost/api/whatsapp', {
    method: 'POST',
    body: raw,
    headers: signature ? { 'x-hub-signature-256': signature } : {},
  });
  return POST(req);
}

beforeEach(() => {
  markMessageSeen.mockClear().mockResolvedValue(true);
  getLastInboundAt.mockClear();
  recordInboundNow.mockClear();
  sendText.mockClear();
  setOptedOut.mockClear();
  clearOptedOut.mockClear();
  setOptedIn.mockClear();
  enqueue.mockClear();
  // Reset customer lookups to the opted-IN default each test.
  getCustomer.mockClear().mockResolvedValue({
    senderPhone: '15551230000',
    optInAt: new Date().toISOString(),
  });
  upsertOnFirstInbound.mockClear().mockResolvedValue({
    customer: { firstSeenAt: new Date().toISOString(), optInAt: new Date().toISOString() },
    wasCreated: true,
  });
});

function textBody(text: string, id = 'wamid.TXT', from = '15551230000') {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          { value: { messages: [{ from, id, type: 'text', text: { body: text } }] } },
        ],
      },
    ],
  });
}

function statusBody(status: string, opts: { code?: number; title?: string } = {}) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              statuses: [
                {
                  id: 'wamid.STATUS1',
                  recipient_id: '15551230000',
                  status,
                  ...(opts.code !== undefined || opts.title
                    ? { errors: [{ code: opts.code, title: opts.title }] }
                    : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

afterEach(() => {
  delete process.env.META_APP_SECRET;
  vi.restoreAllMocks();
});

describe('GET /api/whatsapp', () => {
  it('echoes the challenge when the verify token matches', async () => {
    const req = new NextRequest(
      'http://localhost/api/whatsapp?hub.mode=subscribe&hub.verify_token=verify-test&hub.challenge=42',
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('42');
  });

  it('returns 403 when the verify token is wrong', async () => {
    const req = new NextRequest(
      'http://localhost/api/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42',
    );
    const res = await GET(req);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/whatsapp — signature verification', () => {
  it('secret set + valid signature → request is processed (200, reaches markMessageSeen)', async () => {
    process.env.META_APP_SECRET = SECRET;
    const res = await post(inboundBody, sign(inboundBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(markMessageSeen).toHaveBeenCalledWith('wamid.TEST1');
  });

  it('secret set + tampered signature → 401 and NO processing', async () => {
    process.env.META_APP_SECRET = SECRET;
    const res = await post(inboundBody, sign(inboundBody) + '00');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false });
    expect(markMessageSeen).not.toHaveBeenCalled();
  });

  it('secret set + missing signature header → 401 and NO processing', async () => {
    process.env.META_APP_SECRET = SECRET;
    const res = await post(inboundBody); // no x-hub-signature-256 header
    expect(res.status).toBe(401);
    expect(markMessageSeen).not.toHaveBeenCalled();
  });

  it('secret UNSET → request proceeds (back-compat) and warns', async () => {
    delete process.env.META_APP_SECRET;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await post(inboundBody); // no/garbage signature is irrelevant when unset
    expect(res.status).toBe(200);
    expect(markMessageSeen).toHaveBeenCalledWith('wamid.TEST1');
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toContain('META_APP_SECRET');
  });
});

describe('POST /api/whatsapp — message-status callbacks (Item 4)', () => {
  it('a failed status → 200, warns with the error code, agent NOT run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await post(statusBody('failed', { code: 131056, title: 'Too many messages' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(markMessageSeen).not.toHaveBeenCalled(); // status path never reaches dedup
    expect(enqueue).not.toHaveBeenCalled();
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('131056');
    expect(logged).toContain('delivery_failed');
    // Stage 3: the structured warn line must NOT carry the full phone.
    expect(logged).not.toContain('15551230000');
  });

  it('a delivered status → 200, agent NOT run', async () => {
    const res = await post(statusBody('delivered'));
    expect(res.status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('POST /api/whatsapp — STOP / START consent short-circuit (Item 4)', () => {
  it('inbound "STOP" → setOptedOut, confirmation sent, agent NOT run', async () => {
    const res = await post(textBody('STOP', 'wamid.STOP1'));
    expect(res.status).toBe(200);
    expect(setOptedOut).toHaveBeenCalledWith('15551230000');
    expect(sendText).toHaveBeenCalledWith('15551230000', OPT_OUT_REPLY, undefined);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('inbound "START" → clearOptedOut, confirmation sent, agent NOT run', async () => {
    const res = await post(textBody('start', 'wamid.START1'));
    expect(res.status).toBe(200);
    expect(clearOptedOut).toHaveBeenCalledWith('15551230000');
    expect(sendText).toHaveBeenCalledWith('15551230000', OPT_IN_REPLY, undefined);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a normal "hi" still runs the agent (regression — STOP detection is exact-only)', async () => {
    const res = await post(textBody('hi', 'wamid.HI1'));
    expect(res.status).toBe(200);
    expect(setOptedOut).not.toHaveBeenCalled();
    expect(clearOptedOut).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalled();
  });

  it('"stop the transfer" does NOT opt out (runs the agent)', async () => {
    const res = await post(textBody('stop the transfer', 'wamid.STOPX'));
    expect(res.status).toBe(200);
    expect(setOptedOut).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalled();
  });
});

describe('POST /api/whatsapp — opt-out STATE suppression (Fix 1)', () => {
  it('an already-opted-out customer sending a normal message → reminder sent, agent NOT run', async () => {
    // Customer record carries optedOutAt → the send flow must be suppressed.
    getCustomer.mockResolvedValue({
      senderPhone: '15551230000',
      optInAt: '2026-01-01T00:00:00Z',
      optedOutAt: '2026-05-01T00:00:00Z',
    });
    const res = await post(textBody('send $20', 'wamid.OPTEDOUT1'));
    expect(res.status).toBe(200);
    expect(sendText).toHaveBeenCalledWith('15551230000', OPT_OUT_REMINDER, undefined);
    expect(enqueue).not.toHaveBeenCalled();
    // Not a fresh STOP — no setOptedOut, no fresh OPT_OUT_REPLY confirmation.
    expect(setOptedOut).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalledWith('15551230000', OPT_OUT_REPLY);
  });

  it('an opted-out customer can still resume with START (clears opt-out, agent NOT run)', async () => {
    getCustomer.mockResolvedValue({
      senderPhone: '15551230000',
      optInAt: '2026-01-01T00:00:00Z',
      optedOutAt: '2026-05-01T00:00:00Z',
    });
    const res = await post(textBody('START', 'wamid.RESUME1'));
    expect(res.status).toBe(200);
    expect(clearOptedOut).toHaveBeenCalledWith('15551230000');
    expect(sendText).toHaveBeenCalledWith('15551230000', OPT_IN_REPLY, undefined);
    expect(enqueue).not.toHaveBeenCalled();
    // The state-skip reminder must NOT fire for a resume keyword.
    expect(sendText).not.toHaveBeenCalledWith('15551230000', OPT_OUT_REMINDER);
  });

  it('an opted-IN customer sending a normal message → agent IS run, NO reminder', async () => {
    getCustomer.mockResolvedValue({
      senderPhone: '15551230000',
      optInAt: '2026-01-01T00:00:00Z',
      // no optedOutAt
    });
    const res = await post(textBody('send $20', 'wamid.OPTEDIN1'));
    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalledWith('15551230000', OPT_OUT_REMINDER);
  });
});

describe('POST /api/whatsapp — optInAt backfill on normal inbound (Fix 5)', () => {
  it('an opted-IN customer whose record lacks optInAt → setOptedIn is called (backfill)', async () => {
    upsertOnFirstInbound.mockResolvedValue({
      customer: { firstSeenAt: '2026-01-01T00:00:00Z' }, // NO optInAt
      wasCreated: false,
    });
    getCustomer.mockResolvedValue({
      senderPhone: '15551230000',
      // no optInAt, no optedOutAt
    });
    const res = await post(textBody('hi', 'wamid.BACKFILL1'));
    expect(res.status).toBe(200);
    expect(setOptedIn).toHaveBeenCalledWith('15551230000');
    expect(enqueue).toHaveBeenCalled();
  });

  it('a customer that already has optInAt → setOptedIn NOT called (no churn), agent runs', async () => {
    upsertOnFirstInbound.mockResolvedValue({
      customer: { firstSeenAt: '2026-01-01T00:00:00Z', optInAt: '2026-02-01T00:00:00Z' },
      wasCreated: false,
    });
    const res = await post(textBody('hi', 'wamid.NOCHURN1'));
    expect(res.status).toBe(200);
    expect(setOptedIn).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalled();
  });
});
