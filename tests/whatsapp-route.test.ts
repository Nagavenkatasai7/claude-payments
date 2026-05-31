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
// run to completion once it's past the gate, without real Redis / agent calls.
// vi.hoisted: these mock fns are referenced inside the hoisted vi.mock factories.
const { sendText, setOptedOut, clearOptedOut, setOptedIn, runAgentTurn } = vi.hoisted(() => ({
  sendText: vi.fn(async () => {}),
  setOptedOut: vi.fn(async (_phone: string) => {}),
  clearOptedOut: vi.fn(async (_phone: string) => {}),
  setOptedIn: vi.fn(async (_phone: string) => {}),
  runAgentTurn: vi.fn(async () => ''),
}));
vi.mock('@/lib/whatsapp', async (orig) => {
  const real = await orig<typeof import('@/lib/whatsapp')>();
  return { ...real, sendText };
});
vi.mock('@/lib/customer-store', () => ({
  getCustomerStore: () => ({
    upsertOnFirstInbound: async () => ({
      customer: { firstSeenAt: new Date().toISOString(), optInAt: new Date().toISOString() },
      wasCreated: true,
    }),
    setOptedOut,
    clearOptedOut,
    setOptedIn,
  }),
}));
vi.mock('@/lib/daily-volume-store', () => ({ getDailyVolumeStore: () => ({}) }));
vi.mock('@/lib/monthly-volume-store', () => ({ getMonthlyVolumeStore: () => ({}) }));
vi.mock('@/lib/schedule-store', () => ({ getScheduleStore: () => ({}) }));
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({}) }));
vi.mock('@/lib/partner-store', () => ({ getPartnerStore: () => ({}) }));
vi.mock('@/lib/tier-rules', () => ({ deriveTier: () => 'T1' }));
vi.mock('@/lib/providers/mock-kyc-provider', () => ({ MockKycProvider: class {} }));
vi.mock('@/lib/agent', () => ({
  createAgent: () => ({ runAgentTurn }),
}));
vi.mock('@/lib/ollama', () => ({ chat: async () => '' }));

import { GET, POST } from '@/app/api/whatsapp/route';
import { OPT_OUT_REPLY, OPT_IN_REPLY } from '@/lib/consent';

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
  runAgentTurn.mockClear();
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
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toContain('131056');
    expect(warn.mock.calls.flat().join(' ')).toContain('FAILED');
  });

  it('a delivered status → 200, agent NOT run', async () => {
    const res = await post(statusBody('delivered'));
    expect(res.status).toBe(200);
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
});

describe('POST /api/whatsapp — STOP / START consent short-circuit (Item 4)', () => {
  it('inbound "STOP" → setOptedOut, confirmation sent, agent NOT run', async () => {
    const res = await post(textBody('STOP', 'wamid.STOP1'));
    expect(res.status).toBe(200);
    expect(setOptedOut).toHaveBeenCalledWith('15551230000');
    expect(sendText).toHaveBeenCalledWith('15551230000', OPT_OUT_REPLY);
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it('inbound "START" → clearOptedOut, confirmation sent, agent NOT run', async () => {
    const res = await post(textBody('start', 'wamid.START1'));
    expect(res.status).toBe(200);
    expect(clearOptedOut).toHaveBeenCalledWith('15551230000');
    expect(sendText).toHaveBeenCalledWith('15551230000', OPT_IN_REPLY);
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it('a normal "hi" still runs the agent (regression — STOP detection is exact-only)', async () => {
    const res = await post(textBody('hi', 'wamid.HI1'));
    expect(res.status).toBe(200);
    expect(setOptedOut).not.toHaveBeenCalled();
    expect(clearOptedOut).not.toHaveBeenCalled();
    expect(runAgentTurn).toHaveBeenCalled();
  });

  it('"stop the transfer" does NOT opt out (runs the agent)', async () => {
    const res = await post(textBody('stop the transfer', 'wamid.STOPX'));
    expect(res.status).toBe(200);
    expect(setOptedOut).not.toHaveBeenCalled();
    expect(runAgentTurn).toHaveBeenCalled();
  });
});
