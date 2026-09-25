import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';

// after() runs the agent callback inline (we don't assert on it here, but keep
// it from being a no-op scheduled task that leaks across tests).
vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: (cb: () => Promise<void> | void) => { void cb(); } };
});

// R1: the msgq: fast-skip read is the first side-effect after the signature
// gate; asserting on it tells us whether a request got PAST the gate or was
// rejected before it. The legacy markMessageSeen (msg: SET NX) must never be
// called by the new pipeline — redelivery is deduped by the outbox's unique
// `wamid:{id}` key (ON CONFLICT), not by Redis.
const markMessageSeen = vi.fn(async (_id: string) => true);
const isMessageQueued = vi.fn(async (_id: string) => false);
const markMessageQueued = vi.fn(async (_id: string) => {});
const getLastInboundAt = vi.fn(async (_tenant: string, _from: string) => null);
const recordInboundNow = vi.fn(async (_tenant: string, _from: string) => {});
vi.mock('@/lib/store', () => ({
  getStore: () => ({ markMessageSeen, isMessageQueued, markMessageQueued, getLastInboundAt, recordInboundNow }),
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
  ensureCustomer,
  getPartner,
  enqueue,
  partnerForPhoneNumberId,
  getIntegrations,
} = vi.hoisted(() => ({
  sendText: vi.fn(async () => {}),
  setOptedOut: vi.fn(async (_tenant: string, _phone: string, _at?: Date) => {}),
  clearOptedOut: vi.fn(async (_tenant: string, _phone: string) => {}),
  setOptedIn: vi.fn(async (_tenant: string, _phone: string) => {}),
  // Default: an opted-IN customer (optInAt set, no optedOutAt). Tests override.
  // Typed loosely so per-test overrides can add optedOutAt / drop optInAt.
  getCustomer: vi.fn(
    async (_tenant: string, _phone: string): Promise<Record<string, unknown> | null> => ({
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
  // Program-Fix 49A: STOP from a phone with no row creates it WITHOUT opt-in.
  ensureCustomer: vi.fn(async (_tenant: string, _phone: string) => ({ senderPhone: '15551230000' })),
  // Program-Fix 49A: the opted-out reminder names the tenant's brand.
  getPartner: vi.fn(async (_id: string): Promise<Record<string, unknown> | null> => null),
  enqueue: vi.fn(async (_kind: string, _payload: Record<string, unknown>, _opts?: { dedupeKey?: string }) => true),
  // Fix 1 D11 routing doubles. Default: UNROUTED (null) ⇒ every pre-existing test is untouched.
  partnerForPhoneNumberId: vi.fn(async (_pnid: string): Promise<string | null> => null),
  getIntegrations: vi.fn(async (_partnerId: string) => ({
    kyc: {},
    payment: {},
    whatsapp: {} as { phoneNumberId?: string; token?: string; appSecret?: string },
  })),
}));
vi.mock('@/lib/partner-integrations-store', () => ({
  partnerForPhoneNumberId,
  getPartnerIntegrationsStore: () => ({ getIntegrations }),
}));
vi.mock('@/lib/whatsapp', async (orig) => {
  const real = await orig<typeof import('@/lib/whatsapp')>();
  return { ...real, sendText };
});
vi.mock('@/lib/customer-store', () => ({
  getCustomerStore: () => ({
    upsertOnFirstInbound,
    ensureCustomer,
    getCustomer,
    setOptedOut,
    clearOptedOut,
    setOptedIn,
  }),
}));
vi.mock('@/lib/partner-store', () => ({ getPartnerStore: () => ({ getPartner }) }));
vi.mock('@/lib/tier-rules', () => ({ deriveTier: () => 'T1' }));
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));
// Program-Fix 26: failed delivery statuses write one audit_events row.
const auditRecord = vi.hoisted(() => vi.fn(async (_e: Record<string, unknown>) => {}));
vi.mock('@/db/repos/aux-repos', async (orig) => {
  const real = await orig<typeof import('@/db/repos/aux-repos')>();
  return { ...real, createAuditRepo: () => ({ record: auditRecord }) };
});
vi.mock('@/db/repos/outbox-repo', () => ({ createOutboxRepo: () => ({ enqueue }) }));
vi.mock('@/lib/outbox', () => ({ pokeWorker: vi.fn() }));
// Program-Fix 34A: the inbound throttle reads getRedis(). A fresh in-memory
// fake per test (never the real Upstash client, which would retry against the
// dud test URL).
const throttleRedis = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/redis', () => ({ getRedis: () => throttleRedis.current }));

import { GET, POST } from '@/app/api/whatsapp/route';
import { OPT_OUT_REPLY, OPT_IN_REPLY, OPT_OUT_REMINDER, MEDIA_REPLY } from '@/lib/consent';
import { SLOW_DOWN_REPLY } from '@/lib/inbound-throttle';
import { fakeRedis } from './helpers';
import { waMessageRef } from '@/lib/wa-message-ref';

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
  throttleRedis.current = fakeRedis();
  markMessageSeen.mockClear().mockResolvedValue(true);
  isMessageQueued.mockClear().mockResolvedValue(false);
  markMessageQueued.mockClear().mockResolvedValue(undefined);
  getLastInboundAt.mockClear();
  recordInboundNow.mockClear();
  sendText.mockClear();
  setOptedOut.mockClear();
  clearOptedOut.mockClear();
  setOptedIn.mockClear();
  enqueue.mockReset().mockResolvedValue(true);
  ensureCustomer.mockClear();
  getPartner.mockClear().mockResolvedValue(null);
  auditRecord.mockReset().mockResolvedValue(undefined);
  partnerForPhoneNumberId.mockClear().mockResolvedValue(null);
  getIntegrations.mockClear().mockResolvedValue({ kyc: {}, payment: {}, whatsapp: {} });
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

function textBody(text: string, id = 'wamid.TXT', from = '15551230000', opts: { phoneNumberId?: string } = {}) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      ...(opts.phoneNumberId ? { metadata: { phone_number_id: opts.phoneNumberId } } : {}),
      messages: [{ from, id, type: 'text', text: { body: text } }],
    } }] }],
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
  // R1: no Graph call remains inside the webhook request, and the legacy
  // msg: SET NX is never used as the gate.
  expect(sendText).not.toHaveBeenCalled();
  expect(markMessageSeen).not.toHaveBeenCalled();
  delete process.env.META_APP_SECRET;
  vi.restoreAllMocks();
});

/** R1: the whatsapp.text reply rows the webhook enqueued (to, body, payload). */
const replyRows = () =>
  (enqueue.mock.calls as unknown as [string, Record<string, unknown>, { dedupeKey?: string }][])
    .filter((c) => c[0] === 'whatsapp.text');
const repliesWith = (body: string) => replyRows().filter((c) => c[1].body === body);
/** Exactly the essential reply row for `wamid`, sent to `to`, optionally from a routed partner. */
function expectReply(to: string, body: string, wamid: string, partnerId?: string) {
  expect(enqueue).toHaveBeenCalledWith(
    'whatsapp.text',
    { to, body, category: 'essential', ...(partnerId ? { partnerId } : {}) },
    { dedupeKey: `wamid:${wamid}` },
  );
}

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
  it('secret set + valid signature → request is processed (200, reaches the msgq: fast-skip read, then the durable row, then the mark)', async () => {
    process.env.META_APP_SECRET = SECRET;
    const res = await post(inboundBody, sign(inboundBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(isMessageQueued).toHaveBeenCalledWith('wamid.TEST1');
    expect(markMessageQueued).toHaveBeenCalledWith('wamid.TEST1');
    // R1: the mark is written only AFTER the outbox insert returned.
    expect(enqueue.mock.invocationCallOrder[0]).toBeLessThan(markMessageQueued.mock.invocationCallOrder[0]);
  });

  it('secret set + tampered signature → 401 and NO processing', async () => {
    process.env.META_APP_SECRET = SECRET;
    const res = await post(inboundBody, sign(inboundBody) + '00');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false });
    expect(isMessageQueued).not.toHaveBeenCalled();
  });

  it('secret set + missing signature header → 401 and NO processing', async () => {
    process.env.META_APP_SECRET = SECRET;
    const res = await post(inboundBody); // no x-hub-signature-256 header
    expect(res.status).toBe(401);
    expect(isMessageQueued).not.toHaveBeenCalled();
  });

  it('secret UNSET → request proceeds (back-compat) and warns', async () => {
    delete process.env.META_APP_SECRET;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await post(inboundBody); // no/garbage signature is irrelevant when unset
    expect(res.status).toBe(200);
    expect(isMessageQueued).toHaveBeenCalledWith('wamid.TEST1');
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
    expect(isMessageQueued).not.toHaveBeenCalled(); // status path never reaches dedup
    expect(enqueue).not.toHaveBeenCalled();
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('131056');
    expect(logged).toContain('delivery_failed');
    // Stage 3: the structured warn line must NOT carry the full phone.
    expect(logged).not.toContain('15551230000');
  });

  it('a failed status → ONE audit row {code,title} under the default tenant, with no phone digit run of 7+ (Program-Fix 26)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await post(statusBody('failed', { code: 131047, title: 'Re-engagement message' }));
    expect(res.status).toBe(200);
    expect(auditRecord).toHaveBeenCalledTimes(1);
    const row = auditRecord.mock.calls[0][0];
    expect(row).toEqual({
      partnerId: 'default',
      actor: 'whatsapp',
      actorType: 'system',
      action: 'whatsapp.delivery_failed',
      subjectId: waMessageRef('wamid.STATUS1'),
      meta: { code: 131047, title: 'Re-engagement message' },
    });
    expect(JSON.stringify(row)).not.toMatch(/\d{7,}/);
  });

  it('a Meta-style message id is NEVER stored or logged raw: audit subjectId and log fields carry only the keyed ref', async () => {
    const id = 'wamid.HBgLMTU1NTk4NzEyMzQVAgARGBI5QzZBOEQ3RjA0QjE2NjJCMzcA';
    const token = id.slice('wamid.'.length);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const body = (status: string) => JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { statuses: [{
        id, recipient_id: '15559871234', status,
        ...(status === 'failed' ? { errors: [{ code: 131026, title: 'Message undeliverable' }] } : {}),
      }] } }] }],
    });
    expect((await post(body('failed'))).status).toBe(200);
    expect((await post(body('delivered'))).status).toBe(200);
    const row = auditRecord.mock.calls[0][0];
    expect(row.subjectId).toBe(waMessageRef(id));
    const logged = [...warn.mock.calls, ...debug.mock.calls].flat().map(String).join(' ');
    expect(logged).toContain(waMessageRef(id).slice(0, 16));
    for (const out of [JSON.stringify(row), logged]) {
      expect(out).not.toContain(id);
      expect(out).not.toContain(token.slice(0, 12));
      expect(out).not.toMatch(/\d{7,}/);
    }
  });

  it('the audit insert throws → still 200 {ok:true} (Meta never sees a non-200)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    auditRecord.mockRejectedValue(new Error('db down'));
    const res = await post(statusBody('failed', { code: 131056, title: 'Too many messages' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('a non-failed status writes no audit row', async () => {
    await post(statusBody('read'));
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('a delivered status → 200, agent NOT run', async () => {
    const res = await post(statusBody('delivered'));
    expect(res.status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('POST /api/whatsapp — STOP / START consent short-circuit (Item 4)', () => {
  it('inbound "STOP" → setOptedOut, ONE essential confirmation row, agent NOT run', async () => {
    const res = await post(textBody('STOP', 'wamid.STOP1'));
    expect(res.status).toBe(200);
    expect(setOptedOut).toHaveBeenCalledWith('default', '15551230000', expect.any(Date));
    expectReply('15551230000', OPT_OUT_REPLY, 'wamid.STOP1');
    expect(enqueue).toHaveBeenCalledTimes(1);
    // The opt-out lands BEFORE the confirmation row exists.
    expect(setOptedOut.mock.invocationCallOrder[0]).toBeLessThan(enqueue.mock.invocationCallOrder[0]);
  });

  it('inbound "START" → clearOptedOut, ONE essential confirmation row, agent NOT run', async () => {
    const res = await post(textBody('start', 'wamid.START1'));
    expect(res.status).toBe(200);
    expect(clearOptedOut).toHaveBeenCalledWith('default', '15551230000');
    expectReply('15551230000', OPT_IN_REPLY, 'wamid.START1');
    expect(enqueue).toHaveBeenCalledTimes(1);
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
    expectReply('15551230000', OPT_OUT_REMINDER, 'wamid.OPTEDOUT1');
    expect(enqueue).toHaveBeenCalledTimes(1); // the reminder only — no agent.turn
    // Not a fresh STOP — no setOptedOut, no fresh OPT_OUT_REPLY confirmation.
    expect(setOptedOut).not.toHaveBeenCalled();
    expect(repliesWith(OPT_OUT_REPLY)).toHaveLength(0);
  });

  it('an opted-out customer can still resume with START (clears opt-out, agent NOT run)', async () => {
    getCustomer.mockResolvedValue({
      senderPhone: '15551230000',
      optInAt: '2026-01-01T00:00:00Z',
      optedOutAt: '2026-05-01T00:00:00Z',
    });
    const res = await post(textBody('START', 'wamid.RESUME1'));
    expect(res.status).toBe(200);
    expect(clearOptedOut).toHaveBeenCalledWith('default', '15551230000');
    expectReply('15551230000', OPT_IN_REPLY, 'wamid.RESUME1');
    expect(enqueue).toHaveBeenCalledTimes(1);
    // The state-skip reminder must NOT fire for a resume keyword.
    expect(repliesWith(OPT_OUT_REMINDER)).toHaveLength(0);
  });

  it('an opted-IN customer sending a normal message → agent IS run, NO reminder', async () => {
    getCustomer.mockResolvedValue({
      senderPhone: '15551230000',
      optInAt: '2026-01-01T00:00:00Z',
      // no optedOutAt
    });
    const res = await post(textBody('send $20', 'wamid.OPTEDIN1'));
    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith('agent.turn', expect.anything(), { dedupeKey: 'wamid:wamid.OPTEDIN1' });
    expect(repliesWith(OPT_OUT_REMINDER)).toHaveLength(0);
  });
});

describe('POST /api/whatsapp — optInAt backfill on normal inbound (Fix 5)', () => {
  it('the shared number is the DEFAULT tenant: every customer read/write is keyed (default, phone) and the turn carries routedPartnerId null', async () => {
    const res = await post(textBody('hi', 'wamid.TENANT1'));
    expect(res.status).toBe(200);
    expect(getCustomer).toHaveBeenCalledWith('default', '15551230000');
    expect(upsertOnFirstInbound).toHaveBeenCalledWith('default', '15551230000');
    expect(getLastInboundAt).toHaveBeenCalledWith('default', '15551230000');
    expect(recordInboundNow).toHaveBeenCalledWith('default', '15551230000');
    expect(enqueue).toHaveBeenCalledWith(
      'agent.turn',
      expect.objectContaining({ phone: '15551230000', routedPartnerId: null }),
      expect.objectContaining({ dedupeKey: 'wamid:wamid.TENANT1' }),
    );
  });

  it('STOP / START consent writes are tenant-scoped too', async () => {
    await post(textBody('STOP', 'wamid.STOPT'));
    expect(setOptedOut).toHaveBeenCalledWith('default', '15551230000', expect.any(Date));
    await post(textBody('START', 'wamid.STARTT'));
    expect(clearOptedOut).toHaveBeenCalledWith('default', '15551230000');
  });

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
    expect(setOptedIn).toHaveBeenCalledWith('default', '15551230000');
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

describe('shared webhook: a ROUTED event is verified with THAT partner\'s secret only (fix 1, D11 — variant A, fail closed)', () => {
  const ACME_WITH_SECRET = { kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn_acme', token: 't', appSecret: 'acme_secret' } };
  const ACME_NO_SECRET = { kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn_acme', token: 't' } };
  beforeEach(() => { process.env.META_APP_SECRET = SECRET; }); // the file's afterEach deletes it again

  it('routed + partner has an appSecret ⇒ the partner secret verifies (200, turn enqueued under acme); the PLATFORM secret is refused (401)', async () => {
    partnerForPhoneNumberId.mockResolvedValue('acme');
    getIntegrations.mockResolvedValue(ACME_WITH_SECRET);
    const body = textBody('hi', 'wamid.R1', '15551230000', { phoneNumberId: 'pn_acme' });
    expect((await post(body, sign(body, SECRET))).status).toBe(401); // platform-signed ⇒ never the partner's event
    expect(isMessageQueued).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    const res = await post(body, sign(body, 'acme_secret'));
    expect(res.status).toBe(200);
    expect(isMessageQueued).toHaveBeenCalledWith('wamid.R1');
    expect(enqueue).toHaveBeenCalledWith(
      'agent.turn',
      expect.objectContaining({ phone: '15551230000', routedPartnerId: 'acme' }),
      expect.objectContaining({ dedupeKey: 'wamid:wamid.R1' }),
    );
  });

  it('a ROUTED failed status is audited under THAT partner, not the default tenant (Program-Fix 26)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    partnerForPhoneNumberId.mockResolvedValue('acme');
    getIntegrations.mockResolvedValue(ACME_WITH_SECRET);
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: 'pn_acme' },
        statuses: [{ id: 'wamid.RS1', recipient_id: '15551230000', status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] }],
      } }] }],
    });
    const res = await post(body, sign(body, 'acme_secret'));
    expect(res.status).toBe(200);
    expect(auditRecord).toHaveBeenCalledTimes(1);
    expect(auditRecord.mock.calls[0][0]).toMatchObject({ partnerId: 'acme', subjectId: waMessageRef('wamid.RS1'), meta: { code: 131026, title: 'Message undeliverable' } });
  });

  it('routed + partner has NO appSecret ⇒ 401 fail closed even when signed with the platform secret — no fallback for a routed event', async () => {
    partnerForPhoneNumberId.mockResolvedValue('acme');
    getIntegrations.mockResolvedValue(ACME_NO_SECRET);
    const body = textBody('hi', 'wamid.R2', '15551230000', { phoneNumberId: 'pn_acme' });
    expect((await post(body, sign(body, SECRET))).status).toBe(401);
    expect((await post(body, sign(body, 'acme_secret'))).status).toBe(401);
    expect(isMessageQueued).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('unrouted (the shared number) keeps the platform secret', async () => {
    const body = textBody('hi', 'wamid.R3'); // no metadata ⇒ partnerForPhoneNumberId is never consulted
    expect((await post(body, sign(body, 'acme_secret'))).status).toBe(401);
    const res = await post(body, sign(body, SECRET));
    expect(res.status).toBe(200);
    expect(partnerForPhoneNumberId).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith('agent.turn', expect.objectContaining({ routedPartnerId: null }), expect.anything());
  });
});

describe('POST /api/whatsapp — per-sender inbound throttle (Program-Fix 34A: 20/min, 300/day)', () => {
  // Pin the clock to the START of a minute (and of a UTC day) so the burst never straddles a window.
  const T0 = Date.UTC(2026, 8, 22, 0, 0, 0);
  const agentTurns = () => (enqueue.mock.calls as unknown[][]).filter((c) => c[0] === 'agent.turn');
  const slowNotes = () => repliesWith(SLOW_DOWN_REPLY).map((c) => [c[1].to, c[1].body]);

  it('the 21st text in a minute enqueues NO agent.turn and sends ONE slow-down note; the 22nd sends none', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(T0);
    for (let i = 1; i <= 20; i++) await post(textBody(`m${i}`, `wamid.T${i}`));
    expect(agentTurns()).toHaveLength(20);
    await post(textBody('m21', 'wamid.T21'));
    expect(agentTurns()).toHaveLength(20);
    expect(slowNotes()).toHaveLength(1);
    expect(slowNotes()[0][0]).toBe('15551230000');
    await post(textBody('m22', 'wamid.T22'));
    expect(agentTurns()).toHaveLength(20);
    expect(slowNotes()).toHaveLength(1);
  });

  it('another phone is unaffected', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(T0);
    for (let i = 1; i <= 22; i++) await post(textBody(`m${i}`, `wamid.A${i}`));
    await post(textBody('hello', 'wamid.B1', '15559990000'));
    const last = agentTurns().at(-1)!;
    expect((last[1] as { phone: string }).phone).toBe('15559990000');
    expect(agentTurns()).toHaveLength(21);
  });

  it('a throwing Redis enqueues normally (fail open)', async () => {
    throttleRedis.current = { ...fakeRedis(), incr: async () => { throw new Error('upstash down'); } };
    await post(textBody('hi', 'wamid.F1'));
    expect(agentTurns()).toHaveLength(1);
  });

  it('STOP still works when the sender is over the limit (consent runs first)', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(T0);
    for (let i = 1; i <= 21; i++) await post(textBody(`m${i}`, `wamid.S${i}`));
    await post(textBody('STOP', 'wamid.STOPX'));
    expect(setOptedOut).toHaveBeenCalledWith('default', '15551230000', expect.any(Date));
    expectReply('15551230000', OPT_OUT_REPLY, 'wamid.STOPX');
  });
});

// ── Program-Fix 49A: opt-out holes (whatsapp-10) + media (whatsapp-08) ────────
function buttonBody(buttonId: string, id: string, from = '15551230000') {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages: [
      { from, id, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: buttonId, title: 'Approve' } } },
    ] } }] }],
  });
}
function quickReplyBody(payload: string, text: string, id: string, from = '15551230000') {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages: [{ from, id, type: 'button', button: { payload, text } }] } }] }],
  });
}
function mediaBody(type: string, id: string, from = '15551230000', opts: { phoneNumberId?: string } = {}) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      ...(opts.phoneNumberId ? { metadata: { phone_number_id: opts.phoneNumberId } } : {}),
      messages: [{ from, id, type, [type]: { id: 'media-1', mime_type: 'image/jpeg' } }],
    } }] }],
  });
}
const OPTED_OUT = { senderPhone: '15551230000', optInAt: '2026-01-01T00:00:00Z', optedOutAt: '2026-05-01T00:00:00Z' };
const reminders = () => repliesWith(OPT_OUT_REMINDER);
const agentTurnRows = () => (enqueue.mock.calls as unknown[][]).filter((c) => c[0] === 'agent.turn');

describe('POST /api/whatsapp — opt-out applies to EVERY inbound kind (Program-Fix 49A)', () => {
  it('opted-out button tap → reminder, no agent.turn row', async () => {
    getCustomer.mockResolvedValue(OPTED_OUT);
    const res = await post(buttonBody('approve:draft_1', 'wamid.BTN1'));
    expect(res.status).toBe(200);
    expect(reminders()).toHaveLength(1);
    expect(agentTurnRows()).toHaveLength(0);
  });

  it('opted-out image → the reminder (not the media reply), no agent.turn row', async () => {
    getCustomer.mockResolvedValue(OPTED_OUT);
    await post(mediaBody('image', 'wamid.IMGOUT'));
    expect(reminders()).toHaveLength(1);
    expect(repliesWith(MEDIA_REPLY)).toHaveLength(0);
    expect(agentTurnRows()).toHaveLength(0);
  });

  it('3 taps in an hour → 1 reminder; the next hour gets one more', async () => {
    const T0 = Date.UTC(2026, 8, 22, 10, 0, 0);
    const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
    getCustomer.mockResolvedValue(OPTED_OUT);
    await post(buttonBody('approve:d', 'wamid.TAP1'));
    await post(buttonBody('approve:d', 'wamid.TAP2'));
    await post(textBody('hello?', 'wamid.TAP3'));
    expect(reminders()).toHaveLength(1);
    expect(agentTurnRows()).toHaveLength(0);
    now.mockReturnValue(T0 + 60 * 60 * 1000);
    await post(buttonBody('approve:d', 'wamid.TAP4'));
    expect(reminders()).toHaveLength(2);
  });

  it('a throwing Redis still sends the reminder (fail open to "send")', async () => {
    throttleRedis.current = { ...fakeRedis(), incr: async () => { throw new Error('upstash down'); } };
    getCustomer.mockResolvedValue(OPTED_OUT);
    await post(buttonBody('approve:d', 'wamid.TAPF'));
    expect(reminders()).toHaveLength(1);
    expect(agentTurnRows()).toHaveLength(0);
  });

  it('the reminder names the routed tenant\'s brand', async () => {
    process.env.META_APP_SECRET = SECRET;
    partnerForPhoneNumberId.mockResolvedValue('acme');
    getIntegrations.mockResolvedValue({ kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn_acme', token: 't', appSecret: 'acme_secret' } });
    getPartner.mockResolvedValue({ id: 'acme', displayName: 'Acme Remit' });
    getCustomer.mockResolvedValue(OPTED_OUT);
    const body = textBody('hi', 'wamid.BRAND1', '15551230000', { phoneNumberId: 'pn_acme' });
    await post(body, sign(body, 'acme_secret'));
    expect(getPartner).toHaveBeenCalledWith('acme');
    // The row names the routed tenant; the worker resolves ITS creds at drain
    // time, so the reminder leaves from acme's own number.
    expectReply('15551230000', "You're unsubscribed from Acme Remit. Reply START to resume.", 'wamid.BRAND1', 'acme');
  });

  it('STOP from unknown phone → row created without opt-in, then optedOutAt set', async () => {
    getCustomer.mockResolvedValue(null);
    await post(textBody('STOP', 'wamid.STOPNEW', '15557770000'));
    expect(ensureCustomer).toHaveBeenCalledWith('default', '15557770000');
    expect(setOptedOut).toHaveBeenCalledWith('default', '15557770000', expect.any(Date));
    expect(ensureCustomer.mock.invocationCallOrder[0]).toBeLessThan(setOptedOut.mock.invocationCallOrder[0]);
    expect(upsertOnFirstInbound).not.toHaveBeenCalled(); // never stamps opt-in on a STOP
    expectReply('15557770000', OPT_OUT_REPLY, 'wamid.STOPNEW');
    expect(agentTurnRows()).toHaveLength(0);
  });

  it('a template quick-reply "Unsubscribe" opts out', async () => {
    await post(quickReplyBody('Unsubscribe', 'Unsubscribe', 'wamid.QR1'));
    expect(setOptedOut).toHaveBeenCalledWith('default', '15551230000', expect.any(Date));
    expectReply('15551230000', OPT_OUT_REPLY, 'wamid.QR1');
    expect(agentTurnRows()).toHaveLength(0);
  });

  it('a template quick-reply whose payload is STOP opts out even with a different label', async () => {
    await post(quickReplyBody('STOP', 'Stop promotions', 'wamid.QR2'));
    expect(setOptedOut).toHaveBeenCalledWith('default', '15551230000', expect.any(Date));
  });
});

describe('POST /api/whatsapp — media gets an honest reply (Program-Fix 49A, whatsapp-08)', () => {
  it('image → one reply row, no turn, deduped by wamid', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await post(mediaBody('image', 'wamid.IMG1'));
    expect(replyRows()).toHaveLength(1);
    expectReply('15551230000', MEDIA_REPLY, 'wamid.IMG1');
    expect(agentTurnRows()).toHaveLength(0);
    expect(warn.mock.calls.flat().join(' ')).toContain('whatsapp.unsupported_type');
    // Meta redelivers the same wamid → the msgq: mark says "queued" → nothing more.
    isMessageQueued.mockResolvedValue(true);
    await post(mediaBody('image', 'wamid.IMG1'));
    expect(replyRows()).toHaveLength(1);
  });

  it('a redelivery that misses the fast skip re-attempts the SAME wamid key (the unique index makes it a no-op) — 200', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await post(mediaBody('image', 'wamid.IMG2'));
    enqueue.mockResolvedValue(false); // ON CONFLICT DO NOTHING
    const res = await post(mediaBody('image', 'wamid.IMG2'));
    expect(res.status).toBe(200);
    expect(replyRows().map((c) => c[2].dedupeKey)).toEqual(['wamid:wamid.IMG2', 'wamid:wamid.IMG2']);
  });

  it.each(['audio', 'document', 'video', 'sticker', 'location', 'contacts'])('%s → the media reply, no turn', async (type) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await post(mediaBody(type, `wamid.M_${type}`));
    expectReply('15551230000', MEDIA_REPLY, `wamid.M_${type}`);
    expect(agentTurnRows()).toHaveLength(0);
  });

  it('the media reply leaves from the routed partner\'s own number', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.META_APP_SECRET = SECRET;
    partnerForPhoneNumberId.mockResolvedValue('acme');
    getIntegrations.mockResolvedValue({ kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn_acme', token: 't', appSecret: 'acme_secret' } });
    const body = mediaBody('image', 'wamid.IMGR', '15551230000', { phoneNumberId: 'pn_acme' });
    await post(body, sign(body, 'acme_secret'));
    expectReply('15551230000', MEDIA_REPLY, 'wamid.IMGR', 'acme');
  });

  it('a reaction gets no reply and no turn', async () => {
    await post(JSON.stringify({ entry: [{ changes: [{ value: { messages: [
      { from: '15551230000', id: 'wamid.REACT', type: 'reaction', reaction: { message_id: 'x', emoji: '👍' } },
    ] } }] }] }));
    expect(enqueue).not.toHaveBeenCalled();
    expect(agentTurnRows()).toHaveLength(0);
  });

  it('media over the inbound throttle gets no media reply (the throttle runs first)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 22, 0, 0, 0));
    for (let i = 1; i <= 20; i++) await post(textBody(`m${i}`, `wamid.MT${i}`));
    await post(mediaBody('image', 'wamid.MT21'));
    expect(repliesWith(MEDIA_REPLY)).toHaveLength(0);
  });
});


// ── R1: every message is durable; the 500 path is an infrastructure allowlist ──
describe('POST /api/whatsapp — failure handling (R1)', () => {
  const infra = () => Object.assign(new Error('timeout exceeded when trying to connect'), { name: 'Error' });

  it('an infrastructure error on the durable insert → 500 {ok:false}, logs whatsapp.inbound_failed (error name only), no mark', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    enqueue.mockRejectedValueOnce(infra());
    const res = await post(textBody('hi', 'wamid.INFRA1'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false });
    expect(markMessageQueued).not.toHaveBeenCalled();
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('whatsapp.inbound_failed');
    expect(logged).not.toContain('timeout exceeded'); // the name, never the message
    expect(logged).not.toContain('15551230000');
    // Meta's retry: exactly one agent.turn attempt with the same key, 200.
    const retry = await post(textBody('hi', 'wamid.INFRA1'));
    expect(retry.status).toBe(200);
    expect(agentTurnRows().map((c) => (c[2] as { dedupeKey: string }).dedupeKey)).toEqual(['wamid:wamid.INFRA1', 'wamid:wamid.INFRA1']);
    expect(markMessageQueued).toHaveBeenCalledWith('wamid.INFRA1');
  });

  it('an infrastructure error on a STOP confirmation → 500 (the retry confirms)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    enqueue.mockRejectedValueOnce(infra());
    expect((await post(textBody('STOP', 'wamid.STOPI'))).status).toBe(500);
    expect((await post(textBody('STOP', 'wamid.STOPI'))).status).toBe(200);
    expect(repliesWith(OPT_OUT_REPLY).map((c) => c[2].dedupeKey)).toEqual(['wamid:wamid.STOPI', 'wamid:wamid.STOPI']);
  });

  it('a NON-infrastructure failure (poison body) → 200, one whatsapp.inbound_dropped audit row (keyed ref + error name only)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    enqueue.mockRejectedValueOnce(Object.assign(new Error('unsupported Unicode escape sequence'), { code: '22P05' }));
    const res = await post(textBody('bad body', 'wamid.POISON'));
    expect(res.status).toBe(200);
    expect(auditRecord).toHaveBeenCalledWith({
      partnerId: 'default',
      actor: 'whatsapp',
      actorType: 'system',
      action: 'whatsapp.inbound_dropped',
      subjectId: waMessageRef('wamid.POISON'),
      meta: { reason: 'processing_error', error: 'Error' },
    });
    expect(markMessageQueued).not.toHaveBeenCalled();
  });

  it('a STOP whose opt-out write fails with a NON-infrastructure error → 200 + consent_failed audit + ops alert (R7: 500 only for infra)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setOptedOut.mockRejectedValueOnce(new TypeError('unexpected'));
    const res = await post(textBody('STOP', 'wamid.STOPNI'));
    expect(res.status).toBe(200);
    expect(replyRows()).toHaveLength(0);
    expect(auditRecord).toHaveBeenCalledWith({
      partnerId: 'default',
      actor: 'whatsapp',
      actorType: 'system',
      action: 'whatsapp.consent_failed',
      subjectId: waMessageRef('wamid.STOPNI'),
      meta: { kind: 'stop', error: 'TypeError' },
    });
    expect(enqueue).toHaveBeenCalledWith('ops.alert', expect.objectContaining({ message: expect.any(String) }), expect.objectContaining({ dedupeKey: expect.stringMatching(/^waconsentfail:default:\d+$/) }));
  });

  it('a STOP whose opt-out write fails with an INFRASTRUCTURE error → 500', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setOptedOut.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '08006' }));
    expect((await post(textBody('STOP', 'wamid.STOPIN'))).status).toBe(500);
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('webhook_error rows are deduped per (tenant, hour)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    partnerForPhoneNumberId.mockImplementation(async (pnid: string) => {
      if (pnid === 'pn_x') throw new TypeError('lookup bug');
      return null;
    });
    const body = (id: string) => JSON.stringify({ entry: [
      { changes: [{ value: { messages: [{ from: '15551230000', id, type: 'text', text: { body: 'hi' } }] } }] },
      { changes: [{ value: { metadata: { phone_number_id: 'pn_x' }, messages: [] } }] },
    ] });
    expect((await post(body('wamid.H1'))).status).toBe(200);
    expect((await post(body('wamid.H2'))).status).toBe(200);
    expect(auditRecord.mock.calls.filter((c) => (c[0].meta as { reason?: string })?.reason === 'webhook_error')).toHaveLength(1);
  });

  it('an error OUTSIDE per-message processing on the 200 path → one whatsapp.inbound_dropped row (reason webhook_error) under the routed tenant', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.META_APP_SECRET = SECRET;
    // entry[0] routes to acme; resolving the SECOND change's number blows up (a non-infra bug).
    partnerForPhoneNumberId.mockImplementation(async (pnid: string) => {
      if (pnid === 'pn_acme') return 'acme';
      throw new TypeError('lookup bug');
    });
    getIntegrations.mockResolvedValue({ kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn_acme', token: 't', appSecret: 'acme_secret' } });
    const body = JSON.stringify({ entry: [
      { changes: [{ value: { metadata: { phone_number_id: 'pn_acme' }, messages: [{ from: '15551230000', id: 'wamid.W1', type: 'text', text: { body: 'hi' } }] } }] },
      { changes: [{ value: { metadata: { phone_number_id: 'pn_other' }, messages: [{ from: '15551230000', id: 'wamid.W2', type: 'text', text: { body: 'hi' } }] } }] },
    ] });
    const res = await post(body, sign(body, 'acme_secret'));
    expect(res.status).toBe(200);
    expect(auditRecord).toHaveBeenCalledTimes(1);
    expect(auditRecord).toHaveBeenCalledWith({
      partnerId: 'acme',
      actor: 'whatsapp',
      actorType: 'system',
      action: 'whatsapp.inbound_dropped',
      meta: { reason: 'webhook_error', error: 'TypeError' },
    });
  });

  it('the webhook_error audit is best-effort: its own failure still answers 200', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    auditRecord.mockRejectedValue(new Error('db down'));
    partnerForPhoneNumberId.mockImplementation(async (pnid: string) => {
      if (pnid === 'pn_x') throw new TypeError('lookup bug');
      return null;
    });
    // Unrouted entry[0] (no metadata); the second change's number lookup fails.
    const body = JSON.stringify({ entry: [
      { changes: [{ value: { messages: [{ from: '15551230000', id: 'wamid.BE1', type: 'text', text: { body: 'hi' } }] } }] },
      { changes: [{ value: { metadata: { phone_number_id: 'pn_x' }, messages: [] } }] },
    ] });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ partnerId: 'default', meta: { reason: 'webhook_error', error: 'TypeError' } }));
  });

  it('two messages in one POST → both processed', async () => {
    const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [
      { from: '15551230000', id: 'wamid.B1', type: 'text', text: { body: 'one' } },
      { from: '15551230000', id: 'wamid.B2', type: 'text', text: { body: 'two' } },
    ] } }] }] });
    expect((await post(body)).status).toBe(200);
    expect(agentTurnRows().map((c) => (c[2] as { dedupeKey: string }).dedupeKey)).toEqual(['wamid:wamid.B1', 'wamid:wamid.B2']);
  });
});

describe('shared webhook: per-change tenant rule (R1, cross-tenant regression)', () => {
  const ACME = { kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn_acme', token: 't', appSecret: 'acme_secret' } };
  const twoNumbers = (first: string, second: string) => JSON.stringify({ entry: [
    { changes: [{ value: { metadata: { phone_number_id: first }, messages: [{ from: '15551230000', id: 'wamid.E1', type: 'text', text: { body: 'hi' } }] } }] },
    { changes: [{ value: { metadata: { phone_number_id: second },
      messages: [{ from: '15559990000', id: 'wamid.E2', type: 'text', text: { body: 'STOP' } }],
      statuses: [{ id: 'wamid.ES', recipient_id: '15559990000', status: 'failed', errors: [{ code: 1, title: 't' }] }] } }] },
  ] });
  beforeEach(() => {
    process.env.META_APP_SECRET = SECRET;
    partnerForPhoneNumberId.mockImplementation(async (pnid: string) => (pnid === 'pn_acme' ? 'acme' : pnid === 'pn_beta' ? 'beta' : null));
    getIntegrations.mockResolvedValue(ACME);
  });

  it('signed by A with a change for B\'s number → B\'s change is skipped: no B customer write, turn, reply or audit row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = twoNumbers('pn_acme', 'pn_beta');
    const res = await post(body, sign(body, 'acme_secret'));
    expect(res.status).toBe(200);
    expect(agentTurnRows()).toHaveLength(1);
    expect(agentTurnRows()[0][1]).toMatchObject({ phone: '15551230000', routedPartnerId: 'acme' });
    expect(replyRows()).toHaveLength(0);
    expect(setOptedOut).not.toHaveBeenCalled();
    expect(ensureCustomer).not.toHaveBeenCalled();
    for (const fn of [getCustomer, upsertOnFirstInbound]) {
      expect(fn.mock.calls.every((c) => c[0] === 'acme' && c[1] === '15551230000')).toBe(true);
    }
    expect(auditRecord).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toContain('whatsapp.pnid_mismatch');
  });

  it('the shared (unrouted) number never runs a change addressed to a partner\'s number', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = twoNumbers('pn_shared', 'pn_acme');
    const res = await post(body, sign(body, SECRET));
    expect(res.status).toBe(200);
    expect(agentTurnRows()).toHaveLength(1);
    expect(agentTurnRows()[0][1]).toMatchObject({ phone: '15551230000', routedPartnerId: null });
    expect(setOptedOut).not.toHaveBeenCalled();
  });
});
