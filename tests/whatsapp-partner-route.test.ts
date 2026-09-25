import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';

// R1: the per-partner webhook (/api/whatsapp/[partnerId]) — the per-change
// pnid rule (A2-13) and the infrastructure-only 500.

const { getPartner, getIntegrations, processInboundWebhook } = vi.hoisted(() => ({
  getPartner: vi.fn(async (_id: string): Promise<Record<string, unknown> | null> => ({ id: 'acme', status: 'active' })),
  getIntegrations: vi.fn(async (_id: string) => ({
    kyc: {},
    payment: {},
    whatsapp: { appSecret: 'acme_secret', phoneNumberId: 'pn_acme', token: 't' } as Record<string, string>,
  })),
  processInboundWebhook: vi.fn(async (_body: unknown, _ctx: { routedPartnerId: string | null; acceptPnid?: (p: string | null) => Promise<boolean> }) => ({ ok: true })),
}));
vi.mock('@/lib/partner-store', () => ({ getPartnerStore: () => ({ getPartner }) }));
vi.mock('@/lib/partner-integrations-store', () => ({ getPartnerIntegrationsStore: () => ({ getIntegrations }) }));
vi.mock('@/lib/whatsapp-inbound', () => ({ processInboundWebhook }));
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));
const redisHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redisHolder.current }));
const auditRecord = vi.hoisted(() => vi.fn(async (_e: Record<string, unknown>) => {}));
vi.mock('@/db/repos/aux-repos', () => ({ createAuditRepo: () => ({ record: auditRecord }) }));

import { POST } from '@/app/api/whatsapp/[partnerId]/route';
import { fakeRedis } from './helpers';

const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'pn_acme' }, messages: [] } }] }] });
const sign = (raw: string, secret = 'acme_secret') => 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
function post(raw = body, signature = sign(raw), partnerId = 'acme') {
  const req = new NextRequest(`http://localhost/api/whatsapp/${partnerId}`, {
    method: 'POST',
    body: raw,
    headers: { 'x-hub-signature-256': signature },
  });
  return POST(req, { params: Promise.resolve({ partnerId }) });
}
const lastCtx = () => processInboundWebhook.mock.calls.at(-1)![1];

beforeEach(() => {
  processInboundWebhook.mockReset().mockResolvedValue({ ok: true });
  auditRecord.mockReset().mockResolvedValue(undefined);
  redisHolder.current = fakeRedis();
  getIntegrations.mockResolvedValue({ kyc: {}, payment: {}, whatsapp: { appSecret: 'acme_secret', phoneNumberId: 'pn_acme', token: 't' } });
});
afterEach(() => vi.restoreAllMocks());

describe('POST /api/whatsapp/[partnerId] — per-change pnid rule (R1)', () => {
  it('a configured number ⇒ only changes for THAT pnid are accepted', async () => {
    expect((await post()).status).toBe(200);
    const { routedPartnerId, acceptPnid } = lastCtx();
    expect(routedPartnerId).toBe('acme');
    expect(await acceptPnid!('pn_acme')).toBe(true);
    expect(await acceptPnid!('pn_beta')).toBe(false);
    expect(await acceptPnid!(null)).toBe(false);
  });

  it('no configured number ⇒ no filter (legacy behaviour)', async () => {
    getIntegrations.mockResolvedValue({ kyc: {}, payment: {}, whatsapp: { appSecret: 'acme_secret' } });
    await post();
    expect(lastCtx().acceptPnid).toBeUndefined();
  });

  it('a bad signature never reaches the pipeline', async () => {
    expect((await post(body, sign(body, 'wrong'))).status).toBe(401);
    expect(processInboundWebhook).not.toHaveBeenCalled();
  });
});

describe('POST /api/whatsapp/[partnerId] — failure handling (R1)', () => {
  it('an infrastructure error ⇒ 500 {ok:false} (Meta redelivers)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    processInboundWebhook.mockRejectedValue(Object.assign(new Error('x'), { code: '57P03' }));
    const res = await post();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false });
  });

  it('anything else ⇒ 200 {ok:true} (acknowledged; logged with the error name only)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    processInboundWebhook.mockRejectedValue(new TypeError('secret-ish detail 15551230000'));
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('whatsapp.inbound_failed');
    expect(logged).toContain('TypeError');
    expect(logged).not.toContain('secret-ish');
    // Review fix 6: one best-effort audit row under the routed tenant, name only.
    expect(auditRecord).toHaveBeenCalledTimes(1);
    expect(auditRecord).toHaveBeenCalledWith({
      partnerId: 'acme',
      actor: 'whatsapp',
      actorType: 'system',
      action: 'whatsapp.inbound_dropped',
      meta: { reason: 'webhook_error', error: 'TypeError' },
    });
    expect(JSON.stringify(auditRecord.mock.calls)).not.toContain('secret-ish');
  });

  it('an infrastructure error writes no webhook_error row (Meta redelivers)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    processInboundWebhook.mockRejectedValue(Object.assign(new Error('x'), { code: '08006' }));
    expect((await post()).status).toBe(500);
    expect(auditRecord).not.toHaveBeenCalled();
  });
});

describe('POST /api/whatsapp/[partnerId] — signature health (R2b)', () => {
  type Dump = { dump: Map<string, string> };
  const keys = () => [...(redisHolder.current as Dump).dump.keys()].sort();

  it('a bad signature for a known partner with a secret ⇒ 401 and ONE Redis mark per hour, no DB row', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 5; i++) expect((await post(body, sign(body, 'wrong'))).status).toBe(401);
    const k = keys();
    expect(k.filter((x) => x.startsWith('wasigfail:acme:'))).toHaveLength(1);
    expect(k).toContain('wasigfaillast:acme');
    expect(k.some((x) => x.startsWith('wasigok:'))).toBe(false);
    expect(auditRecord).not.toHaveBeenCalled();
    expect(processInboundWebhook).not.toHaveBeenCalled();
  });

  it('unknown, suspended or secret-less partners ⇒ 401 and NO Redis key at all', async () => {
    getPartner.mockResolvedValueOnce(null);
    expect((await post(body, sign(body, 'wrong'), 'ghost')).status).toBe(401);
    getPartner.mockResolvedValueOnce({ id: 'acme', status: 'suspended' });
    expect((await post(body, sign(body, 'wrong'))).status).toBe(401);
    getIntegrations.mockResolvedValueOnce({ kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn_acme', token: 't' } });
    expect((await post(body, sign(body, 'wrong'))).status).toBe(401);
    expect(keys()).toEqual([]);
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('a Redis outage still answers exactly 401', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    redisHolder.current = { set: async () => { throw new Error('redis down'); }, get: async () => { throw new Error('redis down'); } };
    const res = await post(body, sign(body, 'wrong'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false });
  });

  it('a valid signature records lastSignedOkAt and the response is unchanged', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(keys()).toEqual(['wasigok:acme']);
  });

  it('a Redis outage on a valid signature still processes the webhook (200)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    redisHolder.current = { set: async () => { throw new Error('redis down'); }, get: async () => null };
    expect((await post()).status).toBe(200);
    expect(processInboundWebhook).toHaveBeenCalledTimes(1);
  });
});
