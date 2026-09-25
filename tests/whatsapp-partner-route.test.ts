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
const auditRecord = vi.hoisted(() => vi.fn(async (_e: Record<string, unknown>) => {}));
vi.mock('@/db/repos/aux-repos', () => ({ createAuditRepo: () => ({ record: auditRecord }) }));

import { POST } from '@/app/api/whatsapp/[partnerId]/route';

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
